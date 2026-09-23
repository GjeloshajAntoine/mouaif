// mouaif web — Chat SSE stream + send + recovery
//
// Owns the lifecycle of a single turn: open the fetch, read SSE
// frames, dispatch them to the transcript/usage/stream-recovery
// modules, and reconcile with the server's authoritative transcript
// when the turn ends. The "send" wrapper and the "recover from a
// dropped connection" poller live here too.

import { fetchJson, parseSSEFrame } from '../../api.js';
import { createCounter } from '../../usage.js';
import {
appendDeltaToLive,
appendReasoningToLive,
appendMessageToTranscript,
appendErrorCard,
appendToolCallCard,
appendToolResultCard,
rekeyToolCard,
finalizeLiveMessage,
handleShellOutputEvent,
handleSubagentStreamEvent,
syncTranscriptAppend,
updateProgressCard,
prependOlderTranscript,
cancelTranscriptRender,
whenTranscriptSettled
} from './transcript.js';
import { afterTranscriptAppend } from './scroll.js';
import { renderUsageMeta, updateUsageSummary, setChatStatus } from './usage.js';
import { refreshChatTitle, updateChat } from './meta.js';
import { authorizationCard, askUserCard, removePendingAuthorizationCards } from './cards.js';
import { normalizeToolName, parseAtInvocation, findCustomActionInvocation, buildDirectMcpCall, parseDirectRestartInvocation, parseToolArgs } from './tools.js';
import { saveComposerDraftNow } from './composer.js';
import { subscribeLive } from './live.js';
import { mergeServerRows, nextServerMessageIndex, tailSyncDomAction } from './msgMerge.js';
import { toPublicImageAttachments } from './annotation.js';
import { mountOverlayCard } from './overlay.js';
import { PAGE_SIZE_DEFAULT } from './pagination.js';
import { costSnapshot } from './costSummary.js';

// retryFailedTurn(state, refs, payload)
//
// Re-send a failed model turn. Taps into `send` with `retry` +
// `manualRetry` flags so the failed output stays in the transcript and
// the retry posts a fresh user turn. Stops any in-flight stream
// recovery first (a mid-stream failure may have handed the turn to the
// reconnect poller) and clears the streaming latch so `send` is allowed
// to start.
export function retryFailedTurn(state, refs, payload) {
  if (state.reconnect && state.reconnect.active) stopStreamRecovery(state);
  state.streaming = false;
  state.watchingRun = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  return send(state, refs, Object.assign({ retry: true, manualRetry: true }, payload || {}));
}

// maybeAutoRetry(state, refs, payload)
//
// One-shot transparent retry for a turn that failed before the stream
// started (network error or a non-409 HTTP rejection). Honors the
// per-chat `autoRetry` setting and never fires for a retry itself, so a
// persistently failing message can't loop forever.
//
// `payload.retry` is what marks a retry: the failure sites thread their own
// `retry` / `manualRetry` flags into the payload they hand to the error card,
// so a turn that was already a retry arrives here marked and stops. Only a
// user tap on the error card's Retry button bypasses the guard (it sets
// `manualRetry`), which is the "retry as many times as you like" half of the
// documented behaviour. Without the marker the guard below never matched and
// every failing attempt re-armed the retry, so a server that was simply down
// looped until the browser died.
function maybeAutoRetry(state, refs, payload) {
  if (!state.autoRetry) return false;
  if (payload && payload.manualRetry) return false;
  if (payload && payload.retry) return false;
  setChatStatus(refs, 'auto-retrying…', 'busy');
  send(state, refs, Object.assign({}, payload, { retry: true, manualRetry: false })).catch(() => {});
  return true;
}

// markToolUsed(state, refs, toolName)
//
// Record that a tool was called in this chat session. Two effects:
//   1. If the tool is currently unchecked in the per-chat filter,
//      checking it happens automatically ("tools are started when
//      used") — the model clearly has it, so the filter should
//      reflect reality. Persisted via the normal toggle path.
//   2. The tool gets the "used" dot badge in the tree.
function markToolUsed(state, refs, toolName) {
  if (!state || !toolName) return;
  const name = normalizeToolName(toolName);
  if (!name) return;

  // Auto-check: if the filter is an explicit array and this tool is
  // missing, enable it. (filter === null already means "all on".)
  const t = state.tools || { catalog: [], filter: null };
  if (Array.isArray(t.filter) && t.filter.indexOf(name) < 0
      && (t.catalog || []).some((x) => x && x.name === name)) {
    if (typeof state._toggleTool === 'function') state._toggleTool(name, true);
  }

  const current = state.usedTools || new Set();
  if (!current.has(name)) {
    const next = new Set(current);
    next.add(name);
    state.usedTools = next;
  }
  // Re-render the tools card so the badge/check appears without
  // waiting for the next user interaction. toggleTool already
  // re-renders, so this is a no-op in that path.
  if (state._updateToolsCard) state._updateToolsCard();
}

// runShellCommand(cmd, state, refs, appendToolResultCardFn)
//
// `/shell <cmd>` composer command: run the native shell tool
// directly (no model round-trip) and render the result inline as a
// tool_result card.
export async function runShellCommand(cmd, state, refs) {
  const { projectDir, chatId } = state.props;
  const callId = 'direct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  refs.promptInput.current.value = '';
  refs._autoresize();
  appendToolCallCard({ id: callId, name: 'shell', args: { cmd } }, refs);
  setChatStatus(refs, 'running shell…', 'busy');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  async function requestShell() {
    const resp = await fetch('/api/tools/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId, callId, cmd })
    });
    if (resp.status === 409) return { status: 409, body: await resp.json() };
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('ndjson')) {
      // Plain JSON response (older server or a pre-run error such as
      // ETOOL_DISABLED / EDENIED): fall back to the one-shot read.
      return { status: resp.status, body: await resp.json() };
    }
    // NDJSON stream: `output` lines fill the shell card's live preview
    // while the command is running (same DOM path as the model-driven
    // shell_output SSE events); the final `result` line is the tool
    // result rendered by appendToolResultCard below.
    if (!resp.body) return { status: 500, body: { ok: false, error: 'empty shell response' } };
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let resultBody = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line) continue;
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          if (frame.type === 'output' && typeof frame.delta === 'string') {
            handleShellOutputEvent({ id: callId, stream: frame.stream, delta: frame.delta }, refs);
          } else if (frame.type === 'result' && frame.result) {
            resultBody = frame.result;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    if (!resultBody) resultBody = { ok: false, error: 'empty shell response' };
    return { status: 200, body: resultBody };
  }
  let r;
  try {
    r = await requestShell();
    if (r.status === 409 && r.body && r.body.code === 'EAUTH_REQUIRED') {
      let resumed = null;
      const decision = await authorizationCard(r.body, projectDir, chatId, refs, async () => { resumed = await requestShell(); }, state);
      if (decision === 'deny') {
        r = { status: 403, body: { ok: false, code: 'EDENIED', error: 'user denied' } };
      } else {
        r = resumed;
      }
    }
  } catch (err) {
    appendToolResultCard({ id: callId, name: 'shell', args: { cmd }, ok: false, result: { error: String(err) } }, refs);
    setChatStatus(refs, 'shell error', 'error');
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    return;
  }
  const body = r.body || {};
  appendToolResultCard({ id: callId, name: 'shell', ok: !!body.ok, result: body }, refs);
  if (r.status === 403) setChatStatus(refs, 'shell tool is disabled for this project', 'error');
  else setChatStatus(refs, body.ok ? ('shell exit ' + (body.exitCode ?? 0)) : ('shell failed: ' + (body.error || body.code || '')), body.ok ? 'success' : 'error');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
}

