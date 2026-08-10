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
  await httpTest();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });