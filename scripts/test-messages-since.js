// End-to-end test for GET /api/chats/:id/messages?fromSeq=<seq>:
// spawn the mouaif server on a free port, append messages to a chat,
// and verify the incremental tail fetch:
//
//   - no `fromSeq`        -> full list + nextSeq === length
//   - fromSeq < nextSeq   -> only the tail rows + nextSeq === length
//   - fromSeq === nextSeq -> empty tail (steady-state poll: no transfer)
//   - fromSeq > nextSeq   -> empty tail + nextSeq < fromSeq (rare full-rebuild signal)
//
// The append-only tail fetch is what the 1 s reconcile poll and the
// stream-recovery poll use to avoid re-transferring the whole
// transcript on every change.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-since-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-since-proj-'));

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

let port = 0;

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

async function run() {
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
    const q = 'projectDir=' + encodeURIComponent(root);

    // Create a chat and append three messages.
    const create = await request('POST', '/api/chats', { projectDir: root });
    t('POST /api/chats 201', create.status === 201 && create.body && create.body.chat && create.body.chat.id, JSON.stringify(create));
    const chatId = create.body.chat.id;
    const base = '/api/chats/' + encodeURIComponent(chatId);

    for (const content of ['one', 'two', 'three']) {
      const a = await request('POST', base + '/messages', { projectDir: root, role: 'user', content });
      if (a.status !== 201 && a.status !== 200) { t('append ' + content, false, JSON.stringify(a)); }
    }

    // Full fetch (no fromSeq): all rows + nextSeq echoes the length.
    const full = await request('GET', base + '/messages?' + q);
    t('full fetch 200 with 3 rows', full.status === 200 && full.body.messages.length === 3, JSON.stringify(full.body && full.body.messages && full.body.messages.length));
    t('full fetch nextSeq === 3', full.body.nextSeq === 3, 'nextSeq=' + full.body.nextSeq);

    // Tail fetch: fromSeq=1 -> rows 2..3 only.
    const tail = await request('GET', base + '/messages?' + q + '&fromSeq=1');
    t('fromSeq=1 returns 2 rows', tail.status === 200 && tail.body.messages.length === 2, JSON.stringify(tail.body));
    t('fromSeq=1 rows are the tail', tail.body.messages[0].content === 'two' && tail.body.messages[1].content === 'three');
    t('fromSeq=1 nextSeq === 3', tail.body.nextSeq === 3, 'nextSeq=' + tail.body.nextSeq);

    // Steady state: fromSeq === nextSeq -> empty tail, nothing to transfer.
    const steady = await request('GET', base + '/messages?' + q + '&fromSeq=3');
    t('fromSeq=3 returns 0 rows', steady.status === 200 && steady.body.messages.length === 0, JSON.stringify(steady.body));
    t('fromSeq=3 nextSeq === 3', steady.body.nextSeq === 3, 'nextSeq=' + steady.body.nextSeq);

    // Cursor-ahead signal: fromSeq > nextSeq -> empty tail with nextSeq < fromSeq so
    // the client detects mismatch and rebuilds.
    const shrunk = await request('GET', base + '/messages?' + q + '&fromSeq=9');
    t('fromSeq=9 returns 0 rows', shrunk.status === 200 && shrunk.body.messages.length === 0, JSON.stringify(shrunk.body));
    t('fromSeq=9 nextSeq < fromSeq (rebuild signal)', shrunk.body.nextSeq === 3 && shrunk.body.nextSeq < 9, 'nextSeq=' + shrunk.body.nextSeq);

    // Garbage fromSeq values fall back to the full list.
    const junk = await request('GET', base + '/messages?' + q + '&fromSeq=abc');
    t('fromSeq=abc ignored -> full list', junk.status === 200 && junk.body.messages.length === 3, JSON.stringify(junk.body && junk.body.messages && junk.body.messages.length));
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