// runAgentCommand(agentName, task, state, refs)
//
// `@<agentName> <task>` composer command: dispatch a project agent
// directly through POST /api/tools/subagent — no model round-trip to
// decide whether to delegate. The nested run's text is appended to
// the transcript as an assistant message so it persists; tool_call
// and tool_result cards render inline exactly like the shell path.
export async function runAgentCommand(agentName, task, state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  refs.promptInput.current.value = '';
  refs._autoresize();
  const args = { task, agent: agentName };
  // The server mints this call's id and returns it (`direct_…`). The card is
  // opened before we know it, so it is re-keyed below once the answer lands:
  // a placeholder id would never match the tool result, and the result would
  // then render as a SECOND card while this one sat on "Subagent is
  // working…" forever. On the error path there is no id to adopt, so the card
  // is retired instead of left hanging (the error card the same path renders
  // is the user-facing report).
  const pendingCard = appendToolCallCard({ id: 'pending', name: 'subagent', args }, refs);
  setChatStatus(refs, 'running agent ' + agentName + '…', 'busy');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
  let r;
  try {
    r = await fetchJson('/api/tools/subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId, task, agent: agentName })
    });
  } catch (err) {
    // Nothing will ever fold into the placeholder card: retire it so the
    // transcript is not left with a spinner that can never resolve.
    if (pendingCard && pendingCard.isConnected) pendingCard.remove();
    appendToolResultCard({ id: null, name: 'subagent', args, ok: false, result: { error: String(err) } }, refs);
    setChatStatus(refs, 'agent error', 'error');
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    return;
  }
  const body = r.body || {};
  // Re-key the placeholder to the id the server actually used, BEFORE the
  // result is appended: both sides then agree on `data-tool-id` and the
  // result updates this card in place (head rebuilt with the ok/error pill)
  // instead of adding a duplicate.
  const serverId = body.id || (body.toolCall && body.toolCall.id) || null;
  if (pendingCard && pendingCard.isConnected) {
    if (serverId) rekeyToolCard(refs, serverId, pendingCard);
    else if (!body.ok) pendingCard.remove(); // failed with no id: don't strand it
  }
  appendToolResultCard({ id: body.id || null, name: 'subagent', ok: !!body.ok, result: body.result || body }, refs);
  // Fold the persisted agent result into the live transcript immediately.
  // Its usage/cost is included so the header Total updates before reload.
  const text = body.result && typeof body.result.text === 'string' ? body.result.text : '';
  if (text) {
    const msg = {
      role: 'assistant',
      content: text,
      ts: new Date().toISOString(),
      modelId: body.result.model && body.result.model.id,
      usage: body.result.usage || undefined,
      cost: body.result.cost || undefined
    };
    state.messages = state.messages.concat([msg]);
    appendMessageToTranscript(msg, false, refs, state);
    updateUsageSummary(state, null, refs);
  }
  if (r.status === 403) setChatStatus(refs, 'subagent tool is disabled for this project', 'error');
  else if (!body.ok) setChatStatus(refs, 'agent failed: ' + ((body.result && body.result.error && body.result.error.message) || body.error || 'unknown'), 'error');
  else setChatStatus(refs, 'agent ' + agentName + ' done', 'success');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
}

// runMcpCommand(serverId, toolName, label, state, refs, args)
//
// Direct MCP tool invocation from the @-mention popup.
// Calls POST /api/mcp/call and renders a tool_call + tool_result card.
export async function runMcpCommand(serverId, toolName, label, state, refs, args) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId || !serverId) return;
  const callArgs = args || {};
  const callId = 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  refs.promptInput.current.value = '';
  refs._autoresize();
  appendToolCallCard({ id: callId, name: label || toolName, args: callArgs }, refs);
  setChatStatus(refs, 'calling MCP ' + (label || toolName) + '…', 'busy');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  async function requestMcp() {
    return fetchJson('/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDirectMcpCall({ projectDir, chatId, callId, serverId, toolName, args: callArgs }))
    });
  }
  let r;
  try {
    r = await requestMcp();
    if (r.status === 409 && r.body && r.body.code === 'EAUTH_REQUIRED') {
      let resumed = null;
      const decision = await authorizationCard(r.body, projectDir, chatId, refs, async () => { resumed = await requestMcp(); }, state);
      r = decision === 'deny'
        ? { status: 403, body: { ok: false, code: 'EDENIED', error: 'user denied' } }
        : resumed;
    }
  } catch (err) {
    appendToolResultCard({ id: null, name: label || toolName, args: callArgs, ok: false, result: { error: String(err) } }, refs);
    setChatStatus(refs, 'MCP error', 'error');
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    return;
  }
  const body = (r && r.body) || {};
  appendToolResultCard({ id: callId, name: label || toolName, ok: r && r.status === 200 && body.ok !== false, result: body }, refs);
  if (r && r.status === 403) setChatStatus(refs, 'MCP tool is disabled', 'error');
  else if (!r || r.status !== 200) setChatStatus(refs, 'MCP failed: ' + (body.error || body.code || 'HTTP ' + (r && r.status)), 'error');
  else setChatStatus(refs, 'MCP ' + (label || toolName) + ' done', 'success');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
}

// runCustomAction(action, state, refs)
//
// Execute a project-defined CLI or MCP shortcut without a model round-trip.
// The server resolves the saved definition and applies the underlying tool's
// authorization gate, so the browser never gets to substitute a command.
export async function runRestartCommand(reason, state, refs, options = {}) {
const { projectDir, chatId } = state.props;
if (!projectDir || !chatId) return;
const callId = 'restart_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const restartReason = String(reason || '').trim() || 'User requested restart from chat';
if (refs.promptInput.current) refs.promptInput.current.value = '';
if (typeof options.clearComposerDraft === 'function') await options.clearComposerDraft();
if (typeof options.setImageAttachments === 'function') options.setImageAttachments([]);
refs._autoresize();
appendToolCallCard({ id: callId, name: 'restart_app', args: { reason: restartReason } }, refs);
setChatStatus(refs, 'restarting app…', 'busy');
if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
let response;
try {
response = await fetchJson('/api/restart', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ reason: restartReason, delayMs: 1000 })
});
} catch (error) {
response = { status: 500, body: { ok: false, error: String(error) } };
}
const body = response.body || {};
appendToolResultCard({ id: callId, name: 'restart_app', ok: response.status === 200 && body.ok !== false, result: body }, refs);
if (response.status === 200 && body.ok !== false) {
setChatStatus(refs, 'restart requested', 'success');
} else {
setChatStatus(refs, 'restart failed: ' + (body.error || body.code || 'HTTP ' + response.status), 'error');
if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
}
}
export async function runCustomAction(action, state, refs) {
if (!action || !action.id) return;
const { projectDir, chatId } = state.props;
const callId = 'action_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const toolName = 'action:' + action.id;
if (refs.promptInput.current) refs.promptInput.current.value = '';
refs._autoresize();
appendToolCallCard({ id: callId, name: toolName, args: { action: action.label || action.id } }, refs);
setChatStatus(refs, 'running ' + (action.label || action.id) + '…', 'busy');
if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
async function request() {
return fetchJson('/api/actions/' + encodeURIComponent(action.id) + '/run', {
method: 'POST', headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ projectDir, chatId, callId })
});
}
let response;
try {
response = await request();
if (response.status === 409 && response.body && response.body.code === 'EAUTH_REQUIRED') {
let resumed = null;
const decision = await authorizationCard(response.body, projectDir, chatId, refs, async () => { resumed = await request(); }, state);
response = decision === 'deny' ? { status: 403, body: { ok: false, error: 'user denied' } } : resumed;
}
} catch (error) {
response = { status: 500, body: { ok: false, error: String(error) } };
}
const body = response && response.body || {};
const result = body.result || body;
const resultText = result && Array.isArray(result.content)
? result.content.map((item) => item && item.type === 'text' ? item.text : '').filter(Boolean).join('\n')
: '';
appendToolResultCard({ id: callId, name: toolName, ok: response.status === 200 && body.ok !== false, result }, refs);
if (response.status === 200 && body.ok !== false) setChatStatus(refs, (action.label || action.id) + ' done', 'success');
else setChatStatus(refs, (action.label || action.id) + ' failed: ' + (body.error || result.error || resultText || body.code || 'unknown'), 'error');
if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
}
async function fetchRunState(projectDir, chatId) {
  const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/revision?projectDir=' + encodeURIComponent(projectDir));
  if (r.status !== 200 || !r.body) return null;
  return { nextSeq: Number(r.body.nextSeq) || 0, running: !!r.body.running };
}

