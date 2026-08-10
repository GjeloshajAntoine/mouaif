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
    r = { nextLiveSeq: 0, buffer: [], subscribers: new Set() };
    runs.set(runKey, r);
  }
  return r;
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

function eventToolId(e) {
  const data = e && e.data;
  if (!data) return '';
  if (e.name === 'shell_output') return String(data.id == null ? '' : data.id);
  if (e.name === 'subagent_event') return String(data.parentCallId == null ? '' : data.parentCallId);
  if (e.name === 'authorization_required' || e.name === 'ask_user_required') return String(data.callId == null ? '' : data.callId);
  return '';
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
  pushLive,
  pruneLive,
  addSubscriber,
  finishLiveChat
};
