'use strict';

// Shell review — a second model reads a proposed command before it runs.
//
// The shell tool already has a permission gate (docs/features/tool-authorization.md)
// which asks *the user* whether a command may run. That gate answers "may
// this run?"; it does not answer "what does this actually do?". A short
// `rm -rf build .env && git clean -xdf` is easy to approve on a phone and
// hard to read at a glance.
//
// So this module adds an optional reviewer: a model the user picks (its own
// provider + model, independent of the chat's model), a prompt the user
// writes, and a plain-text verdict that is attached to the approval card
// *before* the user decides. The reviewer is display-only:
//
//   * it never runs anything, never changes a mode, never answers for the
//     user — a command still goes through `authorize()` exactly as before;
//   * it is not part of the chat transcript: no message row is written, the
//     chat's tool loop never sees the verdict, and the chat model cannot ask
//     for a review (there is no tool for it);
//   * a failure (provider down, unknown model, timeout, empty answer) is
//     reported as `{ ok: false, error }` and the approval card simply has no
//     review section. A reviewer that cannot answer never blocks a command,
//     because being unable to review is not evidence that a command is safe
//     or unsafe.
//
// The cost of the reviewer's own run is real, so it is priced with the same
// `src/usage.js` rates the chat uses and returned as `cost`; the HTTP layer
// attributes it to the chat that asked (like dictation — a priced run that is
// not a chat turn: see src/server-handlers-transcribe.js).
//
// Storage: the choice lives in the resolved settings under `shellReview`
// ({ mode, providerId, modelId, prompt }). It is project-scoped like every
// other project setting, so each project can have its own reviewer, and it
// inherits the app-level value when a project does not set one.

const MAX_COMMAND_CHARS = 8000;
const MAX_PROMPT_CHARS = 8000;
const MAX_REVIEW_CHARS = 12000;
const REVIEW_TIMEOUT_MS = 45 * 1000;

// REVIEW_MODES — the values `shellReview.mode` accepts.
//
//   off    — no review is ever produced (the default; nothing is configured).
//   ask    — the composer's review button reviews the draft command on
//            demand. Nothing runs automatically.
//   always — every command the shell tool runs is reviewed first, and the
//            verdict rides the approval card / the shell card.
//
// `ask` is the safe way to try the feature: it costs a request only when the
// user taps the button. `always` reviews model-initiated calls too, which is
// what a user wants when they do not trust their own ability to read a
// command on a phone.
const REVIEW_MODES = Object.freeze(['off', 'ask', 'always']);
const DEFAULT_MODE = 'off';

// DEFAULT_PROMPT — what the reviewer is asked when the user has not written
// their own prompt. Deliberately about *effects*, not about approval: the
// reviewer must not pretend to be the permission gate, and its answer must be
// short enough to read on a 360 px screen.
const DEFAULT_PROMPT = [
  'You review one shell command before a user approves it.',
  'Say what the command does in one short sentence, then list its side effects:',
  'files created, modified or deleted, processes started or stopped, network',
  'access, and anything that cannot be undone. Quote the risky part.',
  'Then answer with exactly one verdict line: SAFE, CAUTION or DANGER.',
  'Do not run anything, do not suggest an alternative command unless asked,',
  'and do not assume arguments that are not in the command.'
].join(' ');

// normalize(raw) -> { mode, providerId, modelId, prompt }
//
// Reads a raw `shellReview` value defensively: a hand-edited project file, a
// legacy shape, or a value from a settings merge. An unknown mode falls back
// to `off` (the safe direction: no request is made), and the prompt falls back
// to DEFAULT_PROMPT when it is missing or blank, so a mode that is on always
// has an instruction to send.
function normalize(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = REVIEW_MODES.includes(value.mode) ? value.mode : DEFAULT_MODE;
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const prompt = typeof value.prompt === 'string' && value.prompt.trim()
    ? value.prompt
    : DEFAULT_PROMPT;
  return { mode, providerId, modelId, prompt };
}

// configured(config) -> boolean
//
// A review needs three things: a non-off mode, and a provider + model to send
// the question to. A half-configured review (mode on, no model) reads as "not
// configured": there is no sensible default model to fall back on, and
// silently reviewing with the chat's model would spend the user's chat budget
// on something they did not choose.
function configured(config) {
  const cfg = normalize(config);
  return cfg.mode !== 'off' && !!cfg.providerId && !!cfg.modelId;
}