async function fetchMessagesFromSeq(projectDir, chatId, fromSeq) {
const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir) + '&fromSeq=' + fromSeq);
if (r.status !== 200 || !r.body || !Array.isArray(r.body.messages)) return null;
return r.body;
}
// fetchMessagesWindow(projectDir, chatId, opts) -> { messages, total, hasMore, beforeSeq }
//
// Fetch one backward page of the transcript. `opts.beforeSeq` is the
// exclusive upper seq bound for OLDER rows (pass nothing for the newest
// page); the server returns up to `opts.limit` rows strictly below it.
// `hasMore` tells the caller whether an even older page exists. This is
// the load path for the scroll-up pagination loader — opening a long chat
// fetches just the tail, and older history is pulled on demand.
async function fetchMessagesWindow(projectDir, chatId, opts) {
const limit = Math.max(1, Math.min(200, (opts && opts.limit) || 100));
let url = '/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir) + '&limit=' + limit;
if (opts && typeof opts.beforeSeq === 'number' && isFinite(opts.beforeSeq) && opts.beforeSeq >= 0) {
url += '&beforeSeq=' + opts.beforeSeq;
}
const r = await fetchJson(url);
if (r.status !== 200 || !r.body || !Array.isArray(r.body.messages)) return null;
return {
messages: r.body.messages,
total: typeof r.body.total === 'number' ? r.body.total : r.body.messages.length,
hasMore: !!r.body.hasMore,
beforeSeq: (typeof r.body.beforeSeq === 'number' && isFinite(r.body.beforeSeq)) ? r.body.beforeSeq : null
};
}
// fetchAndPrependOlderPage(state, refs, pager) -> Promise<boolean>
//
// Fetch ONE older page and prepend it to the transcript, updating the
// pagination cursor. Latch-free — the caller owns the in-flight latch
// (either the scroll loader's single-page latch or the eager drainer's
// session latch), so a drain loop can reuse this core without its own
// call being swallowed by `loading === true`. Returns whether the DOM
// changed; `pager.hasMore` — set from the server's own flag — is the only
// authority on whether older history remains. The prepend preserves
// scroll position.
async function fetchAndPrependOlderPage(state, refs, pager) {
if (!pager || !state || !refs) return false;
if (!pager.hasMore) return false;
if (pager.beforeSeq === null) return false;
const { projectDir, chatId } = state.props;
try {
const body = await fetchMessagesWindow(projectDir, chatId, {
limit: PAGE_SIZE_DEFAULT,
beforeSeq: pager.beforeSeq
});
if (!body || !Array.isArray(body.messages) || !body.messages.length) {
// No rows returned: we've reached the top. Signal "no more".
pager.hasMore = false;
pager.beforeSeq = null;
return true;
}
// Prepending could run while a chunked render or reconcile is in play;
// guard against overlap by cancelling superseded transcript renders so
// the inserted rows aren't wiped or duplicated. The reset also clears
// the scroll-pin suppress flag that a stale pass might have left.
if (typeof cancelTranscriptRender === 'function') cancelTranscriptRender(refs);
// Dedup on seq: a row the server already gave us (e.g. a window edge
// from a reconcile that landed between loads) must be skipped so the
// same message never draws twice.
const seen = state.seenSeqs;
const fresh = body.messages.filter((m) => {
if (typeof m.seq !== 'number') return true;
if (seen.has(m.seq)) return false;
seen.add(m.seq);
return true;
});
const inserted = prependOlderTranscript(state, refs, fresh);
// Keep `state.messages` in sync with the paginated DOM so a later
// rebuild (reconcile, recovery, full render) does not wipe the older
// pages the user already loaded. Prepend the fresh rows to the front
// of the list (they are the oldest known so far) and seed their seqs
// into the seen-set. A rebuild re-renders the full array including
// these rows in order.
if (fresh.length) {
const have = Array.isArray(state.messages) ? state.messages : [];
const haveSeqs = new Set();
for (const m of have) if (typeof m.seq === 'number') haveSeqs.add(m.seq);
const reallyFresh = fresh.filter((m) => typeof m.seq !== 'number' || !haveSeqs.has(m.seq));
if (reallyFresh.length) state.messages = reallyFresh.concat(have);
}
// Advance the cursor from the server's authoritative next old bound,
// NOT from the (possibly deduped) count, so pages never skip a seq.
if (typeof body.beforeSeq === 'number' && body.beforeSeq >= 0) {
pager.beforeSeq = body.beforeSeq;
} else if (body.messages.length && typeof body.messages[0].seq === 'number') {
pager.beforeSeq = body.messages[0].seq;
} else {
pager.beforeSeq = null;
}
pager.hasMore = !!body.hasMore;
pager.offset += body.messages.length;
pager.firstSeq = fresh.length ? fresh[0].seq : pager.firstSeq;
// `inserted` says whether the DOM changed, NOT whether more history
// exists. A page whose rows were all already in `seenSeqs` (a window
// edge from a reconcile that landed between loads) inserts nothing yet
// is real progress: `beforeSeq` advanced. Forcing hasMore to false there
// silently hid every remaining older page. Only the server's answer ends
// pagination; the scroll handler already ignores a `false` return.
return inserted;

} catch {
// Leave hasMore true so a later scroll can retry; clearing it would
// permanently hide history that a transient failure interrupted.
return false;
}
}
// loadOlderMessages(state, refs, pager) -> Promise<boolean>
//
// Fetch the next older page and prepend it to the transcript, updating
// the pagination cursor. The boolean is whether the DOM actually changed
// (rows were inserted); it is NOT a "more history exists" signal — read
// `pager.hasMore` for that. Failures keep the pager intact so the next
// scroll retries. The caller (the scroll-up listener) awaits this so a
// single in-flight page flag can stay across the fetch. The prepend
// preserves scroll position.
export async function loadOlderMessages(state, refs, pager) {
if (!pager || !state || !refs) return false;
if (pager.loading) return false;
pager.loading = true;
try {
return await fetchAndPrependOlderPage(state, refs, pager);
} finally {
pager.loading = false;
}
}
// loadAllOlderMessages(state, refs, pager) -> Promise<void>
//
// Drained-loop eager loader: keep fetching older pages in the
// background until the ENTIRE transcript is in memory, not just the
// newest window. Each page still renders incrementally above the
// anchor and preserves the reading position, so the transcript stays
// fully scrollable with no per-page load delay. The loop is
// deliberately staggered between pages so it yields to the event loop
// and never blocks paint — and it locks the pager flag the whole run
// so the scroll-up path and this drainer can never double-fetch.
//
// This replaces the "open the chat, then wait for a scroll to the top
// to pull each older page" behaviour with "open the chat, then let it
// catch up in the background". The newest page still paints
// immediately; the rest arrives shortly after. Loads stop early under
// any of: an active stream turn (the tail is being written right now,
// so loading older pages is pointless churn), a transient fetch error
// (retried on the next scroll), or a chat/project change (an
// aborted run must not write into a detached transcript).
export async function loadAllOlderMessages(state, refs, pager) {
if (!pager || !state || !refs) return;
// A live turn owns the tail; do not race it for older rows. The
// pager's "next older page" is still valid once the turn settles.
if (state.streaming || state.watchingRun) return;
// Latch the whole drain so the scroll-up loader stays no-op until
// we finish (or bail). loadOlderMessages would otherwise also see
// `loading` true and return early, which is what we want.
if (pager.loading) return;
pager.loading = true;
// Capture the chat the drain belongs to. `state`/`refs` are reused
// across chat navigation (ChatView is not remounted), so after an
// await the props may now point at a DIFFERENT chat; writing an old
// chat's older pages into the new chat's transcript (or fetching the
// new chat with the old cursor) would corrupt the view. Bail as soon
// as the identity drifts.
const { projectDir, chatId } = state.props;
try {
// Give the first paint a chance to land before we start inserting
// rows above it. The initial window is already painted synchronously
// by the time this runs (see the eager call site), so this just
// breathes before the first prepend.
await whenTranscriptSettled(refs);
if (!pager.hasMore || pager.beforeSeq === null) return;
for (;;) {
// Chat change / live turn / unmounted transcript — stop, so we
// neither churn a live run nor fetch the next chat's rows with
// this chat's cursor.
if (state.props.projectDir !== projectDir || state.props.chatId !== chatId) return;
if (state.streaming || state.watchingRun) return;
if (typeof refs.transcript === 'undefined' || (refs.transcript && !refs.transcript.current)) return;
const before = pager.beforeSeq;
await fetchAndPrependOlderPage(state, refs, pager);
// The cursor, not the "did the DOM change" return value, decides
// whether we made progress. A fetch error leaves it untouched, so
// we stop and retry on the next scroll; a page whose rows were all
// already on screen still advances it and must NOT end the drain —
// that page is real progress toward the top of the history.
if (pager.beforeSeq === before) return;
// Yield between pages so the browser can paint the just-inserted
// rows before more are prepended.
await new Promise((resolve) => setTimeout(resolve, 0));
}

} finally {
pager.loading = false;
}
}
async function fullRebuildFromServer(state, refs, nextSeq) {
  const { projectDir, chatId } = state.props;
  const body = await fetchMessagesFromSeq(projectDir, chatId, 0);
  if (!body) return null;
  state.messages = body.messages;
  state.costSnapshot = costSnapshot(body);
  // A refreshed snapshot already covers every attributed run, so the client's
  // session delta is rebased away here rather than counted twice.
  state.attributedCost = 0;
  state.seenSeqs = new Set(body.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq));
  state.transcriptNextSeq = typeof body.nextSeq === 'number' ? body.nextSeq : nextSeq;
  if (state._renderTranscript) state._renderTranscript();
  return 'rebuilt';
}

