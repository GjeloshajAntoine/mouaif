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
  updateProgressCard
} from './transcript.js';
import { afterTranscriptAppend } from './scroll.js';
import { renderUsageMeta, updateUsageSummary, setChatStatus } from './usage.js';
import { refreshChatTitle, updateChat } from './meta.js';
import { authorizationCard, askUserCard, removePendingAuthorizationCards } from './cards.js';
import { normalizeToolName, parseToolArgs } from './tools.js';
import { queueComposerDraftSave } from './composer.js';

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
    return fetchJson('/api/tools/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId, callId, cmd })
    });
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
    appendToolResultCard({ id: null, name: 'shell', args: { cmd }, ok: false, result: { error: String(err) } }, refs);
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
  let synced = null;
  try {
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
    if (r.status === 200 && Array.isArray(r.body.messages)) synced = r.body.messages;
  } catch { synced = null; }

  if (!synced) {
    // Server unreachable — keep trying while attempts remain.
    if (st.attempts < 6) return scheduleRecoveryTick(state, refs, st.attempts);
    return finishStreamRecovery(state, refs, 'could not reconnect — tap to retry', true);
  }

  const signature = JSON.stringify(synced);
  const grew = signature !== state.transcriptSignature;
  if (grew) {
    // New content landed on disk. Swap in the authoritative rows and
    // reset the stability counter — the run is clearly still going.
    state.messages = synced;
    state.transcriptSignature = signature;
    if (state._renderTranscript) state._renderTranscript();
    st.stableTicks = 0;
    setChatStatus(refs, 'reconnected — syncing…', 'busy');
    return scheduleRecoveryTick(state, refs, st.attempts);
  }

  // Transcript is stable. A run is done when the last message is no
  // longer a bare tool call (a call with no result yet means the agent
  // is mid-tool) and we've seen a couple of identical polls.
  const last = synced[synced.length - 1];
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
    if (refs.transcript.current.querySelector('[data-auth-call-id="' + String(request.callId).replace(/"/g, '\\"') + '"]')) continue;
    if (request.tool === 'ask_user' && request.args) {
      askUserCard(Object.assign({}, request.args, { callId: request.callId, tool: request.tool }), projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st));
    } else {
      authorizationCard(request, projectDir, chatId, refs, null, state);
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
  // the exact provider/model choice.
  await updateChat({ providerId, modelId }, state, refs);

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

  // Live per-turn counter. The chat UI runs this on every delta;
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
      authorizationCard(data, projectDir, chatId, refs, null, state);
      return;
    }
    if (data && data.parentTool === 'subagent' && ev.eventName === 'ask_user_required') {
      askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st));
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
      refreshChatTitle(state, refs);
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
    } else if (ev.eventName === 'authorization_required') {
      authorizationCard(data, projectDir, chatId, refs, null, state);
    } else if (ev.eventName === 'ask_user_required') {
      askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st));
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
    const synced = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
    if (synced.status === 200 && Array.isArray(synced.body.messages)) {
      state.messages = synced.body.messages;
      state.transcriptSignature = JSON.stringify(state.messages);
      if (state._renderTranscript) state._renderTranscript();
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
// this chat" poller. Re-renders the transcript if the persisted
// rows changed and surfaces the running flag as a busy status.
//
// Cheap tick: fetch the chat record (small) + a transcript revision
// marker ({ count, ts }) instead of the full message list. The old
// implementation re-fetched every message every second just to
// JSON.stringify and compare — multi-MB per tick on long transcripts.
// The full message list is only fetched when the revision actually
// changed (or a run is active and we need to catch up).
export async function reconcileRunningChat(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!chatId || !projectDir) return;
  if (state.streaming) return; // don't reconcile over our own stream
  try {
    const [rChat, rRev] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/revision?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rRev.status !== 200 || rRev.body == null) return;
    const rev = rRev.body;
    const running = !!(rChat.status === 200 && rChat.body.chat && rChat.body.chat.running);
    const revKey = rev.count + ':' + (rev.ts || '');
    if (revKey !== state.transcriptRevision) {
      // Transcript changed on disk (this tab is a follower, or the
      // stream finished while we were backgrounded). Pull the
      // authoritative rows and re-render.
      const synced = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
      if (synced.status === 200 && Array.isArray(synced.body.messages)) {
        state.transcriptRevision = revKey;
        state.messages = synced.body.messages;
        state.transcriptSignature = JSON.stringify(state.messages);
        if (state._renderTranscript) state._renderTranscript();
      }
    }

    if (running) {
      state.watchingRun = true;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(true);
      setChatStatus(refs, 'streaming…', 'busy');
      loadPendingAuthorization(state, refs);
    } else if (state.watchingRun) {
      state.watchingRun = false;
      if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
      setChatStatus(refs, 'done', 'success');
    } else if (typeof state._setRunningVisible === 'function') {
      state._setRunningVisible(false);
    }
  } catch { /* the next tick retries */ }
}