// clampCommand(cmd) -> string — the command text as the reviewer sees it.
// Capped so a pasted script cannot turn one review into a huge request; the
// cap is announced rather than silently cutting the text, because a reviewer
// that did not see the whole command must not sound certain about it.
function clampCommand(cmd) {
  const text = typeof cmd === 'string' ? cmd : '';
  if (text.length <= MAX_COMMAND_CHARS) return text;
  return text.slice(0, MAX_COMMAND_CHARS) + '\n[... command truncated at ' + MAX_COMMAND_CHARS + ' chars ...]';
}

// buildMessages({ prompt, cmd, cwd }) -> OpenAI-style message array
//
// Two messages: the user's review prompt as the system message (so it can be
// reused as written, the way a custom prompt is) and the command to review as
// the user message. The working directory is included because a command's
// effect depends on where it runs (`rm -rf dist` in a repo root is not the
// same as in `$HOME`), and the reviewer cannot infer it.
function buildMessages({ prompt, cmd, cwd }) {
  const system = normalize({ mode: 'always', prompt }).prompt.slice(0, MAX_PROMPT_CHARS);
  const lines = [];
  if (cwd) lines.push('Working directory: ' + String(cwd));
  lines.push('Command to review:');
  lines.push('```sh');
  lines.push(clampCommand(cmd));
  lines.push('```');
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') }
  ];
}

// parseReview(text) -> { text, verdict }
//
// `verdict` is the LAST word of the answer if it is one of SAFE / CAUTION /
// DANGER, because the prompt asks for the verdict line last. A model that
// answers in prose, or puts the verdict first, still yields a readable
// `text`; only a recognisable verdict word is surfaced separately. This is
// cosmetic — the card shows the text either way.
function parseReview(text) {
  const answer = typeof text === 'string' ? text : '';
  const capped = answer.length > MAX_REVIEW_CHARS
    ? answer.slice(0, MAX_REVIEW_CHARS) + '\n[review truncated]'
    : answer;
  const m = capped.match(/\b(SAFE|CAUTION|DANGER)\b/g);
  return { text: capped.trim(), verdict: m && m.length ? m[m.length - 1] : '' };
}

// resolveReviewModel(projectDir, config) -> hydrated model record | { error }
//
// The reviewer's model is an ordinary model identity (provider + id), resolved
// through the same helper every other one-shot AI call uses, so a live-catalog
// model works without being saved in the project. A project model entry wins
// (it can carry pricing / context limits), and the app-level connection always
// supplies the transport and credential.
function resolveReviewModel(projectDir, config) {
  const cfg = normalize(config);
  if (!cfg.providerId || !cfg.modelId) {
    const error = new Error('shellReview needs providerId and modelId');
    error.code = 'EBADINPUT';
    throw error;
  }
  return require('./server-shared.js').resolveModel(cfg.modelId, projectDir || null, cfg.providerId);
}

