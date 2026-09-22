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

function setLiveRunState(state, key, patch) {
const prev = state.liveRun && state.liveRun.key === key
? state.liveRun
: { key, active: false, connected: false, ended: false, failed: false };
state.liveRun = Object.assign({}, prev, patch || {}, { key });
}

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
  setLiveRunState(state, key, { active: true, connected: false, ended: false, failed: false });
  const fromLiveSeq = Number.isFinite(state.nextLiveSeq) ? state.nextLiveSeq : 0;

  fetch('/api/chats/' + encodeURIComponent(chatId) + '/live?projectDir=' + encodeURIComponent(projectDir) + '&fromLiveSeq=' + fromLiveSeq, {
    signal: ctl.signal
  }).then((resp) => {
    if (!active) return null;
    if (!resp.ok || !resp.body) {
      setLiveRunState(state, key, { active: false, connected: false, ended: false, failed: true });
      return null;
    }
    setLiveRunState(state, key, { active: true, connected: true, failed: false });
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
            handleLiveRunEnd(ev, refs, state, key);
            return; // run finished — close
          }
          dispatchLiveEvent(ev, refs, state, key);
        }
      }
    } catch { /* socket closed / aborted */ }
  }).finally(() => {
    if (active) {
      active = false;
      liveByChat.delete(key);
      const current = state.liveRun;
      if (current && current.key === key && !current.ended && !current.failed) {
        setLiveRunState(state, key, { active: false, connected: false });
      }
    }
  });

  return true;
}

// closeLive(state, projectDir, chatId)
//
// Drop a live subscription (call on chat switch / unmount so a
// backgrounded or closed tab doesn't hold a socket for a chat the user
// left). No-op when this client doesn't own a subscription for it.
//
// Callers MUST pass the projectDir/chatId captured by their own effect
// closure. `state` is a stable ref object whose `props` field is
// reassigned during every render, so on a chat switch it already points
// at the chat the user moved TO by the time the cleanup runs — resolving
// the key from it would always miss and leak the previous chat's socket.
export function closeLive(state, projectDir, chatId) {
  const dir = projectDir || (state.props && state.props.projectDir);
  const id = chatId || (state.props && state.props.chatId);
  if (!dir || !id) return false;
  const key = dir + '::' + id;
  const entry = liveByChat.get(key);
  if (!entry) return false;
  liveByChat.delete(key);
  setLiveRunState(state, key, { active: false, connected: false });
  if (entry.abort) entry.abort.abort();
  return true;
}

// isCurrentChat(state, key) -> boolean
//
// Whether a subscription key still belongs to the chat mounted right now.
// A socket for a chat the user has left keeps draining until its abort is
// observed, and must not paint into the transcript that replaced it.
function isCurrentChat(state, key) {
  const { projectDir, chatId } = state.props || {};
  if (!projectDir || !chatId) return false;
  return !key || key === projectDir + '::' + chatId;
}

// dispatchLiveEvent(ev, refs, state)
//
// Route a transient live event into the same handlers the owner SSE stream
// uses. shell_output and subagent_event mutate existing tool cards;
// progress_update creates/updates a progress card; authorization prompts
// mount the same overlay cards as the owner stream so returning to a chat
// shows the approval UI immediately instead of waiting for /pending.
function dispatchLiveEvent(ev, refs, state, key) {
  if (!refs.transcript || !refs.transcript.current) return;
  // The subscription belongs to a chat the user may have left; its socket
  // can still deliver a frame or two before the abort is observed.
  if (!isCurrentChat(state, key)) return;
  let data = null;
  try { data = JSON.parse(ev.data || 'null'); } catch { return; }
  if (!data || typeof data !== 'object') return;
  const liveSeq = typeof data.liveSeq === 'number' ? data.liveSeq : null;
  if (liveSeq != null) {
    if (liveSeq < (state.nextLiveSeq || 0)) return;
    state.nextLiveSeq = liveSeq + 1;
  }
  const { projectDir, chatId } = state.props;
  if (ev.eventName === 'live_subscribed') return;
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

function handleLiveRunEnd(ev, refs, state, key) {
  // A run that ended for a chat the user already left must not repaint the
  // chat mounted now — `removeOverlayCards` in particular would wipe a
  // pending authorization card belonging to the new chat.
  if (!isCurrentChat(state, key)) return;
  let data = null;
  try { data = JSON.parse(ev.data || 'null'); } catch { data = null; }
  if (data && typeof data.nextLiveSeq === 'number' && data.nextLiveSeq > (state.nextLiveSeq || 0)) state.nextLiveSeq = data.nextLiveSeq;
  setLiveRunState(state, key, { active: false, connected: false, ended: true, failed: false });
  removeOverlayCards(refs);
  state.watchingRun = false;
  state.watchingStableTicks = 0;
  state.runSettled = true;
  if (typeof state._setRunningVisible === 'function') state._setRunningVisible(false);
  setChatStatus(refs, 'done', 'success');
  // Immediately sync the final persisted message so the transcript
  // paints the completed turn without waiting for the next idle poll.
  if (typeof state._kickPoll === 'function') state._kickPoll();
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