// E2E: verify the server emits a stable per-row `seq` on BOTH the full
// /messages read and the incremental ?since= tail read, and that a tail
// fetch after appending yields rows whose seq continues monotonically.
// This is the identity the client's merge-by-seq relies on to never
// re-add a row it already holds (the fix for repeated last messages).
//
// Spawns the server, appends to a chat (JSON storage backend), checks:
//   - every returned message carries an integer `seq`;
//   - full read seqs are 0..N-1 in order;
//   - `since=N` returns only rows with seq >= N (no overlap with what
//     the client already has).
// Also runs the same against a project configured for chatStorage=db
// (SQLite message_store backend).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-seq-home-'));
const rootJson = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-seq-json-'));
const rootDb = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-seq-db-'));

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + JSON.stringify(msg)) : '')); }
}

let port = 0;
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      method, host: '127.0.0.1', port, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
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
    try { const r = await request('GET', '/'); if (typeof r.status === 'number') return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function argsForRoot(root, db) {
  return {
    env: Object.assign({}, process.env, {
      MOUAIF_HOME: mouaifHome,
      MOUAIF_ALLOW_ANY_ROOT: '1',
      MOUAIF_CHAT_STORAGE_DEFAULT: db ? 'db' : 'json'
    }),
    root
  };
}

async function run() {
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: argsForRoot(rootDb, false).env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  if (!(await waitForServer())) { console.error('server failed:\n' + serverLog); child.kill(); process.exit(1); }

  for (const [rn, root, db] of [['json', rootJson, false], ['db', rootDb, true]]) {
    // Configure storage for the project. The default is read from env
    // above (MOUAIF_CHAT_STORAGE_DEFAULT) unless overridden. Simpler:
    // write a .mouaif.json with chatStorage.
    try {
      fs.writeFileSync(path.join(root, '.mouaif.json'), JSON.stringify({ chatStorage: db ? 'db' : 'json' }));
    } catch {}
    const q = 'projectDir=' + encodeURIComponent(root);
    const create = await request('POST', '/api/chats', { projectDir: root });
    if (create.status !== 201 || !create.body || !create.body.chat) { t(rn + ' create chat', false, create); continue; }
    const chatId = create.body.chat.id;
    const base = '/api/chats/' + encodeURIComponent(chatId);
    for (const content of ['one', 'two', 'three', 'four']) {
      await request('POST', base + '/messages', { projectDir: root, role: 'user', content });
    }
    const full = await request('GET', base + '/messages?' + q);
    const msgs = full.body && full.body.messages;
    t(rn + ' full read has seq on every row',
      Array.isArray(msgs) && msgs.length === 4 && msgs.every((m) => Number.isInteger(m.seq)), msgs);
    t(rn + ' full read seqs are 0..N-1 in order',
      Array.isArray(msgs) && msgs.map((m) => m.seq).join(',') === '0,1,2,3', msgs && msgs.map((m)=>m.seq));
    // Tail: since=2 should return only seqs >= 2 (no overlap).
    const tail = await request('GET', base + '/messages?' + q + '&since=2');
    const tmsgs = tail.body && tail.body.messages;
    t(rn + ' since=2 returns only seq>=2 (no re-send of held rows)',
      Array.isArray(tmsgs) && tmsgs.length === 2 && tmsgs.every((m) => m.seq >= 2), tmsgs);
    t(rn + ' since=2 tail seqs continue (2,3)',
      Array.isArray(tmsgs) && tmsgs.map((m) => m.seq).join(',') === '2,3', tmsgs && tmsgs.map((m)=>m.seq));
    // Append one more + verify its seq continues (no reuse).
    await request('POST', base + '/messages', { projectDir: root, role: 'user', content: 'five' });
    const tail2 = await request('GET', base + '/messages?' + q + '&since=4');
    t(rn + ' append-after-tail continues seq (4)',
      tail2.body && tail2.body.messages && tail2.body.messages.length === 1 && tail2.body.messages[0].seq === 4,
      tail2.body && tail2.body.messages);
  }

  child.kill('SIGTERM');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });