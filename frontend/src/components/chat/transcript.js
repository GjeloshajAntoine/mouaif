// mouaif web — Chat transcript rendering
//
// Everything that draws into the .chat-view__transcript: chat
// bubbles, tool call/result cards, the system-prompt message, the
// subagent live + final render, and the per-turn usage meta line.
// Imperative DOM (not Preact JSX) so the SSE hot path stays as
// cheap as a textContent assignment and so the visual layout
// matches the rest of the transcript which is also imperative.

import { renderMarkdown } from '../../markdown.js';
import { afterTranscriptAppend, scrollToolBodyToBottom, pinTranscriptAfterSettle } from './scroll.js';
import {
  isSubagentTool,
  normalizeToolName,
  formatToolArgs,
  formatResultSummary,
  isExpectedToolFailure,
  coerceToolResult,
  formatReadableToolResult,
  TOOL_ARGS_PREVIEW_CHARS
} from './tools.js';
import { renderToolResultBody } from './toolRender.js';
import { publish as publishWebPreview } from './webpreviewState.js';
import { cssEscape, copyText, messageCopyText } from './utils.js';
import { buildSetupCard, mountToolsCard, mountAgentFilesCard, mountSkillsCard } from './cards.js';
import { headerCardIndex, isHeaderCardNode, orderHeaderCards, placeHeaderCard, HEADER_CARD_ORDER } from './headerCards.js';
import { setPromptSize } from './meta.js';
import { updateUsageSummary } from './usage.js';
import { updateJumpButton } from './scroll.js';
import {
  renderShellToolResult,
  renderReadFileToolResult,
  renderListFilesToolResult,
  renderSearchFilesToolResult,
  renderEditFileToolResult,
  renderWriteFileToolResult
} from './toolRender.js';
import { renderUsageMeta } from './usage.js';
import { isPersistedTurnError, retryPayloadForError } from './retry.js';
// agentLabel(agentName) -> string
//
// The role label a delegated run's system row shows. The model chooses an
// agent by its stored name, so the name is the one fact that distinguishes
// this delegated run from a generic `subagent` call. Without it an `@agent`
// dispatch and a model-driven delegation render identically and the card only
// ever says "Subagent" — there was no way to tell WHICH agent answered after
// the fact. An empty or malformed name falls back to `agent` so the row always
// names a role, never a blank.
export function agentLabel(agentName) {
  const name = String(agentName == null ? '' : agentName).trim();
  return name || 'agent';
}

// buildSystemPromptRow(text, extraClass, roleLabel)
//
// The `system` chat row: a role head plus a body holding a collapsed
// <details> whose summary is the line count. Shared by the top-level
// transcript and the nested subagent transcript, so a delegated run's own
// system message renders as a system card instead of a JSON dump of its
// content parts.
//
// `roleLabel` overrides the head's role text (default `system`), which is
// how a nested agent run labels WHICH agent answered — see agentLabel.
export function buildSystemPromptRow(text, extraClass, roleLabel) {
  const row = document.createElement('div');
  row.className = 'chat-msg chat-msg--system' + (extraClass ? ' ' + extraClass : '');
  const head = document.createElement('div');
  head.className = 'chat-msg__head';
  const role = document.createElement('div');
  role.className = 'chat-msg__role';
  role.textContent = roleLabel || 'system';
  // Same head shape as every other chat row so the nested and top-level
  // transcripts cannot drift apart again. Nested turns carry no
  // timestamp, so the element stays hidden rather than omitted.
  const ts = document.createElement('span');
  ts.className = 'chat-msg__ts';
  ts.hidden = true;
  head.appendChild(role);
  head.appendChild(ts);
  const body = document.createElement('div');
  body.className = 'chat-msg__body';
  // Count non-empty lines for the summary. The prompt is plain
  // text; we only render it (as <pre> with pre-wrap) when the user
  // expands the disclosure, so the line count is the only signal
  // the user has of how much is behind it.
  const lineCount = String(text || '').split(/\r?\n/).filter(l => l.length).length;
  const details = document.createElement('details');
  details.className = 'chat-msg__system-details';
  const summary = document.createElement('summary');
  summary.textContent = 'System prompt · ' + lineCount + ' line' + (lineCount === 1 ? '' : 's');
  const pre = document.createElement('pre');
  pre.className = 'chat-msg__system-body';
  pre.textContent = text || '';
  details.appendChild(summary);
  details.appendChild(pre);
  body.appendChild(details);
  row.appendChild(head);
  row.appendChild(body);
  return row;
}

// renderSystemPromptMessage(refs, systemPrompt)
//
// Render (or refresh) the system prompt as the FIRST message of the
// transcript — a normal chat bubble with the `system` role, styled
// like the user/assistant bubbles. The lookup uses
// [data-sys-prompt] to avoid clobbering any future .chat-msg with
// role text "system".
//
// The prompt body is wrapped in a <details> that starts COLLAPSED.
// The agent's system prompt can run to thousands of characters of
// instructions the user never asked to see; showing the full text by
// default pushes the first real turn off-screen on a phone and makes
// the chat look broken on open. The collapsed default shows a single
// "System prompt · N lines" summary that the user can expand with
// one tap. The body uses <pre> with white-space: pre-wrap so the
// prompt's own line breaks survive unchanged when expanded.
export function renderSystemPromptMessage(refs, systemPrompt) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  if (existing) existing.remove();
  if (!systemPrompt || !systemPrompt.text) return;
  const row = buildSystemPromptRow(systemPrompt.text);
  row.dataset.sysPrompt = '1';
  // Slot 1 of the header block, in one mutation: after the setup control and
  // above the tools / agent-files / skills cards, regardless of which of them
  // happen to be mounted right now. The previous "insert after the setup card
  // if mounted, else first child" guess put the row back above a still-mounted
  // setup card whenever the prompt was refreshed.
  placeHeaderCard(refs.transcript.current, row, HEADER_CARD_ORDER.sysPrompt);
  refs._cardSigs = refs._cardSigs || {};
  refs._cardSigs.sys = String((systemPrompt && systemPrompt.text) || '');
}

// transcriptInsert(refs, node)
//
// Append a row/card to the transcript, or — while a latest-first
// backfill pass is running — insert it before the current backfill
// anchor (refs._insertAnchor) so older rows land ABOVE the tail that
// was already painted at the bottom. When no anchor is set (the live
// path and the tail phase) this is a plain appendChild.
function transcriptInsert(refs, node) {
  const el = refs.transcript.current;
  if (!el) return;
  const anchor = refs._insertAnchor;
  if (anchor && anchor.parentNode === el) el.insertBefore(node, anchor);
  else el.appendChild(node);
  // Remember the node just placed. The transcript's row builders all insert
  // through here, and the reconciler stamps identity from this rather than
  // guessing "the last message row": the chunked backfill inserts ABOVE its
  // anchor, so the newest row is not the last one in the child list.
  refs._lastInsertedRow = node;
}

// renderImageAttachments(host, attachments)
function renderImageAttachments(host, attachments) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg__attachments';
  for (const a of attachments) {
    if (!a || !a.dataUrl) continue;
    const img = document.createElement('img');
    img.className = 'chat-msg__attachment-img';
    img.src = a.dataUrl;
    img.alt = a.name || 'attached image';
    wrap.appendChild(img);
  }
  host.appendChild(wrap);
}

// textOfContent(content)
//
// Flatten a message body into displayable text. Top-level transcript
// messages carry a plain string, but a subagent's nested transcript is
// rebuilt from provider-shaped messages, where the system prompt arrives
// as an array of typed content parts. Unknown shapes fall back to pretty
// JSON so nothing is silently dropped.
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .filter((t) => t)
      .join('\n\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content, null, 2);
  return '';
}

// renderAssistantBody(body, content, reasoning, final)
//
// Render the assistant bubble body. When `reasoning` is present,
// wrap it in a <details>/<summary> collapsible block. The final
// pass renders markdown; the streaming pass renders plain text
// (cheaper, and avoids re-parsing every delta).
function renderAssistantBody(body, content, reasoning, final) {
  body.innerHTML = '';
  if (reasoning) {
    const details = document.createElement('details');
    details.className = 'chat-msg__reasoning';
    if (!final) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = final ? 'Thinking' : 'Thinking…';
    const thinkBody = document.createElement('div');
    thinkBody.className = 'chat-msg__reasoning-body' + (final ? '' : ' chat-msg__reasoning-body--raw');
    if (final) thinkBody.innerHTML = renderMarkdown(reasoning);
    else thinkBody.textContent = reasoning;
    details.appendChild(summary);
    details.appendChild(thinkBody);
    body.appendChild(details);
  }
  const answer = document.createElement('div');
  answer.className = 'chat-msg__answer';
  if (final) answer.innerHTML = renderMarkdown(content || '');
  else answer.textContent = content || '';
  body.appendChild(answer);
}

// COPY_GLYPHS — the three states of the per-message copy control, as inline
// SVG. The control is icon-only, so the state has to be carried by the glyph
// itself: the clipboard, a check once the write lands, a cross when the
// clipboard refuses it. Every glyph draws in `currentColor` with no fill, so
// the CSS tint (muted -> success / danger) is the only color decision.
const COPY_GLYPH_IDLE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="12" rx="2"/>' +
  '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const COPY_GLYPH_COPIED =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';
const COPY_GLYPH_FAILED =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 6 6 18M6 6l12 12"/></svg>';

// buildCopyButton(messageFor) -> button
//
// The per-message copy control: a small, tap-sized ICON button appended at the
// END of the row (below the body) so it never sits between the text and its
// neighbors or overlaps the content on a narrow screen — the same place the
// error card puts its Retry button.
//
// It is icon-only on purpose: it repeats under every bubble, and a text label
// there competed with the message for the same line on a 360px screen. The
// accessible name still travels on `aria-label`, so a screen reader hears
// `Copy message` / `Copied message` / `Copy failed`, and `.tap-target` keeps
// the touch area at 44px while the painted box stays 32px.
//
// `messageFor` resolves the message to copy at click time, not at build time.
// That matters for the live row: it streams into `row._content`, not into the
// placeholder object the row was created from, so a snapshot would copy an
// empty string. A settled row simply returns its message. The glyph flips to a
// check / cross in place for ~1.4s — the transcript is a scrolling list, so a
// toast would be missed.
function buildCopyButton(messageFor) {
  const btn = document.createElement('button');
  btn.className = 'chat-msg__copy tap-target';
  btn.type = 'button';
  btn.innerHTML = COPY_GLYPH_IDLE;
  btn.setAttribute('aria-label', 'Copy message');
  btn.title = 'Copy message';
  btn.addEventListener('click', async () => {
    const ok = await copyText(messageCopyText(messageFor()));
    btn.innerHTML = ok ? COPY_GLYPH_COPIED : COPY_GLYPH_FAILED;
    btn.classList.toggle('is-copied', ok);
    btn.classList.toggle('is-failed', !ok);
    btn.setAttribute('aria-label', ok ? 'Copied message' : 'Copy failed');
    btn.title = ok ? 'Copied message' : 'Copy failed';
    if (btn._copyReset) clearTimeout(btn._copyReset);
    btn._copyReset = setTimeout(() => {
      btn._copyReset = null;
      btn.innerHTML = COPY_GLYPH_IDLE;
      btn.classList.remove('is-copied', 'is-failed');
      btn.setAttribute('aria-label', 'Copy message');
      btn.title = 'Copy message';
    }, 1400);
  });
  return btn;
}

// appendMessageToTranscript(m, isLive, refs, state)
//
// Append a chat bubble. `isLive` marks the row as the current
// streaming target so subsequent deltas find it without rebuilding.
export function appendMessageToTranscript(m, isLive, refs, state) {
  if (!refs.transcript.current) return;
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'chat-msg chat-msg--' + m.role;
  if (isLive) row.dataset.live = '1';
  const role = document.createElement('div');
  role.className = 'chat-msg__role';
  // For assistant turns, show the model name instead of the bare
  // "assistant" role label. The modelId is persisted on the
  // message (decision §14); fall back to the chat's currently
  // selected model when the message is missing one (e.g. an
  // older transcript saved before modelId was tracked).
  if (m.role === 'assistant') {
    const modelId = m.modelId || (state.chat && state.chat.modelId) || 'assistant';
    role.textContent = modelId;
  } else {
    role.textContent = m.role;
  }
  const body = document.createElement('div');
  body.className = 'chat-msg__body';
  if (m.role === 'assistant') {
    renderAssistantBody(body, m.content || '', m.reasoning || '', true);
  } else {
    body.textContent = m.content || '';
    if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
      renderImageAttachments(body, m.attachments);
    }
  }
  // Header line: role label on the left, HH:MM timestamp pushed
  // to the right edge of the message row.
  const head = document.createElement('div');
  head.className = 'chat-msg__head';
  const ts = document.createElement('span');
  ts.className = 'chat-msg__ts';
  if (m.ts) {
    ts.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    ts.hidden = true;
  }
  head.appendChild(role);
  head.appendChild(ts);
  row.appendChild(head);
  row.appendChild(body);
  if (m.role === 'user' || m.role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'chat-msg__actions';
    // A live row streams into `_content` (the placeholder message it was
    // created from stays empty), so gather what is on screen right now. Every
    // other row copies its own message.
    actions.appendChild(buildCopyButton(() => {
    if (!isLive) return m;
    return { role: m.role, content: row._content || '', reasoning: row._reasoning || '' };
    }));
    row.appendChild(actions);
  }
  transcriptInsert(refs, row);
  if (m.role === 'assistant' && isLive) {
    row._body = body;
    row._content = m.content || '';
    row._reasoning = m.reasoning || '';
  }
  // Per-turn meta line (decision §14). Lives directly under the
  // assistant bubble and shows the model id, token counts, cost,
  // and live token rate. For non-assistant messages or for
  // assistant messages without a usage block, the line is hidden
  // — the typical case is a fresh chat before any AI turn, or a
  // transcript from before this commit shipped.
  if (m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'chat-msg__meta';
    if (isLive) {
      // Live turns are empty while the user is typing; hide the
      // meta line so the row doesn't reserve a phantom line of
      // height before the first delta arrives.
      meta.hidden = true;
    } else if (m.usage || m.cost || m.modelId) {
      renderUsageMeta(meta, m, state);
    } else {
      meta.hidden = true;
    }
    row.appendChild(meta);
  }
  afterTranscriptAppend(refs, true);
}

