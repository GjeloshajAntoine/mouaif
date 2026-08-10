'use strict';
// Verifies the restart API: POST /api/restart respawns a fresh worker
// process (so the latest code is loaded from disk) while the supervisor —
// the process the user launched — keeps running. See docs/features/restart-api.md.

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'mouaif.js');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BOOT_RE = /server running at/g;

let failed = 0;
function check(cond, msg) {
  if (!cond) { failed++; console.error('❌ ' + msg); }
  else console.log('✅ ' + msg);
}

function getJson(port, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (e) { reject(new Error(pathname + ' returned non-JSON: ' + out)); }
      });
    });
    req.on('error', reject);
    if (data) req.end(data); else req.end();
  });
}

// Wait until the supervisor's captured output shows `min` cumulative boot
// lines. The buffer is shared across calls, so a second call passing
// `min = 2` waits for the NEXT boot rather than starting over.
function makeBootWaiter(child, timeoutMs = 30000) {
  let allOut = '';
  child.stdout.on('data', (c) => { allOut += c; });
  child.on('exit', (code, signal) => {
    // The supervisor must outlive the whole test; if it dies, unblock waiters.
    allOut += `\n[supervisor exited: code=${code} signal=${signal}]\n`;
  });
  return function waitForBoots(min) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const boots = () => (allOut.match(BOOT_RE) || []).length;
      const timer = setInterval(() => {
        if (boots() >= min) { clearInterval(timer); resolve(boots()); }
        else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for ${min} cumulative boot(s); saw ${boots()}\n--- worker output ---\n${allOut}`));
        }
      }, 250);
    });
  };
}

function killTree(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    } else {
      try { process.kill(proc.pid, 'SIGTERM'); } catch (_) {}
      setTimeout(resolve, 600);
    }
  });
}

async function main() {
  console.log(`[restart-supervisor] starting on port ${PORT}`);
  const env = { ...process.env };
  delete env.MOUAIF_SERVE_CHILD;
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'], env });
  const waitForBoots = makeBootWaiter(child);

  try {
    await waitForBoots(1);
    check(true, 'server boots (worker #1)');

    const r1 = await getJson(PORT, '/api/restart', 'POST', { reason: 'test', delayMs: 100 });
    check(r1.status === 200 && r1.body.ok && r1.body.mode === 'relaunch', `restart accepted: ${JSON.stringify(r1.body)}`);

    await waitForBoots(2);
    check(true, 'server boots again after restart (worker #2)');

    check(child.exitCode === null && child.signalCode === null, 'supervisor (the launched process) is still running');
    check(!child.killed, 'supervisor was not force-killed');

    const r2 = await getJson(PORT, '/api/restart', 'POST', { reason: 'second', delayMs: 100 });
    check(r2.status === 200 && r2.body.ok, 'restart works repeatedly');

    await waitForBoots(3);
    check(true, 'server boots a third time (worker #3)');
  } finally {
    await killTree(child);
  }

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\n✅ restart-supervisor: all checks passed');
}

main().catch((e) => {
  console.error('❌ restart-supervisor failed:', e.message);
  process.exit(1);
});
