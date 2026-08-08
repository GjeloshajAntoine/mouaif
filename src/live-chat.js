'use strict';

// Per-chat live-replay registry.
//
// While a chat has an in-flight streaming run, the "transient" tool
// events — shell stdout/stderr (`shell_output`), nested subagent
// activity (`subagent_event`), and progress updates (`progress_update`)
// — are buffered here and fanned out to any subscribed follower.
//
// A follower is the UI on a *different* client (another tab/device) or
// a returning page that shows this running chat. Without this registry
// it would only ever see the settled transcript: tool call cards pinned
// on "Running…" / "Waiting for results…" with no live content until the
// final `tool_result` is persisted. The buffer + replay lets it render
// the live stream into those cards in real time.
//
// The buffer intentionally holds ONLY content not yet represented in the
// persisted transcript. Whenever a tool's result is persisted
// (`tool_result`, handled by `pruneLive`), that tool's buffered transient
// stream is dropped, so a late-subscribing follower can never re-draw
// content that the result card already rendered. Progress updates are
// never persisted, so they are kept until the run finishes.

const runs = new Map();

function sseFrame(name, data) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

// ensureLiveChat(runKey) -> run
//
// Create (or return) the live-run entry for a chat that just started
// streaming. Keyed by the same runningKey used for runningChats.
function ensureLiveChat(runKey) {
  let r = runs.get(runKey);
  if (!r) {
    r = { buffer: [], subscribers: new Set() };
    runs.set(runKey, r);
  }
  return r;
}

// pushLive(runKey, name, data)
//
// Record a transient event and push it to every subscribed follower.
// Called from handleChatStream's `emit` for shell_output /
// subagent_event / progress_update only.
function pushLive(runKey, name, data) {
  const r = runs.get(runKey);
  if (!r) return;
  r.buffer.push({ name, data });
  const frame = sseFrame(name, data);
  for (const sub of r.subscribers) {
    try { sub.write(frame); } catch { /* socket closed */ }
  }
}

// pruneLive(runKey, toolId)
//
// Drop the buffered transient events for a tool whose result has just
// been persisted. `toolId` is the SSE `tool_result` id — the same as
// `shell_output`'s `id` field and the `subagent_event` `parentCallId`.
function pruneLive(runKey, toolId) {
  const r = runs.get(runKey);
  if (!r || !r.buffer.length) return;
  const id = String(toolId == null ? '' : toolId);
  if (!id) return;
  r.buffer = r.buffer.filter((e) => {
    if (e.name === 'shell_output') {
      return String((e.data && e.data.id) == null ? '' : e.data.id) !== id;
    }
    if (e.name === 'subagent_event') {
      return String((e.data && e.data.parentCallId) == null ? '' : e.data.parentCallId) !== id;
    }
    return true;
  });
}

// addSubscriber(runKey, req, res)
//
// Open a per-chat live SSE for a follower: write the SSE headers,
// replay the buffered transient events, then register the response so
// `pushLive` reaches it. Returns the subscriber (whose lifecycle the
// caller owns through `finishLiveChat`). Requires the chat to actually
// be running — the caller checks that before calling.
function addSubscriber(runKey, req, res) {
  const r = ensureLiveChat(runKey);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(sseFrame('live_subscribed', { count: r.buffer.length }));
  for (let i = 0; i < r.buffer.length; i++) {
    try { res.write(sseFrame(r.buffer[i].name, r.buffer[i].data)); } catch { break; }
  }
  r.subscribers.add(res);
  // Drop the subscriber if the client hangs up (the client also closes
  // on `run_end`). Guards keep the set from leaking a dead socket.
  const onClose = () => { r.subscribers.delete(res); };
  if (req && typeof req.on === 'function') req.on('close', onClose);
  res.on('close', onClose);
  return res;
}

// finishLiveChat(runKey)
//
// The run ended: tell every follower (so it settles its running state
// and lets the reconcile poll clear the busy UI), then drop the entry.
function finishLiveChat(runKey) {
  const r = runs.get(runKey);
  if (!r) return;
  runs.delete(runKey);
  const frame = sseFrame('run_end', {});
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