function applyTailSync(state, refs, nextSeq, tail) {
  if (!Array.isArray(tail)) return null;
  state.transcriptNextSeq = nextSeq;
  const prev = state.messages;
  const prevLen = prev.length;
  const merged = mergeServerRows(state, tail);
  if (merged === prev) return 'appended';
  state.messages = merged;
  // syncTranscriptAppend renders ONLY the new tail (messages[prevLen…]) and
  // appends it to the DOM, which is correct only for a pure append — every
  // prior row still at its old index by reference. mergeServerRows also
  // replaces a seq-less optimistic twin in place and splices a late-arriving
  // persisted row into the MIDDLE, both of which move the prefix. Appending
  // the tail then repaints an on-screen row (a visible duplicate) or drops a
  // row at the bottom (wrong order), which the next poll's full rebuild
  // corrects as a visible reload/flash. tailSyncDomAction picks the safe path:
  // a full reconcile render (which reuses unchanged nodes — no re-animate) for
  // a moved prefix, the cheap append only for a genuine append.
  const action = tailSyncDomAction(prev, merged);
  if (action === 'render') {
    if (state._renderTranscript) state._renderTranscript();
  } else if (action === 'append') {
    syncTranscriptAppend(state, refs, prevLen);
  }
  return 'appended';
}

async function syncToNextSeq(state, refs, serverNextSeq) {
  const { projectDir, chatId } = state.props;
  const localNextSeq = nextServerMessageIndex(state);
  if (serverNextSeq < localNextSeq) return fullRebuildFromServer(state, refs, serverNextSeq);
  if (serverNextSeq === localNextSeq) { state.transcriptNextSeq = serverNextSeq; return 'stable'; }
  const body = await fetchMessagesFromSeq(projectDir, chatId, localNextSeq);
  if (!body) return null;
  if (typeof body.nextSeq === 'number' && body.nextSeq < localNextSeq) return fullRebuildFromServer(state, refs, body.nextSeq);
  const result = applyTailSync(state, refs, typeof body.nextSeq === 'number' ? body.nextSeq : serverNextSeq, body.messages);
  // Rebase only after optimistic segments have been replaced by server
  // rows. Metadata saves and older-page loads must not advance this cursor.
  const snapshot = costSnapshot(body);
  if (snapshot) {
    state.costSnapshot = snapshot;
    state.attributedCost = 0;
  }
  updateUsageSummary(state, null, refs);
  return result;
}

// startStreamRecovery / stopStreamRecovery
//
// When the live stream drops mid-turn the server keeps writing the
// run to the transcript file, so we recover by syncing from disk via
// the single reconcile poll (useChatState). Recovery does NOT run its
// own timer: it sets the `reconnect` flags and kicks the shared poll
// once so the first sync happens immediately; the poll tick() then
// keeps running the recovery sync while reconnect.active is set.
export function startStreamRecovery(state, refs, partialText) {
  const st = state.reconnect;
  st.active = true;
  st.attempts = 0;
  st.stopped = false;
  st.partialText = partialText || '';
  state.streaming = true; // still 'in a turn' for the send guard
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
  // When starting recovery, update any shell call cards that are on
  // screen to show 'reconnecting' instead of 'Running'. The live
  // SSE stream is gone, so their output preview stays empty until the
  // final tool_result arrives via the reconcile poll. Without this
  // hint the user sees a spinner with zero output and no feedback.
  if (refs.transcript && refs.transcript.current) {
    const shellCards = refs.transcript.current.querySelectorAll(
      '.tool-card--call[data-tool-name="shell"]:not(.tool-card--result) .tool-card__shell-live-hint'
    );
    for (const hint of shellCards) {
      hint.textContent = 'Reconnecting — waiting for output…';
    }
  }
  setChatStatus(refs, 'connection lost — reconnecting…', 'busy');
  // Kick the shared poll now — it may be parked at the idle 3 s/6 s
  // interval, and the first disk sync should happen straight away.
  if (typeof state._kickPoll === 'function') state._kickPoll();
}

export function stopStreamRecovery(state) {
  const st = state.reconnect;
  st.stopped = true;
  st.active = false;
  st.attempts = 0;
}
// loadPendingAuthorization — pull the server's list of prompts this
// chat is parked on and (re-)mount their cards. Returns the number of
// pending prompts so the reconcile poll can tell a genuinely-waiting
// run apart from a torn/finished one. Safe to call every tick:
// mountOverlayCard de-dupes by call-id and only mounts once the
// transcript has actually painted, so a card missed on the first paint
// (page reload, tab switch, or the transcript not being up yet) gets
// re-mounted on a later tick instead of being lost.
export async function loadPendingAuthorization(state, refs) {
const { projectDir, chatId } = state.props;
if (!projectDir || !chatId || !refs.transcript.current) return 0;
const isCurrentChat = () => state.props.projectDir === projectDir && state.props.chatId === chatId;
let r;
try {
r = await fetchJson('/api/tools/authorization/pending?projectDir=' + encodeURIComponent(projectDir) + '&chatId=' + encodeURIComponent(chatId));
} catch { return 0; }
// ChatView can be reused when hash navigation switches chats. Do not let a
// slow response from the page we just left mount its approval card into the
// page we returned to.
if (!isCurrentChat() || !refs.transcript.current) return 0;
if (r.status !== 200 || !r.body || !Array.isArray(r.body.pending)) return 0;
let count = 0;
for (const request of r.body.pending) {
if (!request || !request.callId) continue;
count++;
if (request.tool === 'ask_user' && request.args) {
const data = Object.assign({}, request.args, { callId: request.callId, tool: request.tool });
mountOverlayCard(refs, request.callId, () => {
if (isCurrentChat()) askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st));
});
} else {
mountOverlayCard(refs, request.callId, () => {
if (isCurrentChat()) authorizationCard(request, projectDir, chatId, refs, null, state);
});
}
}
return count;
}

export async function cancelRunningChat(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  setChatStatus(refs, 'cancelling…', 'busy');
  let r;
  try {
    r = await fetchJson('/api/tools/authorization/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId })
    });
  } catch {
    setChatStatus(refs, 'cancel failed — server unreachable', 'error');
    return;
  }
  if (r.status !== 200) {
    setChatStatus(refs, 'cancel failed: HTTP ' + r.status, 'error');
    return;
  }
  removePendingAuthorizationCards(refs);
  // Stop any in-flight stream-recovery poller first — otherwise it
  // keeps ticking after the cancel and flips the status back to
  // "reconnecting…", fighting the cancel.
  stopStreamRecovery(state);
  state.streaming = false;
  state.watchingRun = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  await reconcileRunningChat(state, refs);
  setChatStatus(refs, 'cancel requested', 'success');
}

// send(state, refs, options)
//
// Send a user turn. The model picker is the source of truth (not a
// <select> value) — the chat record carries { providerId, modelId }.
//
// `options.retry` marks a re-run of a failed turn: the user message is
// posted fresh (not echoed back into the composer) but no duplicate
// optimistic bubble is appended. `options.manualRetry` is a user tap on
// the error card's Retry button — it bypasses the one-shot auto-retry
// guard so the user can retry as many times as they like.
// abortStream(state) — stop this client's local SSE turn.
//
// Called when the user leaves the chat or the view unmounts. The server
// keeps running the turn (a backgrounded tab must not cancel it), but this
// reader must not: it held the fetch and its connection open, kept writing
// deltas into `state.messages`, and rendered them into whatever transcript
// was mounted by then — so a turn left mid-stream could paint the previous
// chat's tool cards and text into the chat the user switched to.
export function abortStream(state) {
  const controller = state && state.streamAbort;
  if (!controller) return false;
  state.streamAbort = null;
  try { controller.abort(); } catch { /* already aborted or unsupported */ }
  return true;
}

