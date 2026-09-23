'use strict';

// Cross-platform pseudo-terminal adapter.
//
// The CLI modal's persistent session (src/server-handlers-tools.js) wants a
// child whose stdin is a TTY, because programs that ask a question — `read`,
// `npm publish` under 2FA, `sudo`, git credential prompts — either get an
// immediate EOF or refuse to prompt when stdin is a pipe.
//
// POSIX stays dependency-free: util-linux `script(1)` is used on Linux,
// BSD/macOS `script` on those hosts, and python3's `pty` module is the final
// fallback. Windows uses the optional `node-pty` package, whose published
// win32-x64 and win32-arm64 prebuilds call ConPTY without requiring Python or
// Visual Studio on the user's machine. Keeping it optional avoids making a
// missing or unsupported native binary prevent mouaif from installing.
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

// A session without a TTY is not a smaller version of the same thing: npm, for
// one, prints its 2FA link as `https://www.npmjs.com/auth/cli/***` (its log
// redactor masks the UUID) unless stdin and stdout are terminals. So the shim
// tries every dependency-free way of getting a pty before the caller falls
// back to pipes:
//
//   1. util-linux `script -qefc`   — every Linux distro and base image;
//   2. BSD `script -q /dev/null`   — macOS and the BSDs (different flags);
//   3. `python3` + its `pty` module — any POSIX host with Python, e.g. a
//                                    stripped container without util-linux.
//
// Each POSIX backend is probed once (it must run a command on a TTY and hand
// back its exit code) and the first that passes is used. Windows loads
// `node-pty` instead; if its optional native package is unavailable, only then
// does the caller keep the piped child.
const POSIX = process.platform !== 'win32';

let nodePty;
let nodePtyLoadAttempted = false;
function loadNodePty() {
  if (nodePtyLoadAttempted) return nodePty;
  nodePtyLoadAttempted = true;
  try {
    nodePty = require('node-pty');
  } catch {
    nodePty = null;
  }
  return nodePty;
}

// Grid size reported to programs on the pty. The modal renders plain text and
// does not report its own size, so this is a sensible fixed terminal size.
const COLS = 100;
const ROWS = 30;

// The python3 backend: fork the command onto a new pty (pty.fork makes it a
// session leader with the slave as its controlling terminal), set the grid,
// then copy stdin → master and master → stdout until the child exits. A
// SIGTERM/SIGHUP to the helper is forwarded as SIGHUP — what a closed
// terminal sends. When the session's stdin reaches EOF (the server went
// away) the helper hangs up too, unless argv[3] is "0" — the probe feeds an
// empty stdin and must let its command finish. The exit status is returned
// the way a shell reports it (128 + signal).
const PY_PTY = [
  'import os, sys, pty, select, signal, struct',
  'cols, rows, hup_on_eof = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3] != "0"',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvp(sys.argv[4], sys.argv[4:])',
  'try:',
  '    import fcntl, termios',
  '    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
  'except Exception:',
  '    pass',
  'def hup(*_):',
  '    try: os.kill(pid, signal.SIGHUP)',
  '    except OSError: pass',
  'signal.signal(signal.SIGHUP, hup)',
  'signal.signal(signal.SIGTERM, hup)',
  'ins = [0, fd]',
  'while True:',
  '    try: r = select.select(ins, [], [])[0]',
  '    except InterruptedError: continue',
  '    if fd in r:',
  '        try: data = os.read(fd, 65536)',
  '        except OSError: data = b""',
  '        if not data: break',
  '        os.write(1, data)',
  '    if 0 in r:',
  '        data = os.read(0, 65536)',
  '        if data: os.write(fd, data)',
  '        else:',
  '            ins = [fd]',
  '            if hup_on_eof: hup()',
  'status = os.waitpid(pid, 0)[1]',
  'sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))'
].join('\n');