// ensureLiveStreamingBody(row)
//
// The streaming hot path must not rebuild the whole assistant body
// on every delta — that's `body.innerHTML = ''` + re-set of the full
// accumulated string per token, which is O(n) per delta and O(n²)
// for a long turn, plus a full DOM teardown/recreate. So the live
// row's body is switched to "streaming mode" exactly once (on the
// first delta), after which subsequent deltas append a single text
// node. Returns the body element.
function ensureLiveStreamingBody(row) {
  const body = row && row._body;
  if (!body) return body;
  if (!row._streaming) {
    renderAssistantBody(body, row._content || '', row._reasoning || '', false);
    row._streaming = true;
  }
  return body;
}

// appendTextToAnswer(body, text)
//
// Append a delta as a text node to the streaming answer element,
// creating it if needed. textContent assignment would re-encode the
// entire accumulated string; a text node touches only the new bytes.
function appendTextToAnswer(body, text) {
  if (!body || text == null) return;
  let answer = body.querySelector('.chat-msg__answer');
  if (!answer) {
    answer = document.createElement('div');
    answer.className = 'chat-msg__answer';
    body.appendChild(answer);
  }
  answer.appendChild(document.createTextNode(text));
}

// appendTextToReasoning(body, text)
//
// Append a delta as a text node to the streaming reasoning block.
// Reasoning <details> is only created when reasoning is actually
// present; if a reasoning delta arrives after the answer was already
// streaming without one, rebuild the body so the block appears in the
// correct order ahead of the answer.
function appendTextToReasoning(body, text) {
  if (!body || text == null) return;
  let rbody = body.querySelector('.chat-msg__reasoning-body');
  if (!rbody) {
    // Reasoning is newly present — rebuild so the block slots in
    // ahead of the answer (the accumulated content is preserved).
    const row = body._owner || null;
    return renderAssistantBody(body, row ? row._content : '', row ? row._reasoning : text, false);
  }
  rbody.appendChild(document.createTextNode(text));
}

// appendDeltaToLive(delta, refs, state)
//
// Find the live row and append text to it. Lazily creates the live
// row if it doesn't exist (the first delta of a turn can arrive
// after a tool call, in which case no live row is on screen yet).
// Appends incrementally (see ensureLiveStreamingBody) instead of
// rebuilding the whole body on every token.
export function appendDeltaToLive(delta, refs, state) {
  if (!refs.transcript.current) return;
  let liveRow = refs.transcript.current.querySelector('[data-live="1"]');
  if (!liveRow) {
    const mid = (state.chat && state.chat.modelId) || '';
    appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '', ts: new Date().toISOString(), modelId: mid }, true, refs, state);
    liveRow = refs.transcript.current.querySelector('[data-live="1"]');
  }
  if (liveRow) {
    // Switch to streaming mode BEFORE accumulating the delta: the
    // one-time initial render in ensureLiveStreamingBody must see the
    // pre-delta content (empty on the first token), otherwise the
    // delta below would be rendered twice.
    const body = ensureLiveStreamingBody(liveRow);
    if (body) body._owner = liveRow;
    liveRow._content = (liveRow._content || '') + delta;
    appendTextToAnswer(body, delta);
    afterTranscriptAppend(refs, false);
  }
}

// appendReasoningToLive(delta, refs, state)
export function appendReasoningToLive(delta, refs, state) {
  if (!refs.transcript.current) return;
  let liveRow = refs.transcript.current.querySelector('[data-live="1"]');
  if (!liveRow) {
    const mid = (state.chat && state.chat.modelId) || '';
    appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '', ts: new Date().toISOString(), modelId: mid }, true, refs, state);
    liveRow = refs.transcript.current.querySelector('[data-live="1"]');
  }
  if (liveRow) {
    // Same ordering as appendDeltaToLive: ensureLiveStreamingBody must
    // see the pre-delta content for its one-time initial render, else
    // the first reasoning token would appear twice.
    const body = ensureLiveStreamingBody(liveRow);
    if (body) body._owner = liveRow;
    liveRow._reasoning = (liveRow._reasoning || '') + delta;
    appendTextToReasoning(body, delta);
    afterTranscriptAppend(refs, false);
  }
}

// appendErrorCard(message, refs, state, opts)
//
// Render a failed turn as an inline error bubble (system role with
// an `is-error` flag for styling). Used for SSE `error` events and
// client-side send failures so failures are part of the transcript
// the user is looking at — not only in the composer's tiny status
// line, which is easy to miss and gets overwritten by the next
// status update. textContent only: provider error bodies may carry
// markup and must never be injected as HTML.
//
// `opts.onRetry` optionally attaches a tap target to the card that
// re-sends the failed user turn. `opts.persist: false` renders a row that
// is already present in state.messages without appending it a second time.
export function appendErrorCard(message, refs, state, opts) {
if (!refs.transcript.current) return;
const empty = refs.transcript.current.querySelector('.chat-view__empty');
if (empty) empty.remove();
const row = document.createElement('div');
row.className = 'chat-msg chat-msg--system is-error';
const head = document.createElement('div');
head.className = 'chat-msg__head';
const role = document.createElement('div');
role.className = 'chat-msg__role';
role.textContent = 'error';
const ts = document.createElement('span');
ts.className = 'chat-msg__ts';
ts.textContent = new Date((opts && opts.ts) || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
head.appendChild(role);
head.appendChild(ts);
const body = document.createElement('div');
body.className = 'chat-msg__body';
body.textContent = message;
row.appendChild(head);
row.appendChild(body);
if (opts && typeof opts.onRetry === 'function') {
const actions = document.createElement('div');
actions.className = 'chat-msg__actions';
const retry = document.createElement('button');
retry.className = 'btn btn--small chat-msg__retry';
retry.type = 'button';
retry.textContent = 'Retry';
retry.addEventListener('click', () => opts.onRetry());
actions.appendChild(retry);
row.appendChild(actions);
}
transcriptInsert(refs, row);
if (state && (!opts || opts.persist !== false)) {
state.messages = state.messages.concat([{ role: 'system', content: message, ts: new Date().toISOString() }]);
}
afterTranscriptAppend(refs, true);
}

// TOOL_VERBS — verb-style labels for the built-in tools, shown in
// the card header instead of the raw snake_case name (the "Reading
// index.ts" style used by modern agentic editors). Unknown tools
// (MCP etc.) fall back to their raw name.
const TOOL_VERBS = {
  read_file: 'Read',
  list_files: 'Listed',
  search_files: 'Searched',
  edit_file: 'Edited',
  write_file: 'Wrote',
  shell: 'Ran',
  subagent: 'Subagent',
ask_user: 'Question',
restart_app: 'Restarted'
};

function toolCardLabel(toolName) {
  const name = normalizeToolName(toolName);
  if (TOOL_VERBS[name]) return TOOL_VERBS[name];
  if (name && name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean);
    return parts[parts.length - 1] || name;
  }
  return name || 'tool';
}

function shortToolText(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// One-line argument budget: the tool card head and the nested subagent
// rows truncate the same call at the same length. The value lives in
// tools.js, next to formatToolArgsFull — the full form the expanded card
// renders — so the two halves of the truncation rule cannot drift.

// buildSubagentToolRow(name, id, argsText, argsObj)
//
// The nested row a delegated run shows for one of its tool calls. It
// reuses the main card head's classes — `.tool-card__name` for the verb
// label, `.tool-card__args` for the one-line arguments,
// `.tool-card__result-summary` and `.tool-card__pill` — so the tool name
// and its content render at the main transcript's type scale, casing,
// truncation budget and status-dot size instead of on a private style
// scale. The row is NOT a `.tool-card__head`: a nested row has no
// expand/collapse of its own (the parent subagent card owns that), so it
// carries no chevron and no tap target.
function buildSubagentToolRow(name, id, argsText, argsObj) {
  const row = document.createElement('div');
  row.className = 'tool-card__subagent-tool';
  if (id) row.dataset.nestedToolId = String(id);
  const callName = document.createElement('span');
  callName.className = 'tool-card__name';
  callName.textContent = toolCardLabel(name);
  row.appendChild(callName);
  if (argsText) {
    const callArgs = document.createElement('pre');
    callArgs.className = 'tool-card__args';
    callArgs.textContent = shortToolText(argsText, TOOL_ARGS_PREVIEW_CHARS);
    if (callArgs.textContent !== argsText) callArgs.title = argsText;
    row.appendChild(callArgs);
  }
  const status = document.createElement('span');
  status.className = 'tool-card__pill tool-card__pill--busy';
  status.textContent = 'running';
  row.appendChild(status);
  // Keep the call's args on the row so its result preview and summary can
  // use them (a nested write_file renders the content it wrote).
  if (argsObj && typeof argsObj === 'object') row._toolArgs = argsObj;
  return row;
}

// fillSubagentToolRow(row, name, raw, args, okHint)
//
// Settle one nested row in place: flip the status dot busy → ok/error,
// add the collapsed result summary the main card shows, and render the
// per-tool preview. Call and result are two messages in the persisted
// nested transcript but ONE row on screen — both the live stream and the
// final render go through here, so the two views cannot disagree.
// `okHint` is the live result frame's authoritative ok flag; the settled
// transcript has no such flag and falls back to inspecting the body.
function fillSubagentToolRow(row, name, raw, args, okHint) {
  if (!row) return null;
  const toolName = normalizeToolName(name);
  const r = coerceToolResult(raw, toolName);
  const ok = typeof okHint === 'boolean' ? okHint : !(r && r.error);
  const status = row.querySelector('.tool-card__pill');
  if (status) {
    status.className = 'tool-card__pill ' + (ok ? 'tool-card__pill--ok' : 'tool-card__pill--err');
    status.textContent = ok ? 'ok' : 'error';
  }
  const summary = (ok || isExpectedToolFailure(name, r, ok)) ? formatResultSummary(name, r) : null;
  if (summary) {
    let summaryEl = row.querySelector('.tool-card__result-summary');
    if (!summaryEl) {
      summaryEl = document.createElement('span');
      summaryEl.className = 'tool-card__result-summary';
      row.insertBefore(summaryEl, status || null);
    }
    summaryEl.textContent = summary;
  }
  const oldPreview = row.querySelector('.tool-card__subagent-preview');
  if (oldPreview) oldPreview.remove();
  renderSubagentToolPreview(row, name, raw, args);
  return r;
}

// buildToolCardHead(toolName, args, pillClass, pillText, resultSummary, toolArgs)
//
// The compact header row shared by tool_call and tool_result cards:
// a chevron, the verb-style tool label, the one-line arg summary,
// and a status dot (busy/ok/err) on the right. The whole row is the
// tap target for expand/collapse. The status element keeps the
// legacy `.tool-card__pill` classes so subagent code that toggles
// pill classes keeps working.
//
// `toolArgs` is the call's argument OBJECT, when the caller has it. `args` is
// only the formatted one-line text, so a card that has to render more than the
// generic arg summary (a delegated run names the agent it dispatched) cannot
// recover the agent from it. Kept separate so the display text stays a plain
// string for every existing caller.
function buildToolCardHead(toolName, args, pillClass, pillText, resultSummary, toolArgs) {
  const head = document.createElement('div');
  head.className = 'tool-card__head';
  head.setAttribute('role', 'button');
  const chev = document.createElement('span');
  chev.className = 'tool-card__chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 5.5 15.5 12 9 18.5l1.4 1.4L18.3 12l-7.9-7.9L9 5.5Z"/></svg>';
  const name = document.createElement('span');
  name.className = 'tool-card__name';
  name.textContent = toolCardLabel(toolName);
  // Name the agent on a delegated run's card. The model chooses an agent by
  // its stored name and the name is not otherwise recoverable from the card,
  // so without this a `@reviewer` dispatch and a generic delegation read
  // identically as "Subagent". Own element (not folded into the name) so it
  // can be styled as a chip and left out of the tap target's label.
  if (isSubagentTool(toolName)) {
    const agentName = toolArgs && typeof toolArgs === 'object' ? toolArgs.agent : null;
    if (String(agentName == null ? '' : agentName).trim()) {
      const agent = document.createElement('span');
      agent.className = 'tool-card__agent';
      agent.textContent = String(agentName).trim();
      agent.title = 'Agent';
      head.appendChild(chev);
      head.appendChild(name);
      head.appendChild(agent);
      return finishToolCardHead(head, toolName, args, pillClass, pillText, resultSummary);
    }
  }
  head.appendChild(chev);
  head.appendChild(name);
  return finishToolCardHead(head, toolName, args, pillClass, pillText, resultSummary);
}

// finishToolCardHead(head, toolName, args, pillClass, pillText, resultSummary)
//
// The half of the head that does not depend on the tool: the one-line argument
// summary, the collapsed result summary and the status dot, plus the tap
// handler. Split out so the subagent branch above can prepend the agent chip
// without duplicating (and drifting from) this markup.
function finishToolCardHead(head, toolName, args, pillClass, pillText, resultSummary) {
  // `args` may be either a raw arg object or an already-formatted
  // string (when the caller has the display text already). Pass it
  // through formatToolArgs either way: passing a string returns
  // that string unchanged.
  const argText = args == null ? '' : (typeof args === 'string' ? args : formatToolArgs(args, toolName));
  const pill = document.createElement('span');
  pill.className = 'tool-card__pill ' + pillClass;
  pill.textContent = pillText;
  if (argText) {
    const argsEl = document.createElement('pre');
    argsEl.className = 'tool-card__args';
    argsEl.textContent = shortToolText(argText, TOOL_ARGS_PREVIEW_CHARS);
    if (argsEl.textContent !== argText) argsEl.title = argText;
    head.appendChild(argsEl);
  }
  // Collapsed result-summary: shown only when the card is a finished
  // result and a short summary string is available (exit code + duration,
  // byte count, etc.). Visible without tapping.
  if (resultSummary) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'tool-card__result-summary';
    summaryEl.textContent = resultSummary;
    head.appendChild(summaryEl);
  }
  head.appendChild(pill);
  head.addEventListener('click', () => {
    const card = head.closest('.tool-card');
    if (!card) return;
    card.classList.toggle('is-expanded');
    // Remember that the user drove the state: a collapsed shell card
    // the user closed stays collapsed when the successful result
    // lands (see appendToolResultCard).
    card._userCollapsed = !card.classList.contains('is-expanded');
    // Result bodies build lazily on first expand (see
    // appendToolResultCard). Triggering the build here — inside the
    // toggle handler that always runs on tap — is robust regardless of
    // listener registration order or head replacement, which a
    // separate click listener was not: in several paths (rebuilt head,
    // restored cards) it never fired and the expanded card showed empty.
    if (card.classList.contains('is-expanded') && typeof card._lazyBody === 'function') {
      card._lazyBody();
    }
  });
  return head;
}

