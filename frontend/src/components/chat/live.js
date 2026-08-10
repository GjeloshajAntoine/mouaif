// mouaif web — Per-chat live replay subscription
//
// While a chat is running, the server keeps a per-chat live stream
// (GET /api/chats/:id/live, src/live-chat.js) that replays the
// buffered transient tool events — shell_output, subagent_event,
// progress_update, authorization_required, and ask_user_required —
// and fans out new ones until the run ends. This
// module opens/dispatches that stream and routes each transient event
// into the same handlers the live SSE uses, so:
//
//   - a second tab following the same running chat renders shell
//     output and subagent activity in real time (previously only the
//     settled transcript arrived, with tool cards stuck on
//     "Running…"), and
//   - a returning page that lost or never had the primary SSE socket
//     still shows live content for a chat that is still running.
//
// The stream is deduped by (projectDir, chatId): two followers never
// open two sockets for the same chat. It closes itself on `run_end`
// (which also tells the caller the run finished).

import { parseSSEFrame } from '../../api.js';
import { authorizationCard, askUserCard } from './cards.js';
import { handleShellOutputEvent, handleSubagentStreamEvent, updateProgressCard } from './transcript.js';
import { mountOverlayCard, removeOverlayCardByCallId, removeOverlayCards } from './overlay.js';
import { setChatStatus } from './usage.js';

const liveByChat = new Map();

// subscribeLive(state, refs)
//
// Open a per-chat live stream for the current chat if it's running and
// no subscription exists yet. Each transient event is dispatched to the
// matching chat/stream handler. Returns true once a subscription is
// active for this chat (either just opened or already present).
export function subscribeLive(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return false;
  const key = projectDir + '::' + chatId;
  if (liveByChat.has(key)) return true;

  let active = true;
  const ctl = new AbortController();
  liveByChat.set(key, { abort: ctl }); // reserve early so concurrent ticks don't double-open

  fetch('/api/chats/' + encodeURIComponent(chatId) + '/live?projectDir=' + encodeURIComponent(projectDir), {
    signal: ctl.signal
  }).then((resp) => {
    if (!active || !resp.ok) return null;
    if (!resp.body) return null;
    return resp.body.getReader();
  }).then(async function consume(reader) {
    if (!reader) return;
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = parseSSEFrame(frame); if (!ev) continue;
          if (ev.eventName === 'run_end') {
            handleLiveRunEnd(refs, state);
            return; // run finished — close
          }
          dispatchLiveEvent(ev, refs, state);
        }
      }
    } catch { /* socket closed / aborted */ }
  }).finally(() => {
    if (active) {
      active = false;
      liveByChat.delete(key);
    }
  });

  return true;
}

// closeLive(state)
//
// Drop the current chat's live subscription (call on unmount so a
// backgrounded/closed tab doesn't hold a socket for a chat the user
// left). No-op when this client doesn't own a subscription for it.
export function closeLive(state) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  const key = projectDir + '::' + chatId;
  const entry = liveByChat.get(key);
  if (!entry) return;
  liveByChat.delete(key);
  if (entry.abort) entry.abort.abort();
}

// dispatchLiveEvent(ev, refs, state)
//
// Route a transient live event into the same handlers the owner SSE stream
// uses. shell_output and subagent_event mutate existing tool cards;
// progress_update creates/updates a progress card; authorization prompts
// mount the same overlay cards as the owner stream so returning to a chat
// shows the approval UI immediately instead of waiting for /pending.
function dispatchLiveEvent(ev, refs, state) {
  if (!refs.transcript || !refs.transcript.current) return;
  let data = null;
  try { data = JSON.parse(ev.data || 'null'); } catch { return; }
  if (!data || typeof data !== 'object') return;
  const { projectDir, chatId } = state.props;
  if (ev.eventName === 'shell_output') {
    handleShellOutputEvent(data, refs);
    return;
  }
  if (ev.eventName === 'subagent_event') {
    handleSubagentStreamEvent({ eventName: data.kind || 'message' }, Object.assign({ parentCallId: data.parentCallId }, data.data || {}), refs);
    return;
  }
  if (ev.eventName === 'progress_update') {
    updateProgressCard(refs, data);
    setLiveStatus(refs, data);
    return;
  }
  if (ev.eventName === 'authorization_resolved') {
    removeOverlayCardByCallId(refs, data.callId);
    return;
  }
  if (ev.eventName === 'authorization_required') {
    mountOverlayCard(refs, data.callId, () => authorizationCard(data, projectDir, chatId, refs, null, state));
    setChatStatus(refs, 'authorization required', 'busy');
    return;
  }
  if (ev.eventName === 'ask_user_required') {
    mountOverlayCard(refs, data.callId, () => askUserCard(data, projectDir, chatId, refs, (txt, st) => setChatStatus(refs, txt, st)));
    setChatStatus(refs, 'answer required', 'busy');
  }
}

function handleLiveRunEnd(refs, state) {
  removeOverlayCards(refs);
  state.watchingRun = false;
  state.watchingStableTicks = 0;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  setChatStatus(refs, 'done', 'success');
}

// setLiveStatus(refs, data)
//
// Mirror the live SSE stream's busy-status update for progress so a
// returning page shows the running percentage in the status bar too.
function setLiveStatus(refs, data) {
  if (!refs.status || !refs.status.current) return;
  const pct = data.current != null && data.total != null
    ? Math.round((Number(data.current) / Math.max(1, Number(data.total))) * 100) + '%'
    : (data.status || 'running');
  refs.status.current.textContent = (data.title || 'Progress') + ' ' + pct;
}