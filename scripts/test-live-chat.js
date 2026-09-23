// Tests for the per-chat live-replay stream (src/live-chat.js) and its
// web route (GET /api/chats/:id/live).
//
// The live-replay layer lets a follower client — a second tab, or a
// returning page that lost or never had the primary SSE socket — render
// the transient tool events (shell_output, subagent_event,
// progress_update, authorization_required, ask_user_required) of an
// in-flight run into its tool cards in real time, instead of seeing
// cards pinned on "Waiting for results…" or waiting for /pending.
//
// Server process control lives in this script; the module-level registry
// is exercised directly with a stub response object. We also verify the
// HTTP route refuses (404) to subscribe to a chat that is NOT running —
// a client must never hold a dead live socket.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const liveChat = require('../src/live-chat.js');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-live-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-live-proj-'));

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}
const isStr = (s) => typeof s === 'string';

// ---- Unit: live-chat.js registry --------------------------------------

function makeFakeRes(onWrite) {
  const res = { _ended: false, _chunks: [] };
  const write = (c) => {
    if (typeof c === 'string') res._chunks.push(c);
    if (onWrite) onWrite(c);
  };
  res.writeHead = () => res;
  res.write = (c) => { write(c); return true; };
  res.setHeader = () => res;
  res.end = () => { res._ended = true; };
  res.on = () => res;
  return res;
}
function collectFrames(res) {
  return res._chunks.join('').split('\n\n').filter(Boolean)
    .map((f) => {
      let name = 'message', data = '';
      for (const line of f.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6) + '\n';
      }
      return { name, data: data.trim() };
    });
}

function baseTest() {
  console.log('live-chat.js unit behavior');
  const rk = 'PROJ::AAAABBBB';
  liveChat.ensureLiveChat(rk);

  // pushLive before any subscriber: nothing recorded unless a run entry
  // exists (it does after ensureLiveChat) — buffer the transient events.
  liveChat.pushLive(rk, 'shell_output', { id: 'c1', stream: 'stdout', delta: 'hello' });
  liveChat.pushLive(rk, 'shell_output', { id: 'c1', stream: 'stdout', delta: ' ' });
  liveChat.pushLive(rk, 'progress_update', { callId: 'c2', title: 'Build', current: 5, total: 10, status: 'running', message: 'compiling' });
  liveChat.pushLive(rk, 'authorization_required', { callId: 'auth1', tool: 'shell', cmd: 'npm test' });
  liveChat.pushLive(rk, 'ask_user_required', { callId: 'ask1', tool: 'ask_user', question: 'Proceed?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] });

  // addSubscriber replays the buffered transient events immediately.
  const sub = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub);
  const frames = collectFrames(sub);
  const names = frames.map((f) => f.name);
  t('replay starts with live_subscribed', frames[0] && frames[0].name === 'live_subscribed', JSON.stringify(names));
  const firstShell = frames.find((f) => f.name === 'shell_output');
  let firstShellData = null; try { firstShellData = firstShell ? JSON.parse(firstShell.data) : null; } catch {}
  t('replayed events carry liveSeq', firstShellData && firstShellData.liveSeq === 0, firstShellData);
  const replayed = frames.filter((f) => f.name === 'shell_output').length;
  t('replays buffered shell_output for the run', replayed === 2, 'saw ' + replayed);
  t('replays buffered progress_update', frames.some((f) => f.name === 'progress_update'));
  t('replays buffered authorization prompt', frames.some((f) => f.name === 'authorization_required' && f.data.includes('auth1')));
  t('replays buffered ask_user prompt', frames.some((f) => f.name === 'ask_user_required' && f.data.includes('ask1')));

  // Live push to a connected subscriber reaches it.
  sub._chunks = [];
  liveChat.pushLive(rk, 'shell_output', { id: 'c1', stream: 'stdout', delta: 'world' });
  const liveFrames = collectFrames(sub);
  t('pushes new shell_output to subscriber', liveFrames.some((f) => f.name === 'shell_output' && f.data.includes('world')), JSON.stringify(liveFrames));
  const subFromSeq = makeFakeRes();
  liveChat.addSubscriber(rk, null, subFromSeq, { fromLiveSeq: 3 });
  const fromSeqFrames = collectFrames(subFromSeq);
  t('fromLiveSeq replays only missed live events', !fromSeqFrames.some((f) => f.data.includes('hello')) && !fromSeqFrames.some((f) => f.data.includes('Build')) && fromSeqFrames.some((f) => f.data.includes('world')), JSON.stringify(fromSeqFrames));

  // pruneLive drops the buffered transient stream for a tool whose
  // result was persisted, so a late subscriber won't re-draw content the
  // result card already rendered. The tool's `tool_result` carries its
  // id — here c1.
  liveChat.pruneLive(rk, 'c1');
  const sub2 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub2);
  const f2 = collectFrames(sub2);
  const replayed2 = f2.filter((f) => f.name === 'shell_output').length;
  t('prune drops the tool_id stream for a late subscriber', replayed2 === 0, 'saw ' + replayed2);
  t('progress_update survives prune (never persisted)', f2.some((f) => f.name === 'progress_update'));
  t('unanswered authorization prompt survives unrelated prune', f2.some((f) => f.name === 'authorization_required' && f.data.includes('auth1')));
  sub._chunks = [];
  liveChat.pruneLive(rk, 'auth1');
  const resolvedFrames = collectFrames(sub);
  t('prune emits authorization_resolved to subscribers', resolvedFrames.some((f) => f.name === 'authorization_resolved' && f.data.includes('auth1')));
  const sub3 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub3);
  const f3 = collectFrames(sub3);
  t('answered authorization prompt is not replayed late', !f3.some((f) => f.name === 'authorization_required' && f.data.includes('auth1')));
  t('unanswered ask_user prompt still replays late', f3.some((f) => f.name === 'ask_user_required' && f.data.includes('ask1')));

  // finishLiveChat closes the subscriber with run_end and clears the entry.
  liveChat.finishLiveChat(rk);
  t('run_end notifies subscribers', collectFrames(sub).some((f) => f.name === 'run_end'));
}