// Anonymous tool-call registry.
//
// Not every provider echoes a tool-call id, and a few internal call sites
// deliberately pass `id: null` (a subagent that failed to start, an MCP
// or tool error result). Call and result sides used to mint an INDEPENDENT
// random id in that case, so the result could never find its call card:
// it appended a second card and the call card stayed stuck on
// "Waiting for results…" forever. Remember the id minted for the call so
// the matching result can adopt it, preferring a name match when several
// unidentified calls are in flight.
function registerAnonToolCall(refs, id, name, card) {
if (!Array.isArray(refs._anonToolCalls)) refs._anonToolCalls = [];
refs._anonToolCalls.push({ id, name, card });
}
function takeAnonToolCallId(refs, name) {
const list = Array.isArray(refs._anonToolCalls) ? refs._anonToolCalls : [];
// Drop entries whose card is no longer in the tree (a rebuild wiped it)
// so a stale id can never be handed to an unrelated result.
const live = list.filter((entry) => entry && entry.card && entry.card.isConnected);
refs._anonToolCalls = live;
const wanted = normalizeToolName(name);
let index = live.findIndex((entry) => entry.name === wanted);
if (index === -1) index = 0;
const entry = live[index];
if (!entry) return null;
live.splice(index, 1);
return entry.id;
}
// appendToolCallCard(toolCall, refs)
//
// Render a tool_call event as a compact card above the live message
// (or appended if there is no live row). Subagent calls get a live
// body up front so the user can expand the card while the subagent
// is still running and watch nested tool activity stream in. Shell
// calls get an empty live body that fills as stdout/stderr chunks
// arrive (see handleShellOutputEvent).
//
// When `isReplay` is true (called from persisted-data rebuild with no
// live SSE stream), shell call cards show "Waiting for results…" instead
// of "Running…" and stay collapsed. There is no `shell_output` stream to
// fill them, so an auto-expanded empty body is confusing.
export function appendToolCallCard(toolCall, refs, isReplay) {
  if (!refs.transcript.current) return;
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (empty) empty.remove();
  const id = toolCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
  // A call card supersedes the ask_user / authorization overlay card that
  // was mounted for the same call. The overlay card only removes itself
  // when the user answers it IN THIS TAB — answering from the OS
  // notification, or from another tab, leaves this one standing. The
  // tool_call frame then arrived as a second card with the same tool id,
  // so one question was on screen twice and the tool_result was folded
  // into the first match (the overlay card) while the call card sat on
  // "running" forever.
  if (toolCall.id) {
    for (const stale of refs.transcript.current.querySelectorAll(OVERLAY_CARD_SELECTOR)) {
      if (stale.dataset.authCallId === String(toolCall.id)) stale.remove();
    }
  }
  const card = document.createElement('div');
  card.className = 'tool-card tool-card--call';
  card.dataset.toolId = id;
  card.dataset.toolName = normalizeToolName(toolCall.name);
  // Keep the call's arguments on the card. The matching `tool_result`
  // frame carries only the result, so a preview that renders the model's
  // own payload — write_file's content — reads it from here when the
  // card is expanded.
  card._toolArgs = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : null;
  card.appendChild(buildToolCardHead(toolCall.name, toolCall.args, 'tool-card__pill--busy', 'running', null, toolCall.args));
  if (isSubagentTool(toolCall.name)) {
    card.classList.add('tool-card--subagent');
    // Auto-expand so the streamed nested activity is visible live
    // instead of updating inside a closed card.
    card.classList.add('is-expanded');
    const body = document.createElement('div');
    body.className = 'tool-card__body';
    const live = document.createElement('div');
    live.className = 'tool-card__subagent-live';
    const hint = document.createElement('div');
    hint.className = 'tool-card__subagent-live-hint';
    hint.innerHTML = '<span class="tool-card__spinner" aria-hidden="true"></span>Subagent is working…';
    live.appendChild(hint);
    body.appendChild(live);
    card.appendChild(body);
  } else if (normalizeToolName(toolCall.name) === 'shell') {
    const body = document.createElement('div');
    body.className = 'tool-card__body';
    const live = document.createElement('div');
    live.className = 'tool-card__shell-live';
    const hint = document.createElement('div');
    hint.className = 'tool-card__shell-live-hint';
    hint.textContent = isReplay ? 'Waiting for results…' : 'Running…';
    const pre = document.createElement('pre');
    pre.className = 'tool-card__shell-live-pre';
    live.appendChild(hint);
    live.appendChild(pre);
    body.appendChild(live);
    card.appendChild(body);
    // Only auto-expand when the card was created by a live stream
    // (shell_output chunks need the body visible). From replayed
    // persisted data the result soon replaces the card anyway.
    if (!isReplay) card.classList.add('is-expanded');
}
// Other tools have no expandable body until a tool_result arrives.
// Their header already shows the call arguments; creating a body here
// would expose placeholder text instead of actual tool output.
  transcriptInsert(refs, card);
  afterTranscriptAppend(refs, true);
  // Park the minted id when the provider gave us none, so the matching
  // result can adopt it instead of appending a duplicate card.
  if (!toolCall.id) registerAnonToolCall(refs, id, normalizeToolName(toolCall.name), card);
  // Return the card so a caller that learns the real call id LATER (the
  // direct @agent dispatch, whose id only exists once the server answers)
  // can key it to that id instead of stranding a second card beside it.
  return card;
  }


// handleShellOutputEvent(data, refs)
//
// Fold a live `shell_output` SSE chunk into the matching shell tool
// card's live preview. The full result still arrives as tool_result
// and replaces the live view; this only fills the wait.
export function handleShellOutputEvent(data, refs) {
  if (!refs.transcript.current || !data) return false;
  const card = data.id
    ? refs.transcript.current.querySelector('[data-tool-id="' + cssEscape(String(data.id)) + '"]')
    : null;
  if (!card) return false;
  const pre = card.querySelector('.tool-card__shell-live-pre');
  if (!pre) return false;
  // Auto-expand the live preview the first time a real delta arrives —
  // but never override an explicit user collapse. The user's collapse
  // (head tap sets card._userCollapsed) is intent and must win over the
  // live-output auto-open, otherwise an output chunk arriving after a
  // deliberate collapse visibly pops the card back open. A card rebuilt
  // from persisted data mid-run (syncFromRevision / reconnect poll) has
  // _userCollapsed undefined, so it still opens on the first delta.
  if (!card.classList.contains('is-expanded') && !card._userCollapsed) {
    card.classList.add('is-expanded');
  }
  const hint = card.querySelector('.tool-card__shell-live-hint');
  if (hint && hint.textContent !== 'Running…') hint.textContent = 'Running…';
  if (data.stream === 'stderr') {
    pre.dataset.hasStderr = '1';
    const marker = '\n── stderr ──\n';
    if (!pre.textContent.includes(marker)) pre.textContent += marker;
    pre.textContent += String(data.delta || '');
  } else {
    pre.textContent += String(data.delta || '');
  }
  scrollToolBodyToBottom(pre);
  afterTranscriptAppend(refs, false);
  return true;
}

// findSubagentCard(refs, parentCallId)
//
// Locate the parent subagent card for a nested stream event. Falls
// back to the most recent subagent card when the id is missing
// (some providers don't echo tool call ids).
function findSubagentCard(refs, parentCallId) {
  if (!refs.transcript.current) return null;
  if (parentCallId) {
    const byId = refs.transcript.current.querySelector('[data-tool-id="' + cssEscape(parentCallId) + '"]');
    if (byId) return byId;
  }
  const cards = refs.transcript.current.querySelectorAll('.tool-card--subagent');
  return cards.length ? cards[cards.length - 1] : null;
}

// ensureSubagentLive(card)
function ensureSubagentLive(card) {
  if (!card) return null;
  let body = card.querySelector('.tool-card__body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'tool-card__body';
    card.appendChild(body);
  }
  let live = card.querySelector('.tool-card__subagent-live');
  if (!live) {
    live = document.createElement('div');
    live.className = 'tool-card__subagent-live';
    body.appendChild(live);
  }
  return live;
}

