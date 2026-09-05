// End-to-end test for GET /api/chats/:id/messages?limit=N&beforeSeq=S
// (chat backward pagination): spawn the mouaif server, append a chat with
// more than one page of messages, and verify the windowed fetch:
//
//   - no `limit`       -> full list + nextSeq (legacy mode preserved)
//   - `limit=5`        -> only the NEWEST 5 rows, oldest-first, plus
//                         total + hasMore + beforeSeq
//   - `limit=5&beforeSeq=<smallest seq>` -> the previous page of 5
//   - `limit` larger than the transcript -> all rows, hasMore=false
//   - `beforeSeq=0`    -> empty window (nothing older exists), hasMore=false
//
// The window cursor must walk backward from the newest page to seq 0
// without skipping or repeating rows.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-window-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-window-proj-'));
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
const create = await request('POST', '/api/chats', { projectDir: root });
t('POST /api/chats 201', create.status === 201 && create.body.chat && create.body.chat.id, JSON.stringify(create));
const chatId = create.body.chat.id;
const base = '/api/chats/' + encodeURIComponent(chatId) + '/messages?';
// Append 12 messages (seq 0..11).
for (let i = 0; i < 12; i++) {
const a = await request('POST', base.split('?')[0] + (base.includes('?') ? '' : '') , { projectDir: root, role: 'user', content: 'msg-' + i });
if (a.status !== 201 && a.status !== 200) { t('append ' + i, false, JSON.stringify(a)); }
}
// Legacy full fetch (no limit): all rows + nextSeq === 12.
const full = await request('GET', base + q);
t('full fetch 12 rows', full.status === 200 && full.body.messages.length === 12, JSON.stringify(full.body && full.body.messages && full.body.messages.length));
t('full fetch nextSeq === 12', full.body.nextSeq === 12, 'nextSeq=' + full.body.nextSeq);

// Window mode: limit=5 (no beforeSeq) -> newest 5 (seq 7..11), oldest-first.
const first = await request('GET', base + q + '&limit=5');
t('window limit=5 returns 5 rows', first.status === 200 && first.body.messages.length === 5, JSON.stringify(first.body && first.body.messages && first.body.messages.length));
t('window first page has total=12', first.body.total === 12, 'total=' + first.body.total);
t('window first page hasMore', first.body.hasMore === true, 'hasMore=' + first.body.hasMore);
t('window first page seqs [7..11]', first.body.messages[0].content === 'msg-7' && first.body.messages[4].content === 'msg-11', JSON.stringify(first.body.messages.map((m) => m.content)));
t('window beforeSeq === 7', first.body.beforeSeq === 7, 'beforeSeq=' + first.body.beforeSeq);

// Previous page: limit=5&beforeSeq=7 -> seq 2..6.
const second = await request('GET', base + q + '&limit=5&beforeSeq=' + first.body.beforeSeq);
t('window second page 5 rows', second.status === 200 && second.body.messages.length === 5, JSON.stringify(second.body && second.body.messages && second.body.messages.length));
t('window second page seqs [2..6]', second.body.messages[0].content === 'msg-2' && second.body.messages[4].content === 'msg-6', JSON.stringify(second.body.messages.map((m) => m.content)));
t('window second page beforeSeq === 2', second.body.beforeSeq === 2, 'beforeSeq=' + second.body.beforeSeq);
t('window second page hasMore', second.body.hasMore === true, 'hasMore=' + second.body.hasMore);

// Last older page: limit=5&beforeSeq=2 -> seq 0..1, hasMore=false.
const third = await request('GET', base + q + '&limit=5&beforeSeq=' + second.body.beforeSeq);
t('window last page 2 rows', third.status === 200 && third.body.messages.length === 2, JSON.stringify(third.body && third.body.messages && third.body.messages.length));
t('window last page seqs [0..1]', third.body.messages[0].content === 'msg-0' && third.body.messages[1].content === 'msg-1', JSON.stringify(third.body.messages.map((m) => m.content)));
t('window last page hasMore false', third.body.hasMore === false, 'hasMore=' + third.body.hasMore);

// beforeSeq=0 -> empty window (nothing older exists).
const none = await request('GET', base + q + '&limit=5&beforeSeq=0');
t('window beforeSeq=0 empty', none.status === 200 && none.body.messages.length === 0, JSON.stringify(none.body));
t('window beforeSeq=0 hasMore false', none.body.hasMore === false, 'hasMore=' + none.body.hasMore);

// limit bigger than transcript -> all rows, hasMore=false.
const big = await request('GET', base + q + '&limit=100');
t('window limit=100 all rows', big.status === 200 && big.body.messages.length === 12, JSON.stringify(big.body && big.body.messages && big.body.messages.length));
t('window limit=100 hasMore false', big.body.hasMore === false, 'hasMore=' + big.body.hasMore);

// Garbage limit ignored -> full list (legacy).
const junk = await request('GET', base + q + '&limit=abc');
t('limit=abc ignored -> full 12', junk.status === 200 && junk.body.messages.length === 12, JSON.stringify(junk.body && junk.body.messages && junk.body.messages.length));
} finally {
child.kill('SIGTERM');
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
