// Unit tests for src/pty.js — the dependency-free pseudo-terminal shim.
//
// The shim replaced `node-pty` (a native addon with no Linux prebuild, whose
// install needed a C++ toolchain and failed outright without one). It
// allocates the TTY with util-linux `script(1)` and exposes the few members
// the CLI session uses: `onData`, `onExit`, `write`, `kill`, `pid`, `killed`.
//
// This test covers the parts that are awkward to reach through the HTTP
// endpoint: the availability probe must agree with the piped-fallback rule,
// quoting must survive a path/argument full of spaces and quotes, output
// written before the stream attaches must be replayed rather than lost, and
// `kill()` must take down the shell *and* its children (a runaway `sleep`).
//
// It skips (exit 0) where no pseudo-terminal can be allocated, because that
// is the documented degraded mode, not a failure.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pty = require('../src/pty.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collect a session's output until `predicate` matches or the deadline
// passes, so the checks are not tied to a fixed sleep.
function waitFor(stream, predicate, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + (ms || 4000);
    const tick = () => {
      if (predicate(stream.text)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function newStream() {
  const stream = { text: '' };
  return stream;
}

async function main() {
  const available = pty.isAvailable();

  check('isAvailable() reports the probe result as a boolean', typeof available === 'boolean');
  check(
    'availability matches the platform rule (Linux + util-linux script only)',
    available === (process.platform === 'linux' && (() => {
      try { execFileSync('script', ['-qefc', 'exit 0', '/dev/null'], { stdio: 'ignore' }); return true; } catch { return false; }
    })()),
    'isAvailable=' + available + ' platform=' + process.platform
  );

  if (!available) {
    console.log('\nSKIP  no pseudo-terminal on this host — the piped fallback is the documented mode.');
    console.log(passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }

  // 1. A TTY exists and output reaches the caller.
  {
    const stream = newStream();
    const session = pty.spawnPty(process.env.SHELL || '/bin/sh', ['-i'], { cwd: process.cwd() });
    check('spawnPty returns a handle with a pid', !!session && typeof session.pid === 'number');
    session.onData((d) => { stream.text += d.toString('utf8'); });
    session.write('echo TTY=$([ -t 0 ] && echo yes || echo no)\n');
    const seen = await waitFor(stream, (t) => /TTY=(yes|no)/.test(t), 5000);
    check('the shell sees a TTY on stdin', seen && /TTY=yes/.test(stream.text), JSON.stringify(stream.text.slice(0, 200)));
    session.kill();
  }

  // 2. Buffered output is replayed to a late onData handler (a PTY gives no
  //    backlog on its own — the first prompt would otherwise be dropped).
  {
    const session = pty.spawnPty(process.env.SHELL || '/bin/sh', ['-i'], { cwd: process.cwd() });
    session.write('echo REPLAY-MARKER\n');
    await sleep(600);
    const stream = newStream();
    session.onData((d) => { stream.text += d.toString('utf8'); });
    const seen = await waitFor(stream, (t) => /REPLAY-MARKER/.test(t), 3000);
    check('output produced before onData attached is replayed', seen, JSON.stringify(stream.text.slice(0, 200)));
    session.kill();
  }

  // 3. Quoting: a project path containing spaces and single quotes must reach
  //    the shell intact (`script -c` puts the command through /bin/sh).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mouaif pty's "));
    const marker = path.join(dir, 'marker file.txt');
    const stream = newStream();
    const session = pty.spawnPty(process.env.SHELL || '/bin/sh', ['-i'], { cwd: dir });
    session.onData((d) => { stream.text += d.toString('utf8'); });
    session.write('pwd\n');
    await waitFor(stream, (t) => t.includes(dir.replace("'", '')) || t.includes(dir), 4000);
    session.write('touch ' + JSON.stringify(marker) + '\n');
    await sleep(700);
    session.write('ls\n');
    await waitFor(stream, (t) => /marker file\.txt/.test(t), 4000);
    check('a working directory with spaces/quotes survives the command string', fs.existsSync(marker), 'dir=' + JSON.stringify(dir));
    session.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // 4. onExit carries the child's exit code (script's -e), like node-pty did.
  {
    const stream = newStream();
    const session = pty.spawnPty(process.env.SHELL || '/bin/sh', ['-i'], { cwd: process.cwd() });
    session.onData((d) => { stream.text += d.toString('utf8'); });
    const exited = new Promise((resolve) => session.onExit(resolve));
    session.write('exit 7\n');
    const event = await Promise.race([exited, sleep(5000).then(() => null)]);
    check('onExit reports the session\'s exit code', !!event && event.exitCode === 7, JSON.stringify(event));
    check('killed is true once the session exited', session.killed === true);
  }

  // 5. kill() must take the whole process group down, not just `script`:
  //    leaving a `sleep 300` behind would leak a process per closed modal.
  {
    const marker = 'mouaif-pty-orphan-' + Date.now();
    const stream = newStream();
    const session = pty.spawnPty(process.env.SHELL || '/bin/sh', ['-i'], { cwd: process.cwd() });
    session.onData((d) => { stream.text += d.toString('utf8'); });
    session.write('exec -a ' + marker + ' sleep 300\n');
    await sleep(700);
    session.kill();
    await sleep(700);
    let leaked = '';
    try { leaked = execFileSync('pgrep', ['-af', marker], { encoding: 'utf8' }).trim(); } catch { /* no match: good */ }
    check('kill() leaves no orphaned child from the session', !leaked.includes('sleep 300'), JSON.stringify(leaked.slice(0, 200)));
    check('kill() marks the handle as killed', session.killed === true);
  }

  // 6. A *background* job lives in its own process group (job control in an
  //    interactive shell), and the shell itself is a session leader under
  //    `script` — so signalling script's group alone left `cmd &` running
  //    after the modal closed. kill() must reach every job in the session.
  {
    const marker = 'mouaif-pty-bg-' + Date.now();
    const stream = newStream();
    const session = pty.spawnPty('/bin/bash', ['-i'], { cwd: process.cwd() });
    session.onData((d) => { stream.text += d.toString('utf8'); });
    session.write('(exec -a ' + marker + ' sleep 300) &\n');
    session.write('echo BG-STARTED\n');
    await waitFor(stream, (t) => /BG-STARTED/.test(t), 4000);
    await sleep(300);
    const find = () => {
      try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim(); } catch { return ''; }
    };
    check('the background job is running before kill()', !!find());
    session.kill();
    // SIGHUP/SIGTERM land at once; the SIGKILL sweep follows after ~1 s.
    let leaked = find();
    for (let i = 0; i < 30 && leaked; i++) { await sleep(100); leaked = find(); }
    check('kill() also stops a backgrounded job (`cmd &`)', !leaked, 'still running: ' + leaked);
    if (leaked) { try { execFileSync('pkill', ['-KILL', '-f', marker]); } catch { /* best effort */ } }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log('FAIL  unexpected error: ' + (err && err.stack || err));
  process.exit(1);
});
