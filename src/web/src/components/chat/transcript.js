// mouaif web — Chat transcript rendering
//
// Everything that draws into the .chat-view__transcript: chat
// bubbles, tool call/result cards, the system-prompt message, the
// subagent live + final render, and the per-turn usage meta line.
// Imperative DOM (not Preact JSX) so the SSE hot path stays as
// cheap as a textContent assignment and so the visual layout
// matches the rest of the transcript which is also imperative.

import { renderMarkdown } from '../../markdown.js';
import { afterTranscriptAppend, scrollToolBodyToBottom } from './scroll.js';
import {
  isSubagentTool,
  normalizeToolName,
  formatToolArgs,
  formatResultSummary,
  coerceToolResult,
  formatReadableToolResult
} from './tools.js';
import { renderToolResultBody } from './toolRender.js';
import { cssEscape } from './utils.js';
import { buildSetupCard, mountToolsCard, mountAgentFilesCard } from './cards.js';
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
  const row = document.createElement('div');
  row.className = 'chat-msg chat-msg--system';
  row.dataset.sysPrompt = '1';
  const role = document.createElement('div');
  role.className = 'chat-msg__role';
  role.textContent = 'system';
  const body = document.createElement('div');
  body.className = 'chat-msg__body';
  // Count non-empty lines for the summary. The prompt is plain
  // text; we only render it (as <pre> with pre-wrap) when the user
  // expands the disclosure, so the line count is the only signal
  // the user has of how much is behind it.
  const lineCount = systemPrompt.text.split(/\r?\n/).filter(l => l.length).length;
  const details = document.createElement('details');
  details.className = 'chat-msg__system-details';
  const summary = document.createElement('summary');
  summary.textContent = 'System prompt · ' + lineCount + ' line' + (lineCount === 1 ? '' : 's');
  const pre = document.createElement('pre');
  pre.className = 'chat-msg__system-body';
  pre.textContent = systemPrompt.text;
  details.appendChild(summary);
  details.appendChild(pre);
  body.appendChild(details);
  row.appendChild(role);
  row.appendChild(body);
  // Insert directly after the setup card if one is still mounted,
  // so the system message always sits under it on a new chat.
  const setup = refs.setupCard.current;
  if (setup && setup.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(row, setup.nextSibling);
  } else {
    refs.transcript.current.insertBefore(row, refs.transcript.current.firstChild);
  }
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
  refs.transcript.current.appendChild(row);
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

// appendErrorCard(message, refs, state)
//
// Render a failed turn as an inline error bubble (system role with
// an `is-error` flag for styling). Used for SSE `error` events and
// client-side send failures so failures are part of the transcript
// the user is looking at — not only in the composer's tiny status
// line, which is easy to miss and gets overwritten by the next
// status update. textContent only: provider error bodies may carry
// markup and must never be injected as HTML.
export function appendErrorCard(message, refs, state) {
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
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  head.appendChild(role);
  head.appendChild(ts);
  const body = document.createElement('div');
  body.className = 'chat-msg__body';
  body.textContent = message;
  row.appendChild(head);
  row.appendChild(body);
  refs.transcript.current.appendChild(row);
  if (state) state.messages = state.messages.concat([{ role: 'system', content: message, ts: new Date().toISOString() }]);
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
  ask_user: 'Question'
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

// buildToolCardHead(toolName, args, pillClass, pillText, resultSummary)
//
// The compact header row shared by tool_call and tool_result cards:
// a chevron, the verb-style tool label, the one-line arg summary,
// and a status dot (busy/ok/err) on the right. The whole row is the
// tap target for expand/collapse. The status element keeps the
// legacy `.tool-card__pill` classes so subagent code that toggles
// pill classes keeps working.
function buildToolCardHead(toolName, args, pillClass, pillText, resultSummary) {
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
  // `args` may be either a raw arg object or an already-formatted
  // string (when the caller has the display text already). Pass it
  // through formatToolArgs either way: passing a string returns
  // that string unchanged.
  const argText = args == null ? '' : (typeof args === 'string' ? args : formatToolArgs(args, toolName));
  const pill = document.createElement('span');
  pill.className = 'tool-card__pill ' + pillClass;
  pill.textContent = pillText;
  head.appendChild(chev);
  head.appendChild(name);
  if (argText) {
    const argsEl = document.createElement('pre');
    argsEl.className = 'tool-card__args';
    argsEl.textContent = shortToolText(argText, 220);
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
  });
  return head;
}

