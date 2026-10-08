'use strict';

// Run the cross-process race probe against two locally spawned servers.
//
// This is the same suite `npm run test:race` runs, without Docker: it starts
// two `mouaif serve` processes that share one MOUAIF_HOME and one project
// folder, waits for both, runs scripts/test-race.js against them, and cleans
// up. Use it while iterating on a fix; use the compose stack to confirm the
// result on the shipped image.
//
//   npm run test:race:local
//
// Env: RACE_HOME_ROOT  where the throwaway home/project dirs are created
//      (default: a fresh mkdtemp under the OS temp dir)
//      RACE_CONCURRENCY / RACE_SETTINGS_ROUNDS  passed through to the probe.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function pickFreePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function once(child, event) {
  return new Promise((resolve) => child.once(event, resolve));
}

async function waitFor(base, log) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(base + '/api/settings');
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server never answered on ' + base + '\n' + log());
}

async function main() {
  const root = process.env.RACE_HOME_ROOT
    ? fs.mkdtempSync(path.join(process.env.RACE_HOME_ROOT, 'mouaif-race-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-race-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  // Both servers register this folder, and registration stats it first, so it
  // has to exist before either starts.
  fs.mkdirSync(path.join(project, 'race'), { recursive: true });
  fs.writeFileSync(path.join(project, '.mouaif.json'), '{}\n');

  const ports = [await pickFreePort(), await pickFreePort()];
  const logs = ['', ''];
  const children = ports.map((port, i) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'mouaif.js'), 'serve', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, MOUAIF_HOME: home, MOUAIF_ALLOW_ANY_ROOT: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = (chunk) => { logs[i] += chunk; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    return child;
  });

  let code = 1;
  try {
    const urls = ports.map((port) => 'http://127.0.0.1:' + port);
    await Promise.all(urls.map((base, i) => waitFor(base, () => logs[i])));
    console.log('two servers sharing ' + home);
    const probe = spawn(process.execPath, [path.join(__dirname, 'test-race.js')], {
      cwd: ROOT,
      env: { ...process.env, BASE_URLS: urls.join(','), PROJECT_DIR: project },
      stdio: 'inherit'
    });
    code = await new Promise((resolve) => probe.once('exit', (c) => resolve(c === null ? 1 : c)));
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => once(child, 'exit')));
    if (code !== 0) {
      // Only the logs of a failed run are worth printing; a passing run's are
      // noise next to the probe's own output.
      for (const [i, log] of logs.entries()) {
        if (log.trim()) console.error('\n--- server ' + i + ' ---\n' + log.trimEnd());
      }
    }
    console.log('\nstate kept for inspection: ' + root);
  }
  process.exitCode = code;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});