// Assistant text deltas are broadcast to followers but never buffered: a turn
// emits one per token, so replaying them on every reconnect would cost more
// than the deltas that follow the subscription and would grow the buffer
// without bound. The in-progress segment is handed over separately, once.
function transientTest() {
  console.log('live-chat.js transient text deltas + segment handover');
  const rk = 'PROJ::TRANSIENT';

  // Nothing is recorded when no run entry exists (kept cheap for the common
  // case where nobody is following).
  liveChat.pushTransient(rk, 'message', { delta: 'ignored' });
  liveChat.ensureLiveChat(rk);
  t('no run entry means the transient push is a no-op', true);

  const sub = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub);
  sub._chunks = [];
  liveChat.pushTransient(rk, 'message', { delta: 'hello ' });
  const frames = collectFrames(sub);
  t('a transient delta reaches a connected subscriber', frames.some((f) => f.name === 'message' && f.data.includes('hello')),
    JSON.stringify(frames));
  const deltaFrame = frames.find((f) => f.name === 'message');
  let deltaData = null; try { deltaData = JSON.parse(deltaFrame.data); } catch { }
  t('a transient delta carries no liveSeq', deltaData && deltaData.liveSeq === undefined, String(deltaFrame.data));

  // The cursor must not move: a later buffered event still replays from the
  // seq the client actually holds. If the transient had consumed a seq, a
  // reconnect asking for `fromLiveSeq` would skip this shell_output.
  sub._chunks = [];
  liveChat.pushLive(rk, 'shell_output', { id: 'c1', stream: 'stdout', delta: 'out' });
  const sub2 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub2, { fromLiveSeq: 0 });
  const f2 = collectFrames(sub2);
  t('a transient push does not advance the replay cursor',
    f2.some((f) => f.name === 'shell_output' && f.data.includes('out')), JSON.stringify(f2.map((f) => f.name)));

  // Transients are absent from a fresh subscriber's replay: nothing to replay.
  t('transient deltas are not replayed to a later subscriber',
    !f2.some((f) => f.name === 'message'), JSON.stringify(f2.map((f) => f.name)));

  // The mid-turn segment snapshot IS handed over, exactly once, and without a
  // liveSeq (it is not a buffered event).
  liveChat.setSegment(rk, 'partial answer', 'thinking so far');
  const sub3 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub3);
  const f3 = collectFrames(sub3);
  const segFrame = f3.find((f) => f.name === 'live_segment');
  let segData = null; try { segData = JSON.parse(segFrame.data); } catch { }
  t('a mid-turn subscriber receives the in-progress segment', !!(segData && segData.text === 'partial answer'), String(segFrame && segFrame.data));
  t('the segment handover carries the reasoning too', !!(segData && segData.reasoning === 'thinking so far'));
  t('the segment handover carries no liveSeq', !!(segData && segData.liveSeq === undefined));
  t('the live_subscribed frame is not mistaken for a segment', segData && segData.liveSeq === undefined);

  // A cleared segment sends nothing: the segment that ended is persisted as a
  // transcript row and reaches the follower through the message sync.
  liveChat.setSegment(rk, '', '');
  const sub4 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub4);
  t('an empty segment is not handed over', !collectFrames(sub4).some((f) => f.name === 'live_segment'));

  // hasSubscribers gates the per-delta snapshot maintenance.
  liveChat.finishLiveChat(rk);
  t('hasSubscribers is false with no run entry', liveChat.hasSubscribers(rk) === false);
  liveChat.ensureLiveChat(rk);
  t('hasSubscribers is false before anyone subscribes', liveChat.hasSubscribers(rk) === false);
  const sub5 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub5);
  t('hasSubscribers is true once someone subscribes', liveChat.hasSubscribers(rk) === true);
  liveChat.finishLiveChat(rk);
}