// handleSubagentStreamEvent(ev, data, refs)
//
// Fold a nested subagent stream event into the parent subagent
// card's live container. Returns true when the event was consumed
// and should not hit the normal handlers.
export function handleSubagentStreamEvent(ev, data, refs) {
  if (!refs.transcript.current) return false;
  const card = findSubagentCard(refs, data && data.parentCallId);
  if (!card) return false;
  const live = ensureSubagentLive(card);
  if (!live) return false;
  if (ev.eventName === 'message' && typeof data.delta === 'string') {
    live._text = (live._text || '') + data.delta;
    // Stream the nested answer into a real assistant chat bubble, the same
    // row the top-level transcript streams into. The card head already says
    // the run is a subagent and no model id is known until the result lands,
    // so this row has no head.
    let row = live.querySelector('.tool-card__subagent-live-msg');
    if (!row) {
      row = document.createElement('div');
      row.className = 'chat-msg chat-msg--assistant tool-card__subagent-msg tool-card__subagent-live-msg';
      const rowBody = document.createElement('div');
      rowBody.className = 'chat-msg__body';
      row.appendChild(rowBody);
      live.appendChild(row);
    }
    renderAssistantBody(row.querySelector('.chat-msg__body'), live._text, '', false);
    scrollToolBodyToBottom(live);
    afterTranscriptAppend(refs, false);
    return true;
  }
  if (ev.eventName === 'shell_output' && data && data.id) {
    // Nested shell output: append to the matching nested tool row's
    // live preview so the user can watch a subagent's command run.
    const row = live.querySelector('[data-nested-tool-id="' + cssEscape(String(data.id)) + '"]');
    if (row) {
      let pre = row.querySelector('.tool-card__shell-live-pre');
      if (!pre) {
        pre = document.createElement('pre');
        pre.className = 'tool-card__shell-live-pre';
        row.appendChild(pre);
      }
      if (data.stream === 'stderr') {
        const marker = '\n── stderr ──\n';
        if (!pre.textContent.includes(marker)) pre.textContent += marker;
        pre.textContent += String(data.delta || '');
      } else {
        pre.textContent += String(data.delta || '');
      }
      scrollToolBodyToBottom(pre);
      afterTranscriptAppend(refs, false);
    }
    return true;
  }
  if (ev.eventName === 'tool_call') {
    const hint = live.querySelector('.tool-card__subagent-live-hint');
    if (hint) hint.remove();
    // Same row builder the settled render uses, so the live view and the
    // final view of one call cannot differ in label, args or status dot.
    const row = buildSubagentToolRow(data.name, data.id, formatToolArgs(data.args, data.name), data.args);
    live.appendChild(row);
    scrollToolBodyToBottom(live);
    afterTranscriptAppend(refs, false);
    return true;
  }
  if (ev.eventName === 'tool_result') {
    let row = data.id ? live.querySelector('[data-nested-tool-id="' + cssEscape(String(data.id)) + '"]') : null;
    if (!row) row = live.querySelector('.tool-card__subagent-tool:last-child');
    // The live result frame carries the authoritative ok flag; the settled
    // transcript only has the result body, so the flag is a hint here.
    fillSubagentToolRow(row, data.name, data.result, row && row._toolArgs, data.ok);
    scrollToolBodyToBottom(live);
    afterTranscriptAppend(refs, false);
    return true;
  }
  return false;
}

// appendToolResultCard(toolResult, refs)
//
// Render a tool_result event. If a matching tool_call card is on
// screen, update it; otherwise append a fresh card so the user can
// see the result regardless of order. Tap the header row to expand.
// Unlike the call card, a result has no "still waiting" state to
// render, so it takes no replay flag.
export function appendToolResultCard(toolResult, refs) {
  if (!refs.transcript.current) return;
  // Adopt the id of an unidentified call card when this result has none of
  // its own. Without this the two sides disagree on the key and the call
  // card is left stranded on "Waiting for results…" next to a duplicate
  // result card.
  const id = toolResult.id || takeAnonToolCallId(refs, toolResult.name);
  let card = id ? refs.transcript.current.querySelector('[data-tool-id="' + cssEscape(String(id)) + '"]') : null;
  const isSubagent = isSubagentTool(toolResult && toolResult.name);
  const pillClass = toolResult.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err';
  const pillText = toolResult.ok ? 'ok' : 'error';
const rawR = coerceToolResult(toolResult && toolResult.result, normalizeToolName(toolResult && toolResult.name));
const summary = (toolResult.ok || isExpectedToolFailure(toolResult && toolResult.name, rawR, toolResult.ok))
  ? formatResultSummary(toolResult && toolResult.name, rawR)
  : null;
// Publish a successful capture immediately. Tool result bodies are lazy and
// usually stay collapsed, so relying on renderToolResultBody would delay the
// dock until the user expanded a transcript card.
if (toolResult.ok && normalizeToolName(toolResult.name) === 'webpreview' && rawR && rawR.thumbnail) {
publishWebPreview(rawR);
}
// A `tool_result` frame carries only the result, so recover the call
// arguments a preview may need — the `write_file` card renders the
// content the model wrote. Preference order: args on the result event
// (direct invocations), then the args stashed by the call card this
// result is updating (the live-stream order).
const callArgs = (toolResult && toolResult.args && typeof toolResult.args === 'object')
  ? toolResult.args
  : (card && card._toolArgs) || null;
if (callArgs && card) card._toolArgs = callArgs;
if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card tool-card--result';
    card.dataset.toolId = id || ('call_' + Math.random().toString(36).slice(2, 10));
    card.dataset.toolName = normalizeToolName(toolResult.name);
    // Keep the recovered call args on the card (same contract as the call
    // card), so any later re-render of this body still has them.
    card._toolArgs = callArgs;
    // Show the command/args in the collapsed header for shell
    // (and any tool that carries args on the result event).
    const name = normalizeToolName(toolResult.name);
    const headArgs = (isSubagent || name === 'shell' || (callArgs && callArgs.cmd))
      ? formatToolArgs(callArgs, toolResult.name)
      : null;
    card.appendChild(buildToolCardHead(toolResult.name, headArgs, pillClass, pillText, summary, callArgs));
    const body = document.createElement('div');
    body.className = 'tool-card__body';
    card.appendChild(body);
    transcriptInsert(refs, card);
  } else {
    // The call card becomes a result card. Preserve the command text
    // from the old call card header so the collapsed view still shows
    // the cmd (especially for shell results). Subagent cards keep the
    // delegated task from the result payload.
    card.classList.add('tool-card--result');
    card.classList.remove('tool-card--call');
    card.dataset.toolName = normalizeToolName(toolResult.name);
    const oldArgs = card.querySelector('.tool-card__args');
    const headArgs = isSubagent
      ? formatToolArgs(toolResult.args, toolResult.name)
      : (oldArgs ? oldArgs.textContent : null);
    rebuildToolCardHead(card, toolResult.name, headArgs, pillClass, pillText, summary, callArgs);
    let body = card.querySelector('.tool-card__body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'tool-card__body';
      card.appendChild(body);
    }
    // A shell card that streamed a live preview while running keeps
    // its expanded state if the user opened it; successful results
    // stay as they are, errors auto-expand below.
  }
  if (isSubagent) card.classList.add('tool-card--subagent');
  const body = card.querySelector('.tool-card__body');
  if (body) {
    // Defer the full result-body build until the card is first
    // expanded. The collapsed header (verb + args + status + summary)
    // is all the user sees by default; building the structured preview
    // (coerceToolResult + per-tool renderers + diff rows) for every
    // result is the dominant per-row DOM cost on tool-heavy chats. The
    // result payload is stashed on the card and rendered once, on the
    // first expand, then the listener is removed.
    const lazyBody = () => {
      if (card._resultBodyBuilt) return;
      card._resultBodyBuilt = true;
      renderToolResultBody(body, callArgs ? Object.assign({}, toolResult, { args: callArgs }) : toolResult, isSubagentTool);
      if (isSubagent) renderSubagentChat(card, toolResult);
      afterTranscriptAppend(refs, false);
    };
    card._lazyBody = lazyBody;
    // A subagent card's whole point is the delegated conversation it holds.
    // Leaving its body lazy meant a finished run rendered as a bare
    // "Subagent · task · ok" header with nothing under it until the user
    // guessed that the row is tappable — the transcript looked like the run
    // had produced nothing. Delegate cards keep the body VISIBLE (a
    // delegation is a rare, deliberate action, not the tool-heavy chatter the
    // lazy path was added for), still built on first paint rather than
    // deferred.
    if (isSubagent || card.classList.contains('is-expanded') || !toolResult.ok) {
    // Errors auto-expand — build immediately so the failure is visible.
    lazyBody();
    } else {
      // Build on the first head tap. The head's own toggle handler
      // (buildToolCardHead) calls card._lazyBody() when it opens the
      // card, so no separate listener is needed here. A separate
      // listener was fragile: rebuildToolCardHead replaces the head on
      // every result — dropping any listener armed on the old head —
      // and the ordering vs. the toggle handler was easy to get wrong.
      body.dataset.lazyResult = '1';
    }
  }
// Expand errors automatically so the user sees what went wrong.
// Successful results stay collapsed; webpreview publishes its image to the
// dedicated dock above the composer rather than expanding in the transcript.
// A subagent card is the exception: its built body IS the delegated
// transcript, so it stays expanded (never over a deliberate collapse) instead
// of showing a header with an invisible conversation under it.
if (!toolResult.ok) {
card.classList.add('is-expanded');
} else if (isSubagent) {
if (!card._userCollapsed) card.classList.add('is-expanded');
} else if (!card._userCollapsed) card.classList.remove('is-expanded');
  afterTranscriptAppend(refs, true);
}

// rebuildToolCardHead(card, toolName, args, pillClass, pillText, resultSummary, toolArgs)
function rebuildToolCardHead(card, toolName, args, pillClass, pillText, resultSummary, toolArgs) {
  const oldHead = card.querySelector(':scope > .tool-card__head');
  const fresh = buildToolCardHead(toolName, args, pillClass, pillText, resultSummary, toolArgs);
  if (oldHead && oldHead.parentNode === card) {
    card.replaceChild(fresh, oldHead);
  } else {
    card.insertBefore(fresh, card.firstChild);
  }
}

// appendSubagentNestedToolCall(parent, tc)
//
// Render one nested tool CALL as a row. Returns the row so the caller can
// remember it by call id and merge the matching tool result into it
// instead of appending a second row for the same call.
function appendSubagentNestedToolCall(parent, tc) {
  const fn = (tc && tc.function) || tc || {};
  const rawArgs = fn.arguments != null ? fn.arguments : (tc && tc.args);
  let parsedArgs = rawArgs;
  if (typeof rawArgs === 'string') { try { parsedArgs = JSON.parse(rawArgs); } catch { /* keep raw string */ } }
  const callArgsText = typeof parsedArgs === 'object' && parsedArgs !== null
    ? formatToolArgs(parsedArgs, fn.name)
    : String(rawArgs || '');
  // Same builder as the live path: the row carries the main card's name
  // and args classes, so the settled view of a call reads exactly like the
  // streamed one.
  const call = buildSubagentToolRow(fn.name, tc && tc.id, callArgsText,
    (parsedArgs && typeof parsedArgs === 'object') ? parsedArgs : null);
  parent.appendChild(call);
  return call;
}

// appendSubagentToolResult(parent, m, args[, row])
//
// Settle a nested tool RESULT. When the caller already has the row its
// matching call created (`row`), the result fills that row in place —
// the same one-row-per-call shape the live stream builds. Without a match
// (a result whose call is not in the transcript) a fresh row is appended
// so nothing is dropped.
function appendSubagentToolResult(parent, m, args, row) {
  if (row) {
    row._settled = true;
    fillSubagentToolRow(row, m.name, m.content, args);
    return row;
  }
  const call = buildSubagentToolRow(m.name, m.tool_call_id, null, args);
  call._settled = true;
  parent.appendChild(call);
  fillSubagentToolRow(call, m.name, m.content, args);
  return call;
}

// renderSubagentToolPreview(parent, name, raw, args)
//
// Use the per-tool preview renderer for the nested tool result. `args`
// is the matching nested call's argument object when the caller has it
// (write_file's preview renders the written content from it).
function renderSubagentToolPreview(parent, name, raw, args) {
  const toolName = normalizeToolName(name);
  const r = coerceToolResult(raw, toolName);
  const preview = document.createElement('div');
  preview.className = 'tool-card__subagent-preview';
  parent.appendChild(preview);
  if (toolName === 'shell') return renderShellInPreview(preview, r, args);
  if (toolName === 'read_file') return renderReadFileInPreview(preview, r);
  if (toolName === 'list_files') return renderListFilesInPreview(preview, r);
  if (toolName === 'search_files') return renderSearchFilesInPreview(preview, r);
  if (toolName === 'edit_file') return renderEditFileInPreview(preview, r);
  if (toolName === 'write_file') return renderWriteFileInPreview(preview, r, args);
  if (r && Array.isArray(r.content)) {
    const lines = [];
    for (const c of r.content) {
      if (c && typeof c.text === 'string') lines.push(c.text);
      else lines.push(String(c && (c.text || c.type) || c));
    }
    return renderPreviewInPreview(preview, lines.join('\n'), 'tool-preview__pre');
  }
  return renderPreviewInPreview(preview, formatReadableToolResult(r), 'tool-preview__pre');
}

// Per-tool preview helpers used by renderSubagentToolPreview. They
// can't import from toolRender.js directly because that module
// exports renderToolResultBody, which assumes it owns the body
// element. Here we want to fill an already-created host.
function renderShellInPreview(host, r, args) { return renderShellInto(host, r, args); }
function renderReadFileInPreview(host, r) { return renderReadFileInto(host, r); }
function renderListFilesInPreview(host, r) { return renderListFilesInto(host, r); }
function renderSearchFilesInPreview(host, r) { return renderSearchFilesInto(host, r); }
function renderEditFileInPreview(host, r) { return renderEditFileInto(host, r); }
function renderWriteFileInPreview(host, r, args) { return renderWriteFileInto(host, r, args); }
function renderPreviewInPreview(host, text, cls) {
  const pre = document.createElement('pre');
  pre.className = cls || 'tool-preview__pre';
  pre.textContent = text || '';
  host.appendChild(pre);
  return pre;
}

