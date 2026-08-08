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
  finalizeLiveMessage,
  handleShellOutputEvent,
  handleSubagentStreamEvent,
  syncTranscriptAppend,
  updateProgressCard,
  whenTranscriptSettled
} from './transcript.js';
import { afterTranscriptAppend } from './scroll.js';
import { renderUsageMeta, updateUsageSummary, setChatStatus } from './usage.js';
import { refreshChatTitle, updateChat } from './meta.js';
import { authorizationCard, askUserCard, removePendingAuthorizationCards } from './cards.js';
import { normalizeToolName, parseToolArgs } from './tools.js';
import { queueComposerDraftSave } from './composer.js';
import { cssEscape } from './utils.js';

// markToolUsed(state, refs, toolName)
//
// Record that a tool was called in this chat session. Two effects:
//   1. If the tool is currently unchecked in the per-chat filter,
//      checking it happens automatically ("tools are started when
//      used") — the model clearly has it, so the filter should
//      reflect reality. Persisted via the normal toggle path.
//   2. The tool gets the "used" dot badge in the tree.
// authCardGuard(refs, callId) -> bool
//
// De-dupe authorization / ask_user cards. The live SSE stream and the
// reconcile poll (loadPendingAuthorization) both read the SAME pending
// authorization queue on the server, so one request can arrive twice —
// once as an SSE frame and again as a polled pending item. Both card
// types stamp `data-auth-call-id` on the card; if a card for this
// callId is already on screen, skip (return false) instead of mounting
// a duplicate.
function authCardGuard(refs, callId) {
  if (!callId || !refs.transcript || !refs.transcript.current) return true;
  const existing = refs.transcript.current.querySelector(
    '.tool-card--authorization[data-auth-call-id="' + cssEscape(String(callId)) + '"],' +
    '.tool-card--ask-user[data-auth-call-id="' + cssEscape(String(callId)) + '"]'
  );
  return !existing;
}

// mountOverlayCard(refs, mountFn)
//
// Mount an ask_user / authorization overlay card so it actually lands
// on screen: wait for any in-flight chunked transcript render, skip
// the mount while the transcript is still empty (a rebuild would wipe
// the card), de-dupe by auth-call-id, and scroll the card into view.
// Used by every overlay-card path (SSE events, nested subagent events,
// and the pending-auth poll) so all of them behave identically.
function mountOverlayCard(refs, callId, mountFn) {
  whenTranscriptSettled(refs).then(() => {
    if (!refs.transcript || !refs.transcript.current) return;
    if (!authCardGuard(refs, callId)) return;
    const t = refs.transcript.current;
    const hasContent = t.children.length > 0
      && !(t.children.length === 1 && t.querySelector(':scope > .chat-view__empty'));
    if (!hasContent) {
      // The transcript hasn't painted yet (chat still loading, or a
      // rebuild is about to wipe it). Mounting now would lose the card;
      // the loadPendingAuthorization poll re-mounts it once the
      // transcript is up.
      return;
    }
    mountFn();
  });
}

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
  appendToolCallCard({ id: 'pending', name: 'subagent', args }, refs);
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
    appendToolResultCard({ id: null, name: 'subagent', args, ok: false, result: { error: String(err) } }, refs);
    setChatStatus(refs, 'agent error', 'error');
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    return;
  }
  const body = r.body || {};
  appendToolResultCard({ id: body.id || null, name: 'subagent', ok: !!body.ok, result: body.result || body }, refs);
  // Fold the agent's final text into the transcript as an assistant
  // message so it survives reloads (tool cards are live-only here;
  // the server does not persist direct tool invocations).
  const text = body.result && typeof body.result.text === 'string' ? body.result.text : '';
  if (text) {
    const msg = { role: 'assistant', content: text, ts: new Date().toISOString() };
    state.messages = state.messages.concat([msg]);
    appendMessageToTranscript(msg, false, refs, state);
  }
  if (r.status === 403) setChatStatus(refs, 'subagent tool is disabled for this project', 'error');
  else if (!body.ok) setChatStatus(refs, 'agent failed: ' + ((body.result && body.result.error && body.result.error.message) || body.error || 'unknown'), 'error');
  else setChatStatus(refs, 'agent ' + agentName + ' done', 'success');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
}

