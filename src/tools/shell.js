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
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 min ceiling
const DEFAULT_MAX_CHARS = 256 * 1024; // 256K chars per stream
const DEFAULT_MAX_BYTES = DEFAULT_MAX_CHARS; // legacy export alias
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

// Human-readable label for the platform shell ("PowerShell 7 (pwsh)",
// "bash (bash)", ...). Computed once at module load from the exact
// interpreter the runner will spawn, so the model-facing description
// and the result metadata always agree with what actually ran.
function shellLabel() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const base = comspec.split(/[\\/]/).pop().toLowerCase();
    if (base === 'pwsh.exe' || base === 'pwsh') return 'PowerShell 7 (pwsh)';
    if (base === 'powershell.exe' || base === 'powershell') return 'Windows PowerShell (powershell)';
    if (base === 'cmd.exe' || base === 'cmd') return 'Command Prompt (cmd.exe)';
    return 'Windows shell (' + comspec + ')';
  }
  const shellPath = process.env.SHELL || '/bin/sh';
  const base = shellPath.split('/').pop() || shellPath;
  return base + ' (' + shellPath + ')';
}

function osLabel() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return process.platform;
}

// The model-facing tool spec (OpenAI-compatible function shape).
const SPEC = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command in the project directory through mouaif, the local AI coding assistant that provides this chat. Commands execute on ' + osLabel() + ' via ' + shellLabel() + '. Returns stdout, stderr, and exit code. Non-interactive only: the child has no stdin, so REPLs, prompts, and commands that read from stdin fail or exit immediately — run the one-shot/flagged form instead (e.g. "node -e ...", "npm test", not bare "node" or "cmd").',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to run, as a single string. Must be non-interactive (no stdin input, no REPL, no prompts).' },
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

// Truncate a Buffer/string to maxChars characters, appending a
// truncation marker. Counts UTF-16 code units (String.length) rather
// than bytes so the cap and the marker match how the model and the UI
// read the text; multi-byte output can no longer be split mid-codepoint.
function truncate(buf, maxChars) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n...[truncated at ' + maxChars + ' chars]';
}

// The platform shell: cmd.exe on Windows, $SHELL (or /bin/sh) on POSIX.
//
// Windows needs two non-obvious tweaks:
//   1. The flags must be separate argv elements; passing "/d /s /c" as one
//      element makes Node quote it ("/d /s /c") and cmd.exe mis-parse it.
//   2. With /s, cmd.exe strips the first and last quote of the command line,
//      mangling inner quotes ("node -e \"console.log(1+1)\"" silently
//      produces no output). Wrapping the whole command in an extra pair of
//      quotes plus windowsVerbatimArguments preserves it exactly.
function platformShell() {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', flags: ['/d', '/s', '/c'], wrapQuotes: true, verbatim: true };
  }
  return { file: process.env.SHELL || '/bin/sh', flags: ['-c'], wrapQuotes: false, verbatim: false };
}

// runShell — execute cmd in projectDir, capturing stdout/stderr.
// Optional opts.onOutput(stream, delta) fires per decoded output chunk
// while the command is still running so callers can stream a live
// preview to the chat UI.
async function runShell(opts) {
  const projectDir = opts && opts.projectDir;
  const cmd = opts && opts.cmd;
  const onOutput = opts && typeof opts.onOutput === 'function' ? opts.onOutput : null;
  let timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxChars = opts && typeof opts.maxChars === 'number' ? opts.maxChars
    : (opts && typeof opts.maxBytes === 'number' ? opts.maxBytes : DEFAULT_MAX_CHARS);

  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, error: 'cmd is required', code: 'EBADINPUT', durationMs: 0 };
  }
  // Clamp timeout to [1, MAX_TIMEOUT_MS].
  if (!(timeoutMs >= 1)) timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;

  // Identity of this runner, surfaced in the tool result and prepended
  // to the first model-facing tool message, so the model always knows
  // which software and which shell executed the command.
  const identity = 'mouaif shell · ' + osLabel() + ' · ' + shellLabel();

  let cwd;
  try { cwd = resolveSandbox(projectDir); }
  catch (e) { return { ok: false, error: e.message, code: e.code || 'EOUTSIDE_PROJECT', durationMs: 0 }; }

  hookExit();

  const { file, flags, wrapQuotes, verbatim } = platformShell();
  const args = flags.concat(wrapQuotes ? '"' + cmd + '"' : cmd);
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: childEnv(),
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, code: 'ESPAWN', durationMs: Date.now() - startedAt });
    }

    liveChildren.add(child);

    // Output is accumulated as decoded text (StringDecoder keeps
    // multi-byte UTF-8 sequences intact across chunk boundaries) so
    // both the char cap and the live preview deltas are codepoint-safe.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let outText = '';
    let errText = '';
    let settled = false;
    let killGrace = null;

    const appendCapped = (existing, decoder, chunk, stream) => {
      const text = decoder.write(chunk);
      if (text && onOutput) {
        try { onOutput(stream, text); } catch { /* preview is best-effort */ }
      }
      // Stop growing the buffer once we exceed the cap (leave room for
      // the marker in truncate()); we still drain the stream so the
      // child does not block on a full pipe.
      if (existing.length >= maxChars) return existing;
      return existing + text;
    };

    child.stdout.on('data', (c) => { outText = appendCapped(outText, outDec, c, 'stdout'); });
    child.stderr.on('data', (c) => { errText = appendCapped(errText, errDec, c, 'stderr'); });

    const timer = setTimeout(() => {
      // Timed out: SIGTERM, then SIGKILL after the grace window.
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      killGrace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, KILL_GRACE_MS);
      killGrace.unref && killGrace.unref();
      if (!settled) {
        settled = true;
        // Note: the child may still be alive (waiting out the SIGKILL
        // grace window). Keep it in liveChildren so the exit hook can
        // reap it; its late 'close' is a no-op because `settled` is true.
        resolve({
          ok: false,
          error: 'timed out',
          code: 'ETIMEDOUT',
          stdout: truncate(outText, maxChars),
          stderr: truncate(errText, maxChars),
          identity,
          durationMs: Date.now() - startedAt
        });
      }
    }, timeoutMs);
    timer.unref && timer.unref();

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
        stdout: truncate(outText, maxChars),
        stderr: truncate(errText, maxChars),
        exitCode: exitCode == null ? -1 : exitCode,
        identity,
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
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_BYTES
};