function renderShellInto(host, r, args) { renderShellToolResult(host, r, args); }
function renderReadFileInto(host, r) { renderReadFileToolResult(host, r); }
function renderListFilesInto(host, r) { renderListFilesToolResult(host, r); }
function renderSearchFilesInto(host, r) { renderSearchFilesToolResult(host, r); }
function renderEditFileInto(host, r) { renderEditFileToolResult(host, r); }
function renderWriteFileInto(host, r, args) { renderWriteFileToolResult(host, r, args); }

// renderSubagentChat(card, toolResult)
//
// Final render of a subagent's nested conversation as polished chat
// bubbles inside the parent subagent card. Replaces the streamed
// live container so the user sees a single coherent view.
export function renderSubagentChat(card, toolResult) {
  if (!card) return;
  // Drop any prior chat render so re-runs don't stack copies.
  const old = card.querySelector('.tool-card__subagent-chat');
  if (old) old.remove();
  const r = coerceToolResult(toolResult && toolResult.result, normalizeToolName(toolResult && toolResult.name));
  const chat = r && Array.isArray(r.chat) ? r.chat : null;
  if ((!chat || !chat.length) && !(r && typeof r.text === 'string' && r.text)) return;
  const wrap = document.createElement('div');
  wrap.className = 'tool-card__subagent-chat';
  // Don't let taps inside the nested chat bubble up to the parent
  // card's expand/collapse toggle.
  wrap.addEventListener('click', (e) => e.stopPropagation());
  const turns = chat && chat.length ? chat : [{ role: 'assistant', content: r.text }];
  // One row per tool CALL, keyed by call id. The persisted nested chat
  // splits a call and its result into two messages (an assistant turn with
  // `tool_calls`, then a `role: 'tool'` turn); the live stream shows them
  // as a single row whose status dot flips. Pairing them here reproduces
  // the live shape instead of doubling every row on settle.
  const rowsByCallId = new Map();
  // Rows whose result has not landed yet, in creation order. A provider may
  // omit tool-call ids entirely; the live path then settles the run's last
  // row, and this list keeps the settled render just as deterministic
  // instead of appending an unpaired row beside the call.
  const pendingCallRows = [];
  const appendCallRows = (parent, toolCalls) => {
    for (const tc of toolCalls) {
      const callRow = appendSubagentNestedToolCall(parent, tc);
      const id = tc && (tc.id || (tc.function && tc.function.id));
      if (callRow && id) rowsByCallId.set(id, callRow);
      if (callRow) pendingCallRows.push(callRow);
    }
  };
  const takePendingCallRow = () => pendingCallRows.find((r) => !r._settled) || null;
  // The model that actually ran the delegated call, when the result
  // carries it. Nested assistant turns are labelled with it, the same way
  // the top-level transcript labels an assistant turn with its model id.
  const nestedModelId = r && r.model && r.model.id ? r.model.id : '';
  // Nested tool results reference their call by id while the arguments
  // live on the assistant turn's `tool_calls`. Index them so a nested
  // write_file preview can render the written content, the same as the
  // top-level card.
  const argsByCallId = new Map();
  for (const m of turns) {
    const tcs = m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of tcs) {
      const id = tc && (tc.id || (tc.function && tc.function.id));
      const raw = tc && tc.function ? tc.function.arguments : (tc && tc.args);
      if (!id || raw == null) continue;
      let parsed = raw;
      if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { /* not JSON */ } }
      if (parsed && typeof parsed === 'object') argsByCallId.set(id, parsed);
    }
  }
  for (const m of turns) {
    const role = m && m.role;
    if (role === 'tool') {
      // Tool turns are not chat bubbles — render them as compact
      // tool rows so the nested transcript shows the full loop
      // (assistant call → tool result) without breaking the
      // bubble rhythm for the user/assistant turns around them.
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length) {
        appendCallRows(wrap, toolCalls);
      } else {
      appendSubagentToolResult(wrap, m, argsByCallId.get(m.tool_call_id) || null,
      rowsByCallId.get(m.tool_call_id) || takePendingCallRow());
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = textOfContent(m.content);
    // A nested system turn is the subagent's own prompt — the generic
    // focused-subagent instruction or the delegated agent's instructions.
    // Render it as the same collapsed system card the top-level transcript
    // uses instead of dumping its content parts as JSON. A delegated run
    // carries its agent name on the tool call, so the row's role label names
    // WHICH agent answered instead of the generic `system`.
    if (role === 'system') {
    const sysRow = buildSystemPromptRow(text, 'tool-card__subagent-msg', agentLabel(r && r.agent));
      const sysCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      appendCallRows(sysRow, sysCalls);
      wrap.appendChild(sysRow);
      continue;
    }
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    // An assistant turn that only asked for tools carries no text of its
    // own (the rebuilt nested chat stores `content: null` for it) — the same
    // empty assistant turn the top-level transcript skips. Rendering it
    // produced an empty bubble wrapped around the tool rows, a shape the
    // live view never shows.
    if (role === 'assistant' && !text && toolCalls.length) {
      appendCallRows(wrap, toolCalls);
      continue;
    }
    if (role === 'assistant' && !text) continue;
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--' + role + ' tool-card__subagent-msg';
    // Same head as appendMessageToTranscript — role label left, timestamp
    // right. A nested turn carries no timestamp, so that element stays
    // hidden rather than omitted, keeping both transcripts identical in
    // shape. The assistant label is the model that ran the delegated call:
    // nested turns have no modelId of their own.
    const head = document.createElement('div');
    head.className = 'chat-msg__head';
    const roleEl = document.createElement('div');
    roleEl.className = 'chat-msg__role';
    roleEl.textContent = role === 'assistant' ? (nestedModelId || 'assistant') : role;
    const ts = document.createElement('span');
    ts.className = 'chat-msg__ts';
    ts.hidden = true;
    head.appendChild(roleEl);
    head.appendChild(ts);
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    if (role === 'assistant') {
      renderAssistantBody(body, text || '', '', true);
    } else {
      body.textContent = text || '';
    }
    row.appendChild(head); row.appendChild(body);
    wrap.appendChild(row);
    // Tool rows are appended flat, at the same level as the bubbles — the
    // level the live container uses — so a call reads in the same place
    // while streaming and after the run settles.
    appendCallRows(wrap, toolCalls);
  }
  // Append inside the card's body so the body's max-height,
  // overflow, and expand/collapse mask control the nested chat.
  const body = card.querySelector('.tool-card__body');
  if (body) body.appendChild(wrap);
  else card.appendChild(wrap);
}

// getOrCreateProgressCard(refs, callId, title)
//
// Find an existing progress card by callId, or create + append a new
// one. Returns the card element.
function getOrCreateProgressCard(refs, callId, title) {
  if (!refs.transcript.current) return null;
  const existing = refs.transcript.current.querySelector('[data-progress-id="' + cssEscape(callId || '') + '"]');
  if (existing) return existing;

  const card = document.createElement('div');
  card.className = 'tool-card tool-card--progress';
  if (callId) card.dataset.progressId = callId;

  const head = document.createElement('div');
  head.className = 'tool-card__head';
  const chev = document.createElement('span');
  chev.className = 'tool-card__chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 5.5 15.5 12 9 18.5l1.4 1.4L18.3 12l-7.9-7.9L9 5.5Z"/></svg>';
  const name = document.createElement('span');
  name.className = 'tool-card__name';
  name.textContent = title || 'Progress';
  const pill = document.createElement('span');
  pill.className = 'tool-card__pill tool-card__pill--busy';
  pill.textContent = 'running';
  head.appendChild(chev);
  head.appendChild(name);
  head.appendChild(pill);
  card.appendChild(head);
  // Toggle expand/collapse on head tap.
  head.addEventListener('click', () => {
    card.classList.toggle('is-expanded');
  });

  const body = document.createElement('div');
  body.className = 'tool-card__body';

  const row = document.createElement('div');
  row.className = 'tool-card__progress-row';

  const barWrap = document.createElement('div');
  barWrap.className = 'tool-card__progress-bar-wrap';
  const bar = document.createElement('div');
  bar.className = 'tool-card__progress-bar';
  barWrap.appendChild(bar);
  row.appendChild(barWrap);

  const pct = document.createElement('span');
  pct.className = 'tool-card__progress-pct';
  pct.textContent = '0%';
  row.appendChild(pct);

  body.appendChild(row);

  const msg = document.createElement('div');
  msg.className = 'tool-card__progress-msg';
  body.appendChild(msg);

  card.appendChild(body);
  refs.transcript.current.appendChild(card);
  afterTranscriptAppend(refs, true);
  return card;
}

// updateProgressCard(refs, data)
//
// Update an existing progress card with new values (current, total,
// status, message). Creates one if no card matches `callId`.
export function updateProgressCard(refs, data) {
  if (!refs.transcript.current || !data) return;
  const card = getOrCreateProgressCard(refs, data.callId, data.title);
  if (!card) return;

  const current = Math.max(0, Math.min(Number(data.current) || 0, Number(data.total) || 100));
  const total = Math.max(1, Number(data.total) || 100);
  const fraction = Math.min(1, current / total);
  const percent = Math.round(fraction * 100);

  const bar = card.querySelector('.tool-card__progress-bar');
  if (bar) bar.style.width = percent + '%';

  const pct = card.querySelector('.tool-card__progress-pct');
  if (pct) pct.textContent = percent + '%';

  const msgEl = card.querySelector('.tool-card__progress-msg');
  if (msgEl) msgEl.textContent = data.message || '';

  const pill = card.querySelector('.tool-card__pill');
  if (pill) {
    if (data.status === 'completed') {
      pill.className = 'tool-card__pill tool-card__pill--ok';
      pill.textContent = 'completed';
      // Auto-expand on completion so the user sees the result.
      card.classList.add('is-expanded');
    } else if (data.status === 'failed') {
      pill.className = 'tool-card__pill tool-card__pill--err';
      pill.textContent = 'failed';
      card.classList.add('is-expanded');
    } else {
      pill.className = 'tool-card__pill tool-card__pill--busy';
      pill.textContent = 'running';
    }
  }

  afterTranscriptAppend(refs, false);
}

// renderTranscript(state, refs)
//
// Build / rebuild the entire transcript from state.messages. On a
// brand-new chat the first child is the setup card, then the
// system-prompt message, then the tools card, then the empty
// state. For chats with messages, render every message in order
// (tool call/result cards and chat bubbles), then pin to the
// bottom.
//
// The setup card is built imperatively here so the change handler
// can call back into the meta module. The system prompt and tools
// card are delegated to their own helpers.
// snapshotExpandedState(el)
//
// Record which interactive elements in the transcript are currently
// expanded before a full rebuild, so renderTranscript can restore
// them afterwards. Covers tool cards (keyed by data-tool-id) and
// progress cards (keyed by data-progress-id), plus any <details>
// disclosure the user has opened. Without this, a rebuild collapses
// every card the user expanded whenever a new element is added to
// the transcript (e.g. the reconcile pass after a tool completes).
function snapshotExpandedState(root) {
  const state = { toolIds: new Set(), collapsedToolIds: new Set(), builtToolIds: new Set(), progressIds: new Set(), details: [] };
  if (!root) return state;
  for (const card of root.querySelectorAll('.tool-card')) {
    if (!(card.dataset && card.dataset.toolId)) continue;
    if (card.classList.contains('is-expanded')) state.toolIds.add(card.dataset.toolId);
    // Cards the user explicitly collapsed carry _userCollapsed; preserve
    // that intent across the rebuild so a finished shell card the user
    // opened doesn't fold away again on the next reconcile tick.
    else if (card._userCollapsed) state.collapsedToolIds.add(card.dataset.toolId);
    // Result bodies build lazily on first expand; remember which cards
    // already built theirs so the rebuild can build them up front
    // instead of showing an empty body on the next expand.
    if (card._resultBodyBuilt) state.builtToolIds.add(card.dataset.toolId);
  }
  for (const card of root.querySelectorAll('.tool-card--progress.is-expanded')) {
    if (card.dataset && card.dataset.progressId) state.progressIds.add(card.dataset.progressId);
  }
  root.querySelectorAll('details[open]').forEach((d) => state.details.push(d.className || ''));
  return state;
}

// restoreExpandedState(state, root)
//
// Re-apply the expanded state captured by snapshotExpandedState to a
// freshly rebuilt transcript.
//
// Chunked transcript rendering.
//
// A long agentic transcript can be hundreds of messages, and
// renderTranscript builds every bubble + tool card + a full markdown
// parse per assistant message. Built synchronously that's one long,
// blocking pass that keeps the chat blank and the UI frozen for the
// duration. For long transcripts we now render progressively: the
// head (system prompt, tools card, first screen of messages) paints
// immediately, then the remaining rows are appended a few at a time
// on animation frames so the browser can paint and stay responsive
// while the transcript fills in. The transcript is already fetched
// in one request — this is purely a rendering concern.
//
//   - renderTranscriptChunked(state, refs): kick off a chunked pass.
//     Cancels any in-flight chunked pass first (so a rebuild triggered
//     by a stream reconcile never double-renders the same transcript),
//     and bumps the module-level renderToken so a superseded pass
//     silently stops appending.
//   - renderTranscriptChunk(state, refs, token): one animation-frame
//     step. Appends up to TRANSCRIPT_CHUNK_ROWS messages, then either
//     schedules another frame or finalizes (scroll + usage summary).
//
// While a chunked pass is active the per-append scroll pinning in
// afterTranscriptAppend is suppressed (see the guard there), because
// each chunk's scrollTop = scrollHeight would otherwise yank the
// scrollbar down dozens of times while the transcript is still
// growing. The finalize step re-pins once at the end.