// progress_update is a latest-value event: each frame carries the whole state
// (title, current, total, status, message) and it is never persisted, so
// buffering every frame made a long run replay one entry per progress report on
// every return to the chat — to draw a single card. replaceLive keeps only the
// newest per call id.
function progressCoalescingTest() {
  console.log('live-chat.js coalesces progress_update to the latest per call');
  const rk = 'PROJ::PROGRESS';
  liveChat.ensureLiveChat(rk);

  liveChat.replaceLive(rk, 'progress_update', { callId: 'p1', title: 'Build', current: 1, total: 10, status: 'running' }, liveChat.progressKey({ callId: 'p1' }));
  liveChat.replaceLive(rk, 'progress_update', { callId: 'p1', title: 'Build', current: 5, total: 10, status: 'running' }, liveChat.progressKey({ callId: 'p1' }));
  liveChat.replaceLive(rk, 'progress_update', { callId: 'p1', title: 'Build', current: 10, total: 10, status: 'completed' }, liveChat.progressKey({ callId: 'p1' }));

  const sub = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub);
  const frames = collectFrames(sub).filter((f) => f.name === 'progress_update');
  t('many reports for one call replay as a single frame', frames.length === 1, 'saw ' + frames.length);
  let data = null; try { data = JSON.parse(frames[0].data); } catch { }
  t('the surviving frame is the latest state', !!(data && data.current === 10 && data.status === 'completed'), frames[0] && frames[0].data);

  // A different call id is a different card and must not be merged away.
  liveChat.replaceLive(rk, 'progress_update', { callId: 'p2', title: 'Tests', current: 1, total: 4, status: 'running' }, liveChat.progressKey({ callId: 'p2' }));
  const sub2 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub2);
  const names = collectFrames(sub2).filter((f) => f.name === 'progress_update');
  t('a second call id keeps its own frame', names.length === 2, 'saw ' + names.length);

  const seqs = names.map((f) => { try { return JSON.parse(f.data).liveSeq; } catch { return null; } });
  t('each surviving progress frame carries a liveSeq', seqs.every((n) => typeof n === 'number'), JSON.stringify(seqs));

  // A frame with no call id falls back to the title, so a distinct card is
  // never lost to over-merging.
  liveChat.replaceLive(rk, 'progress_update', { title: 'Task A', current: 1, total: 3, status: 'running' }, liveChat.progressKey({ title: 'Task A' }));
  liveChat.replaceLive(rk, 'progress_update', { title: 'Task A', current: 3, total: 3, status: 'completed' }, liveChat.progressKey({ title: 'Task A' }));
  liveChat.replaceLive(rk, 'progress_update', { title: 'Task B', current: 1, total: 2, status: 'running' }, liveChat.progressKey({ title: 'Task B' }));
  const sub3 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub3);
  const titles = collectFrames(sub3)
    .filter((f) => f.name === 'progress_update')
    .map((f) => { try { return JSON.parse(f.data).title; } catch { return ''; } });
  t('title-keyed reports coalesce per title', titles.filter((x) => x === 'Task A').length === 1, JSON.stringify(titles));
  t('a differently titled report is preserved', titles.includes('Task B'), JSON.stringify(titles));

  // A progress frame is never persisted, so pruneLive must leave it alone.
  liveChat.pruneLive(rk, 'p1');
  const sub4 = makeFakeRes();
  liveChat.addSubscriber(rk, null, sub4);
  t('prune for a persisted tool result does not drop progress frames',
    collectFrames(sub4).some((f) => f.name === 'progress_update'));

  liveChat.finishLiveChat(rk);
}

