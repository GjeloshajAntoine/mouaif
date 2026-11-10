'use strict';

// Turn-level hooks (docs/features/hooks.md, spec phase 2): `turn.start`,
// `turn.error` and `turn.end` with its follow-up turn.
//
// runChatStream calls these without awaiting them, so a slow hook never holds
// the chat. A `turn.end` hook may answer `{ "followUp": "…" }`: mouaif then
// starts ONE more turn in the same chat with that text as the prompt, marked
// `origin: { kind: 'hook', hookId, depth, run }`. A chain stops after
// MAX_FOLLOW_UPS follow-ups. When the chat is busy by the time the hooks
// answer (you sent something, or another run started), the follow-up is
// dropped, not queued: it must never overlap a run or land after you took over.

const hooks = require('./hooks.js');

const MAX_FOLLOW_UPS = 3;

function hookOriginOf(origin) {
  return { kind: (origin && origin.kind) || 'user' };
}

function depthOf(origin) {
  return origin && origin.kind === 'hook' && Number.isSafeInteger(origin.depth) ? origin.depth : 0;
}

// fireTurnStart({ projectDir, chatId, cwd, origin, model, provider, thinkingLevel }) -> Promise
function fireTurnStart(t) {
  return hooks.runHooks('turn.start', {
    origin: hookOriginOf(t.origin), model: t.model || '', provider: t.provider || '', thinkingLevel: t.thinkingLevel || ''
  }, { projectDir: t.projectDir, chatId: t.chatId, cwd: t.cwd }).catch(() => null);
}

// fireTurnError({ projectDir, chatId, cwd, origin, code, message, stopped }) -> Promise
function fireTurnError(t) {
  return hooks.runHooks('turn.error', {
    origin: hookOriginOf(t.origin), code: t.code || '', message: t.message || '', stopped: !!t.stopped
  }, { projectDir: t.projectDir, chatId: t.chatId, cwd: t.cwd }).catch(() => null);
}

// fireSubagentEnd(ctx, s) -> Promise<{ notes, context? } | null>
//
// A delegated run finished, at any depth (`depth` says how deep). Its caller
// waits for this unless the run was cancelled, so a hook's context reaches the
// parent with the result. Fired by src/tools/subagent-orchestration.js through
// the `onEnd` src/ai-stream.js gives it.
//
// s: { row, exec, state, task, background, origin }
async function fireSubagentEnd(ctx, { row, exec, state, task, background, origin }) {
  const result = (exec && exec.result) || {};
  const outcome = await hooks.runHooks('subagent.end', {
    origin: hookOriginOf(origin), callId: row.callId, agent: row.agent || null, task: task || '', background: !!background,
    state, ok: !!(exec && exec.ok), text: typeof result.text === 'string' ? result.text : '', error: result.error || null,
    model: (result.model && result.model.id) || row.modelId || null, depth: row.depth, parentCallId: row.parentCallId || null,
    groupId: row.groupId || null, memberId: row.memberId || null, durationMs: Date.now() - row.startedAt
  }, ctx).catch(() => null);
  if (!outcome || !outcome.notes.length) return null;
  return outcome.context ? { notes: outcome.notes, context: outcome.context } : { notes: outcome.notes };
}

// fireTurnEnd(t, { startTurn, isRunning }) -> Promise<{ followUp: 'started' | 'limit' | 'busy' | 'failed' | null }>
//
// t: { projectDir, chatId, cwd, origin, modelId, providerId, sessionToken,
//      lifecycle, text, usage, cost, toolCount }
// startTurn(body, lifecycle, sessionToken) -> { ok } | { ok: false, code, error }
// isRunning() -> true while the chat has a run
async function fireTurnEnd(t, { startTurn, isRunning } = {}) {
  const ctx = { projectDir: t.projectDir, chatId: t.chatId, cwd: t.cwd };
  const depth = depthOf(t.origin);
  let outcome;
  try {
    outcome = await hooks.runHooks('turn.end', {
      origin: hookOriginOf(t.origin), text: t.text || '', usage: t.usage || null, cost: t.cost || null,
      toolCount: t.toolCount || 0, followUpDepth: depth
    }, ctx);
  } catch { return { followUp: null }; }
  if (!outcome.followUps.length) return { followUp: null };

  const first = outcome.followUps[0];
  const note = (decision, error) => hooks.logRun({ hook: first.hook, event: 'turn.end', decision, error,
    reason: decision === 'continue' ? 'follow-up ' + (depth + 1) + '/' + MAX_FOLLOW_UPS + ' started' : undefined }, ctx);
  if (depth >= MAX_FOLLOW_UPS) {
    note('skipped', 'follow-up not started: ' + MAX_FOLLOW_UPS + ' follow-ups in a row already');
    return { followUp: 'limit' };
  }
  if (typeof startTurn !== 'function' || (typeof isRunning === 'function' && isRunning())) {
    note('skipped', 'follow-up not started: the chat was busy');
    return { followUp: 'busy' };
  }
  // Several hooks asking at once make one follow-up turn, each part labelled.
  const content = outcome.followUps.length === 1
    ? first.text
    : outcome.followUps.map((f) => '[' + f.hook + '] ' + f.text).join('\n\n');
  let result;
  try {
    result = await startTurn({
      projectDir: t.projectDir, chatId: t.chatId, modelId: t.modelId, providerId: t.providerId || '',
      content, origin: { kind: 'hook', hookId: first.hook, depth: depth + 1, run: depth + 1 }
    }, t.lifecycle || {}, t.sessionToken || null);
  } catch (e) { result = { ok: false, error: e.message }; }
  if (result && result.ok) { note('continue'); return { followUp: 'started' }; }
  if (result && result.code === 'EALREADY_RUNNING') {
    note('skipped', 'follow-up not started: the chat was busy');
    return { followUp: 'busy' };
  }
  note('error', 'follow-up not started: ' + ((result && (result.error || result.code)) || 'unknown error'));
  return { followUp: 'failed' };
}

module.exports = { MAX_FOLLOW_UPS, fireTurnStart, fireTurnError, fireSubagentEnd, fireTurnEnd };