const TRANSCRIPT_CHUNK_ROWS = 40;   // rows appended per animation frame
const TRANSCRIPT_CHUNK_THRESHOLD = 120; // render progressively above this many rows
let _renderToken = 0;

function resetTranscriptRender(refs) {
  _renderToken++;
  if (refs._pendingTranscriptChunk) {
    cancelAnimationFrame(refs._pendingTranscriptChunk);
    refs._pendingTranscriptChunk = null;
  }
  // A cancelled or superseded pass must not leave the scroll-pin
  // suppress flag stuck on, or later live appends would stop pinning.
  refs._suspendScrollPin = false;
  // Nor a stale backfill anchor, or the next live append would insert
  // mid-transcript instead of at the bottom.
  refs._insertAnchor = null;
}

// whenTranscriptSettled(refs) -> Promise
//
// Resolve once any in-flight chunked transcript render has finished.
// Authorization and ask_user cards append outside the message flow —
// if they land while a chunked pass is still filling in, later chunks
// are appended after the card and it ends up stranded mid-transcript
// (or is wiped by a rebuild). Callers that append overlay cards await
// this first so the card always lands at the bottom.
export function whenTranscriptSettled(refs) {
  return new Promise((resolve) => {
    function check() {
      if (!refs._pendingTranscriptChunk) return resolve();
      requestAnimationFrame(check);
    }
    check();
  });
}

// cancelTranscriptRender(refs)
//
// Abort any in-flight chunked transcript render. Called by a rebuild
// (renderTranscript) so a freshly started pass never races a stale
// one, and by the owning view's cleanup so a navigate-away can't leak
// a scheduled frame that writes into a detached transcript.
export function cancelTranscriptRender(refs) {
  resetTranscriptRender(refs);
}

// toolCallArgsFor(state, resultRow) -> object | null
//
// Persisted transcripts keep a tool call's arguments on the `call` row
// and only the result on the `result` row. The tail-first render can
// build a card from a result row whose call row is still up in the
// backfill (the card then wins the tool-id de-dup and the call row is
// skipped), so a write_file preview recovers the arguments from the
// transcript itself. Only called for tools whose preview renders the
// model's payload — it is a linear scan and does not belong on the
// generic result path.
function toolCallArgsFor(state, m) {
if (!state || !Array.isArray(state.messages) || !m.toolCallId) return null;
const messages = state.messages;
for (let i = messages.length - 1; i >= 0; i--) {
const row = messages[i];
if (row && row.role === 'tool' && row.phase === 'call' && row.toolCallId === m.toolCallId
&& row.args && typeof row.args === 'object') return row.args;
}
return null;
}

// renderMessageRow(state, refs, m)
//
// Render a single persisted message into a transcript row. Extracted
// from the old renderTranscript loop body so the chunked pass and the
// empty-transcript case can share the exact same rendering.
function renderMessageRow(state, refs, m) {
  if (m.role === 'tool' && m.phase === 'call') {
    // De-dup: skip a call row when a card for this tool id is already
    // on screen. Two paths need this: (1) latest-first render draws the
    // tail before the backfill, so a result whose call sits in the
    // backfill already produced a (standalone) card by the time we
    // reach the call; (2) an overlapping reconcile/recovery sync can
    // re-render a row this client already appended. Without the guard
    // the call card is duplicated (and left stuck on "Waiting…").
    if (m.toolCallId && refs.transcript.current
        && refs.transcript.current.querySelector('[data-tool-id="' + cssEscape(String(m.toolCallId)) + '"]')) {
      return;
    }
    appendToolCallCard({ id: m.toolCallId, name: m.name, args: m.args }, refs, true);
} else if (m.role === 'tool' && m.phase === 'result') {
// A `tool_result` row carries only the result. Previews that render the
// model's own payload need the call's arguments, so recover them from the
// persisted call row whenever they are not on this row. `write_file`
// renders the written content from them; `shell` renders the command it
// ran. The lookup used to be gated to `write_file`, so a shell card built
// from the result side (the chunked latest-first render, a pagination
// page, a rebuild that lost the stashed args) showed its output with no
// command — and whether that happened depended on which row was painted
// first, which is why the command appeared only "sometimes".
const recoveredArgs = m.args || toolCallArgsFor(state, m);
appendToolResultCard({
id: m.toolCallId, name: m.name, ok: m.ok,
args: recoveredArgs,
result: m.content || ''
}, refs);
} else if (isPersistedTurnError(m)) {
const payload = retryPayloadForError(state.messages, m);
appendErrorCard(m.content, refs, state, {
persist: false,
ts: m.ts,
onRetry: payload && typeof state._retryFailedTurn === 'function'
? () => state._retryFailedTurn(payload)
: null
});
} else {
appendMessageToTranscript(m, false, refs, state);
}
// Stamp the row just built with its identity, so the NEXT pass can reuse
// this exact element instead of destroying and re-creating it — which is
// what replayed the entry animation and made the transcript flash. Every
// builder above inserts exactly one node as the transcript's last message
// row, so the stamp is taken from there rather than threaded back through
// four different return contracts.
stampLastTranscriptRow(refs, m);
}

// stampLastTranscriptRow(refs, m)
//
// Record `transcriptRowKey(m)` on the message row a builder just inserted,
// which is the last message row in the transcript (builders insert at the
// end, or before the backfill anchor, which never follows a message row).
// A call row skipped by the de-dup guard above inserts nothing, so the
// existing card — already keyed by its result — keeps its key: restamping
// it with the call row's key would make the next pass see one node under
// two identities.
function stampLastTranscriptRow(refs, m) {
const el = refs.transcript.current;
if (!el) return;
// transcriptInsert records the node each builder placed; the chunked
// backfill inserts above its anchor, so "the last message row" would be
// the wrong element there.
const last = refs._lastInsertedRow;
if (!last || last.parentNode !== el) return;
const key = transcriptRowKey(m);
if (key) last._rowKey = key;
}

// isRenderableMessage(m) -> bool
//
// Empty assistant turns (no content, no reasoning) are placeholders
// the loops skip. Extracted so the tail-first render and the backfill
// share one predicate.
function isRenderableMessage(m) {
if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) return false;
return true;
}
// OVERLAY_CARD_SELECTOR
//
// The ask_user / authorization cards. Unlike message rows they are not
// part of state.messages — they are mounted from the pending-auth queue
// and SSE events — so a rebuild must carry them across, and must never
// hide them from `authCardGuard` / `removeOverlayCards` (both look the
// cards up in the live DOM).
const OVERLAY_CARD_SELECTOR = '.tool-card--ask-user[data-auth-call-id], .tool-card--authorization[data-auth-call-id]';
// clearTranscriptRows(root)
//
// Empty the transcript for a rebuild WITHOUT detaching the overlay
// cards. They used to be pulled into a local array and re-appended at
// the end of the rebuild, which lost them whenever a second rebuild
// landed while the first chunked pass was still backfilling: the second
// call's `querySelectorAll` found nothing (the first had already removed
// them), the first pass was then cancelled before it could re-attach
// them, and an unanswered question silently disappeared. Leaving them in
// the tree makes the rebuild idempotent — nothing to re-attach, nothing
// to lose — and keeps them discoverable by the de-dupe helpers. They are
// moved back to the bottom by reanchorOverlayCards when the rebuild ends.
function clearTranscriptRows(root) {
if (!root) return;
for (const child of Array.from(root.children)) {
if (child.matches(OVERLAY_CARD_SELECTOR)) continue;
child.remove();
}
}


// renderTranscriptChunked — latest-first progressive render.
//
// Long transcripts used to render top-down from row 0 and only reveal
// the newest turn after the WHOLE transcript had been built, so a big
// chat opened slow and scrolled up from the top. This paints the tail
// (newest rows that fill the viewport) FIRST and pins to the bottom
// immediately, then backfills older rows ABOVE an anchor in rAF
// chunks. The user sees the latest message on the first frame; the
// history fills in behind it without moving the view.
function renderTranscriptChunked(state, refs, expanded) {
  const transcriptEl = refs.transcript.current;
  if (!transcriptEl) return;
  // Cancel any previous chunked pass so two overlapping renders can't
  // append the same rows twice.
  resetTranscriptRender(refs);
  const token = _renderToken;

  // Indices of the renderable messages (skip empty assistant turns) in
  // order, so the tail/backfill split is by visible rows, not raw rows.
  const order = [];
  for (let i = 0; i < state.messages.length; i++) {
    if (isRenderableMessage(state.messages[i])) order.push(i);
  }
  if (!order.length) {
    restoreExpandedState(expanded, transcriptEl);
    reanchorOverlayCards(refs);
    scrollTranscriptToBottomImpl(refs);
    updateUsageSummary(state, null, refs);
    return;
  }

  // Phase 1 — tail. Render the newest TRANSCRIPT_CHUNK_ROWS rows in
  // order at the bottom (no anchor: plain append), then pin. This is
  // the only synchronous work on open, so the first paint is bounded
  // regardless of transcript length. Suspend per-row scroll pinning:
  // this phase manages the scroll itself with a single pin at the end.
  refs._suspendScrollPin = true;
  const tailStart = Math.max(0, order.length - TRANSCRIPT_CHUNK_ROWS);
  const childrenBefore = transcriptEl.children.length;
  refs._insertAnchor = null;
  try {
    for (let k = tailStart; k < order.length; k++) {
      renderMessageRow(state, refs, state.messages[order[k]]);
    }
  } finally {
    // A throw inside a row renderer must not leave pinning suppressed for
    // the rest of the session.
    refs._suspendScrollPin = false;
  }
  // Pin to the bottom now so the newest turn is on screen on frame one.
  scrollTranscriptToBottomImpl(refs);

  if (tailStart === 0) {
    // Everything fit in the tail — nothing to backfill.
    refs._insertAnchor = null;
    restoreExpandedState(expanded, transcriptEl);
    reanchorOverlayCards(refs);
    scrollTranscriptToBottomImpl(refs);
    updateUsageSummary(state, null, refs);
    return;
  }

  // Phase 2 — backfill older rows above the first tail row. The anchor
  // is the first element the tail phase appended; inserting before it
  // keeps older history between the header cards and the tail.
  const anchor = transcriptEl.children[childrenBefore] || null;
  refs._insertAnchor = anchor;
  refs._pendingTranscriptChunk = requestAnimationFrame(() => renderTranscriptBackfill(state, refs, {
    order, index: tailStart - 1, token, expanded
  }));
}

function renderTranscriptBackfill(state, refs, chunk) {
  // Nothing below may leave `_pendingTranscriptChunk` set on an early
  // return: whenTranscriptSettled polls it every animation frame, so a
  // leaked id spins that loop forever and every overlay-card mount waits
  // on it. The frame that is running right now is this one.
  refs._pendingTranscriptChunk = null;
  if (chunk.token !== _renderToken) { refs._insertAnchor = null; return; } // superseded
  const transcriptEl = refs.transcript.current;
  if (!transcriptEl) { refs._insertAnchor = null; return; }
  const wasPinned = refs.pinnedToBottom.current;
  const prevScrollTop = transcriptEl.scrollTop;
  const prevScrollHeight = transcriptEl.scrollHeight;
  let rendered = 0;
  // Suspend per-row scroll pinning while we insert above the viewport;
  // the height compensation below keeps the view stable in one step.
  refs._suspendScrollPin = true;
  // Walk backwards so rows are inserted in reverse; because each insert
  // goes before the SAME anchor, the net order stays chronological. The
  // anchor advances to the node just inserted so the next (older) row
  // lands above it — but only when a node was actually inserted (a
  // duplicate tool-call row is skipped and inserts nothing, in which
  // case the anchor must stay put).
  try {
  while (chunk.index >= 0 && rendered < TRANSCRIPT_CHUNK_ROWS) {
    const m = state.messages[chunk.order[chunk.index]];
    chunk.index--;
    const before = transcriptEl.childElementCount;
    const prevInserted = refs._insertAnchor ? refs._insertAnchor.previousElementSibling : transcriptEl.lastElementChild;
    renderMessageRow(state, refs, m);
    if (transcriptEl.childElementCount > before) {
      // The newly inserted node is the one now sitting right before the
      // old anchor; make it the new anchor.
      const nowInserted = refs._insertAnchor ? refs._insertAnchor.previousElementSibling : transcriptEl.lastElementChild;
      if (nowInserted && nowInserted !== prevInserted) refs._insertAnchor = nowInserted;
    }
    rendered++;
  }
} finally {
  // A throw inside a row renderer must not leave pinning suppressed or
  // strand the backfill anchor for the rest of the session.
  refs._suspendScrollPin = false;
}

  // Keep the viewport stable: if the user was pinned to the bottom stay
  // there; otherwise preserve their reading position by compensating
  // for the height the inserted rows added above the viewport.
  if (wasPinned) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    transcriptEl.scrollTop = prevScrollTop + (transcriptEl.scrollHeight - prevScrollHeight);
  }
  if (chunk.index >= 0) {
    refs._pendingTranscriptChunk = requestAnimationFrame(() => renderTranscriptBackfill(state, refs, chunk));
    return;
  }
  // Done: clear the anchor, restore expanded cards, final pin.
