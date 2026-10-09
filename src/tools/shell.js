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

// Live children, reaped on parent exit. `runShell` registers its child
// here directly; a batch runner (src/tools/groupCli.js) registers a whole
// batch through registerLiveChild/clearLiveChild so one live set covers
// every native command mouaif spawns.
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

// Track one spawned child until it settles. Exported so a runner that
// cannot use runShell (the background half of the batch tool) is reaped
// by the same exit hook instead of leaking on a server shutdown.
function registerLiveChild(child) {
  hookExit();
  liveChildren.add(child);
}
function clearLiveChild(child) {
  liveChildren.delete(child);
}

// Human-readable label for the platform shell ("PowerShell 7 (pwsh)",
// "bash (bash)", ...). Computed once at module load from the exact
// interpreter the runner will spawn, so the model-facing description
// and the result metadata always agree with what actually ran.
//
// Windows note: cmd.exe is a COMMAND.COM-style shell whose quoting,
// escaping and environment differ from POSIX sh. `SHELL` is
// conventionally unset on Windows, so we never consult it there; the
// child always runs under `ComSpec` (cmd.exe by default).
function shellLabelFor(shellPath) {
  if (process.platform === 'win32') {
    const base = shellPath.split(/[\\/]/).pop().toLowerCase();
    if (base === 'pwsh.exe' || base === 'pwsh') return 'PowerShell 7 (pwsh)';
    if (base === 'powershell.exe' || base === 'powershell') return 'Windows PowerShell (powershell)';
    if (base === 'cmd.exe' || base === 'cmd') return 'Command Prompt (cmd.exe)';
    return 'Windows shell (' + shellPath + ')';
  }
  const base = shellPath.split('/').pop() || shellPath;
  return base + ' (' + shellPath + ')';
}

function shellLabel() {
  return shellLabelFor(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh'));
}

function osLabel() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return process.platform;
}

// Shell-family summary for the model, e.g. "Command Prompt (cmd.exe) —
// Windows command-line syntax, not POSIX sh". This makes the
// interpreter's dialect explicit so the model does not assume bash.
function shellDialectHint() {
  const label = shellLabel();
  if (process.platform === 'win32') {
    return label + ' — Windows command-line syntax (cmd.exe batch-style quoting and escaping; not POSIX sh/bash)';
  }
  return label + ' — POSIX sh syntax';
}

// "The exact interpreter that runs commands, e.g. 'C:\Windows\system32\cmd.exe'."
function shellExeDescription() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return 'The exact interpreter that runs commands, e.g. ' + JSON.stringify(comspec) + '.';
  }
  return "The exact interpreter that runs commands, e.g. '/bin/sh' or the user's \$SHELL.";
}

// The model-facing tool spec (OpenAI-compatible function shape).
const SPEC = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command in the project directory through mouaif, the local AI coding assistant that provides this chat. Commands execute on ' + osLabel() + ' via ' + shellDialectHint() + '. Returns stdout, stderr, and exit code. Non-interactive only: the child has no stdin, so REPLs, prompts, and commands that read from stdin fail or exit immediately — run the one-shot/flagged form instead (e.g. "node -e ...", "npm test", not bare "node" or "cmd").',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to run, as a single string. Must be non-interactive (no stdin input, no REPL, no prompts).' },
        shell: { type: 'string', description: shellExeDescription() },
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

// resolveShellPlan(cmd, shellOverride) -> { ok, file, args, identity }
//                                         | { ok: false, error, code }
//
// Resolve the exact argv one command runs under, plus the identity line
// naming the interpreter. `runShell` and the grouped `group_cli` runner
// both go through this, so a batch entry runs byte-for-byte like a single
// shell call — the flags, the cmd.exe wrapper quoting and the validation
// of the optional interpreter override cannot drift between the two.
function resolveShellPlan(cmd, shellOverrideRaw) {
  // Optional explicit interpreter override (Windows: cmd.exe / pwsh /
  // powershell.exe; POSIX: a path to a sh-compatible binary). The
  // override is validated here and reuses the platform flags, so it
  // cannot turn into an arbitrary-args injection.
  let shellOverride = typeof shellOverrideRaw === 'string' ? shellOverrideRaw.trim() : '';
  if (shellOverride && shellOverride !== 'default') {
    const lower = shellOverride.toLowerCase();
    const knownWin = ['cmd.exe', 'cmd', 'pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'];
    if (process.platform === 'win32' && !knownWin.includes(lower)) {
      return { ok: false, error: 'unsupported shell override on Windows: ' + shellOverride + ' (expected cmd.exe, pwsh, or powershell)', code: 'EBADINPUT', durationMs: 0 };
    }
    if (process.platform !== 'win32' && (lower.endsWith('.exe') || lower.includes('\\') || !lower.includes('/'))) {
      return { ok: false, error: 'unsupported shell override: ' + shellOverride + ' (expected a path to a sh-compatible binary)', code: 'EBADINPUT', durationMs: 0 };
    }
  } else {
    shellOverride = '';
  }
  const base = platformShell();
  const file = shellOverride || base.file;
  // cmd.exe (and cmd aliases) must keep the wrapper-quote handling;
  // any POSIX-style interpreter gets the plain `-c` flag path.
  const isCmd = process.platform === 'win32' && (!shellOverride || ['cmd.exe', 'cmd'].includes(shellOverride.toLowerCase()));
  const flags = isCmd ? base.flags : ['-c'];
  const args = flags.concat(isCmd ? '"' + cmd + '"' : cmd);
  // Identity reflects the interpreter that actually runs the command,
  // which is the override when one was requested.
  return {
    ok: true,
    file,
    args,
    verbatim: isCmd,
    identity: shellOverride
      ? 'mouaif shell · ' + osLabel() + ' · ' + shellLabelFor(file)
      : 'mouaif shell · ' + osLabel() + ' · ' + shellLabel()
  };
}

