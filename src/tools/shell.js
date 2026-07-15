'use strict';

// Native `shell` tool — lets the model run a command in the project's
// working directory. Implements docs/features/shell-tool.md.
//
// Public surface:
//   runShell({ projectDir, cmd, timeoutMs, maxBytes }) ->
//     Promise<{ ok, stdout, stderr, exitCode, durationMs }>
//                | { ok: false, error, code, durationMs }
//   SPEC  — the OpenAI-compatible tool spec advertised to the model.
//
// The runner is built on node:child_process.spawn only; no third-party
// shell wrappers, no new runtime dependencies. Every child is tracked
// in a module-level Set and killed on parent exit so a server shutdown
// does not leak zombies.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 min ceiling
const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB per stream
const KILL_GRACE_MS = 5_000; // SIGTERM -> SIGKILL grace

// Environment variables stripped from the child to prevent trivial
// tool escape via preloading / injected node options.
const ENV_DENYLIST = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS'
];

// Live children, reaped on parent exit.
const liveChildren = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const reap = () => {
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    liveChildren.clear();
  };
  process.on('exit', reap);
  process.on('SIGINT', () => { reap(); process.exit(130); });
  process.on('SIGTERM', () => { reap(); process.exit(143); });
}

// The model-facing tool spec (OpenAI-compatible function shape).
const SPEC = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command in the project directory. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to run, as a single string.' },
        timeoutMs: { type: 'integer', description: 'Optional per-call timeout, 1 ms - 10 min. Default 30000.' }
      },
      required: ['cmd'],
      additionalProperties: false
    }
  }
};

// Resolve and validate the working directory. Returns the real,
// absolute project dir or throws a typed error.
function resolveSandbox(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    const e = new Error('projectDir is required'); e.code = 'EBADINPUT'; throw e;
  }
  let real;
  try { real = fs.realpathSync(projectDir); }
  catch { const e = new Error('project directory not found'); e.code = 'ENOENT'; throw e; }
  let st;
  try { st = fs.statSync(real); }
  catch { const e = new Error('project directory not found'); e.code = 'ENOENT'; throw e; }
  if (!st.isDirectory()) {
    const e = new Error('projectDir is not a directory'); e.code = 'ENOTDIR'; throw e;
  }
  return real;
}

// Build the child environment: parent env minus the denylist.
function childEnv() {
  const env = Object.assign({}, process.env);
  for (const key of ENV_DENYLIST) delete env[key];
  return env;
}

// Truncate a Buffer/string to maxBytes, appending a truncation marker.
function truncate(buf, maxBytes) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= maxBytes) return s;
  // Slice by bytes, then decode; append the marker.
  const sliced = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
  return sliced + '\n...[truncated at ' + maxBytes + ' bytes]';
}

// The platform shell: cmd.exe on Windows, $SHELL (or /bin/sh) on POSIX.
function platformShell() {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', flag: '/d /s /c' };
  }
  return { file: process.env.SHELL || '/bin/sh', flag: '-c' };
}

// runShell — execute cmd in projectDir, capturing stdout/stderr.
async function runShell(opts) {
  const projectDir = opts && opts.projectDir;
  const cmd = opts && opts.cmd;
  let timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = opts && typeof opts.maxBytes === 'number' ? opts.maxBytes : DEFAULT_MAX_BYTES;

  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, error: 'cmd is required', code: 'EBADINPUT', durationMs: 0 };
  }
  // Clamp timeout to [1, MAX_TIMEOUT_MS].
  if (!(timeoutMs >= 1)) timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;

  let cwd;
  try { cwd = resolveSandbox(projectDir); }
  catch (e) { return { ok: false, error: e.message, code: e.code || 'EOUTSIDE_PROJECT', durationMs: 0 }; }

  hookExit();

  const { file, flag } = platformShell();
  const args = process.platform === 'win32' ? flag.split(' ').concat(cmd) : [flag, cmd];
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, code: 'ESPAWN', durationMs: Date.now() - startedAt });
    }

    liveChildren.add(child);

    let outBuf = Buffer.alloc(0);
    let errBuf = Buffer.alloc(0);
    let settled = false;
    let killGrace = null;

    const appendCapped = (existing, chunk) => {
      // Stop growing the buffer once we exceed the cap (leave room for
      // the marker in truncate()); we still drain the stream so the
      // child does not block on a full pipe.
      if (Buffer.byteLength(existing) >= maxBytes) return existing;
      return Buffer.concat([existing, chunk]);
    };

    child.stdout.on('data', (c) => { outBuf = appendCapped(outBuf, c); });
    child.stderr.on('data', (c) => { errBuf = appendCapped(errBuf, c); });

    const timer = setTimeout(() => {
      // Timed out: SIGTERM, then SIGKILL after the grace window.
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      killGrace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, KILL_GRACE_MS);
      if (!settled) {
        settled = true;
        liveChildren.delete(child);
        resolve({
          ok: false,
          error: 'timed out',
          code: 'ETIMEDOUT',
          stdout: truncate(outBuf, maxBytes),
          stderr: truncate(errBuf, maxBytes),
          durationMs: timeoutMs + KILL_GRACE_MS
        });
      }
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      liveChildren.delete(child);
      resolve({ ok: false, error: e.message, code: 'ESPAWN', durationMs: Date.now() - startedAt });
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      liveChildren.delete(child);
      resolve({
        ok: exitCode === 0,
        stdout: truncate(outBuf, maxBytes),
        stderr: truncate(errBuf, maxBytes),
        exitCode: exitCode == null ? -1 : exitCode,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

module.exports = {
  runShell,
  resolveSandbox,
  truncate,
  SPEC,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_BYTES
};