refs._insertAnchor = null;
restoreExpandedState(chunk.expanded, transcriptEl);
reanchorOverlayCards(refs);
if (refs.pinnedToBottom.current) scrollTranscriptToBottomImpl(refs);
updateUsageSummary(state, null, refs);
}

// restoreExpandedState(state, root)
//
// Re-apply the expanded state captured by snapshotExpandedState to a
// freshly rebuilt transcript.
function restoreExpandedState(exp, root) {
  if (!root) return;
  for (const card of root.querySelectorAll('.tool-card')) {
    if (!(card.dataset && card.dataset.toolId)) continue;
    if (exp.toolIds.has(card.dataset.toolId)) {
      card.classList.add('is-expanded');
      // Result bodies render lazily on first expand (see
      // appendToolResultCard); restoring the class alone would show
      // an empty body for a card the user had open before a rebuild.
      if (typeof card._lazyBody === 'function') card._lazyBody();
    } else if (exp.collapsedToolIds && exp.collapsedToolIds.has(card.dataset.toolId)) {
      // The user deliberately collapsed this card before the rebuild —
      // keep it collapsed (appendToolResultCard auto-collapses clean
      // results, but an errored card re-adds is-expanded; the user's
      // intent wins).
      card._userCollapsed = true;
      card.classList.remove('is-expanded');
    }
    // A card whose body was already built before the rebuild builds it
    // again up front so the transcript is identical after the rebuild —
    // not an empty body waiting for a tap that already happened.
    if (exp.builtToolIds && exp.builtToolIds.has(card.dataset.toolId) && typeof card._lazyBody === 'function') {
      card._lazyBody();
    }
  }
  for (const card of root.querySelectorAll('.tool-card--progress')) {
    if (card.dataset && card.dataset.progressId && exp.progressIds.has(card.dataset.progressId)) {
      card.classList.add('is-expanded');
    }
  }
  root.querySelectorAll('details').forEach((d) => {
    const cls = d.className || '';
    if (exp.details.includes(cls)) d.open = true;
  });
}

// reanchorOverlayCards(refs) — move any standing ask_user /
// authorization overlay cards to the very bottom of the transcript.
// They are appended (and reattached after a rebuild) at the end, but a
// reconcile / recovery tail sync renders message rows AFTER that point,
// stranding the card mid-transcript — it would then float "at a random
// place" above content that arrived later. Re-anchoring after every
// batch keeps the live question the user must answer always on top.
function reanchorOverlayCards(refs) {
const el = refs.transcript.current;
if (!el) return;
// querySelectorAll returns a static NodeList, so collecting first and
// then moving is safe — no need to iterate in reverse.
const cards = el.querySelectorAll(OVERLAY_CARD_SELECTOR);
if (!cards.length) return;
for (const card of cards) {
if (card.parentNode) card.parentNode.removeChild(card);
}
for (const card of cards) el.appendChild(card);
}

// syncTranscriptAppend(state, refs, prevCount)
//
// Incremental transcript update: the server store is append-only
// (rows are never edited in place), so when the authoritative rows
// grow from prevCount to state.messages.length the DOM can be
// brought up to date by rendering just the new tail — no full
// rebuild, no re-parsing markdown for messages the user already
// has on screen. Used by the 1 s reconcile poll while following a
// run started in another tab. Callers must verify the prefix is
// unchanged before calling (a changed prefix requires renderTranscript).
export function syncTranscriptAppend(state, refs, prevCount) {
  const transcriptEl = refs.transcript.current;
  if (!transcriptEl) return;
  const total = state.messages.length;
  if (total <= prevCount) return;
  // If the transcript is still in its empty state (setup card + empty
  // state only), fall back to a full render so the setup card and
  // system prompt mount in the right order. A full render re-owns the
  // whole transcript, so it does supersede an in-flight chunked pass.
  if (prevCount === 0) {
    resetTranscriptRender(refs);
    renderTranscript(state, refs);
    return;
  }
  // A chunked backfill may still be filling in older history ABOVE its
  // anchor. It is not superseded by an append: the rows appended here
  // belong at the bottom, and the backfill keeps inserting older rows
  // above the tail, so the two never compete for a position. Cancelling
  // it here (what this function used to do via resetTranscriptRender)
  // dropped every history row the pass had not reached yet — they stayed
  // in state.messages but never reached the DOM until some later full
  // rebuild, leaving a hole in the middle of the transcript.
  //
  // transcriptInsert() targets refs._insertAnchor while one is set, so the
  // anchor is parked for the duration of the append and handed back
  // afterwards: without that the new rows would be inserted above the tail.
  const anchor = refs._insertAnchor;
  refs._insertAnchor = null;
  for (let i = prevCount; i < total; i++) {
    const m = state.messages[i];
    if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) continue;
    renderMessageRow(state, refs, m);
  }
  if (anchor && anchor.parentNode === transcriptEl) refs._insertAnchor = anchor;
  // Don't let newly appended rows bury a pending auth/ask card.
  reanchorOverlayCards(refs);
  // One scroll decision for the whole batch (countNew drives the
  // jump-to-bottom counter while unpinned).
  afterTranscriptAppend(refs, true);
  updateUsageSummary(state, null, refs);
}

// ---- Row identity + reconciliation ---------------------------------
//
// The transcript used to be rebuilt by destroying every child and
// re-creating it from state.messages on each pass. A re-created row is a
// NEW element, so it replayed `.chat-msg`'s entry animation
// (frontend/src/chat-transcript.css) from `opacity: 0` — the "flash" —
// even when the row's data had not changed at all. On an empty chat that
// happened on every reconcile tick: the system-prompt row was removed and
// rebuilt although it was already correct on screen, so the conversation
// area blinked between paints for no reason.
//
// Reconciliation fixes the cause rather than the symptom: the element
// already on screen is REUSED for a row whose identity is unchanged, and
// only genuinely new rows are built. A pass over unchanged data then
// performs no DOM mutation at all — nothing is created, so nothing
// animates, and the transcript cannot blink.

const _rowKeys = new WeakMap();
let _rowKeyCounter = 0;

// hasClass(el, name) -> bool
//
// `className` is read as a string rather than through `classList` so the
// transcript's own file-order tests (which drive this module in a VM with
// a minimal element stub — see scripts/test-transcript-reconcile.js) can
// exercise the reconciliation logic without a full DOM implementation.
function hasClass(el, name) {
  const cls = el && el.className;
  return typeof cls === 'string' && (' ' + cls + ' ').indexOf(' ' + name + ' ') >= 0;
}

// isOverlayCard(el) -> bool
//
// Authorization / ask_user prompts are NOT transcript rows: they are
// mounted beside the transcript while a run is parked and must survive
// every pass (see clearTranscriptRows). The reconciler never matches,
// moves, or removes them.
function isOverlayCard(el) {
  return !!(el && el.dataset && el.dataset.authCallId);
}

// isMessageRowNode(el) -> bool
//
// A transcript row the reconciler may match, move, or remove. Header cards
// are excluded even though the system-prompt row is a `.chat-msg` bubble: it
// is a card with a fixed slot above the conversation, not a message from
// state.messages. Without the exclusion the reconciler saw it as an unkeyed
// row — culling it whenever it did not happen to be first (see
// reconcileTranscriptRows) and parking its row cursor on it, so real messages
// were inserted ABOVE the header block.
function isMessageRowNode(el) {
  if (!el || el.nodeType !== 1 || isOverlayCard(el) || isHeaderCardNode(el)) return false;
  return hasClass(el, 'chat-msg') || hasClass(el, 'tool-card');
}

// firstOverlayCard(el) -> Element | null
function firstOverlayCard(el) {
  for (const child of el.children) if (isOverlayCard(child)) return child;
  return null;
}

// chatTranscriptKey(state) -> string
//
// The identity of the transcript currently mounted. A pass that sees a
// different key is looking at a different chat, so it must not reconcile
// against the rows of the chat the user just left.
function chatTranscriptKey(state) {
  const p = (state && state.props) || {};
  return (p.projectDir || '') + '::' + (p.chatId || '');
}

// transcriptRowKey(m) -> string | null
//
// Stable identity for one transcript row across passes:
//   - a persisted row is identified by its `seq`; the message store is
//     append-only, so a given seq's content never changes and reusing the
//     node is always correct;
//   - a tool row pairs its call id with its phase, because a call and its
//     result are two messages but two distinct rows;
//   - anything else — an optimistic user bubble, a live assistant row —
//     falls back to object identity, which survives the reconcile merge
//     because mergeServerRows keeps untouched rows by reference.
export function transcriptRowKey(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.seq === 'number' && Number.isFinite(m.seq)) return 'seq:' + m.seq;
  if (m.role === 'tool' && m.toolCallId) return 'tool:' + m.toolCallId + ':' + (m.phase || '');
  let key = _rowKeys.get(m);
  if (!key) {
    key = 'obj:' + (++_rowKeyCounter);
    _rowKeys.set(m, key);
  }
  return key;
}

// hasMessageRows(el) -> bool
function hasMessageRows(el) {
  if (!el) return false;
  for (const child of el.children) if (isMessageRowNode(child)) return true;
  return false;
}

// reconcileTranscriptRows(state, refs, order) -> { reused, created, removed }
//
// Bring the transcript's message rows in line with `order` — the indices
// of the renderable messages, in display order — without re-creating a
// row that is already on screen under the same key. Header cards and
// overlay cards are left exactly where they are; only message rows take
// part.
//
// The walk keeps a `cursor` at the position the next row must occupy.
// A reused row that is already exactly at the cursor is left untouched —
// which is what makes the common case (nothing changed) a genuine no-op,
// with no insert, no removal and therefore no replayed animation.
export function reconcileTranscriptRows(state, refs, order) {
  const el = refs.transcript.current;
  const stats = { reused: 0, created: 0, removed: 0 };
  if (!el) return stats;

  // Index the rows already on screen by key. A duplicate key is a leftover
  // from an earlier overlapping pass: the first is kept, the rest go.
  const existing = new Map();
  for (const child of Array.from(el.children)) {
    if (!isMessageRowNode(child)) continue;
    const key = child._rowKey;
    if (!key) continue;
    if (!existing.has(key)) existing.set(key, child);
    else { child.remove(); stats.removed++; }
  }

  // The row block sits between the header cards and the overlay cards, so
  // an insert with no cursor yet belongs just before the first overlay.
  let cursor = null;
  for (const child of el.children) {
    if (isMessageRowNode(child)) { cursor = child; break; }
    if (isOverlayCard(child)) { cursor = child; break; }
  }

  const keep = new Set();
  for (let i = 0; i < order.length; i++) {
    const m = state.messages[order[i]];
    const key = transcriptRowKey(m);
    if (!key) continue;
    keep.add(key);

    let node = existing.get(key) || null;
    if (node) {
      stats.reused++;
    } else {
      // Build the row. The row builders insert themselves (appendChild, or
      // before refs._insertAnchor, which this path never sets), so the new
      // node is found by diffing the child list immediately after.
      const before = new Set(el.children);
      renderMessageRow(state, refs, m);
      for (const child of el.children) {
        if (before.has(child) || !isMessageRowNode(child) || child._rowKey) continue;
        node = child;
        break;
      }
      if (node) stats.created++;
    }
    // A tool call row whose card is already owned by its result renders
    // nothing (see renderMessageRow's de-dup): leave the cursor alone.
    if (!node) continue;
    node._rowKey = key;

    if (node === cursor) {
      cursor = node.nextElementSibling;
      continue;
    }
    el.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }

  // Rows whose key is no longer in the transcript (a deleted chat, a
  // diverged prefix) are the only nodes this pass removes.
  for (const child of Array.from(el.children)) {
    if (!isMessageRowNode(child)) continue;
    const key = child._rowKey;
    if (key && keep.has(key)) continue;
    child.remove();
    stats.removed++;
  }
  return stats;
}

// ---- Header cards ---------------------------------------------------
//
// The four cards above the messages (system prompt, tools, agent files,
// skills) render from a handful of inputs that usually do not change
// between passes. Each card records the signature it was built from and
// is rebuilt only when that signature moves — otherwise the mounted node
// is left alone, so it cannot be destroyed and re-animated either.