export async function send(state, refs, options) {
const { content, attachments, clearComposerDraft, setImageAttachments, retry, manualRetry } = options || {};
const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  const c = state.chat || {};
  const modelId = c.modelId || '';
  const providerId = c.providerId || '';
  const text = (content != null ? content : (refs.promptInput.current.value || '')).trim();
const localAtts = attachments || state.imageAttachments;
const atts = toPublicImageAttachments(localAtts);
if (!text && !atts.length) {
if (refs.status.current) refs.status.current.textContent = 'type something or add an image';
return;
}
  // A turn is already streaming from THIS client or being followed
  // from another tab/device. Bail out before the composer is cleared so
  // the typed text is never lost. (The server would 409 anyway; this also
  // covers the Enter-key path, which bypasses the disabled send button.)
  if (state.streaming || state.watchingRun) {
    setChatStatus(refs, 'wait for the current response to finish', 'busy');
    return;
  }
// /shell <cmd> — direct tool invocation, no model.
if (text.startsWith('/shell ')) {
const cmd = text.slice('/shell '.length).trim();
if (cmd) return runShellCommand(cmd, state, refs);
}
// An exact @restart_app composer command is an explicit user request, not
// an autonomous model tool call. Dispatch it directly so Ask mode does not
// ask the user to approve the restart they just requested. Model-initiated
// restart_app calls still pass through the shared authorization gate.
const restartInvocation = parseDirectRestartInvocation(text);
if (restartInvocation) return runRestartCommand(restartInvocation.reason, state, refs, {
clearComposerDraft,
setImageAttachments
});
// @<toolname> <args?> — direct tool invocation via @-mention syntax.
  // Only fires when the text starts with @ and names a directly-invocable
  // tool (shell or mcp__...). Native tools (read_file, write_file, etc.)
  // and file references fall through to the normal model send — the popup
  // inserts @path for file refs too, and we don't want to silently drop
  // those when the user hits Enter.
  const atMatch = parseAtInvocation(text);
if (atMatch) {
const toolName = atMatch.toolName;
const rest = atMatch.rest;
// @<custom-action> — direct project shortcut. Custom actions do not
// accept ad-hoc arguments; their command or MCP args are saved in settings.
const customAction = findCustomActionInvocation(text, state.customActions);
if (customAction) return runCustomAction(customAction, state, refs);
// @<agent> <task> — direct project-agent dispatch. Checked before
    // the tool catalog: agent names live in .mouaif.json, not the tool
    // list. Only a leading @ with a non-empty task dispatches.
    if (rest && Array.isArray(state.agents) && state.agents.some(a => a && a.name === toolName)) {
      return runAgentCommand(toolName, rest, state, refs);
    }
    const t = state.tools || { catalog: [] };
    const toolSpec = (t.catalog || []).find(x => x && x.name === toolName);
    if (toolSpec) {
      if (String(toolName).startsWith('mcp__')) {
        // MCP tool — the catalog carries the stable server ID required by
        // the direct endpoint; the composed name still supplies the tool name.
        const parts = String(toolName).split('__');
        if (parts.length >= 3 && toolSpec.serverId) {
          const mcpTool = parts.slice(2).join('__');
          const args = rest ? parseToolArgs(rest) : null;
          if (args) {
            return runMcpCommand(toolSpec.serverId, mcpTool, toolName, state, refs, args);
          }
        }
      } else if (toolName === 'shell') {
        if (rest) return runShellCommand(rest, state, refs);
      }
    }
    // Not a directly-invocable tool (native file tool, empty-arg shell/MCP,
    // or plain file path). Fall through to normal model send.
  }
  if (!modelId || !providerId) {
    // If the chat has no provider+model yet, open the picker so
    // the user is one tap from picking one.
    const msg = !state.providers.length ? 'add a provider in Settings → Providers' : 'pick a model';
    setChatStatus(refs, msg, 'error');
    if (state._openModelPicker) state._openModelPicker();
    return;
  }

  // Mark streaming BEFORE the awaited updateChat below: the reconcile
  // poller skips running chats, and without this a 1s reconcile tick
  // landing in the await window could replace state.messages and
  // re-render, after which the optimistic user bubble appended below
  // would be duplicated by the next sync.
  state.streaming = true;
  state.nextLiveSeq = 0;

  // Persist the pair before sending so reopening this chat keeps
  // the exact provider/model choice. Skipped when the server record
  // already carries this pair (state._persistedModelPair is updated
  // on load and after every successful PATCH) — the picker persists
  // on selection, so the common case is a no-op and a PATCH here
  // would be a wasted round-trip on every send.
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
  setChatStatus(refs, 'preparing message…', 'busy');
  try {
    if (state._persistedModelPair !== providerId + '|' + modelId) {
      if (await updateChat({ providerId, modelId }, state, refs) === false) {
        throw new Error('model settings could not be saved');
      }
    }
    // Keep the exact draft (including whitespace and attachments) in the
    // composer until persistence succeeds. Preparation failures must not
    // leave a cleared composer or a streaming latch with no request behind it.
    if (!retry && clearComposerDraft && await clearComposerDraft() === false) {
      throw new Error('draft could not be saved');
    }
  } catch {
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    setChatStatus(refs, 'Could not prepare message — your draft is unchanged. Try sending again.', 'error');
    return;
  }
  setChatStatus(refs, 'streaming…', 'busy');
if (!retry) {
if (refs.promptInput.current) refs.promptInput.current.value = '';
if (setImageAttachments) setImageAttachments([]);
if (refs.imageInput.current) refs.imageInput.current.value = '';
refs._autoresize();
}
const userMsg = retry ? null : { role: 'user', content: text, attachments: atts, ts: new Date().toISOString() };
if (!retry) {
state.messages = state.messages.concat([userMsg]);
appendMessageToTranscript(userMsg, false, refs, state);
// The first message ends the creation phase: remove the
// prompt-size setup control for good (the prompt size is now
// fixed).
if (state._updateSetupVisibility) state._updateSetupVisibility();
}

  // Live per-turn counter. The chat UI runs this on every message AND
  // reasoning delta (thinking tokens count toward the upstream's
  // completionTokens, so the window must span the thinking phase too);
  // the server's authoritative completionTokens (sent on `done`)
  // replaces the heuristic on the final tick.
  const counter = createCounter();

  // Read the effective thinking level: if the dropdown is set to
  // __custom__, use the custom input value instead of the sentinel.
  const effectiveThinkingLevel = (() => {
    const tl = state.thinkingLevel || '';
    if (tl === '__custom__') {
      return (refs.thinkingLevelCustom && refs.thinkingLevelCustom.current && refs.thinkingLevelCustom.current.value.trim()) || '';
    }
    return tl;
  })();

  let resp;
  // Abortable so leaving the chat (or unmounting) stops this reader; see
  // abortStream() above.
  const streamAbort = new AbortController();
  state.streamAbort = streamAbort;
try {
resp = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages/stream', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
signal: streamAbort.signal,
body: JSON.stringify({ projectDir, modelId, providerId, content: text, attachments: atts, thinkingLevel: effectiveThinkingLevel, maxOutputTokens: state.maxOutputTokens || '' })
});
} catch (err) {
    // Leaving the chat aborts the fetch. That is not a network failure, so
    // it must not raise an error card or trigger the auto-retry.
    if (err && err.name === 'AbortError') {
      if (state.streamAbort === streamAbort) state.streamAbort = null;
      state.streaming = false;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
      return;
    }
const failMsg = 'Network error — could not reach the server. Your message was sent to the transcript but the response never started.';
  // The retry flags ride along so the error card's Retry button keeps them
  // AND so maybeAutoRetry can see that this turn was already a retry.
  const payload = { content: text, attachments: atts, clearComposerDraft, setImageAttachments, retry, manualRetry };
    setChatStatus(refs, 'network error', 'error');
    appendErrorCard(failMsg + ' Try again.', refs, state, { onRetry: () => retryFailedTurn(state, refs, payload) });
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    maybeAutoRetry(state, refs, payload);
    return;
  }
  if (!resp.ok) {
    let errText = '';
    try { errText = await resp.text(); } catch { /* ignore */ }
    let errMsg = 'HTTP ' + resp.status;
    try { const j = JSON.parse(errText); if (j && j.error) errMsg = j.error; } catch { /* not JSON */ }
    if (resp.status === 409) {
if (retry) {
setChatStatus(refs, 'a response is already streaming — retry later', 'busy');
state.streaming = false;
if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
return;
}
// Another client (tab/device) is already streaming this chat and
// the server rejected BEFORE persisting the user message. Undo the
// optimistic append and put the text + attachments back in the
// composer so the message is never lost — without this the next
// reconcileRunningChat tick rebuilds the transcript from disk and
// the bubble silently disappears.
state.messages = state.messages.filter((m) => m !== userMsg);
      // Rolling back the first message leaves state.messages empty, so
      // this rebuild also restores the creation-time setup card that
      // send() removed above (renderTranscript mounts it on empty).
      if (state._renderTranscript) state._renderTranscript();
      if (refs.promptInput.current) {
        refs.promptInput.current.value = text;
        refs._autoresize();
      }
      setImageAttachments(localAtts);
      if (state._updateChat) {
        saveComposerDraftNow(text, refs, state._updateChat, { draftAttachments: atts }).catch(() => {});
      }
      setChatStatus(refs, 'a response is already streaming — your message is back in the composer', 'busy');
      state.streaming = false;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
      return;
    }
    setChatStatus(refs, errMsg, 'error');
    const payload = { content: text, attachments: atts, clearComposerDraft, setImageAttachments, retry, manualRetry };
    appendErrorCard(errMsg, refs, state, { onRetry: () => retryFailedTurn(state, refs, payload) });
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    maybeAutoRetry(state, refs, payload);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', assembled = '', reasoning = '';
  let usage = null;
  let cost = null;
  let streamingMs = null;
  // Subagent delegated cost accumulated mid-turn. The server emits
  // a `usage_update` event with the subagent's cost as soon as the
  // nested run finishes; the parent turn's `done` later carries
  // the same number inside the final segment's remainder cost, so
  // we clear this when the final assistant message is persisted to
  // avoid double-counting. While the turn is still in flight the
  // live running "Total" pill in the head summary is updated by
  // folding this delta into the `liveInfo` passed to
  // updateUsageSummary.
  let liveSubagentCost = 0;
  // Track the latest round's usage so intermediate segments can
  // carry their own cost estimate. The server sends `usage_input`
  // per round; we pair it with `usage_output` to form a complete
  // picture for the segment that ends at `assistant_turn_end`.
  let roundPromptTokens = 0;
  let roundCompletionTokens = 0;
  // Anthropic prompt-cache metrics for the current round (read from
  // `usage_input` frames; the server folds them into the `done` usage
  // block, but a segment finalized before `done` needs its own copy).
  let roundCacheReadTokens = 0;
  let roundCacheCreationTokens = 0;
  // Throttle the live tok/s repaint: redrawing on every delta
  // produces a strobe effect on a phone. We repaint at most every
  // 120 ms while deltas are flowing, and once on `done`.
  let lastRepaintAt = 0;
  // composeLiveInfo() -> { modelId, usage, cost, streamingMs, liveRate, liveCost }
  //
  // Builds the `info` object passed to renderUsageMeta and
  // updateUsageSummary. The live running "Total" pill must include
  // any subagent cost that has been billed since the last segment
  // was persisted, otherwise it falls behind the true total until
  // the parent turn's `done` event lands. We add the running
  // subagent cost to the parent's `cost` here; when the final
  // `done` arrives the persisted message absorbs both and the
  // running delta is cleared.
  function composeLiveInfo() {
    const info = { modelId, usage, cost, streamingMs, liveRate: counter.rate(usage && usage.completionTokens) };
    if (liveSubagentCost > 0) {
      // Carry the subagent delta in a new envelope so
      // updateUsageSummary can keep the parent's `cost` intact
      // (it's used for the per-turn meta line) while still
      // adding the subagent contribution to the running total.
      info.liveCost = { known: true, total: liveSubagentCost, currency: 'USD' };
    }
    return info;
  }
  function repaintLiveRate() {
    if (!refs.transcript.current) return;
    const live = refs.transcript.current.querySelector('[data-live="1"]');
    if (!live) return;
    const meta = live.querySelector('.chat-msg__meta');
    if (!meta) return;
    const info = composeLiveInfo();
    renderUsageMeta(meta, info, state);
    updateUsageSummary(state, info, refs);
  }
  let streamFailed = false;
  // Set when this reader was aborted on purpose (chat switch / unmount).
  let aborted = false;
  function handleStreamEvent(ev, data) {
    // Nested subagent activity: render inside the parent subagent
    // card instead of the live bubble / standalone tool cards.
    if (ev.eventName === 'subagent_event' && data) {
      handleSubagentStreamEvent({ eventName: data.kind }, Object.assign({ parentCallId: data.parentCallId }, data.data || {}), refs);
      return;
    }
    if (ev.eventName === 'shell_output' && data) {
      handleShellOutputEvent(data, refs);
      return;
    }
    if (data && data.parentTool === 'subagent' && ev.eventName === 'authorization_required') {
      mountOverlayCard(refs, data && data.callId, () => authorizationCard(data, projectDir, chatId, refs, null, state));
      return;
    }
    if (data && data.parentTool === 'subagent' && ev.eventName === 'ask_user_required') {
      mountOverlayCard(refs, data && data.callId, () => askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st)));
      return;
    }
    if (ev.eventName === 'message' && typeof data.delta === 'string') {
      assembled += data.delta;
      counter.add(data.delta);
      appendDeltaToLive(data.delta, refs, state);
      const now = performance.now ? performance.now() : Date.now();
      if (now - lastRepaintAt > 120) {
        lastRepaintAt = now;
        repaintLiveRate();
      }
    } else if (ev.eventName === 'reasoning' && typeof data.delta === 'string') {
      reasoning += data.delta;
      // Feed thinking deltas into the live counter too. Upstream
      // completionTokens (which replace the heuristic on `done`)
      // include thinking tokens, so the counter's window must span
      // the thinking phase — otherwise a reasoning-heavy turn divides
      // the full token count by the answer-only window and over-reports
      // tok/s by the think/answer ratio.
      counter.add(data.delta);
      appendReasoningToLive(data.delta, refs, state);
      const now = performance.now ? performance.now() : Date.now();
      if (now - lastRepaintAt > 120) {
        lastRepaintAt = now;
        repaintLiveRate();
      }
    } else if (ev.eventName === 'done') {
      // Merge rather than overwrite: usage_input/usage_output may
      // have accumulated a prompt/completion count before `done`.
      if (data.usage) {
        const merged = usage || {};
        const p = Number(data.usage.promptTokens);
        const c2 = Number(data.usage.completionTokens);
        const cr = Number(data.usage.cacheReadTokens);
        const cc = Number(data.usage.cacheCreationTokens);
        if (isFinite(p) && p > 0) merged.promptTokens = p;
        if (isFinite(c2) && c2 > 0) merged.completionTokens = c2;
        // Anthropic cache metrics ride the final `done` usage block
        // (the turn aggregate). Last report wins like the token counts.
        if (isFinite(cr) && cr > 0) merged.cacheReadTokens = cr;
        if (isFinite(cc) && cc > 0) merged.cacheCreationTokens = cc;
        usage = merged;
      }
      cost = data.cost || cost;
      streamingMs = typeof data.streamingMs === 'number' ? data.streamingMs : streamingMs;
      roundPromptTokens = 0;
      roundCompletionTokens = 0;
      // The final `done` event's `cost` already includes the
      // delegated subagent cost as part of the turn remainder
      // (turnCost + delegatedCost − persistedSegmentCost). Clear
      // the running mid-turn delta so the persisted sum is the
      // single source of truth from this point on.
      liveSubagentCost = 0;
      // Snap the live tok/s line to the authoritative number now that
      // the upstream reported its real completionTokens (they include
      // thinking tokens, matching the counter's window). Without this
      // repaint the meta line keeps the character-based estimate until
      // the final render after the stream closes.
      repaintLiveRate();
      // The title only ever changes on the first user turn (the server
      // derives it from the first prompt). Skip the full GET /api/chats/:id
      // round-trip on every subsequent done — refreshChatTitle is only
      // needed when the chat still has a default title.
      const c = state.chat;
      const isDefaultTitle = !c || !c.title || c.title === 'New chat';
      if (isDefaultTitle) refreshChatTitle(state, refs);
    } else if (ev.eventName === 'usage_input') {
      // Per-round prompt footprint (fires on each tool round for
      // Anthropic; the final `done` carries the authoritative sum).
      const p = Number(data && data.promptTokens);
      if (isFinite(p) && p > 0) {
        usage = usage || {};
        if (!usage.promptTokens || p > usage.promptTokens) usage.promptTokens = p;
        roundPromptTokens = p;
        repaintLiveRate();
      }
      // Cache metrics also arrive on this frame (Anthropic message_start).
      // Keep the latest values around so a segment finalized before
      // `done` can render its own cached-token share.
      const cr = Number(data && data.cacheReadTokens);
      const cc = Number(data && data.cacheCreationTokens);
      if (isFinite(cr) && cr > 0) { usage = usage || {}; usage.cacheReadTokens = cr; }
      if (isFinite(cc) && cc > 0) { usage = usage || {}; usage.cacheCreationTokens = cc; }
      if (isFinite(cr) && cr > 0) roundCacheReadTokens = cr;
      if (isFinite(cc) && cc > 0) roundCacheCreationTokens = cc;
    } else if (ev.eventName === 'usage_output') {
      const c2 = Number(data && data.completionTokens);
      if (isFinite(c2) && c2 > 0) {
        usage = usage || {};
        usage.completionTokens = (usage.completionTokens || 0) + c2;
        roundCompletionTokens += c2;
        repaintLiveRate();
      }
    } else if (ev.eventName === 'usage_update') {
      // Mid-turn subagent cost. The server emits this as soon as a
      // nested subagent call finishes, so the head "Total" pill
      // grows in real time instead of jumping on the parent
      // turn's `done`. The `done` event later folds the same
      // number into the final segment's remainder and clears the
      // running delta (handled below) so nothing is double-counted
      // on reload.
      const updateCost = data && data.cost;
      if (updateCost && updateCost.known && typeof updateCost.total === 'number' && updateCost.total > 0) {
        liveSubagentCost += updateCost.total;
        // No repaintLiveRate(): the per-turn meta line is for the
        // parent's own cost, not the running subagent total. The
        // head summary is the only surface that needs to grow
        // right now, and updateUsageSummary below is the single
        // source of truth for it.
        updateUsageSummary(state, composeLiveInfo(), refs);
      }
    } else if (ev.eventName === 'assistant_turn_end') {
      const segment = assembled;
      const thoughtSegment = reasoning;
      if (segment.trim() || thoughtSegment.trim()) {
        finalizeLiveMessage({ content: segment, reasoning: thoughtSegment }, refs);
        // The server attaches the round's exact usage + cost to this
        // event (computed from the per-round snapshot, incl. OpenRouter's
        // real providerCost). Prefer it; fall back to locally tracked
        // round counters only if the frame didn't carry usage.
        const segmentUsage = data.usage
          || ((roundPromptTokens || roundCompletionTokens || roundCacheReadTokens || roundCacheCreationTokens)
            ? {
                promptTokens: roundPromptTokens || undefined,
                completionTokens: roundCompletionTokens || undefined,
                cacheReadTokens: roundCacheReadTokens || undefined,
                cacheCreationTokens: roundCacheCreationTokens || undefined
              }
            : undefined);
        const segmentCost = data.cost || undefined;
        state.messages = state.messages.concat([{
          role: 'assistant', content: segment, reasoning: thoughtSegment, ts: new Date().toISOString(), modelId,
          usage: segmentUsage,
          cost: segmentCost
        }]);
        // Update the just-finalized row's meta line so the segment
        // shows its cost immediately without waiting for the
        // post-stream reconciliation.
        if (refs.transcript.current) {
          const rows = refs.transcript.current.querySelectorAll('.chat-msg--assistant');
          const lastRow = rows.length ? rows[rows.length - 1] : null;
          if (lastRow) {
            const meta = lastRow.querySelector('.chat-msg__meta');
            if (meta) renderUsageMeta(meta, { modelId, usage: segmentUsage, cost: segmentCost }, state);
          }
        }
        // Reset round counters for the next segment.
        roundPromptTokens = 0;
        roundCompletionTokens = 0;
        roundCacheReadTokens = 0;
        roundCacheCreationTokens = 0;
      }
      assembled = '';
      reasoning = '';
    } else if (ev.eventName === 'authorization_required' || ev.eventName === 'ask_user_required') {
      // Authorization and ask_user cards both read the SAME pending
      // queue the reconcile poll (loadPendingAuthorization) drains, so
      // the same request can arrive here as an SSE frame and again as
      // a polled pending item. mountOverlayCard de-dupes by
      // auth-call-id, waits for the chunked render, skips the mount
      // while the transcript is empty, and scrolls the card into view.
      mountOverlayCard(refs, data && data.callId, () => {
        if (ev.eventName === 'authorization_required') {
          authorizationCard(data, projectDir, chatId, refs, null, state);
        } else {
          askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st));
        }
      });
    } else if (ev.eventName === 'tool_call') {
      markToolUsed(state, refs, data && data.name);
      appendToolCallCard(data, refs);
    } else if (ev.eventName === 'tool_result') {
      appendToolResultCard(data, refs);
    } else if (ev.eventName === 'progress_update') {
      // Real-time progress bar from the model's report_progress tool.
      // Creates or updates a progress card in the transcript with a
      // live progress bar and status pill.
      updateProgressCard(refs, data);
      const pct = data.current != null && data.total != null
        ? Math.round((Number(data.current) / Math.max(1, Number(data.total))) * 100) + '%'
        : (data.status || 'running');
      setChatStatus(refs, data.title + ' ' + pct, 'busy');
} else if (ev.eventName === 'error') {
streamFailed = true;
// Clear the per-round counters so a subsequent turn does not
// inherit stale tokens from the failed exchange.
roundPromptTokens = 0;
roundCompletionTokens = 0;
// Show the failure IN the transcript, not only in the status
// pill: the user asked for errors to be visible in the chat,
// and a status line is overwritten by the next update while
// the bubble stays where the conversation happened.
const failPayload = { content: text, attachments: atts, clearComposerDraft, setImageAttachments, retry, manualRetry };
appendErrorCard((data.message || 'Request failed') + (data.detail ? '\n' + String(data.detail).slice(0, 500) : ''), refs, state, {
onRetry: () => retryFailedTurn(state, refs, failPayload)
});
setChatStatus(refs, 'error: ' + (data.code || '') + ' ' + (data.message || ''), 'error');
}
  }
  try {
    for (;;) {
      // Stop as soon as this view belongs to another chat: the deltas in
      // this stream describe a conversation the user has left, and the
      // mounted transcript now belongs to the chat they moved to.
      if (state.props.projectDir !== projectDir || state.props.chatId !== chatId) {
      // Flag the detach BEFORE breaking. `break` unwinds the loop
      // normally, so the `catch` below never runs and would leave
      // `aborted` false — the finalize path would then concat this
      // chat's partial turn into the transcript of the chat the user
      // just moved to.
      aborted = true;
      abortStream(state);
      break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = parseSSEFrame(frame); if (!ev) continue;
        let data; try { data = JSON.parse(ev.data); } catch { continue; }
        try {
          handleStreamEvent(ev, data);
        } catch (eventError) {
          // A rendering failure in one tool card must not cancel
          // the network reader: the model may still be producing
          // the next assistant turn.
          console.error('chat SSE event failed', ev.eventName, eventError);
        }
      }
    }
  } catch (err) {
    // An abort we caused (chat switch / unmount) is not a dropped
    // connection: do not report it and do not start the recovery poll,
    // which would sync a transcript the user is no longer looking at.
    aborted = !!(err && err.name === 'AbortError') || streamAbort.signal.aborted;
    if (!aborted) {
      streamFailed = true;
      // Clear the per-round counters so a subsequent turn does not
      // inherit stale tokens from the interrupted exchange.
      roundPromptTokens = 0;
      roundCompletionTokens = 0;
      console.error('chat SSE reader failed', err);
      setChatStatus(refs, 'stream interrupted: ' + (err && err.message ? err.message : 'connection closed'), 'error');
    }
  } finally {
    if (state.streamAbort === streamAbort) state.streamAbort = null;
    try { reader.releaseLock(); } catch { /* already released */ }
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  }
  // Safety net: an abort that lands between two reads unwinds the loop
  // without throwing, so `aborted` may still be false here. The signal is
  // the authoritative answer — `abortStream` is the only thing that sets
  // it, and it is only ever called to detach (chat switch / unmount).
  if (streamAbort.signal.aborted) aborted = true;
  if (aborted) {
    // Detach silently: the server still owns the turn, and the chat it
    // belongs to is no longer mounted. Hand the flags back so the chat the
    // user moved to does not start out stuck on "streaming…".
    counter.reset();
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    return;
  }
  if (streamFailed) {
    // The SSE socket dropped mid-turn, but the server-side agent
    // may still be appending to the persisted transcript. Hand the
    // partial turn over to a backoff poll that syncs from disk.
    finalizeLiveMessage({ content: assembled, reasoning }, refs);
    counter.reset();
    startStreamRecovery(state, refs, assembled);
    return;
  }
  const finalLive = refs.transcript.current
    ? refs.transcript.current.querySelector('[data-live="1"]')
    : null;
  const hasFinalAssistantText = !!(assembled.trim() || reasoning.trim());
  if (hasFinalAssistantText) {
    finalizeLiveMessage({ content: assembled, reasoning }, refs);
    // Final meta line: the live counter has the authoritative
    // completionTokens; the cost is already on the `done` event.
    const finalRate = counter.rate(usage && usage.completionTokens);
    const persisted = {
      role: 'assistant',
      content: assembled,
      reasoning,
      ts: new Date().toISOString(),
      modelId,
      usage: usage || undefined,
      cost: cost || undefined,
      streamingMs: streamingMs || undefined,
      liveRate: finalRate
    };
    state.messages = state.messages.concat([persisted]);
    updateUsageSummary(state, null, refs);
    if (finalLive) {
      const meta = finalLive.querySelector('.chat-msg__meta');
      if (meta) renderUsageMeta(meta, persisted, state);
    }
  } else if (finalLive && finalLive.parentNode) {
    finalLive.remove();
    updateUsageSummary(state, null, refs);
  }
  counter.reset();
  // The server transcript is authoritative. Reconcile after the
  // complete exchange so tool-heavy turns cannot leave the
  // browser showing only the last tool card when a delta was
  // missed, reordered, or failed to render.
  try {
    const run = await fetchRunState(projectDir, chatId);
    if (run) await syncToNextSeq(state, refs, run.nextSeq);
  } catch (syncError) {
    console.error('chat transcript reconciliation failed', syncError);
  }
  if (refs.status.current && refs.status.current.textContent === 'streaming…') {
    const hasCounts = usage && (usage.promptTokens != null || usage.completionTokens != null);
    setChatStatus(
      refs,
      hasCounts
        ? ('done — ' + (usage.promptTokens || 0) + ' in, ' + (usage.completionTokens || 0) + ' out')
        : 'done',
      'success'
    );
  }
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  state.streaming = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
}

// recoverFromDisk — one recovery sync for a dropped local SSE turn.
// Polls the authoritative transcript (server keeps writing the run to
// disk while we were disconnected) with attempt-based backoff, collapsing
// the old self-timer recovery into the single shared poll. Returns true
// while still recovering, false once recovered (or failed) so the poll
// drops back to its idle cadence.
async function recoverFromDisk(state, refs) {
  const { projectDir, chatId } = state.props;
  const st = state.reconnect;
  if (!st || !st.active || st.stopped) { if (st) st.active = false; return false; }
  st.attempts += 1;

  const run = await fetchRunState(projectDir, chatId).catch(() => null);
  if (!run) {
    if (st.attempts < 6) return true;
    return finishRecovery(state, refs, 'could not reconnect — tap to retry', true);
  }

  const applied = await syncToNextSeq(state, refs, run.nextSeq).catch(() => null);
  if (applied == null) {
    if (st.attempts < 6) return true;
    return finishRecovery(state, refs, 'could not reconnect — tap to retry', true);
  }
  if (applied !== 'stable') {
    st.stableTicks = 0;
    setChatStatus(refs, 'reconnected — syncing…', 'busy');
    return true;
  }

  const last = state.messages[state.messages.length - 1];
  const midTool = last && last.role === 'tool' && last.phase === 'call';
  st.stableTicks = (st.stableTicks || 0) + 1;
  if (!run.running && !midTool) return finishRecovery(state, refs, null, false);
  if (!midTool && st.stableTicks >= 2) return finishRecovery(state, refs, null, false);
  if (st.attempts >= 8) return finishRecovery(state, refs, 'reconnect timed out — pull to retry', true);
  return true;
}

// finishRecovery — conclude a recovery: clear the flags, re-enable the
// send button, and set the status. `failed` toggles the status color.
function finishRecovery(state, refs, message, failed) {
  const st = state.reconnect;
  st.active = false;
  st.stopped = false;
  st.attempts = 0;
  st.stableTicks = 0;
  state.streaming = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  if (message) setChatStatus(refs, message, failed ? 'error' : 'success');
  else setChatStatus(refs, 'reconnected', 'success');
  return false;
}
// reconcileRunningChat — one tick of the "another tab is running
// this chat" poller. Syncs the transcript if the persisted rows
// changed and surfaces the running flag as a busy status.
//
// Cheap tick: ONE request — /revision returns { nextSeq, running }.
// Rows are fetched only when the server cursor is ahead, and then just
// `/messages?fromSeq=<localNextSeq>`, so normal stream comeback stays
// incremental and never needs a full transcript reload.
export async function reconcileRunningChat(state, refs) {
  const { chatId, projectDir } = state.props;
  if (!chatId || !projectDir) return;
  if (state.reconnect && state.reconnect.active) return recoverFromDisk(state, refs);
  if (state.streaming) return;

  try {
    const rev = await fetchRunState(projectDir, chatId);
    if (!rev) return;
    const running = !!rev.running;
    const prevWatching = state.watchingRun;
    const applied = await syncToNextSeq(state, refs, rev.nextSeq);
    const moved = applied && applied !== 'stable';
    if (moved && state.runSettled) state.runSettled = false;

    if (running) {
      const liveKey = projectDir + '::' + chatId;
      subscribeLive(state, refs);
      const liveState = state.liveRun && state.liveRun.key === liveKey ? state.liveRun : null;
      const liveConnected = !!(liveState && (liveState.active || liveState.connected) && !liveState.ended && !liveState.failed);
      const last = state.messages[state.messages.length - 1];
      const midTool = last && last.role === 'tool' && last.phase === 'call';
      const stable = !moved && !midTool && state.messages.length > 0 && !liveConnected;
// Even a locally settled run must re-check the pending queue. The page can
// remain open in the background after the stable-tick guard latches; if an
// authorization request arrives later, returning to the same hash does not
// remount ChatView. Checking before the settled early-return lets the prompt
// clear the latch and become actionable immediately.
if (!prevWatching || moved || stable || state.pendingAuthCount > 0 || state.runSettled) {
state.pendingAuthCount = await loadPendingAuthorization(state, refs);
}
if (state.pendingAuthCount > 0) state.runSettled = false;
if (state.runSettled) {
state.watchingRun = false;
state.watchingStableTicks = 0;
if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
return;
}
state.watchingRun = true;
if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
if (state.pendingAuthCount > 0) {
        state.watchingStableTicks = 0;
        setChatStatus(refs, 'waiting for you…', 'busy');
      } else if (stable) {
        setChatStatus(refs, 'streaming…', 'busy');
        state.watchingStableTicks = (state.watchingStableTicks || 0) + 1;
        if (state.watchingStableTicks >= 2) {
          state.watchingRun = false;
          state.watchingStableTicks = 0;
          state.runSettled = true;
          if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
          setChatStatus(refs, 'done', 'success');
        }
      } else {
        setChatStatus(refs, 'streaming…', 'busy');
        state.watchingStableTicks = 0;
      }
      } else if (state.watchingRun) {
      state.pendingAuthCount = 0;
      state.watchingRun = false;
      state.watchingStableTicks = 0;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      setChatStatus(refs, 'done', 'success');
      // The run just ended for this client too (no live socket, or it closed
      // without a run_end): the older-history drain bailed while the run was
      // in flight, so restart it here or history waits for a manual scroll.
      if (typeof state._drainOlderMessages === 'function') state._drainOlderMessages();
      } else if (typeof state._setRunningVisible === 'function') {
      state.pendingAuthCount = 0;
      state._setRunningVisible(false);
      state.watchingStableTicks = 0;
    }
  } catch { /* the next tick retries */ }
}
