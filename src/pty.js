'use strict';

// A dependency-free pseudo-terminal shim.
//
// The CLI modal's persistent session (src/server-handlers-tools.js) wants a
// child whose stdin is a TTY, because programs that ask a question — `read`,
// `npm publish` under 2FA, `sudo`, git credential prompts — either get an
// immediate EOF or refuse to prompt when stdin is a pipe.
//
// This module used to be delegated to `node-pty`. That native addon ships no
// prebuilt binary for Linux (only darwin/win32), so a plain `npm install`
// without a C++ toolchain failed outright on Linux — the exact platform where
// mouaif is most often installed (Docker, CI, Codespaces, VPS). Instead of a
// replacement dependency this module allocates the TTY with `script(1)` from
// util-linux, present on every Linux base image including
// `node:22-bookworm-slim`, and falls back to a piped child where it is not.
//
// `spawnPty(exe, args, opts)` returns a handle shaped like the handful of
// node-pty members the session uses — `onData`, `onExit`, `write`, `kill`,
// `pid`, `killed` — or `null` when no TTY can be allocated, in which case the
// caller keeps its piped `child_process.spawn` path.
//
// How the TTY is obtained: `script -qefc "<command>" /dev/null` runs `printf`
// (the caveat in the original node-pty code) on a pty slave and copies the
// master to its own stdout, which is merged onto the pty by the kernel. So the
// shell and everything it starts see a terminal, while the server keeps a plain
// pipe to `script` — one readable stream, like node-pty's merged stdout.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// The `script` implementation we can rely on: util-linux, which supports
// `-e` (return the child's exit code), `-f` (flush) and `-c` (command). BSD /
// macOS `script` shares the name but not the flags, and Windows has no
// equivalent, so on those platforms the caller's piped path stays in charge
// (the documented degraded mode) and `isAvailable()` reports false.
const SUPPORTED_PLATFORM = process.platform === 'linux';

let resolved;
let probeDone = false;
let scriptBin = null;

// Resolve an executable file on PATH without spawning anything, so the probe
// below only runs when `script` is actually present.
function which(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here; keep looking */ }
  }
  return null;
}

// One-shot capability probe: confirm this `script` accepts our flags before a
// session depends on it. A util-linux build that predates `-f`, or a foreign
// `script` that happens to be on PATH, fails the probe and the caller keeps the
// piped fallback instead of a session that dies on spawn.
function probeScript(bin) {
  const result = spawnSync(bin, ['-qefc', 'exit 0', '/dev/null'], {
    stdio: 'ignore',
    timeout: 2000,
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function resolveScript() {
  if (probeDone) return scriptBin;
  probeDone = true;
  if (!SUPPORTED_PLATFORM) return (scriptBin = null);
  const bin = which('script');
  scriptBin = bin && probeScript(bin) ? bin : null;
  return scriptBin;
}

// True when a real pseudo-terminal can be allocated on this host. The CLI
// session reports this as `interactive`, and the modal hides its prompt badge
// when it is false.
function isAvailable() {
  return !!resolveScript();
}

// The command string `script -c` hands to /bin/sh, so every word is quoted for
// that shell: a project path, shell path or argument containing a space or
// quote must survive the round trip.
function shellQuote(word) {
  return "'" + String(word).replace(/'/g, "'\\''") + "'";
}

function shellCommand(exe, args) {
  return [exe].concat(args || []).map(shellQuote).join(' ');
}

// `kill()` has to reach the whole tree: the shell spawned its own children
// (a running `npm test`, a pager), and `script` sits in between. POSIX only:
// detached:true puts `script` in its own process group, so signalling the
// negative pid takes down the shell and everything under it.
function terminate(child) {
  if (!child || child.killed) return;
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already gone */ }
  }
  try { child.kill(); } catch { /* already reaped */ }
}

function spawnPty(exe, args, opts) {
  const bin = resolveScript();
  if (!bin) return null;
  const options = opts || {};
  const child = spawn(bin, ['-qefc', shellCommand(exe, args), '/dev/null'], {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  if (!child || !child.pid) return null;

  const dataHandlers = [];
  const exitHandlers = [];
  // A PTY is not rewindable: anything written before the caller attaches its
  // stream (the shell's first prompt, a login banner) would be lost. Hold a
  // bounded amount until the first `onData` arrives, then flush it in order.
  let pending = [];
  let pendingBytes = 0;
  const PENDING_LIMIT = 65536;
  let killed = false;

  const emit = (chunk) => {
    if (dataHandlers.length) {
      for (const handler of dataHandlers) {
        try { handler(chunk); } catch { /* a bad handler must not break the stream */ }
      }
      return;
    }
    pendingBytes += chunk.length;
    pending.push(chunk);
    while (pendingBytes > PENDING_LIMIT && pending.length > 1) {
      pendingBytes -= pending.shift().length;
    }
  };

  // A PTY merges stdout and stderr, so both feeds report on the single `data`
  // stream; `-e` keeps the child's exit code, surfaced through `onExit` the
  // way node-pty reported it.
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('exit', (code, signal) => {
    killed = true;
    const event = { exitCode: code == null ? 0 : code, signal: signal ? 1 : 0 };
    for (const handler of exitHandlers) {
      try { handler(event); } catch { /* ignore */ }
    }
  });

  return {
    // node-pty compatibility surface used by the CLI session.
    pty: true,
    pid: child.pid,
    get killed() { return killed || child.killed; },
    onData(handler) {
      if (typeof handler !== 'function') return;
      dataHandlers.push(handler);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        pendingBytes = 0;
        for (const chunk of buffered) handler(chunk);
      }
    },
    onExit(handler) {
      if (typeof handler === 'function') exitHandlers.push(handler);
    },
    write(data) {
      if (!child.stdin || !child.stdin.writable) return false;
      try { return child.stdin.write(String(data)); } catch { return false; }
    },
    kill() {
      killed = true;
      terminate(child);
    }
  };
}

module.exports = { isAvailable, spawnPty };
