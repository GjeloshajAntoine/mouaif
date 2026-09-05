'use strict';
// Manual test for POST /api/git stage/unstage/commit via the modal.
// Usage: node scripts/test-git-stage-commit.js
//
// Creates a temp repo with one commit, starts the server on an ephemeral
// port, then drives the modal's working-tree actions: stage a modified file,
// stage an untracked file, unstage a file, and commit with a message. Uses the
// array `files` form (not string args) so paths with spaces are exercised.
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const sh = (cmd, opts) => new Promise((resolve) => {
const c = spawn('/bin/bash', ['-c', cmd], Object.assign({ cwd: process.cwd() }, opts));
let out = '', err = '';
c.stdout.on('data', (d) => { out += d; });
c.stderr.on('data', (d) => { err += d; });
c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
});
const postJson = (port, path, body) => new Promise((resolve, reject) => {
const data = JSON.stringify(body);
const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
let out = '';
res.on('data', (d) => { out += d; });
res.on('end', () => {
try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
catch (e) { reject(e); }
});
});
req.on('error', reject);
req.write(data);
req.end();
});
const git = (cwd, cmd) => sh(cmd, { cwd });
function pickFreePort() {
return new Promise((resolve) => {
const srv = http.createServer();
srv.listen(0, '127.0.0.1', () => {
const p = srv.address().port;
srv.close(() => resolve(p));
});
});
}
async function waitForServer(port) {
for (let i = 0; i < 60; i++) {
try {
const status = await new Promise((resolve, reject) => {
const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => {
res.resume();
resolve(res.statusCode);
});
req.on('error', reject);
req.end();
});
if (status === 200 || status === 302 || status === 401) return true;
} catch {}
await new Promise((r) => setTimeout(r, 200));
}
return false;
}
(async () => {
const repo = mkdtempSync(join(tmpdir(), 'mouaif-git-stage-'));
const home = mkdtempSync(join(tmpdir(), 'mouaif-git-home-'));
const init = await git(repo, 'git init -q && git config user.email t@t && git config user.name T && git config commit.gpgsign false');
if (init.code !== 0) { console.error('git init failed', init.err); process.exit(1); }
writeFileSync(join(repo, 'a.txt'), 'a\n');
writeFileSync(join(repo, 'my file.txt'), 'm\n');
await git(repo, 'git add a.txt "my file.txt" && git commit -qm "first"');
// Working tree change to a tracked file, plus a new untracked file.
writeFileSync(join(repo, 'a.txt'), 'a\nchange\n');
writeFileSync(join(repo, 'new.txt'), 'n\n');
const port = await pickFreePort();
const server = spawn(process.execPath, [join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
cwd: join(__dirname, '..'),
env: Object.assign({}, process.env, { MOUAIF_HOME: home, MOUAIF_ALLOW_ANY_ROOT: '1' }),
stdio: ['ignore', 'ignore', 'pipe']
});
let serverStderr = '';
server.stderr.on('data', (d) => { serverStderr += String(d); });
const up = await waitForServer(port);
if (!up) {
console.error('server did not start:\n' + serverStderr);
server.kill();
process.exit(1);
}
let failed = false;
const P = () => '/api/git';
const B = () => ({ projectDir: repo });
try {
// Stage a modified tracked file using the array form.
let r = await postJson(port, P(), Object.assign(B(), { action: 'add', files: ['a.txt'] }));
if (!(r.status === 200 && r.body.ok)) throw new Error('add a.txt failed: ' + JSON.stringify(r.body));
// Stage an untracked file with a space in the name.
r = await postJson(port, P(), Object.assign(B(), { action: 'add', files: ['new.txt'] }));
if (!(r.status === 200 && r.body.ok)) throw new Error('add new.txt failed: ' + JSON.stringify(r.body));
const infoGet = await new Promise((resolve, reject) => {
const req = http.request({ host: '127.0.0.1', port, path: '/api/git/info?projectDir=' + encodeURIComponent(repo), method: 'GET' }, (res) => {
let b = '';
res.on('data', (d) => { b += d; });
res.on('end', () => { try { resolve({ body: JSON.parse(b) }); } catch (e) { reject(e); } });
});
req.on('error', reject);
req.end();
});
if (!(infoGet.body.staged.length === 2)) throw new Error('expected 2 staged, got ' + infoGet.body.staged.length + ': ' + JSON.stringify(infoGet.body.staged));
if (!(infoGet.body.unstaged.length === 0)) throw new Error('expected 0 unstaged, got ' + infoGet.body.unstaged.length + ': ' + JSON.stringify(infoGet.body.unstaged));
// Unstage one file (a.txt) — should drop it from staged; it becomes unstaged.
r = await postJson(port, P(), Object.assign(B(), { action: 'unstage', files: ['a.txt'] }));
if (!(r.status === 200 && r.body.ok)) throw new Error('unstage a.txt failed: ' + JSON.stringify(r.body));
const infoGet2 = await new Promise((resolve, reject) => {
const req = http.request({ host: '127.0.0.1', port, path: '/api/git/info?projectDir=' + encodeURIComponent(repo), method: 'GET' }, (res) => {
let b = '';
res.on('data', (d) => { b += d; });
res.on('end', () => { try { resolve({ body: JSON.parse(b) }); } catch (e) { reject(e); } });
});
req.on('error', reject);
req.end();
});
if (!(infoGet2.body.staged.length === 1)) throw new Error('expected 1 staged after unstage, got ' + infoGet2.body.staged.length);
if (!(infoGet2.body.staged[0].path === 'new.txt')) throw new Error('expected new.txt to remain staged, got ' + infoGet2.body.staged[0].path);
// Re-stage a.txt then commit with a message.
r = await postJson(port, P(), Object.assign(B(), { action: 'add', files: ['a.txt'] }));
if (!(r.status === 200 && r.body.ok)) throw new Error('re-add a.txt failed');
r = await postJson(port, P(), Object.assign(B(), { action: 'commit', message: 'stage and commit via modal' }));
if (!(r.status === 200 && r.body.ok)) throw new Error('commit failed: ' + JSON.stringify(r.body));
// After commit, no staged/unstaged changes and HEAD is the new commit.
const infoGet3 = await new Promise((resolve, reject) => {
const req = http.request({ host: '127.0.0.1', port, path: '/api/git/info?projectDir=' + encodeURIComponent(repo), method: 'GET' }, (res) => {
let b = '';
res.on('data', (d) => { b += d; });
res.on('end', () => { try { resolve({ body: JSON.parse(b) }); } catch (e) { reject(e); } });
});
req.on('error', reject);
req.end();
});
if (!(infoGet3.body.staged.length === 0 && infoGet3.body.unstaged.length === 0)) throw new Error('expected clean tree after commit');
if (!(infoGet3.body.commits[0] && /modal/.test(infoGet3.body.commits[0].subject))) throw new Error('new commit subject missing: ' + JSON.stringify(infoGet3.body.commits[0]));
// Path-with-space file is tracked.
const ls = await git(repo, 'git ls-files');
if (!/my file\.txt/.test(ls.out)) throw new Error('path-with-space file not intact');
console.log('PASS: stage/unstage/commit via array files');
} catch (e) {
failed = true;
console.error('FAIL: ' + e.message);
} finally {
server.kill();
rmSync(repo, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
