'use strict';
// Manual test for POST /api/git commit actions used by the per-commit options
// menu in the Git modal: checkout (detached HEAD), cherry-pick, and revert.
// Usage: node scripts/test-git-commit-actions.js
//
// Creates a temp repo with three commits and an upstream branch, starts the
// server on an ephemeral port, then drives POST /api/git to:
//   * checkout an older commit -> detached HEAD
//   * cherry-pick a commit that is NOT on the current branch -> new commit
//   * revert a commit -> a new commit that undoes it
// Also verifies the server rejects a missing hash (a 400, not a git crash).
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
const repo = mkdtempSync(join(tmpdir(), 'mouaif-git-actions-'));
const home = mkdtempSync(join(tmpdir(), 'mouaif-git-actions-home-'));
const init = await git(repo, 'git init -q && git config user.email t@t && git config user.name T && git config commit.gpgsign false && git config user.useConfigOnly true');
if (init.code !== 0) { console.error('git init failed', init.err); process.exit(1); }
// Build a history: base, second, third on the default branch; then a separate
// branch off HEAD with its own commit so cherry-pick has something to apply.
// The default branch name is not guaranteed (master vs main), so read it back.
writeFileSync(join(repo, 'a.txt'), 'a\n');
await git(repo, 'git add a.txt && git commit -qm "base"');
const defaultBranchRes = await git(repo, 'git rev-parse --abbrev-ref HEAD');
const defaultBranch = defaultBranchRes.out.trim();
writeFileSync(join(repo, 'a.txt'), 'a\n2\n');
await git(repo, 'git add a.txt && git commit -qm "second"');
writeFileSync(join(repo, 'a.txt'), 'a\n2\n3\n');
await git(repo, 'git add a.txt && git commit -qm "third"');
// Branch `topic` off HEAD (third), add a commit, then return to the default
// branch.
await git(repo, 'git checkout -q -b topic && echo t > topic.txt && git add topic.txt && git commit -qm "topic change" && git checkout -q ' + defaultBranch);
const headRes = await git(repo, 'git rev-parse HEAD');
const head = headRes.out.trim(); // default branch tip = third
const baseRes = await git(repo, 'git rev-list --max-parents=0 HEAD');
const base = baseRes.out.trim(); // root = base
const topicRes = await git(repo, 'git rev-parse topic');
const topic = topicRes.out.trim(); // tip of topic branch
const port = await pickFreePort();
const server = spawn(process.execPath, [join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
cwd: join(__dirname, '..'),
env: Object.assign({}, process.env, { MOUAIF_HOME: home, MOUAIF_ALLOW_ANY_ROOT: '1', GIT_TERMINAL_PROMPT: '0' }),
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
// checkout base -> detached HEAD. The commit-message editor is non-TTY, so
// git must not block; a detached HEAD confirms the checkout landed.
let r = await postJson(port, P(), Object.assign(B(), { action: 'checkout', args: base }));
if (!(r.status === 200 && r.body.ok)) throw new Error('checkout base failed: ' + JSON.stringify(r.body));
let h = await git(repo, 'git rev-parse HEAD');
let sym = await git(repo, 'git symbolic-ref -q HEAD');
if (!(h.out.trim() === base)) throw new Error('checkout did not move HEAD to base: ' + h.out);
// Detached HEAD: `git symbolic-ref` exits non-zero (no symref left at HEAD).
if (sym.code === 0) throw new Error('expected detached HEAD, but HEAD is still a branch: ' + sym.out);
// Cherry-pick the topic commit while HEAD is at `base`. `topic` was branched
// off `third`, so its parent differs from `base` — cherry-pick therefore
// yields a genuinely new object ID (applying it onto `third` instead could
// reproduce the identical hash when commits share a timestamp, which would
// make an equality assertion flaky). topic.txt should land as a new commit.
r = await postJson(port, P(), Object.assign(B(), { action: 'cherry-pick', args: topic }));
if (!(r.status === 200 && r.body.ok)) throw new Error('cherry-pick failed: ' + JSON.stringify(r.body));
h = await git(repo, 'git rev-parse HEAD');
if (!(h.out.trim() !== topic)) throw new Error('cherry-pick should create a new commit');
if (h.out.trim() === base) throw new Error('cherry-pick did not advance HEAD');
const hasTopic = await git(repo, 'git cat-file -e HEAD:topic.txt && echo present');
if (!/present/.test(hasTopic.out)) throw new Error('cherry-pick did not bring topic.txt onto the branch');
// Revert the tip. git revert --no-edit creates a new commit that undoes it.
const before = await git(repo, 'git rev-parse HEAD');
r = await postJson(port, P(), Object.assign(B(), { action: 'revert', args: before.out.trim() }));
if (!(r.status === 200 && r.body.ok)) throw new Error('revert failed: ' + JSON.stringify(r.body));
h = await git(repo, 'git rev-parse HEAD');
if (!(h.out.trim() !== before.out.trim())) throw new Error('revert should create a new commit');
const hasTopicAfter = await git(repo, 'git cat-file -e HEAD:topic.txt && echo present');
if (/present/.test(hasTopicAfter.out)) throw new Error('revert did not remove topic.txt from the tree');
// Return to a named branch so the repo is left in a normal state.
r = await postJson(port, P(), Object.assign(B(), { action: 'checkout', args: defaultBranch }));
if (!(r.status === 200 && r.body.ok)) throw new Error('checkout ' + defaultBranch + ' failed: ' + JSON.stringify(r.body));
// Missing hash is rejected (400), not a git crash.
r = await postJson(port, P(), Object.assign(B(), { action: 'cherry-pick' }));
if (!(r.status === 400)) throw new Error('missing hash should be a 400, got ' + r.status);
// Option-looking or program-running args are refused before git runs.
const rejected = [
  { action: 'checkout', args: '--orphan=x' },
  { action: 'revert', args: '-m 1 ' + base },
  { action: 'pull', args: '--upload-pack=touch /tmp/mouaif-pwned' },
  { action: 'push', args: '--receive-pack=true' },
  { action: 'diff', args: '--output=/tmp/mouaif-pwned' },
  { action: 'stash-drop', args: '--quiet' }
];
for (const bad of rejected) {
  r = await postJson(port, P(), Object.assign(B(), bad));
  if (r.status !== 400) throw new Error(bad.action + ' ' + bad.args + ' should be a 400, got ' + r.status + ' ' + JSON.stringify(r.body));
}
// Remote-branch checkout with track: true creates a local tracking branch.
await git(repo, 'git remote add origin "' + repo + '" && git update-ref refs/remotes/origin/remote-only ' + base);
r = await postJson(port, P(), Object.assign(B(), { action: 'checkout', args: 'origin/remote-only', track: true }));
if (!(r.status === 200 && r.body.ok)) throw new Error('track checkout failed: ' + JSON.stringify(r.body));
sym = await git(repo, 'git symbolic-ref --short -q HEAD');
if (sym.out.trim() !== 'remote-only') throw new Error('expected local remote-only branch, got ' + sym.out);
console.log('PASS: checkout/cherry-pick/revert commit actions');
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