// appendToolCallCard(toolCall, refs)
//
// Render a tool_call event as a compact card above the live message
// (or appended if there is no live row). Subagent calls get a live
// body up front so the user can expand the card while the subagent
// is still running and watch nested tool activity stream in. Shell
// calls get an empty live body that fills as stdout/stderr chunks
// arrive (see handleShellOutputEvent).
export function appendToolCallCard(toolCall, refs) {
  if (!refs.transcript.current) return;
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (empty) empty.remove();
  const id = toolCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
  const card = document.createElement('div');
  card.className = 'tool-card tool-card--call';
  card.dataset.toolId = id;
  card.dataset.toolName = normalizeToolName(toolCall.name);
  card.appendChild(buildToolCardHead(toolCall.name, toolCall.args, 'tool-card__pill--busy', 'running'));
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
    hint.textContent = 'Running…';
    const pre = document.createElement('pre');
    pre.className = 'tool-card__shell-live-pre';
    live.appendChild(hint);
    live.appendChild(pre);
    body.appendChild(live);
    card.appendChild(body);
    // Auto-expand so stdout/stderr chunks show as they stream in
    // instead of filling a hidden body.
    card.classList.add('is-expanded');
  }
  refs.transcript.current.appendChild(card);
  afterTranscriptAppend(refs, true);
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
    let textEl = live.querySelector('.tool-card__subagent-live-text');
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'tool-card__subagent-live-text';
      live.appendChild(textEl);
    }
    renderAssistantBody(textEl, live._text, '', false);
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
    const row = document.createElement('div');
    row.className = 'tool-card__subagent-tool';
    if (data.id) row.dataset.nestedToolId = data.id;
    const callName = document.createElement('span');
    callName.className = 'tool-card__subagent-tool-name';
    callName.textContent = toolCardLabel(data.name);
    const callArgsText = formatToolArgs(data.args, data.name);
    const callArgs = document.createElement('pre');
    callArgs.className = 'tool-card__subagent-text';
    callArgs.textContent = shortToolText(callArgsText, 160);
    if (callArgsText && callArgs.textContent !== callArgsText) callArgs.title = callArgsText;
    const status = document.createElement('span');
    status.className = 'tool-card__pill tool-card__pill--busy';
    status.textContent = 'running…';
    row.appendChild(callName); row.appendChild(callArgs); row.appendChild(status);
    live.appendChild(row);
    scrollToolBodyToBottom(live);
    afterTranscriptAppend(refs, false);
    return true;
  }
  if (ev.eventName === 'tool_result') {
    let row = data.id ? live.querySelector('[data-nested-tool-id="' + cssEscape(data.id) + '"]') : null;
    if (!row) row = live.querySelector('.tool-card__subagent-tool:last-child');
    if (row) {
      const status = row.querySelector('.tool-card__pill');
      if (status) {
        status.className = 'tool-card__pill ' + (data.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err');
        status.textContent = data.ok ? 'ok' : 'error';
      }
      const oldPreview = row.querySelector('.tool-card__subagent-preview');
      if (oldPreview) oldPreview.remove();
      renderSubagentToolPreview(row, data.name, data.result);
    }
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
export function appendToolResultCard(toolResult, refs) {
  if (!refs.transcript.current) return;
  const id = toolResult.id;
  let card = id ? refs.transcript.current.querySelector('[data-tool-id="' + cssEscape(id) + '"]') : null;
  const isSubagent = isSubagentTool(toolResult && toolResult.name);
  const pillClass = toolResult.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err';
  const pillText = toolResult.ok ? 'ok' : 'error';
  const rawR = coerceToolResult(toolResult && toolResult.result, normalizeToolName(toolResult && toolResult.name));
  const summary = toolResult.ok ? formatResultSummary(toolResult && toolResult.name, rawR) : null;
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card tool-card--result';
    card.dataset.toolId = id || ('call_' + Math.random().toString(36).slice(2, 10));
    card.dataset.toolName = normalizeToolName(toolResult.name);
    // Show the command/args in the collapsed header for shell
    // (and any tool that carries args on the result event).
    const name = normalizeToolName(toolResult.name);
    const headArgs = (isSubagent || name === 'shell' || (toolResult.args && toolResult.args.cmd))
      ? formatToolArgs(toolResult.args, toolResult.name)
      : null;
    card.appendChild(buildToolCardHead(toolResult.name, headArgs, pillClass, pillText, summary));
    const body = document.createElement('div');
    body.className = 'tool-card__body';
    card.appendChild(body);
    refs.transcript.current.appendChild(card);
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
    rebuildToolCardHead(card, toolResult.name, headArgs, pillClass, pillText, summary);
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
      renderToolResultBody(body, toolResult, isSubagentTool);
      if (isSubagent) renderSubagentChat(card, toolResult);
      afterTranscriptAppend(refs, false);
    };
    card._lazyBody = lazyBody;
    if (card.classList.contains('is-expanded') || !toolResult.ok) {
      // Errors auto-expand — build immediately so the failure is visible.
      lazyBody();
    } else {
      body.dataset.lazyResult = '1';
      // Build on the first head tap, in the same gesture that toggles
      // the card open. A delegated card-click listener can't be used
      // here: it fires after the head's own toggle, so it would also
      // build on collapse (when the class is already gone) and is
      // dropped entirely by the rebuildToolCardHead above (which
      // replaces the head on every result, taking any listener the
      // user armed while expanding the running call card with it).
      const head = card.querySelector('.tool-card__head');
      if (head) {
        head.addEventListener('click', function onExpand() {
          if (!card.classList.contains('is-expanded')) lazyBody();
          head.removeEventListener('click', onExpand);
        });
      }
    }
  }
  // Expand errors automatically so the user sees what went wrong
  // without an extra tap. Successful results stay collapsed.
  if (!toolResult.ok) card.classList.add('is-expanded');
  // Collapse on success: a card the user never touched (the running
  // card auto-expanded to stream live output) folds away on success,
  // keeping the transcript compact. For subagents the body stays
  // visible even collapsed (see the .tool-card--subagent CSS rule),
  // so the final nested chat is still readable; shell folds fully.
  else if (!card._userCollapsed) card.classList.remove('is-expanded');
  afterTranscriptAppend(refs, true);
}

// rebuildToolCardHead(card, toolName, args, pillClass, pillText)
function rebuildToolCardHead(card, toolName, args, pillClass, pillText, resultSummary) {
  const oldHead = card.querySelector(':scope > .tool-card__head');
  const fresh = buildToolCardHead(toolName, args, pillClass, pillText, resultSummary);
  if (oldHead && oldHead.parentNode === card) {
    card.replaceChild(fresh, oldHead);
  } else {
    card.insertBefore(fresh, card.firstChild);
  }
}

// appendSubagentNestedToolCall(parent, tc)
function appendSubagentNestedToolCall(parent, tc) {
  const fn = (tc && tc.function) || tc || {};
  const call = document.createElement('div');
  call.className = 'tool-card__subagent-tool';
  if (tc && tc.id) call.dataset.nestedToolId = tc.id;
  const callName = document.createElement('span');
  callName.className = 'tool-card__subagent-tool-name';
  callName.textContent = toolCardLabel(fn.name);
  const callArgs = document.createElement('pre');
  callArgs.className = 'tool-card__subagent-text';
  const rawArgs = fn.arguments != null ? fn.arguments : (tc && tc.args);
  let parsedArgs = rawArgs;
  if (typeof rawArgs === 'string') { try { parsedArgs = JSON.parse(rawArgs); } catch { /* keep raw string */ } }
  const callArgsText = typeof parsedArgs === 'object' && parsedArgs !== null
    ? formatToolArgs(parsedArgs, fn.name)
    : String(rawArgs || '');
  callArgs.textContent = shortToolText(callArgsText, 160);
  if (callArgsText && callArgs.textContent !== callArgsText) callArgs.title = callArgsText;
  call.appendChild(callName); call.appendChild(callArgs);
  parent.appendChild(call);
  return call;
}

function appendSubagentToolResult(parent, m) {
  const call = document.createElement('div');
  call.className = 'tool-card__subagent-tool';
  const callName = document.createElement('span');
  callName.className = 'tool-card__subagent-tool-name';
  callName.textContent = toolCardLabel(m.name);
  call.appendChild(callName);
  renderSubagentToolPreview(call, m.name, m.content);
  parent.appendChild(call);
}

// renderSubagentToolPreview(parent, name, raw)
//
// Use the per-tool preview renderer for the nested tool result.
function renderSubagentToolPreview(parent, name, raw) {
  const toolName = normalizeToolName(name);
  const r = coerceToolResult(raw, toolName);
  const preview = document.createElement('div');
  preview.className = 'tool-card__subagent-preview';
  parent.appendChild(preview);
  if (toolName === 'shell') return renderShellInPreview(preview, r);
  if (toolName === 'read_file') return renderReadFileInPreview(preview, r);
  if (toolName === 'list_files') return renderListFilesInPreview(preview, r);
  if (toolName === 'search_files') return renderSearchFilesInPreview(preview, r);
  if (toolName === 'edit_file') return renderEditFileInPreview(preview, r);
  if (toolName === 'write_file') return renderWriteFileInPreview(preview, r);
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
function renderShellInPreview(host, r) { return renderShellInto(host, r); }
function renderReadFileInPreview(host, r) { return renderReadFileInto(host, r); }
function renderListFilesInPreview(host, r) { return renderListFilesInto(host, r); }
function renderSearchFilesInPreview(host, r) { return renderSearchFilesInto(host, r); }
function renderEditFileInPreview(host, r) { return renderEditFileInto(host, r); }
function renderWriteFileInPreview(host, r) { return renderWriteFileInto(host, r); }
function renderPreviewInPreview(host, text, cls) {
  const pre = document.createElement('pre');
  pre.className = cls || 'tool-preview__pre';
  pre.textContent = text || '';
  host.appendChild(pre);
  return pre;
}

function renderShellInto(host, r) { renderShellToolResult(host, r); }
function renderReadFileInto(host, r) { renderReadFileToolResult(host, r); }
function renderListFilesInto(host, r) { renderListFilesToolResult(host, r); }
function renderSearchFilesInto(host, r) { renderSearchFilesToolResult(host, r); }
function renderEditFileInto(host, r) { renderEditFileToolResult(host, r); }
function renderWriteFileInto(host, r) { renderWriteFileToolResult(host, r); }

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
  for (const m of turns) {
    const role = m && m.role;
    if (role === 'tool') {
      // Tool turns are not chat bubbles — render them as compact
      // tool rows so the nested transcript shows the full loop
      // (assistant call → tool result) without breaking the
      // bubble rhythm for the user/assistant turns around them.
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length) {
        for (const tc of toolCalls) appendSubagentNestedToolCall(wrap, tc);
      } else {
        appendSubagentToolResult(wrap, m);
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--' + role + ' tool-card__subagent-msg';
    const roleEl = document.createElement('div');
    roleEl.className = 'chat-msg__role';
    roleEl.textContent = role;
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    const content = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content, null, 2) : '');
    if (role === 'assistant') {
      renderAssistantBody(body, content || '', '', true);
    } else {
      body.textContent = content || '';
    }
    row.appendChild(roleEl); row.appendChild(body);
    // Inline any tool calls attached to this assistant turn so the
    // bubble shows the full assistant→tool→assistant loop.
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of toolCalls) appendSubagentNestedToolCall(row, tc);
    wrap.appendChild(row);
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
  const state = { toolIds: new Set(), progressIds: new Set(), details: [] };
  if (!root) return state;
  for (const card of root.querySelectorAll('.tool-card.is-expanded')) {
    if (card.dataset && card.dataset.toolId) state.toolIds.add(card.dataset.toolId);
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

// renderMessageRow(state, refs, m)
//
// Render a single persisted message into a transcript row. Extracted
// from the old renderTranscript loop body so the chunked pass and the
// empty-transcript case can share the exact same rendering.
function renderMessageRow(state, refs, m) {
  if (m.role === 'tool' && m.phase === 'call') {
    appendToolCallCard({ id: m.toolCallId, name: m.name, args: m.args }, refs);
  } else if (m.role === 'tool' && m.phase === 'result') {
    appendToolResultCard({ id: m.toolCallId, name: m.name, ok: m.ok, args: m.args, result: m.content || '' }, refs);
  } else {
    appendMessageToTranscript(m, false, refs, state);
  }
}

function renderTranscriptChunked(state, refs, expanded) {
  const transcriptEl = refs.transcript.current;
  if (!transcriptEl) return;
  // Cancel any previous chunked pass so two overlapping renders can't
  // append the same rows twice.
  resetTranscriptRender(refs);
  const token = _renderToken;

  // First visible screen paints immediately: the system prompt, the
  // tools card, and enough messages to fill the viewport. Each append
  // calls afterTranscriptAppend, but while chunking is armed that
  // helper suppresses its scroll pin (transcript can't be scrolled to
  // a stable bottom yet) — the finalize step re-pins.
  refs._suspendScrollPin = true;

  const headRows = Math.min(state.messages.length, TRANSCRIPT_CHUNK_ROWS);
  for (let i = 0; i < headRows; i++) {
    const m = state.messages[i];
    if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) continue;
    renderMessageRow(state, refs, m);
  }
  if (state.messages.length <= headRows) {
    refs._suspendScrollPin = false;
    restoreExpandedState(expanded, transcriptEl);
    scrollTranscriptToBottomImpl(refs);
    updateUsageSummary(state, null, refs);
    return;
  }
  // Short transcripts finish in a single continuation frame so the box
  // paints before we pin and scroll; long ones keep chunking.
  if (state.messages.length < TRANSCRIPT_CHUNK_THRESHOLD) {
    refs._pendingTranscriptChunk = requestAnimationFrame(() => renderTranscriptChunk(state, refs, { index: headRows, token, expanded }));
    return;
  }
  refs._pendingTranscriptChunk = requestAnimationFrame(() => renderTranscriptChunk(state, refs, { index: headRows, token, expanded }));
}

function renderTranscriptChunk(state, refs, chunk) {
  if (chunk.token !== _renderToken) return; // superseded by a newer render
  const transcriptEl = refs.transcript.current;
  if (!transcriptEl) {
    refs._suspendScrollPin = false;
    return;
  }
  refs._pendingTranscriptChunk = null;
  let rendered = 0;
  while (chunk.index < state.messages.length && rendered < TRANSCRIPT_CHUNK_ROWS) {
    const m = state.messages[chunk.index];
    chunk.index++;
    if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) continue;
    renderMessageRow(state, refs, m);
    rendered++;
  }
  if (chunk.index < state.messages.length) {
    refs._pendingTranscriptChunk = requestAnimationFrame(() => renderTranscriptChunk(state, refs, chunk));
    return;
  }
  // Done: re-pin to the bottom and restore the user's expanded cards.
  refs._suspendScrollPin = false;
  restoreExpandedState(chunk.expanded, transcriptEl);
  scrollTranscriptToBottomImpl(refs);
  updateUsageSummary(state, null, refs);
}

// restoreExpandedState(state, root)
//
// Re-apply the expanded state captured by snapshotExpandedState to a
// freshly rebuilt transcript.
function restoreExpandedState(exp, root) {
  if (!root) return;
  for (const card of root.querySelectorAll('.tool-card')) {
    if (card.dataset && card.dataset.toolId && exp.toolIds.has(card.dataset.toolId)) {
      card.classList.add('is-expanded');
      // Result bodies render lazily on first expand (see
      // appendToolResultCard); restoring the class alone would show
      // an empty body for a card the user had open before a rebuild.
      if (typeof card._lazyBody === 'function') card._lazyBody();
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
  // Any in-flight chunked render is superseded: its rows are part of
  // the prefix and the tail is rendered here instead.
  resetTranscriptRender(refs);
  // If the transcript is still in its empty state (setup card + empty
  // state only), fall back to a full render so the setup card and
  // system prompt mount in the right order.
  if (prevCount === 0) {
    renderTranscript(state, refs);
    return;
  }
  for (let i = prevCount; i < total; i++) {
    const m = state.messages[i];
    if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) continue;
    renderMessageRow(state, refs, m);
  }
  // One scroll decision for the whole batch (countNew drives the
  // jump-to-bottom counter while unpinned).
  afterTranscriptAppend(refs, true);
  updateUsageSummary(state, null, refs);
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
  refs.transcript.current.innerHTML = '';
  refs.setupCard.current = null;
  if (!state.messages.length) {
    const card = buildSetupCardForMount(refs, state);
    refs.transcript.current.appendChild(card);
    refs.setupCard.current = card;
    const empty = buildEmptyState();
    refs.transcript.current.appendChild(empty);
    renderSystemPromptMessage(refs, state.systemPrompt);
    mountToolsCard(refs, state);
    mountAgentFilesCard(refs, state);
    return;
  }
  renderSystemPromptMessage(refs, state.systemPrompt);
  mountToolsCard(refs, state);
  mountAgentFilesCard(refs, state);
  // Long transcripts render progressively so the first screen paints
  // immediately instead of blocking on a full DOM+markdown rebuild.
  if (state.messages.length >= TRANSCRIPT_CHUNK_THRESHOLD) {
    renderTranscriptChunked(state, refs, expanded);
    return;
  }
  for (const m of state.messages) {
    if (m.role === 'assistant' && !String(m.content || '').trim() && !String(m.reasoning || '').trim()) {
      continue;
    }
    renderMessageRow(state, refs, m);
  }
  restoreExpandedState(expanded, refs.transcript.current);
  scrollTranscriptToBottomImpl(refs);
  updateUsageSummary(state, null, refs);
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
function scrollTranscriptToBottomImpl(refs) {
  const el = refs.transcript.current;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  refs.pinnedToBottom.current = true;
  refs.pendingCount.current = 0;
  updateJumpButton(refs);
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