function clientHandlerTest() {
  console.log('live.js dispatches the follower text path');
  const liveSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/live.js'), 'utf8');
  t('handleLiveRunEnd invokes state._kickPoll', liveSrc.includes("if (typeof state._kickPoll === 'function') state._kickPoll();"));
  // The follower must resume the older-history drain when the run ends; it
  // bails while a run is in flight and nothing else restarted it.
  t('handleLiveRunEnd resumes the older-history drain', liveSrc.includes('state._drainOlderMessages'));
  // Assistant deltas must reach the follower's bubble, not just the owner's.
  t('live.js routes message deltas into appendDeltaToLive', liveSrc.includes('appendDeltaToLive(data.delta'));
  t('live.js routes reasoning deltas into appendReasoningToLive', liveSrc.includes('appendReasoningToLive(data.delta'));
  t('live.js finalizes a segment on assistant_turn_end', liveSrc.includes('finalizeLiveSegment(refs, state'));
  t('live.js restores the in-progress segment', liveSrc.includes('restoreLiveSegment(data'));

  // The owner SSE path must NOT mirror its own deltas into the live stream:
  // it would draw the sending tab's bubble twice.
  const streamSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
  t('the owner SSE path does not append its own live deltas', !streamSrc.includes('appendDeltaToLive(data.delta, refs, state, true)'));

  // The server must broadcast deltas transiently (no buffer) and keep the
  // segment snapshot current only while someone follows.
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server-handlers-chats.js'), 'utf8');
  t('server broadcasts message deltas transiently', serverSrc.includes("liveChat.pushTransient(runKey, name, data)"));
  t('server broadcasts the segment boundary with a seq', serverSrc.includes('seq: nextLiveMessageSeq(runKey, assistantSegmentHasText)'));
  t('server maintains the segment snapshot only with subscribers', serverSrc.includes('if (liveChat.hasSubscribers(runKey)) liveChat.setSegment('));
}

// ---- HTTP: GET /api/chats/:id/live -------------------------------------

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      method, host: '127.0.0.1', port, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(b); } catch { json = b; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/');
      if (typeof r.status === 'number') return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function httpTest() {
  console.log('GET /api/chats/:id/live route guard');
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: Object.assign({}, process.env, {
      MOUAIF_HOME: mouaifHome,
      MOUAIF_ALLOW_ANY_ROOT: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  const up = await waitForServer();
  if (!up) { console.error('server failed to start:\n' + serverLog); child.kill(); process.exit(1); }

  try {
    const idMatch = /^[a-f0-9]{8}$/i;

    // Subscribing to a chat that is NOT running must 404 (no dead live
    // socket) — and must not hang.
    const create = await request('POST', '/api/chats', { projectDir: root });
    t('POST /api/chats 201', create.status === 201 && create.body && isStr(create.body.chat.id) && idMatch.test(create.body.chat.id), JSON.stringify(create));
    const chatId = create.body.chat.id;
    const live = await request('GET', '/api/chats/' + encodeURIComponent(chatId) + '/live?projectDir=' + encodeURIComponent(root));
    t('live on a non-running chat returns after rejecting', live.status === 404, 'status=' + live.status + ' ' + JSON.stringify(live.body));
    t('live rejection is JSON (not a held SSE)', typeof live.body === 'object' && live.body.error != null, JSON.stringify(live.body));

    // A chat id that doesn't exist also rejects cleanly.
    const missing = await request('GET', '/api/chats/00000000/live?projectDir=' + encodeURIComponent(root));
    t('live on a missing chat 404', missing.status === 404, 'status=' + missing.status);
  } finally {
    child.kill('SIGTERM');
  }
}

let port = 0;

async function run() {
  baseTest();
  transientTest();
  progressCoalescingTest();
  clientHandlerTest();
  await httpTest();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });