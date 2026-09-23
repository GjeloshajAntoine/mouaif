'use strict';

// Per-chat live-replay registry.
//
// While a chat has an in-flight streaming run, the transient tool events
// (shell/subagent/progress/auth prompts) are buffered here and fanned out
// to followers. Persisted transcript rows use message `seq`; this module
// uses a separate `liveSeq` cursor for transient events so a reconnect can
// replay only the live chunks the client has not consumed yet.

const runs = new Map();

function sseFrame(name, data) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function ensureLiveChat(runKey) {
  let r = runs.get(runKey);
  if (!r) {
    r = { nextLiveSeq: 0, buffer: [], subscribers: new Set(), segment: { text: '', reasoning: '' } };
    runs.set(runKey, r);
  }
  return r;
}

// setSegment(runKey, text, reasoning)
//
// Record the text the run has produced since the last `assistant_turn_end`.
// Text deltas are never buffered (see pushTransient), so this snapshot is the
// only record of the in-progress segment: without it a follower that joins
// mid-turn paints no bubble at all until the segment ends, and "streaming…"
// looks stalled while tokens are actually flowing. Cleared on each segment
// boundary, because the segment that just ended is persisted as a transcript
// row and reaches the follower through the normal message sync.
function setSegment(runKey, text, reasoning) {
  const r = runs.get(runKey);
  if (!r) return;
  r.segment = { text: text || '', reasoning: reasoning || '' };
}

function pushLive(runKey, name, data) {
  const r = runs.get(runKey);
  if (!r) return;
  const ev = { liveSeq: r.nextLiveSeq++, name, data };
  r.buffer.push(ev);
  const frame = sseFrame(name, Object.assign({ liveSeq: ev.liveSeq }, data || {}));
  for (const sub of r.subscribers) {
    try { sub.write(frame); } catch { /* socket closed */ }
  }
}

// replaceLive(runKey, name, data, key)
//
// Push an event and, in the same step, drop any earlier buffered event of the
// same name carrying the same coalescing key. Used for the progress stream.
//
// `progress_update` is a LATEST-VALUE event, not a log: each frame carries the
// whole state (title, current, total, status, message), so an earlier frame is
// worthless once a newer one exists. It is also never persisted, so nothing
// else re-delivers it. Buffering every frame meant a run that reported progress
// across many tool rounds accumulated one entry per report, and every
// subsequent return to the chat replayed all of them to draw a single final
// card — a cost that grew with the length of the run, for output nobody sees.
//
// The surviving frame keeps the newer liveSeq, so a client that already
// consumed a superseded frame is not asked to rewind.
function replaceLive(runKey, name, data, key) {
  const r = runs.get(runKey);
  if (!r) return;
  const id = String(key == null ? '' : key);
  if (id && r.buffer.length) {
    r.buffer = r.buffer.filter((e) => !(e.name === name && progressKey(e.data) === id));
  }
  pushLive(runKey, name, data);
}

// pushTransient(runKey, name, data)
//
// Fan an event out to the subscribers connected RIGHT NOW, without
// buffering it for replay and without consuming a liveSeq.
//
// Used for the assistant text deltas (`message` / `reasoning`) and the
// per-segment boundary (`assistant_turn_end`). Those are the highest-volume
// frames on the stream — a long turn emits one per token — and they are the
// one family of events a late subscriber does NOT need replayed: whatever
// the run produced before it joined is either already covered by the
// persisted transcript rows the reconcile poll fetches, or is superseded by
// the segment that lands at `assistant_turn_end`. Buffering them would make
// every reconnect replay the whole turn's text (and grow the buffer without
// bound), for no gain over the deltas that follow the subscription.
//
// Not allocating a liveSeq is deliberate: the cursor exists to let a
// reconnect ask for "everything after N", and a transient frame that is
// never stored must not advance it — doing so would make a reconnect's
// `fromLiveSeq` skip a buffered shell_output that sat below the transient's
// seq. A frame with no liveSeq is simply applied by the client (see
// frontend/src/components/chat/live.js).
function pushTransient(runKey, name, data) {
  const r = runs.get(runKey);
  if (!r || !r.subscribers.size) return;
  const frame = sseFrame(name, data || {});
  for (const sub of r.subscribers) {
    try { sub.write(frame); } catch { /* socket closed */ }
  }
}

// hasSubscribers(runKey) -> bool
//
// Whether anyone is currently following this run. The text-delta path uses it
// to skip maintaining the mid-turn snapshot when no follower exists — the
// common case (the sending tab is on the primary SSE socket, not the live
// stream), so the snapshot costs nothing on an ordinary turn.
function hasSubscribers(runKey) {
  const r = runs.get(runKey);
  return !!(r && r.subscribers.size);
}

function eventToolId(e) {
  const data = e && e.data;
  if (!data) return '';
  if (e.name === 'shell_output') return String(data.id == null ? '' : data.id);
  if (e.name === 'subagent_event') return String(data.parentCallId == null ? '' : data.parentCallId);
  if (e.name === 'authorization_required' || e.name === 'ask_user_required') return String(data.callId == null ? '' : data.callId);
  // Deliberately NOT `progress_update`: pruneLive drops everything matching a
  // tool id whose result was just persisted, and a progress frame is never
  // persisted — dropping it would lose the run's progress card for a late
  // subscriber. Coalescing uses progressKey below, which is separate on
  // purpose.
  return '';
}

// progressKey(data) -> string
//
// Coalescing key for a progress frame, used by replaceLive only.
//
// A frame's `callId` identifies the tool call that reported it and is the same
// id the frontend keys the progress CARD by (`[data-progress-id]`), so two
// frames with the same callId always draw the same card and the older one is
// redundant.
//
// A frame with no callId — the subagent forwarding path reuses the event name
// without one, and `task`-derived updates may not carry one either — falls back
// to the title, which is the card's other identity. Keying by title is
// deliberately conservative: two same-titled reports coalesce, two differently
// titled ones both survive, so a distinct card is never lost to over-merging.
function progressKey(data) {
  const callId = data && data.callId != null ? String(data.callId) : '';
  if (callId) return 'call:' + callId;
  const title = data && data.title != null ? String(data.title) : '';
  return title ? 'title:' + title : '';
}

function pruneLive(runKey, toolId) {
  const r = runs.get(runKey);
  if (!r) return;
  const id = String(toolId == null ? '' : toolId);
  if (!id || !r.buffer.length) return;
  const hadOverlay = r.buffer.some((e) =>
    (e.name === 'authorization_required' || e.name === 'ask_user_required') && eventToolId(e) === id
  );
  r.buffer = r.buffer.filter((e) => eventToolId(e) !== id);
  if (hadOverlay) {
    const ev = { liveSeq: r.nextLiveSeq++, name: 'authorization_resolved', data: { callId: id } };
    r.buffer.push(ev);
    const frame = sseFrame(ev.name, Object.assign({ liveSeq: ev.liveSeq }, ev.data));
    for (const sub of r.subscribers) {
      try { sub.write(frame); } catch { /* socket closed */ }
    }
  }
}

function addSubscriber(runKey, req, res, options) {
  const r = ensureLiveChat(runKey);
  const fromLiveSeq = options && Number.isFinite(options.fromLiveSeq) ? options.fromLiveSeq : 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const replay = r.buffer.filter((e) => e.liveSeq >= fromLiveSeq);
  res.write(sseFrame('live_subscribed', {
    count: replay.length,
    nextLiveSeq: r.nextLiveSeq,
    fromLiveSeq
  }));
  for (const ev of replay) {
    try { res.write(sseFrame(ev.name, Object.assign({ liveSeq: ev.liveSeq }, ev.data || {}))); } catch { break; }
  }
  // Hand the in-progress segment over too. Deliberately NOT a `liveSeq`
  // frame: the cursor must only advance for buffered events, and a
  // reconnect's `fromLiveSeq` has to stay comparable with them.
  const seg = r.segment || { text: '', reasoning: '' };
  if (seg.text || seg.reasoning) {
    try { res.write(sseFrame('live_segment', { text: seg.text, reasoning: seg.reasoning })); } catch { /* closed */ }
  }
  r.subscribers.add(res);
  const onClose = () => { r.subscribers.delete(res); };
  if (req && typeof req.on === 'function') req.on('close', onClose);
  res.on('close', onClose);
  return res;
}

function finishLiveChat(runKey) {
  const r = runs.get(runKey);
  if (!r) return;
  runs.delete(runKey);
  const frame = sseFrame('run_end', { nextLiveSeq: r.nextLiveSeq });
  for (const sub of r.subscribers) {
    try { sub.write(frame); } catch { /* socket closed */ }
    try { sub.end(); } catch { /* already closed */ }
  }
  r.subscribers.clear();
}

module.exports = {
  ensureLiveChat,
  setSegment,
  hasSubscribers,
  pushLive,
  pushTransient,
  replaceLive,
  progressKey,
  pruneLive,
  addSubscriber,
  finishLiveChat
};