function stableJson(value) {
  try { return JSON.stringify(value == null ? null : value); } catch { return ''; }
}

function headerSignatures(state, empty) {
  const t = state.tools || { catalog: [], filter: null };
  const af = state.agentFiles || {};
  const sk = state.skills || {};
  return {
    // The setup widget is a creation-time control: an empty chat shows it,
    // a chat with messages never does.
    setup: empty ? String((state.chat && state.chat.promptSize) || 'average') : 'hidden',
    sys: String((state.systemPrompt && state.systemPrompt.text) || ''),
    tools: stableJson([
      (t.catalog || []).map((tool) => (tool && tool.name) || ''),
      t.filter == null ? null : t.filter,
      state.toolAuth || null,
      state.mcpAuth || null,
      state._mcpStartBusyServerId || null,
      (state.mcpServers || []).map((s) => (s && s.id) + ':' + (s && s.status)),
      Array.from(state.usedTools || [])
    ]),
    agentFiles: stableJson([af.files || [], !!af.enabled, !!af.explicit, !!af.projectLocked]),
    skills: stableJson([
      (sk.items || []).map((s) => [s && s.id, !!s.disabled, !!s.chatDisabled]),
      !!sk.enabled,
      !!sk.projectLocked
    ])
  };
}

// ensureEmptyState(refs, want)
//
// The "Start the conversation" block belongs to an empty chat only. It is
// kept across passes instead of being rebuilt, so its contents do not
// re-animate while the chat is still empty.
function ensureEmptyState(refs, want) {
  const el = refs.transcript.current;
  if (!el) return;
  const existing = el.querySelector ? el.querySelector('.chat-view__empty') : null;
  if (want) {
    if (existing && existing.parentNode === el) return;
    if (existing) existing.remove();
    el.appendChild(buildEmptyState());
  } else if (existing && existing.parentNode === el) {
    existing.remove();
  }
}

// syncHeaderCards(state, refs, empty)
//
// Mount or refresh the header cards, in the order the transcript expects:
// [setup] [system prompt] [tools] [agent files] [skills]. A card whose
// signature and mounted node are both unchanged is skipped entirely.
function syncHeaderCards(state, refs, empty) {
  const el = refs.transcript.current;
  if (!el) return;
  const sigs = headerSignatures(state, empty);
  const prev = refs._cardSigs || (refs._cardSigs = {});

  const mounted = (selector) => !!(el.querySelector && el.querySelector(selector));

  // Setup control — removed outright once the chat has any message, which
  // is the transcript-cleaning contract documented on updateSetupVisibility.
  if (sigs.setup === 'hidden') {
    const host = refs.setupCard.current;
    if (host && host.parentNode) host.remove();
    refs.setupCard.current = null;
    prev.setup = '';
  } else if (prev.setup !== sigs.setup || !refs.setupCard.current || !refs.setupCard.current.parentNode) {
    if (refs.setupCard.current && refs.setupCard.current.parentNode) refs.setupCard.current.remove();
    const card = buildSetupCardForMount(refs, state);
    // The setup control owns slot 0 of the header block, where buildToolCard
    // expects to find it (it queries `.chat-view__setup`).
    placeHeaderCard(el, card, HEADER_CARD_ORDER.setup);
    refs.setupCard.current = card;
    prev.setup = sigs.setup;
  }

  if (prev.sys !== sigs.sys || !mounted('[data-sys-prompt="1"]')) {
    renderSystemPromptMessage(refs, state.systemPrompt);
    prev.sys = sigs.sys;
  }
  if (prev.tools !== sigs.tools || !mounted('[data-tools-card="1"]')) {
    mountToolsCard(refs, state);
    prev.tools = sigs.tools;
  }
  if (prev.agentFiles !== sigs.agentFiles || !mounted('[data-agent-files-card="1"]')) {
    mountAgentFilesCard(refs, state);
    prev.agentFiles = sigs.agentFiles;
  }
  if (prev.skills !== sigs.skills || !mounted('[data-skills-card="1"]')) {
    mountSkillsCard(refs, state);
    prev.skills = sigs.skills;
  }
  // Header cards keep their fixed order no matter which mounters ran this
  // pass, or which card one of them found or missed as an anchor. Only a card
  // already out of place is moved, so a settled pass performs no mutation.
  orderHeaderCards(refs);
  ensureEmptyState(refs, empty);
}

export function renderTranscript(state, refs) {
if (!refs.transcript.current) return;
// Preserve expand/collapse across the rebuild below: appending an
// element re-runs renderTranscript from disk, which would otherwise
// collapse every tool/result card the user had opened.
const expanded = snapshotExpandedState(refs.transcript.current);
// Cancel any in-flight chunked render before rebuilding — a stream
// reconcile can call renderTranscript while the previous chunked
// pass is still mid-flight, and without this the two would append
// the same rows twice.
resetTranscriptRender(refs);
// A pass for a DIFFERENT chat must not reconcile against the rows of the
// chat the user just left (same seqs would key onto the wrong rows), and
// it must drop the per-chat group-expansion memory so the new chat's tree
// starts collapsed. Everything else about the old transcript goes too:
// the mounted header-card signatures are keyed to the old chat's data.
const key = chatTranscriptKey(state);
if (refs._transcriptKey !== key) {
  refs._transcriptKey = key;
  refs._cardSigs = {};
  refs._toolTreeCollapsed = null;
  clearTranscriptRows(refs.transcript.current);
  refs._anonToolCalls = [];
  refs.setupCard.current = null;
}
// Pending ask_user / authorization overlay cards are NOT part of
// state.messages (they're mounted from the pending-auth queue / SSE
// events), so a pass must carry them across rather than wipe an
// unanswered question the user is looking at. The reconciler never
// matches, moves, or removes them; reanchorOverlayCards puts them back
// at the bottom once the pass finishes.
const empty = !state.messages.length;
// Header cards first, in transcript order. Each is rebuilt only when the
// inputs it renders from actually changed — an unchanged card keeps the
// node it already has, so it is never destroyed and re-animated.
syncHeaderCards(state, refs, empty);
// Move the standing overlay cards below the header cards before any
// message row is placed. Without this they would sit above the headers,
// and findTranscriptContentStart (used by the pagination prepend) would
// treat the leading overlay card as the first message row and insert
// older history above the headers.
reanchorOverlayCards(refs);
// Rows are reused, not rebuilt. Long transcripts are the one case that
// cannot be a single pass: their rows are created progressively so the
// first screen paints immediately instead of blocking on a full
// DOM+markdown build. Everything already on screen is still reused — the
// chunked pass only creates the rows it has not reached yet.
if (state.messages.length >= TRANSCRIPT_CHUNK_THRESHOLD && !hasMessageRows(refs.transcript.current)) {
renderTranscriptChunked(state, refs, expanded);
return;
}
const order = [];
for (let i = 0; i < state.messages.length; i++) {
if (isRenderableMessage(state.messages[i])) order.push(i);
}
reconcileTranscriptRows(state, refs, order);
restoreExpandedState(expanded, refs.transcript.current);
reanchorOverlayCards(refs);
// An empty chat creates no rows, so nothing here has changed the viewport:
// leave the scroll position alone rather than re-pinning it on an idle
// reconcile tick.
if (order.length) scrollTranscriptToBottomImpl(refs);
updateUsageSummary(state, null, refs);
}




// findTranscriptContentStart(el) -> Element | null
//
// Locate the first non-header node in the transcript, i.e. the first
// chat/tool row the header cards (system prompt, tools, agent files,
// skills, setup, empty state) sit above. Older paginated rows must be
// inserted BEFORE this node so they land between the header cards and
// the currently-loaded messages.
function findTranscriptContentStart(el) {
if (!el) return null;
for (let i = 0; i < el.children.length; i++) {
const child = el.children[i];
// Shared classification (see headerCards.js) rather than a second list of
// classes and data attributes that could drift from the mounters'.
if (isHeaderCardNode(child)) continue;
return child;
}
return null;
}
// prependOlderTranscript(state, refs, messages) -> boolean
//
// Insert a page of older messages ABOVE the currently-loaded rows, in
// chronological order, preserving the user's reading position. Used by
// the scroll-up pagination loader. `messages` runs oldest -> newest
// (as the server window returns it). Returns true when any row was
// inserted.
export function prependOlderTranscript(state, refs, messages) {
const el = refs.transcript.current;
if (!el || !Array.isArray(messages) || !messages.length) return false;
const contentStart = findTranscriptContentStart(el);
if (!contentStart) return false;
const prevScrollHeight = el.scrollHeight;
const prevScrollTop = el.scrollTop;
// Insert before the fixed content-start anchor so the rows land in the
// order they arrive (oldest first). Suppress per-row scroll pinning so
// the loading pass owns the scroll position and no jump-button flutter
// fires while the page fills in above the viewport.
refs._insertAnchor = contentStart;
refs._suspendScrollPin = true;
const beforeCount = el.childElementCount;
try {
for (const m of messages) renderMessageRow(state, refs, m);
} finally {
// A throw inside a row renderer must not leave scroll pinning disabled
// for the rest of the session, nor strand the prepend anchor.
refs._suspendScrollPin = false;
refs._insertAnchor = null;
}
if (el.childElementCount === beforeCount) return false;
// Preserve the viewport anchor: the inserted content raised the total
// height above the viewport, so bump scrollTop by exactly the delta to
// keep the rows the user was reading in place.
el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
updateUsageSummary(state, null, refs);
return true;
}
// buildSetupCardForMount(refs, state)
//
// Build the prompt-size selector and wire its onChange to the meta
// module's setPromptSize.
function buildSetupCardForMount(refs, state) {
const sel = buildSetupCard();
sel._onChange = (v) => setPromptSize(v, state, refs);
return sel;
}

// buildEmptyState()
function buildEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'chat-view__empty';
  const icon = document.createElement('span');
  icon.className = 'chat-view__empty-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9.586a1.5 1.5 0 0 0-1.06.44l-2.122 2.12A.5.5 0 0 1 6.4 20.146V18H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3 5a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H7Zm0 4a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H7Z"/></svg>';
  const title = document.createElement('p');
  title.className = 'chat-view__empty-title';
  title.textContent = 'Start the conversation';
  const text = document.createElement('p');
  text.className = 'chat-view__empty-text';
  text.textContent = "Type a message below. The model streams its reply in real time; everything you send is saved to this chat's transcript on disk.";
  empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
  return empty;
}

// scrollTranscriptToBottomImpl — local copy used only by
// renderTranscript. Same semantics as the scroll.js helper, kept
// inline so renderTranscript doesn't need to import the whole
// module.
//
// Unlike a hard `scrollTop = scrollHeight` on every rebuild, only pin
// when the user was already pinned to the bottom (or near it) BEFORE
// the rebuild. A full render can be triggered mid-view by recovery /
// reconcile — force-pinning then yanks the user to the bottom and
// discards their reading position. `pinnedToBottom` defaults to true,
// so the initial load still pins.
function scrollTranscriptToBottomImpl(refs) {
  const el = refs.transcript.current;
  if (!el) return;
  const wasPinned = refs.pinnedToBottom.current;
  // The rebuild has already reflowed the transcript; judge "near
  // bottom" before we are allowed to pin, using the pre-rebuild state.
  // After a full innerHTML='' the scrollHeight is reset, so compare
  // against the saved decision from before clear instead of a live
  // isNearBottom() read (which would always look "near").
  if (!wasPinned) {
    // User had scrolled up — preserve their position. The innerHTML
    // wipe already reset scrollTop to 0; leave it and let the pin/
    // jump button reflect reality (don't fabricate a scroll change).
    refs.pendingCount.current = 0;
    updateJumpButton(refs);
    return;
  }
  el.scrollTop = el.scrollHeight;
  refs.pendingCount.current = 0;
  updateJumpButton(refs);
  // Re-pin once layout settles: markdown code blocks and reflowing tool
  // cards can grow a frame after this synchronous pin, which would
  // otherwise strand the newest row a few pixels below the fold.
  pinTranscriptAfterSettle(refs);
}

// finalizeLiveMessage(message, refs)
//
// Promote the live row to a final state. Renders the assembled
// content as markdown and removes the data-live marker so the
// next deltas create a fresh live row.
export function finalizeLiveMessage(message, refs) {
  if (!refs.transcript.current) return;
  const liveRow = refs.transcript.current.querySelector('[data-live="1"]');
  if (liveRow) {
    delete liveRow.dataset.live;
    if (liveRow._body && message && typeof message.content === 'string') {
      // Render the assembled assistant turn as markdown. Non-assistant
      // roles (and the rare "stream interrupted" sentinel) stay as
      // plain text so we never inject HTML into error placeholders.
      const isAssistant = liveRow.classList.contains('chat-msg--assistant');
      if (isAssistant) {
        renderAssistantBody(liveRow._body, message.content, message.reasoning || liveRow._reasoning || '', true);
      } else {
        liveRow._body.textContent = message.content;
      }
    }
  }
}