// runMcpCommand(serverSlug, toolName, label, state, refs)
//
// runMcpCommand(serverSlug, toolName, label, state, refs, args)
//
// Direct MCP tool invocation from the @-mention popup.
// Calls POST /api/mcp/call and renders a tool_call + tool_result card.
export async function runMcpCommand(serverSlug, toolName, label, state, refs, args) {
  const { projectDir, chatId } = state.props;
  if (!projectDir) return;
  const callArgs = args || {};
  const callId = 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  refs.promptInput.current.value = '';
  refs._autoresize();
  appendToolCallCard({ id: callId, name: label || toolName, args: callArgs }, refs);
  setChatStatus(refs, 'calling MCP ' + (label || toolName) + '…', 'busy');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  let r;
  try {
    r = await fetchJson('/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, serverId: serverSlug, toolName, args: callArgs })
    });
  } catch (err) {
    appendToolResultCard({ id: null, name: label || toolName, args: callArgs, ok: false, result: { error: String(err) } }, refs);
    setChatStatus(refs, 'MCP error', 'error');
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    return;
  }
  const body = r.body || {};
  appendToolResultCard({ id: callId, name: label || toolName, ok: !!body.ok, result: body }, refs);
  if (r.status === 403) setChatStatus(refs, 'MCP tool is disabled', 'error');
  else if (r.status !== 200) setChatStatus(refs, 'MCP failed: ' + (body.error || body.code || 'HTTP ' + r.status), 'error');
  else setChatStatus(refs, 'MCP ' + (label || toolName) + ' done', 'success');
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
}

// syncFromRevision(state, refs, revKey, synced) -> 'appended' | 'rebuilt' | null
//
// Bring the on-screen transcript in line with the authoritative rows
// after a revision-marker change. The store is append-only (rows are
// never edited in place; edits/delete go through replaceMessages or
// clearMessages, which always change the row count), so when only the
// tail grew we render just the new rows incrementally instead of
// rebuilding the whole transcript — a full rebuild re-parses every
// message's markdown and collapses/scroll-jumps the view, and the
// follower-tab poll hits this path once a second while a run is
// active. A changed prefix (unreachable today; defensive only) falls
// back to the full rebuild. Returns how the sync was applied, or null
// when the payload wasn't usable.
// sameMessage(a, b) -> bool
//
// Logical-equality for two transcript rows. The fallback path that
// reaches syncFromRevision carries a freshly `JSON.parse`d full fetch,
// so reference `===` is always false even when the rows are unchanged
// — that forced a full blank-and-repaint (and a scroll reset) on the
// very first recovery/reconcile tick that hit the fallback. Compare
// by a stable key instead: the store is append-only, so an unchanged
// prefix matches on role + ts (+ toolCallId/phase for tool rows).
function sameMessage(a, b) {
  if (!a || !b) return a === b;
  if (a.role !== b.role) return false;
  if ((a.ts || '') !== (b.ts || '')) return false;
  if ((a.toolCallId || '') !== (b.toolCallId || '')) return false;
  if ((a.phase || '') !== (b.phase || '')) return false;
  return true;
}

export function syncFromRevision(state, refs, revKey, synced) {
  if (!Array.isArray(synced)) return null;
  const prev = state.messages;
  const prefixIntact = synced.length >= prev.length
    && synced.slice(0, prev.length).every((m, i) => sameMessage(m, prev[i]));
  state.transcriptRevision = revKey;
  state.messages = synced;
  if (prefixIntact) {
    syncTranscriptAppend(state, refs, prev.length);
    return 'appended';
  }
  if (state._renderTranscript) state._renderTranscript();
  return 'rebuilt';
}

// fetchMessagesSince(projectDir, chatId, since) -> { body, status }
//
// Fetch only the transcript tail after index `since` (the number of
// rows the client already has). Returns null when the transcript was
// cleared/replaced on the server (base < since) — the caller must
// then fall back to a full /messages fetch and rebuild.
async function fetchMessagesSince(projectDir, chatId, since) {
  const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir) + '&since=' + since);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.messages)) return { body: null, status: r.status };
  if (typeof r.body.base === 'number' && r.body.base < since) return { body: null, status: r.status };
  return { body: r.body, status: r.status };
}

// fetchMessagesFull(projectDir, chatId) -> messages[] | null
async function fetchMessagesFull(projectDir, chatId) {
  const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
  return (r.status === 200 && r.body && Array.isArray(r.body.messages)) ? r.body.messages : null;
}

// applyTailSync(state, refs, revKey, tail) -> 'appended' | null
//
// Fast path for the common append-only change: the server sent only
// the rows after our known prefix, so concat them and render just
// those rows. No prefix re-verification needed — the store is
// append-only, and a non-append change is caught upstream by the
// base < since check in fetchMessagesSince.
function applyTailSync(state, refs, revKey, tail) {
  if (!Array.isArray(tail)) return null;
  const prevLen = state.messages.length;
  state.transcriptRevision = revKey;
  state.messages = state.messages.concat(tail);
  if (!tail.length) return 'appended';
  syncTranscriptAppend(state, refs, prevLen);
  return 'appended';
}

// syncTailOrFull(state, refs, revKey) -> 'appended' | 'rebuilt' | null
//
// Shared catch-up for the reconcile/recovery polls: try the cheap
// tail fetch first; on a non-append change (or a failed tail fetch)
// fall back to the full transcript and the prefix-checking sync.
async function syncTailOrFull(state, refs, revKey) {
  const { projectDir, chatId } = state.props;
  const t = await fetchMessagesSince(projectDir, chatId, state.messages.length);
  if (t.body) return applyTailSync(state, refs, revKey, t.body.messages);
  const full = await fetchMessagesFull(projectDir, chatId);
  if (full == null) return null;
  return syncFromRevision(state, refs, revKey, full);
}

// startStreamRecovery / scheduleRecoveryTick / runRecoveryTick /
// finishStreamRecovery / stopStreamRecovery
//
// When the live stream drops mid-turn the server keeps writing the
// run to the transcript file, so we recover by polling that file
// with exponential backoff.

export function startStreamRecovery(state, refs, partialText) {
  const st = state.reconnect;
  stopStreamRecovery(state, refs);
  st.active = true;
  st.attempts = 0;
  st.stopped = false;
  st.partialText = partialText || '';
  state.streaming = true; // still "in a turn" for the poller
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
  // When starting recovery, update any shell call cards that are on
  // screen to show "reconnecting" instead of "Running…". The live
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
  scheduleRecoveryTick(state, refs, 0);
}

function scheduleRecoveryTick(state, refs, attempt) {
  const st = state.reconnect;
  if (st.stopped) return;
  // Backoff: 1s, 2s, 4s, 5s, 5s … (cap at 5s, cap total attempts).
  const delay = Math.min(5000, 1000 * Math.pow(2, attempt));
  st.timer = setTimeout(() => runRecoveryTick(state, refs), delay);
}