// The command string `script` hands to /bin/sh, so every word is quoted for
// that shell: a project path, shell path or argument containing a space or
// quote must survive the round trip.
function shellQuote(word) {
  return "'" + String(word).replace(/'/g, "'\\''") + "'";
}

function shellCommand(exe, args) {
  return [exe].concat(args || []).map(shellQuote).join(' ');
}

// util-linux `script` sizes the pty from its own stdin, which is a pipe
// here, so the grid would read 0×0 (`stty size` → `0 0`) and programs that
// lay out to the width (npm's progress, `ls`, pagers) would misbehave. Set
// the grid first, then exec the real command so its exit code is kept.
function sizedCommand(exe, args) {
  return 'stty rows ' + ROWS + ' cols ' + COLS + ' 2>/dev/null; exec ' + shellCommand(exe, args);
}

// Each backend turns (exe, args[, forProbe]) into the real (file, argv).
const ALL_BACKENDS = [
  {
    name: 'script (util-linux)',
    bin: 'script',
    platforms: ['linux'],
    argv: (bin, exe, args) => [bin, ['-qefc', sizedCommand(exe, args), '/dev/null']]
  },
  {
    // BSD / macOS `script [-q] file command ...` runs the command directly
    // (no shell string) and has no -e/-c; it exits with the child's status.
    name: 'script (BSD)',
    bin: 'script',
    platforms: ['darwin', 'freebsd', 'openbsd', 'netbsd'],
    argv: (bin, exe, args) => [bin, ['-q', '/dev/null', '/bin/sh', '-c', sizedCommand(exe, args)]]
  },
  {
    name: 'python3 pty',
    bin: 'python3',
    platforms: null, // any POSIX host
    argv: (bin, exe, args, forProbe) =>
      [bin, ['-c', PY_PTY, String(COLS), String(ROWS), forProbe ? '0' : '1', exe].concat(args || [])]
  }
];

let candidates = ALL_BACKENDS;
let probeDone = false;
let backend = null; // { name, bin, argv }

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

// One-shot capability probe for a backend: it must run a command whose stdin
// AND stdout are terminals and return that command's exit status. A
// util-linux build that predates `-f`, a foreign `script` that happens to be
// on PATH, or a Python without `pty` fails the probe, and the next backend is
// tried instead of a session that dies on spawn (or silently has no TTY).
const PROBE = '[ -t 0 ] && [ -t 1 ] && exit 3; exit 1';
function probe(b, bin) {
  const [file, argv] = b.argv(bin, '/bin/sh', ['-c', PROBE], true);
  const result = spawnSync(file, argv, {
    stdio: ['pipe', 'ignore', 'ignore'],
    input: '',
    timeout: 3000,
    windowsHide: true
  });
  return !result.error && result.status === 3;
}

function resolveBackend() {
  if (probeDone) return backend;
  probeDone = true;
  if (!POSIX) {
    const mod = loadNodePty();
    return (backend = mod && typeof mod.spawn === 'function'
      ? { name: 'node-pty (ConPTY)', module: mod }
      : null);
  }
  for (const b of candidates) {
    if (b.platforms && b.platforms.indexOf(process.platform) === -1) continue;
    const bin = which(b.bin);
    if (bin && probe(b, bin)) return (backend = { name: b.name, bin, argv: b.argv });
  }
  return (backend = null);
}

// True when a real pseudo-terminal can be allocated on this host. A missing
// optional node-pty binary on Windows reports false and lets the caller use its
// existing piped fallback rather than failing startup.
function isAvailable() {
  return !!resolveBackend();
}

// Which backend is in use ('node-pty (ConPTY)', 'script (util-linux)',
// 'script (BSD)', 'python3 pty'), or null. For diagnostics and tests.
function backendName() {
  const b = resolveBackend();
  return b ? b.name : null;
}

// Tests only: forget the probe result and optionally restrict the candidates,
// so each backend can be exercised on a host that has several.
function _resetForTests(onlyNames) {
  probeDone = false;
  backend = null;
  candidates = Array.isArray(onlyNames)
    ? ALL_BACKENDS.filter((b) => onlyNames.indexOf(b.name) !== -1)
    : ALL_BACKENDS;
}

// Read `/proc/<pid>/stat` → { ppid, sid }, or null once the process is gone.
// The command name (field 2) is parenthesised and may itself contain spaces
// or `)`, so the numeric fields are parsed after the LAST `)`.
function procStat(pid) {
  let text;
  try { text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch { return null; }
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // After the name: state ppid pgrp session ...
  return { ppid: Number(fields[1]), sid: Number(fields[3]) };
}

function listPids() {
  try {
    return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
  } catch { return []; }
}

// Every process in the terminal session `script` created. `script` forks the
// shell onto the pty slave as a *session leader* (its own sid), and an
// interactive shell then gives every job its own process group — so neither
// `-script.pid` nor the shell's group reaches a background job
// (`npm run dev &`). The session id is the one thing they all share. Linux
// only (the only platform where the shim runs); a process that called
// setsid() itself (a daemon) has left the session on purpose and is not
// followed.
function sessionMembers(scriptPid) {
  const pids = listPids();
  const sids = new Set();
  for (const pid of pids) {
    const st = procStat(pid);
    if (st && st.ppid === scriptPid) sids.add(st.sid);
  }
  sids.delete(0);
  const members = [];
  if (!sids.size) return members;
  for (const pid of pids) {
    if (pid === scriptPid) continue;
    const st = procStat(pid);
    if (st && sids.has(st.sid)) members.push({ pid, sid: st.sid });
  }
  return members;
}

const KILL_GRACE_MS = 1000;

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

// `kill()` has to reach the whole tree: the shell spawned its own children
// (a running `npm test`, a pager, a backgrounded dev server), and `script`
// sits in between. The session members are snapshotted *before* anything is
// signalled — once the shell dies its children are reparented and could no
// longer be found through `script`. They get SIGHUP (what a closed terminal
// sends; an interactive bash ignores SIGTERM but not SIGHUP) plus SIGTERM,
// then SIGKILL after a short grace period for anything still in the session.
// The re-check of the session id before SIGKILL guards against a recycled pid.
function terminate(child) {
  if (!child || child.killed) return;
  const members = child.pid ? sessionMembers(child.pid) : [];
  for (const m of members) { signal(m.pid, 'SIGHUP'); signal(m.pid, 'SIGTERM'); }
  if (process.platform !== 'win32' && child.pid) {
    // detached:true put `script` in its own process group.
    signal(-child.pid, 'SIGTERM');
  }
  try { child.kill(); } catch { /* already reaped */ }
  if (!members.length) return;
  const timer = setTimeout(() => {
    for (const m of members) {
      const st = procStat(m.pid);
      if (st && st.sid === m.sid) signal(m.pid, 'SIGKILL');
    }
  }, KILL_GRACE_MS);
  // Never keep the server (or a test) alive just to finish the sweep.
  if (timer.unref) timer.unref();
}

function spawnPty(exe, args, opts) {
  const b = resolveBackend();
  if (!b) return null;
  const options = opts || {};
  if (b.module) {
    return b.module.spawn(exe, args || [], {
      name: 'xterm-256color',
      cols: options.cols || COLS,
      rows: options.rows || ROWS,
      cwd: options.cwd,
      env: options.env || process.env
    });
  }
  const [file, argv] = b.argv(b.bin, exe, args);
  const child = spawn(file, argv, {
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

module.exports = { isAvailable, spawnPty, backendName, COLS, ROWS, _resetForTests };
