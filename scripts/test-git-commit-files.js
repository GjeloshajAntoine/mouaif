'use strict';
// Manual test for GET /api/git/commit-files (lazy per-commit file list).
// Usage: node scripts/test-git-commit-files.js
//
// Creates a temp repo with several commits (one with many files to prove
// there is no 3-commit / 120-line cap), starts the server on an ephemeral
// port, and checks that commit-files returns the full file list for a
// commit that /api/git/info never populated.

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

const getJson = (port, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
      catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.end();
});

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
  const repo = mkdtempSync(join(tmpdir(), 'mouaif-git-test-'));
  const home = mkdtempSync(join(tmpdir(), 'mouaif-git-home-'));
  const init = await sh('git init -q && git config user.email t@t && git config user.name T && git config commit.gpgsign false', { cwd: repo });
  if (init.code !== 0) { console.error('git init failed', init.err); process.exit(1); }

  // Commit 1: a single small file.
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await sh('git add a.txt && git commit -qm "first"', { cwd: repo });

  // Commit 2: many files (more than the old MAX_COMMIT_DIFFS=3) plus one
  // file with a diff longer than 120 lines, to prove no list truncation.
  for (let i = 0; i < 10; i++) writeFileSync(join(repo, 'f' + i + '.txt'), 'x\n');
  writeFileSync(join(repo, 'big.txt'), Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\n') + '\n');
  await sh('git add -A && git commit -qm "second"', { cwd: repo });

  // Commit 3: a rename + delete (rename parsing).
  await sh('git mv f0.txt renamed.txt && git rm -q f1.txt && git commit -qm "third"', { cwd: repo });

  const hash2 = (await sh('git rev-parse HEAD~1', { cwd: repo })).out;

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
  try {
    const info = await getJson(port, '/api/git/info?projectDir=' + encodeURIComponent(repo));
    if (!(info.body && info.body.ok)) throw new Error('git info failed: ' + JSON.stringify(info.body));
    const c2 = info.body.commits.find((c) => c.hash === hash2) || info.body.commits[1];
    if (c2.files && c2.files.length > 0) {
      console.log('NOTE: commit already has files in /api/git/info (expected empty with lazy loading)');
    }

    const cf = await getJson(port, '/api/git/commit-files?projectDir=' + encodeURIComponent(repo) + '&hash=' + hash2);
    if (!(cf.status === 200 && cf.body && cf.body.ok)) throw new Error('commit-files failed: ' + cf.status + ' ' + JSON.stringify(cf.body));

    const paths = cf.body.files.map((f) => f.path);
    if (paths.length !== 11) throw new Error('expected 11 files (10 f*.txt + big.txt), got ' + paths.length + ': ' + paths.join(', '));
    if (!paths.includes('big.txt')) throw new Error('big.txt missing from list');
    const big = cf.body.files.find((f) => f.path === 'big.txt');
    if (!big.diff || !/diff --git/.test(big.diff)) throw new Error('big.txt has no diff');
    if (cf.body.files.filter((f) => f.diff).length !== 11) throw new Error('not every file has a diff');

    // Rename commit: expect R entry with old -> new path.
    const headHash = (await sh('git rev-parse HEAD', { cwd: repo })).out;
    const cfHead = await getJson(port, '/api/git/commit-files?projectDir=' + encodeURIComponent(repo) + '&hash=' + headHash);
    if (!(cfHead.body && cfHead.body.ok)) throw new Error('commit-files (head) failed');
    const renamed = cfHead.body.files.find((f) => f.status === 'R');
    if (!renamed) throw new Error('expected a renamed file in head commit');
    if (!/renamed\.txt/.test(renamed.path) || !/f0\.txt/.test(renamed.path)) throw new Error('rename path malformed: ' + renamed.path);

    // Bad hash must 400.
    const bad = await getJson(port, '/api/git/commit-files?projectDir=' + encodeURIComponent(repo) + '&hash=xyz');
    if (bad.status !== 400) throw new Error('expected 400 for invalid hash, got ' + bad.status);

    console.log('PASS: commit-files full list, diffs, rename, bad-hash guard');
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