async function runRecoveryTick(state, refs) {
  const { projectDir, chatId } = state.props;
  const st = state.reconnect;
  if (st.stopped || !st.active) return;
  st.attempts += 1;
  // Cheap first: the revision marker ({count, ts}) tells us whether the
  // transcript moved at all. Rows are fetched only when it did — and
  // then just the tail after our known prefix (?since=), not the
  // whole transcript.
  let revKey = null;
  try {
    const rRev = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/revision?projectDir=' + encodeURIComponent(projectDir));
    if (rRev.status === 200 && rRev.body != null) revKey = rRev.body.count + ':' + (rRev.body.ts || '');
  } catch { revKey = null; }

  if (revKey == null) {
    // Server unreachable — keep trying while attempts remain.
    if (st.attempts < 6) return scheduleRecoveryTick(state, refs, st.attempts);
    return finishStreamRecovery(state, refs, 'could not reconnect — tap to retry', true);
  }

  if (revKey !== state.transcriptRevision) {
    // New content landed on disk. Sync the authoritative rows (tail
    // fetch first — only the rows after our known prefix cross the
    // wire) and reset the stability counter — the run is clearly
    // still going.
    let applied = null;
    try {
      applied = await syncTailOrFull(state, refs, revKey);
    } catch { applied = null; }
    if (applied == null) {
      if (st.attempts < 6) return scheduleRecoveryTick(state, refs, st.attempts);
      return finishStreamRecovery(state, refs, 'could not reconnect — tap to retry', true);
    }
    st.stableTicks = 0;
    setChatStatus(refs, 'reconnected — syncing…', 'busy');
    return scheduleRecoveryTick(state, refs, st.attempts);
  }

  // Transcript is stable. A run is done when the last message is no
  // longer a bare tool call (a call with no result yet means the agent
  // is mid-tool) and we've seen a couple of identical polls.
  const last = state.messages[state.messages.length - 1];
  const midTool = last && last.role === 'tool' && last.phase === 'call';
  st.stableTicks = (st.stableTicks || 0) + 1;
  if (!midTool && st.stableTicks >= 2) {
    return finishStreamRecovery(state, refs, null, false);
  }
  if (st.attempts >= 8) {
    return finishStreamRecovery(state, refs, 'reconnect timed out — pull to retry', true);
  }
  scheduleRecoveryTick(state, refs, st.attempts);
}

function finishStreamRecovery(state, refs, message, failed) {
  const st = state.reconnect;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  st.active = false;
  state.streaming = false;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
  if (message) setChatStatus(refs, message, failed ? 'error' : 'success');
  else setChatStatus(refs, 'reconnected', 'success');
}

export function stopStreamRecovery(state, refs) {
  const st = state.reconnect;
  st.stopped = true;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  st.active = false;
}

export async function loadPendingAuthorization(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId || !refs.transcript.current) return;
  let r;
  try {
    r = await fetchJson('/api/tools/authorization/pending?projectDir=' + encodeURIComponent(projectDir) + '&chatId=' + encodeURIComponent(chatId));
  } catch { return; }
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.pending)) return;
  for (const request of r.body.pending) {
    if (!request || !request.callId) continue;
    if (request.tool === 'ask_user' && request.args) {
      const data = Object.assign({}, request.args, { callId: request.callId, tool: request.tool });
      mountOverlayCard(refs, request.callId, () => askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st)));
    } else {
      mountOverlayCard(refs, request.callId, () => authorizationCard(request, projectDir, chatId, refs, null, state));
    }
  }
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
  stopStreamRecovery(state, refs);
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
export async function send(state, refs, { content, attachments, clearComposerDraft, setImageAttachments }) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  const c = state.chat || {};
  const modelId = c.modelId || '';
  const providerId = c.providerId || '';
  const text = (content != null ? content : (refs.promptInput.current.value || '')).trim();
  const atts = attachments || state.imageAttachments;
  if (!text && !atts.length) {
    if (refs.status.current) refs.status.current.textContent = 'type something or add an image';
    return;
  }
  // A turn is already streaming from THIS client. Bail out before the
  // composer is cleared so the typed text is never lost. (The server
  // would 409 anyway; this also covers the Enter-key path, which
  // bypasses the disabled send button.)
  if (state.streaming) {
    setChatStatus(refs, 'wait for the current response to finish', 'busy');
    return;
  }
  // /shell <cmd> — direct tool invocation, no model.
  if (text.startsWith('/shell ')) {
    const cmd = text.slice('/shell '.length).trim();
    if (cmd) return runShellCommand(cmd, state, refs);
  }
  // @<toolname> <args?> — direct tool invocation via @-mention syntax.
  // Only fires when the text starts with @ and names a directly-invocable
  // tool (shell or mcp__...). Native tools (read_file, write_file, etc.)
  // and file references fall through to the normal model send — the popup
  // inserts @path for file refs too, and we don't want to silently drop
  // those when the user hits Enter.
  const atMatch = text.match(/^@(\S+)\s*(.*)$/);
  if (atMatch) {
    const toolName = atMatch[1];
    const rest = atMatch[2].trim();
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
        // MCP tool — parse server slug + tool name
        const parts = String(toolName).split('__');
        if (parts.length >= 3) {
          const serverSlug = parts[1];
          const mcpTool = parts.slice(2).join('__');
          const args = rest ? parseToolArgs(rest) : null;
          if (args) {
            return runMcpCommand(serverSlug, mcpTool, toolName, state, refs, args);
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

  // Persist the pair before sending so reopening this chat keeps
  // the exact provider/model choice. Skipped when the server record
  // already carries this pair (state._persistedModelPair is updated
  // on load and after every successful PATCH) — the picker persists
  // on selection, so the common case is a no-op and a PATCH here
  // would be a wasted round-trip on every send.
  if (state._persistedModelPair !== providerId + '|' + modelId) {
    await updateChat({ providerId, modelId }, state, refs);
  }

  if (refs.sendBtn.current) refs.sendBtn.current.disabled = true;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
  setChatStatus(refs, 'streaming…', 'busy');
  if (refs.promptInput.current) refs.promptInput.current.value = '';
  await clearComposerDraft();
  setImageAttachments([]);
  if (refs.imageInput.current) refs.imageInput.current.value = '';
  refs._autoresize();

  const userMsg = { role: 'user', content: text, attachments: atts, ts: new Date().toISOString() };
  state.messages = state.messages.concat([userMsg]);
  appendMessageToTranscript(userMsg, false, refs, state);
  // The first message ends the creation phase: remove the
  // prompt-size setup control for good (the prompt size is now
  // fixed).
  if (state._updateSetupVisibility) state._updateSetupVisibility();

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
  try {
    resp = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, modelId, providerId, content: text, attachments: atts, thinkingLevel: effectiveThinkingLevel })
    });
  } catch (err) {
    setChatStatus(refs, 'network error', 'error');
    appendErrorCard('Network error — could not reach the server. Your message was sent to the transcript but the response never started. Try again.', refs, state);
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    return;
  }
  if (!resp.ok) {
    let errText = '';
    try { errText = await resp.text(); } catch { /* ignore */ }
    let errMsg = 'HTTP ' + resp.status;
    try { const j = JSON.parse(errText); if (j && j.error) errMsg = j.error; } catch { /* not JSON */ }
    if (resp.status === 409) {
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
        queueComposerDraftSave(text, projectDir, chatId, refs, state._updateChat || (() => Promise.resolve()));
      }
      setImageAttachments(atts);
      setChatStatus(refs, 'a response is already streaming — your message is back in the composer', 'busy');
      state.streaming = false;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
      return;
    }
    setChatStatus(refs, errMsg, 'error');
    appendErrorCard(errMsg, refs, state);
    state.streaming = false;
    if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', assembled = '', reasoning = '';
  let usage = null;
  let cost = null;
  let streamingMs = null;
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
  function repaintLiveRate() {
    if (!refs.transcript.current) return;
    const live = refs.transcript.current.querySelector('[data-live="1"]');
    if (!live) return;
    const meta = live.querySelector('.chat-msg__meta');
    if (!meta) return;
    const info = { modelId, usage, cost, streamingMs, liveRate: counter.rate(usage && usage.completionTokens) };
    renderUsageMeta(meta, info, state);
    updateUsageSummary(state, info, refs);
  }
  let streamFailed = false;
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
      appendErrorCard((data.message || 'Request failed') + (data.detail ? '\n' + String(data.detail).slice(0, 500) : ''), refs, state);
      setChatStatus(refs, 'error: ' + (data.code || '') + ' ' + (data.message || ''), 'error');
    }
  }
  try {
    for (;;) {
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
    streamFailed = true;
    // Clear the per-round counters so a subsequent turn does not
    // inherit stale tokens from the interrupted exchange.
    roundPromptTokens = 0;
    roundCompletionTokens = 0;
    console.error('chat SSE reader failed', err);
    setChatStatus(refs, 'stream interrupted: ' + (err && err.message ? err.message : 'connection closed'), 'error');
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    if (refs.sendBtn.current) refs.sendBtn.current.disabled = false;
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
    // Cheap first: only pull anything when the revision marker moved
    // (this client appended messages itself, so the common case is a
    // no-op without a round-trip). When it did move, fetch just the
    // rows after our known prefix — not the whole transcript.
    const rRev = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/revision?projectDir=' + encodeURIComponent(projectDir));
    const revKey = (rRev.status === 200 && rRev.body)
      ? (rRev.body.count + ':' + (rRev.body.ts || ''))
      : '';
    if (revKey && revKey !== state.transcriptRevision) {
      await syncTailOrFull(state, refs, revKey);
    }
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

// reconcileRunningChat — one tick of the "another tab is running
// this chat" poller. Syncs the transcript if the persisted rows
// changed and surfaces the running flag as a busy status.
//
// Cheap tick: ONE request — /revision returns the {count, ts} marker
// plus the chat's running flag (the old version fetched the chat
// record and the marker separately, two round-trips per second).
// Rows are fetched only when the marker actually moved, and then just
// the tail after the known prefix (?since=) — the store is
// append-only, so the transcript updates incrementally instead of
// re-rendering every row.
export async function reconcileRunningChat(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!chatId || !projectDir) return;
  if (state.streaming) return; // don't reconcile over our own stream
  try {
    const rRev = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/revision?projectDir=' + encodeURIComponent(projectDir));
    if (rRev.status !== 200 || rRev.body == null) return;
    const rev = rRev.body;
    const running = !!rev.running;
    const revKey = rev.count + ':' + (rev.ts || '');
    const prevWatching = state.watchingRun;
    let moved = false;
    if (revKey !== state.transcriptRevision) {
      // Transcript changed on disk (this tab is a follower, or the
      // stream finished while we were backgrounded). Pull just the
      // rows after our known prefix and sync them in; a non-append
      // change falls back to the full fetch inside syncTailOrFull.
      moved = true;
      await syncTailOrFull(state, refs, revKey);
    }

    if (running) {
      state.watchingRun = true;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
      setChatStatus(refs, 'streaming…', 'busy');
      // Only drain the pending-authorization queue on an actual state
      // change (a run just started here, or new rows arrived), not on
      // every 1 s tick — it is an extra GET /pending round-trip per
      // second while a long run spins, and the queue only grows on
      // new requests. authCardGuard dedups the cards themselves.
      if (!prevWatching || moved) loadPendingAuthorization(state, refs);

      // Settle a torn run. On a reloaded page the server may report
      // `running` true while the SSE socket that would have cleared it
      // is gone (the client lost the stream, not the run). If the
      // transcript has stopped moving AND the last row isn't a bare
      // mid-tool call, the turn is done — clear the busy state after a
      // couple of identical stable polls instead of looping
      // "streaming…" and re-fetching /revision forever.
      const last = state.messages[state.messages.length - 1];
      const midTool = last && last.role === 'tool' && last.phase === 'call';
      // Require at least one persisted row: a reloaded run that has
      // produced nothing yet must keep the busy state (it may still be
      // pre-stream). Only a stable, non-empty, not-mid-tool transcript
      // is a finished-then-torn run.
      if (!moved && !midTool && state.messages.length > 0) {
        state.watchingStableTicks = (state.watchingStableTicks || 0) + 1;
        if (state.watchingStableTicks >= 2) {
          state.watchingRun = false;
          state.watchingStableTicks = 0;
          if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
          setChatStatus(refs, 'done', 'success');
        }
      } else {
        state.watchingStableTicks = 0;
      }
    } else if (state.watchingRun) {
      state.watchingRun = false;
      state.watchingStableTicks = 0;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      setChatStatus(refs, 'done', 'success');
    } else if (typeof state._setRunningVisible === 'function') {
      state._setRunningVisible(false);
      state.watchingStableTicks = 0;
    }
  } catch { /* the next tick retries */ }
}