// runShell — execute cmd in projectDir, capturing stdout/stderr.
// Optional opts.onOutput(stream, delta) fires per decoded output chunk
// while the command is still running so callers can stream a live
// preview to the chat UI.
async function runShell(opts) {
  const projectDir = opts && opts.projectDir;
  const cmd = opts && opts.cmd;
  const onOutput = opts && typeof opts.onOutput === 'function' ? opts.onOutput : null;
  const signal = opts && opts.signal;
  let timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxChars = opts && typeof opts.maxChars === 'number' ? opts.maxChars
    : (opts && typeof opts.maxBytes === 'number' ? opts.maxBytes : DEFAULT_MAX_CHARS);

  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, error: 'cmd is required', code: 'EBADINPUT', durationMs: 0 };
  }
  // Optional explicit interpreter override (Windows: cmd.exe / pwsh /
  // powershell.exe; POSIX: a path to a sh-compatible binary), validated
  // by resolveShellPlan below.
  const shellOverride = opts && typeof opts.shell === 'string' ? opts.shell : '';
  // Clamp timeout to [1, MAX_TIMEOUT_MS].
  if (!(timeoutMs >= 1)) timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;

  let cwd;
  try { cwd = resolveSandbox(projectDir); }
  catch (e) { return { ok: false, error: e.message, code: e.code || 'EOUTSIDE_PROJECT', durationMs: 0 }; }

  const plan = resolveShellPlan(cmd, shellOverride);
  if (!plan.ok) return plan;
  // Identity of this runner, surfaced in the tool result and prepended
  // to the first model-facing tool message, so the model always knows
  // which software and which shell executed the command.
  const { file, args, verbatim, identity } = plan;

  hookExit();
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let child;
    const detached = process.platform !== 'win32';
    try {
      child = spawn(file, args, {
        cwd,
        env: childEnv(),
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, code: 'ESPAWN', durationMs: Date.now() - startedAt });
    }

    liveChildren.add(child);

    // Keep the shell and every descendant in one process group on POSIX so
    // a timeout/cancellation cannot leave grandchildren running after the
    // shell wrapper exits.
    const killTree = (signal) => {
    try {
      if (detached && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already gone */ }
    };

    // Output is accumulated as decoded text (StringDecoder keeps
    // multi-byte UTF-8 sequences intact across chunk boundaries) so
    // both the char cap and the live preview deltas are codepoint-safe.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let outText = '';
    let errText = '';
    let settled = false;
    let killGrace = null;
    let timer = null;
    const abortHandler = () => {
      killTree('SIGTERM');
      killGrace = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      killGrace.unref && killGrace.unref();
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          error: 'aborted',
          code: 'EABORTED',
          stdout: truncate(outText, maxChars),
          stderr: truncate(errText, maxChars),
          identity,
          durationMs: Date.now() - startedAt
        });
      }
    };

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

    timer = setTimeout(() => {
    // Timed out: SIGTERM, then SIGKILL after the grace window.
    killTree('SIGTERM');
    killGrace = setTimeout(() => {
      killTree('SIGKILL');
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
    if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('error', (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killGrace) clearTimeout(killGrace);
    if (signal) signal.removeEventListener('abort', abortHandler);
    liveChildren.delete(child);
    resolve({ ok: false, error: e.message, code: 'ESPAWN', durationMs: Date.now() - startedAt });
    });

    child.on('close', (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killGrace) clearTimeout(killGrace);
    if (signal) signal.removeEventListener('abort', abortHandler);
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
  resolveShellPlan,
  registerLiveChild,
  clearLiveChild,
  SPEC,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_BYTES,
  shellLabel,
  shellDialectHint,
  shellExeDescription,
  osLabel,
  platformShell
};