// reviewCommand(opts) -> Promise<{ ok, text, verdict, model, kind, usage, cost, error?, code? }>
//
//   opts.projectDir   — which project's model list / settings to read
//   opts.cmd          — the command to review
//   opts.cwd          — where the command would run (optional)
//   opts.chatId       — the chat asking (optional; used for cost attribution by
//                       the caller, not by this module)
//   opts.signal       — an AbortSignal (optional)
//   opts.force        — ignore `mode === 'off'`? No: an off review is an error,
//                       so a disabled feature can never be triggered by a
//                       stale button. The composer hides the button instead.
//
// The upstream call is a single non-streaming turn on a message array with no
// tools, so the reviewer cannot call anything even by accident: it answers in
// text or it fails.
async function reviewCommand(opts) {
  const projectDir = opts && opts.projectDir;
  const cmd = opts && opts.cmd;
  if (!projectDir) return { ok: false, code: 'EBADINPUT', error: 'projectDir is required' };
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, code: 'EBADINPUT', error: 'cmd is required' };
  }
  const settings = require('./settings.js');
  let config;
  try { config = normalize(settings.getResolved(projectDir || null).shellReview); }
  catch (e) { return { ok: false, code: 'ECONFIG', error: e.message || String(e) }; }
  if (config.mode === 'off') {
    return { ok: false, code: 'EREVIEW_OFF', error: 'shell review is off for this project' };
  }
  if (!configured(config)) {
    return {
      ok: false,
      code: 'EREVIEW_MODEL',
      error: 'shell review has no model — pick one in Settings → Project → Shell review'
    };
  }

  let model;
  try { model = resolveReviewModel(projectDir, config); }
  catch (e) {
    return { ok: false, code: e.code || 'EREVIEW_MODEL', error: e.message || String(e), model: { id: config.modelId, provider: config.providerId } };
  }

  const startedAt = Date.now();
  // Bound the review so a stuck provider cannot hold the approval card. The
  // caller's signal (a closed request) aborts too; whichever fires first wins.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch { /* already aborted */ } }, REVIEW_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) { clearTimeout(timer); return { ok: false, code: 'EABORTED', error: 'aborted' }; }
    opts.signal.addEventListener('abort', () => { try { controller.abort(); } catch { /* already aborted */ } }, { once: true });
  }

  let text = '';
  let usage = null;
  try {
    const result = await require('./ai.js').streamChat({
    model,
    messages: buildMessages({ prompt: config.prompt, cmd, cwd: opts.cwd }),
    signal: controller.signal,
    // No tool surface at all: the reviewer answers in text. Without this the
    // request would carry every advertised tool, and a model that decided to
    // call one would be trying to ACT on a command it was only asked to read.
    noTools: true,
      // No projectDir/chatId: the reviewer is a one-shot question with no
      // tools, no skills and no agent files. Passing a chat id would make the
      // stream path treat it as a chat turn (working folder system message,
      // tool advertisement, pending approvals) — none of which belong here.
      onEvent: (name, data) => {
        if (name === 'message' && data && typeof data.delta === 'string') text += data.delta;
        else if (name === 'done' && data && data.usage) usage = data.usage;
      }
    });
    if (!result || result.ok === false) {
      const err = (result && result.error) || {};
      const code = timedOut ? 'ETIMEOUT' : (err.code || 'EREVIEW');
      return {
        ok: false,
        code,
        error: timedOut ? 'review timed out after ' + Math.round(REVIEW_TIMEOUT_MS / 1000) + 's' : (err.message || 'review failed'),
        model: { id: model.id, provider: model.provider },
        durationMs: Date.now() - startedAt
      };
    }
  } catch (e) {
    const code = timedOut ? 'ETIMEOUT' : (e && e.code) || 'EREVIEW';
    return {
      ok: false,
      code,
      error: timedOut ? 'review timed out after ' + Math.round(REVIEW_TIMEOUT_MS / 1000) + 's' : ((e && e.message) || String(e)),
      model: { id: model.id, provider: model.provider },
      durationMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseReview(text);
  if (!parsed.text) {
    return {
      ok: false,
      code: 'EEMPTY_REVIEW',
      error: 'the reviewing model returned no text',
      model: { id: model.id, provider: model.provider },
      durationMs: Date.now() - startedAt
    };
  }
  // Priced with the same table the chat uses (docs/decisions.md §14). A
  // provider that reports no token counts leaves the cost unknown rather than
  // guessing zero.
  let cost = { known: false, total: 0, currency: 'USD' };
  if (usage) {
    try {
      cost = require('./usage.js').computeCost({ model, usage, app: settings.getApp() });
    } catch { /* pricing is best-effort; the review itself already succeeded */ }
  }
  return {
    ok: true,
    text: parsed.text,
    verdict: parsed.verdict,
    model: { id: model.id, provider: model.provider },
    usage: usage || null,
    cost,
    durationMs: Date.now() - startedAt
  };
}

// ---- Automatic review, once per tool call ---------------------------
//
// A shell call is handled in two places: the authorization step (which may
// prompt before anything runs) and the dispatcher (which runs the command).
// When review mode is `always` both want a verdict for the same call, and the
// user must not pay for two requests or see two review cards. `startReview`
// therefore de-duplicates by the tool call id: the first caller starts the
// request, later callers for the same id reuse it.
//
// The entry survives briefly after the review settles (REVIEW_DEDUPE_MS) so
// the dispatcher's follow-up — normally a fraction of a second after the
// prompt resolved — still finds the answer instead of re-asking.
const REVIEW_DEDUPE_MS = 5 * 60 * 1000;
const started = new Map(); // callId -> { promise, at }

function sweepStarted(now = Date.now()) {
  for (const [callId, entry] of started) {
    if (now - entry.at > REVIEW_DEDUPE_MS) started.delete(callId);
  }
}

// shouldAutoReview(projectDir) -> boolean
//
// True only for `mode: 'always'` with a complete model choice. `ask` exists so
// a user can try the feature from the composer button without spending a
// request on every command the model runs.
function shouldAutoReview(projectDir) {
  try {
    const resolved = require('./settings.js').getResolved(projectDir || null);
    return normalize(resolved && resolved.shellReview).mode === 'always'
      && configured(resolved && resolved.shellReview);
  } catch { return false; }
}

// attachReviewToPending(projectDir, chatId, callId, review)
//
// Put the verdict on the pending approval request so a reconnect, a page
// reload, or the reconcile poll's pending-queue drain shows the same review
// the live card showed. Best-effort: a call that has already been decided has
// no pending entry, and that is not an error.
function attachReviewToPending(projectDir, chatId, callId, review) {
  if (!projectDir || !chatId || !callId || !review) return false;
  try {
    const authz = require('./tools/authorization.js');
    if (typeof authz.attachReview === 'function') {
      return authz.attachReview(projectDir, chatId, callId, review);
    }
  } catch { /* authorization module unavailable; the live event still ran */ }
  return false;
}

// startReview({ projectDir, chatId, callId, cmd, cwd, onEvent, signal, force })
//
//   -> null   when this call should not be reviewed (mode off/ask without
//             `force`, no model, no call id)
//   -> Promise<review>   otherwise. The promise never rejects: a failed review
//             resolves `{ ok: false, error, code }`, because nobody's command
//             may be blocked by a reviewer that could not answer.
//
// `onEvent('shell_review', { id: callId, ...review })` fires when the answer
// lands, so the chat card can show it without a second request. `force: true`
// is the composer button: an explicit tap reviews even in `ask` mode.
function startReview(opts) {
  const projectDir = opts && opts.projectDir;
  const chatId = opts && opts.chatId;
  const callId = opts && opts.callId;
  const cmd = opts && opts.cmd;
  if (!projectDir || !cmd || typeof cmd !== 'string' || !cmd.trim()) return null;
  let config;
  try { config = normalize(require('./settings.js').getResolved(projectDir).shellReview); }
  catch { return null; }
  if (config.mode === 'off') return null;
  if (!configured(config)) return null;
  if (config.mode !== 'always' && !(opts && opts.force)) return null;
  // No call id means no card to attach a verdict to. The REST reviewer
  // endpoint answers the caller directly instead.
  if (!callId) return null;

  sweepStarted();
  const existing = started.get(callId);
  if (existing) return existing.promise;

  const onEvent = typeof (opts && opts.onEvent) === 'function' ? opts.onEvent : null;
  const promise = reviewCommand({
    projectDir,
    cmd,
    cwd: opts && opts.cwd,
    chatId,
    signal: opts && opts.signal
  }).then((review) => {
    const payload = Object.assign({}, review, { id: callId, cmd: typeof cmd === 'string' ? cmd : '' });
    if (review && review.ok && chatId && review.cost && review.cost.known && Number.isFinite(review.cost.total) && review.cost.total > 0) {
      try { require('./messages.js').addChatCost(projectDir, chatId, review.cost.total); } catch { /* non-fatal */ }
    }
    if (onEvent && review) {
      try { onEvent('shell_review', payload); } catch { /* client gone; the run continues */ }
    }
    attachReviewToPending(projectDir, chatId, callId, payload);
    return review;
  }).catch((e) => ({ ok: false, code: 'EREVIEW', error: (e && e.message) || String(e) }));
  started.set(callId, { promise, at: Date.now() });
  // A settled entry stays for the dedupe window; sweep it on the next start
  // rather than holding a timer open for every reviewed command.
  return promise;
}

module.exports = {
  REVIEW_MODES,
  DEFAULT_PROMPT,
  REVIEW_TIMEOUT_MS,
  REVIEW_DEDUPE_MS,
  normalize,
  configured,
  buildMessages,
  parseReview,
  clampCommand,
  resolveReviewModel,
  reviewCommand,
  shouldAutoReview,
  attachReviewToPending,
  startReview
};
