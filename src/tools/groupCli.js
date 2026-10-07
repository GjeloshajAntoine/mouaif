'use strict';

// Native `group_cli` tool — run a group of shell commands in one call, with
// an asynchronous (background) mode for the long ones.
//
// It is the CLI counterpart of `group_read` / `group_edit` (see
// docs/features/grouped-file-tools.md): one tool call carries an ordered
// `commands` array, every entry runs exactly like a single `shell` call —
// `src/tools/shell.js` resolves the argv, the sandbox and the output cap —
// and the result reports per-entry outcomes instead of failing the whole
// batch on the first non-zero exit.
//
// Async mode: an entry with `"async": true` is SPAWNED and not awaited. The
// call returns as soon as the process is up, with `{ async: true,
// status: "running", pid, logPath }`, and the command keeps running in the
// background. Its merged output (stdout and stderr in arrival order) is
// appended to a log file under the project's `.mouaif/logs/`, so anything —
// this chat later, the CLI modal, the user's own editor — can read it. The
// model can run the next batch entry while a background command is still
// working, and it can read the log with `read_file`.
//
// Public surface:
//   SPEC                    : the OpenAI-compatible function spec
//   TOOL_NAME               : 'group_cli'
//   runGroupCli(opts)       -> Promise<{ results, succeededCount,
//                                        failedCount, runningCount,
//                                        stillRunning, logs }>
//
// Design notes:
//   - Sequential is the default and the order is the array's order: a batch
//     is usually a dependent chain (`npm run build`, then `npm test`), and a
//     silent parallel default would reorder output the model cannot see.
//     Entry-level `"async": true` is how a caller asks for the opposite.
//   - Failures are data, never an exception: an entry that cannot run is
//     reported with its typed code so the model can retry just that entry
//     (the same contract `group_read` / `group_edit` use).
//   - The batch is bounded in three ways — entry count, total synchronous
//     time and total output — so one call cannot monopolize a turn.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const shell = require('./shell.js');
const { err } = require('../util.js');

// The grouped entry cap, shared with the file batches so every "grouped"
// tool advertises the same ceiling (src/tools/files.js MAX_BATCH_ENTRIES).
const MAX_BATCH_ENTRIES = require('./files.js').MAX_BATCH_ENTRIES;
const MAX_TIMEOUT_MS = shell.MAX_TIMEOUT_MS;
// Per-entry default when the caller names none; the authorization gate
// clamps the batch-level `timeoutMs` before it reaches this runner.
const DEFAULT_ENTRY_TIMEOUT_MS = shell.DEFAULT_TIMEOUT_MS;
// A synchronous batch stops starting new entries once it has spent this
// long, so a ten-entry batch of slow commands cannot run for 100 minutes
// while the chat waits. Background entries are exempt: they do not block.
const DEFAULT_TOTAL_BUDGET_MS = 5 * 60 * 1000;
// Merged output a background command keeps writing to its log, past which
// the log stops growing (the tail is what matters, and the model is told).
const BACKGROUND_LOG_MAX_BYTES = 4 * 1024 * 1024;
const BACKGROUND_LOG_DIR = path.join('.mouaif', 'logs');
const EXIT_GRACE_MS = 2_000;

const TOOL_NAME = 'group_cli';

// Live background children, reaped on parent exit through the shell
// module's own exit hook, so a server shutdown cannot leak them.
const backgroundChildren = new Set();
// Monotonic per-process counter behind the log file names, so two batches
// in the same millisecond cannot land on one file.
let backgroundSeq = 0;

function nowMs() { return Date.now(); }

function str(value) {
  return typeof value === 'string' ? value : '';
}

// One entry's command text: `cmd` is the canonical key (the same one the
// single shell tool uses); `command` is accepted as a synonym so a batch
// written either way works.
function entryCommand(entry) {
  return str(entry && (entry.cmd != null ? entry.cmd : entry.command)).trim();
}

function entryShellOverride(entry, fallback) {
  const value = entry && typeof entry.shell === 'string' ? entry.shell.trim() : '';
  return value || fallback;
}

function entryTimeout(entry, fallback) {
  const value = entry && Number.isFinite(entry.timeoutMs) ? Math.round(entry.timeoutMs) : null;
  if (value == null || value < 1) return fallback;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function entryLabel(entry) {
  return entry && typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
}

function isAsyncEntry(entry) {
  return !!(entry && entry.async === true);
}

// ---- Background log files ------------------------------------------------

// The `.mouaif/logs` directory is mouaif's own per-project scratch space
// (`.mouaif/` is gitignored by convention), so a background command's log
// never becomes project content the user has to clean up.
function ensureLogDir(root) {
  const dir = path.join(root, BACKGROUND_LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logFileName(cmd, startedAt) {
  backgroundSeq += 1;
  const slug = String(cmd).replace(/\s+/g, ' ').trim().slice(0, 40)
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'command';
  return startedAt + '-' + backgroundSeq + '-' + slug + '.log';
}

// beginBackgroundLog(dir, fileName, cmd) -> Promise<{ logPath, write, close }>
//
// Create the log file and return an append function plus a close that
// appends the exit line. Writes are best-effort: a log that cannot be
// written must not fail the command the user asked for. The file name is
// computed by the caller from logFileName(), so the path announced in the
// result and the file the handle appends to are the same one.
async function beginBackgroundLog(dir, fileName) {
  const logPath = path.join(dir, fileName);
  let handle = null;
  try { handle = await fsp.open(logPath, 'a'); } catch { handle = null; }
  const write = (text) => {
    if (!handle || !text) return;
    handle.write(text).catch(() => { /* log is best-effort */ });
  };
  const close = async (trailer) => {
    if (!handle) return;
    if (trailer) { try { await handle.write(trailer); } catch { /* best-effort */ } }
    try { await handle.close(); } catch { /* best-effort */ }
    handle = null;
  };
  return { logPath, write, close };
}

// ---- Background run ------------------------------------------------------

// startBackgroundCommand(root, entry, opts)
//   -> Promise<{ ok, async: true, status, pid, relPath, logPath, startedAt,
//                 identity }>
//   -> Promise<{ ok: false, error: { code, message } }>
//
// Spawn the command detached from this call and return as soon as it is
// running. Output is decoded through a StringDecoder per stream (so a
// multi-byte character split across chunks is not corrupted) and appended
// to the log, capped at BACKGROUND_LOG_MAX_BYTES.
async function startBackgroundCommand(root, entry, shared) {
  const cmd = entryCommand(entry);
  const plan = shell.resolveShellPlan(cmd, entryShellOverride(entry, shared.shell));
  if (!plan.ok) return { ok: false, error: { code: plan.code || 'EBADINPUT', message: plan.error } };
  const startedAt = nowMs();
  const logs = new Map();
  let log = null;
  let logger = null;
  try {
    const dir = ensureLogDir(root);
    const relName = BACKGROUND_LOG_DIR.split(path.sep).join('/') + '/' + logFileName(cmd, startedAt);
    logger = await beginBackgroundLog(dir, path.basename(relName));
    log = { relPath: relName, logPath: logger.logPath, bytes: 0, truncated: false };
    logs.set(relName, log);
  } catch (e) {
    // A project directory we cannot write to is a project fact, not a
    // command failure: run the command anyway, with output going nowhere.
    logger = null;
  }

  let child;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: root,
      env: childEnv(),
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    if (logger) { logger.write('\n[mouaif] failed to start: ' + e.message + '\n').catch?.(() => {}); await logger.close(); }
    return { ok: false, error: { code: 'ESPAWN', message: e.message } };
  }

  const buf = { bytes: 0 };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const onChunk = (streamName, chunk) => {
    const text = decoders[streamName].write(chunk);
    if (!text) return;
    buf.bytes += Buffer.byteLength(text, 'utf8');
    if (buf.bytes > BACKGROUND_LOG_MAX_BYTES) {
      if (log && !log.truncated) {
        log.truncated = true;
        logger.write('\n[mouaif] log truncated at ' + BACKGROUND_LOG_MAX_BYTES + ' bytes\n');
      }
      return;
    }
    logger.write(streamName === 'stderr' ? text : text);
    if (shared.onOutput) {
      try { shared.onOutput(streamName, text); } catch { /* preview is best-effort */ }
    }
  };
  child.stdout.on('data', (c) => onChunk('stdout', c));
  child.stderr.on('data', (c) => onChunk('stderr', c));

  shell.registerLiveChild(child);
  backgroundChildren.add(child);
  const finished = new Promise((resolve) => {
    let done = false;
    const settle = async (exitCode) => {
      if (done) return;
      done = true;
      const code = exitCode == null ? -1 : exitCode;
      shell.clearLiveChild(child);
      backgroundChildren.delete(child);
      if (logger) {
        await logger.close('\n[mouaif] exit ' + code + ' after ' + (nowMs() - startedAt) + 'ms\n');
      }
      if (log) { log.exitCode = code; log.durationMs = nowMs() - startedAt; }
      shared.onBackgroundExit && shared.onBackgroundExit({ cmd, relPath: log && log.relPath, exitCode: code, durationMs: nowMs() - startedAt });
      resolve({ exitCode: code, durationMs: nowMs() - startedAt });
    };
    child.on('error', async (e) => {
      if (log) log.spawnError = e.message;
      await settle(-1);
    });
    child.on('close', (code) => { settle(code); });
  });
  // Never let a rejection escape: the promise is awaited only by the
  // detach check below, which ignores a failure.
  finished.catch(() => {});

  // Detach check: a spawn that fails immediately (ENOENT for a missing
  // shell) reports `ok: false` instead of a "running" entry for a process
  // that never existed. A real command is still alive after this tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (child.exitCode != null || child.signalCode != null || (log && log.spawnError)) {
    await finished;
    return {
      ok: false,
      async: true,
      error: { code: 'ESPAWN', message: (log && log.spawnError) || 'command exited immediately' },
      exitCode: log && log.exitCode,
      relPath: log && log.relPath,
      startedAt
    };
  }

  return {
    ok: true,
    async: true,
    status: 'running',
    pid: child.pid == null ? null : child.pid,
    relPath: log && log.relPath,
    logPath: log && log.logPath,
    identity: plan.identity,
    startedAt
  };
}

function childEnv() {
  const env = Object.assign({}, process.env);
  for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']) delete env[key];
  return env;
}

// ---- Runner --------------------------------------------------------------

// runGroupCli(opts) -> Promise<{ results, succeededCount, failedCount,
//                                runningCount, stillRunning, logs,
//                                durationMs }>
//
//   opts.projectDir  absolute directory the commands run in (the chat's
//                    working folder, resolved by the dispatcher)
//   opts.args        { commands: [...], timeoutMs?, shell?, async?, parallel? }
//   opts.toolTimeoutMs  the batch timeout the authorization gate clamped
//   opts.signal      AbortSignal — a batch stops starting entries once set
//   opts.onOutput    (stream, delta) live preview for the chat card
//   opts.onBackgroundExit  ({ cmd, relPath, exitCode, durationMs })
async function runGroupCli(opts) {
  const args = (opts && opts.args) || {};
  const onOutput = opts && typeof opts.onOutput === 'function' ? opts.onOutput : null;
  const startedAt = nowMs();
  let root;
  try { root = shell.resolveSandbox(opts && opts.projectDir); }
  catch (e) {
    throw err(e.code || 'EOUTSIDE_PROJECT', e.message);
  }

  const commands = Array.isArray(args.commands) ? args.commands : null;
  if (!commands || !commands.length) throw err('EBADINPUT', 'commands must be a non-empty array');
  if (commands.length > MAX_BATCH_ENTRIES) {
    throw err('ETOOL_CAP', 'commands exceeds ' + MAX_BATCH_ENTRIES + ' entries');
  }

  const budgetMs = opts && opts.toolTimeoutMs != null
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, opts.toolTimeoutMs))
    : DEFAULT_TOTAL_BUDGET_MS;
  const shared = {
    shell: str(args.shell),
    onOutput,
    onBackgroundExit: opts && typeof opts.onBackgroundExit === 'function' ? opts.onBackgroundExit : null
  };
  const logs = new Map();
  const results = [];
  const images = [];
  const startOfBatch = nowMs();

  for (let index = 0; index < commands.length; index += 1) {
    const entry = commands[index];
    const requested = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    const cmd = entryCommand(entry);
    const label = entryLabel(entry);
    const base = { index, label, cmd };
    if (!requested) {
      results.push(Object.assign({}, base, { ok: false, result: { error: { code: 'EBADINPUT', message: 'Each entry must be an object' } } }));
      continue;
    }
    if (!cmd) {
      results.push(Object.assign({}, base, { ok: false, result: { error: { code: 'EBADINPUT', message: 'cmd is required' } } }));
      continue;
    }
    // The batch is cancellable: a signal that fired between entries stops
    // the run with a per-entry reason instead of silently dropping them.
    if (opts && opts.signal && opts.signal.aborted) {
      results.push(Object.assign({}, base, { ok: false, result: { error: { code: 'EABORTED', message: 'Batch cancelled; entry was not executed' } } }));
      continue;
    }
    const spent = nowMs() - startOfBatch;
    const background = isAsyncEntry(entry) || args.async === true;
    if (!background && spent >= budgetMs) {
      results.push(Object.assign({}, base, { ok: false,
        result: { error: { code: 'ETIMEDOUT', message: 'Batch time budget of ' + budgetMs + 'ms is exhausted (' + spent + 'ms spent); entry was not started' } } }));
      continue;
    }

    if (background) {
      const started = await startBackgroundCommand(root, entry, shared);
      if (started.ok) {
        if (started.relPath) {
          logs.set(started.relPath, { relPath: started.relPath, logPath: started.logPath, bytes: 0, truncated: false, exitCode: undefined, running: true });
        }
        results.push(Object.assign({}, base, { ok: true, result: {
          async: true,
          status: 'running',
          pid: started.pid,
          logPath: started.relPath,
          identity: started.identity,
          note: 'started in the background; its output is appended to ' + started.relPath + ' — read it with read_file'
        } }));
      } else {
        results.push(Object.assign({}, base, { ok: false, result: {
          async: true,
          error: started.error,
          logPath: started.relPath || null,
          exitCode: started.exitCode != null ? started.exitCode : null
        } }));
      }
      continue;
    }

    const timeoutMs = entryTimeout(entry, Math.min(DEFAULT_ENTRY_TIMEOUT_MS, budgetMs));
    const out = await shell.runShell({
      projectDir: root,
      cmd,
      shell: entryShellOverride(entry, shared.shell),
      timeoutMs,
      onOutput: onOutput
        ? (stream, delta) => { try { onOutput(stream, delta, { index, label, cmd }); } catch { /* best-effort */ } }
        : null
    });
    results.push(Object.assign({}, base, { ok: !!out.ok, result: out }));
  }

  const failedCount = results.filter((entry) => !entry.ok).length;
  const runningCount = results.filter((entry) => entry.ok && entry.result && entry.result.async === true).length;
  // Prefer the command text in `stillRunning` when the caller labelled it:
  // the label is what the caller will recognize, and the two are on the
  // same result row.
  const stillRunning = results
    .filter((entry) => entry.ok && entry.result && entry.result.async === true)
    .map((entry) => entry.label || entry.cmd);
  const logList = Array.from(logs.values()).map((log) => ({
    path: log.relPath,
    running: log.running !== false && log.exitCode === undefined,
    exitCode: log.exitCode === undefined ? null : log.exitCode
  }));

  return {
    results,
    succeededCount: results.length - failedCount,
    failedCount,
    runningCount,
    stillRunning,
    logs: logList,
    durationMs: nowMs() - startedAt,
    ...(images.length ? { content: images } : {})
  };
}

// Model-facing text: per-entry lines, then a one-line tally. JSON is what
// `toolFeedback` can compact, but a batch's value is the human-readable
// shape, and the chat card renders the structured `result` anyway.
function formatGroupCliResult(out) {
  const lines = [];
  for (const entry of out.results || []) {
    const head = (entry.index + 1) + '. ' + (entry.label || entry.cmd || '(entry)');
    const r = entry.result || {};
    if (r.async === true && r.status === 'running') {
      lines.push(head + '\n    → started in the background (pid ' + (r.pid == null ? '?' : r.pid) + '), log: ' + (r.logPath || 'unavailable'));
      continue;
    }
    if (!entry.ok) {
      const e = r.error || r;
      lines.push(head + '\n    ✗ ' + (e.code || 'ERROR') + ': ' + (e.message || 'failed'));
      if (r.logPath) lines.push('    log: ' + r.logPath);
      continue;
    }
    const status = r.exitCode === 0 || r.exitCode == null ? '✓' : '✗ exit ' + r.exitCode;
    lines.push(head + '\n    ' + status + ' · ' + (r.durationMs == null ? '' : r.durationMs + 'ms'));
    const body = [r.stdout, r.stderr && (r.stdout ? '── stderr ──\n' + r.stderr : r.stderr)]
      .filter(Boolean).join('\n');
    if (body) lines.push(body.split('\n').map((line) => '    ' + line).join('\n'));
  }
  lines.push('');
  lines.push(out.succeededCount + ' succeeded · ' + out.failedCount + ' failed'
    + (out.runningCount ? ' · ' + out.runningCount + ' running in the background' : '')
    + ' · ' + out.durationMs + 'ms');
  return lines.join('\n');
}

const SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Run a group of up to ' + MAX_BATCH_ENTRIES + ' shell commands in one call and get every result back. Commands execute in the chat’s working folder through mouaif, the local AI coding assistant that provides this chat, on '
      + shell.osLabel() + ' via ' + shell.shellDialectHint() + '. Entries run in order; a non-zero exit does not stop the batch, and each entry reports its own stdout, stderr, exit code and duration. Set "async": true on an entry (or "async": true on the call) to start it in the background instead of waiting: the result immediately names a log file under .mouaif/logs/ that keeps receiving its output, so you can start a build or a server, run further entries, and read the log later with read_file. Use one call for a read-check chain (git status, then git diff, then npm test) instead of several shell calls. Non-interactive only: children have no stdin, so REPLs, prompts and anything that reads from stdin fail or exit immediately — feed input with a heredoc or a pipe.',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_ENTRIES,
          description: 'Commands to run, in order. Each entry is { cmd, label?, shell?, timeoutMs?, async? }.',
          items: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'The command to run, as a single string. Must be non-interactive (no stdin input, no REPL, no prompts).' },
              label: { type: 'string', description: 'Optional short name for this entry, echoed in the result so a long command is recognizable.' },
              shell: { type: 'string', description: 'Optional interpreter for this entry, same values as the shell tool’s `shell` argument.' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional per-entry timeout, 1 ms - 10 min. Default ' + DEFAULT_ENTRY_TIMEOUT_MS + '.' },
              async: { type: 'boolean', description: 'Start this entry in the background and return immediately; its output is appended to .mouaif/logs/ for later reading.' }
            },
            required: ['cmd'],
            additionalProperties: false
          }
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional whole-batch time budget for the synchronous entries, 1 ms - 10 min. A clamped default applies; background entries do not count against it.' },
        shell: { type: 'string', description: 'Optional interpreter for every entry that does not name its own, same values as the shell tool’s `shell` argument.' },
        async: { type: 'boolean', description: 'Start EVERY entry in the background and return immediately. A per-entry "async" overrides it.' },
        parallel: { type: 'boolean', description: 'Reserved: entries always run in order today, and this argument is accepted but ignored.' }
      },
      required: ['commands'],
      additionalProperties: false
    }
  }
};

module.exports = {
  SPEC,
  TOOL_NAME,
  runGroupCli,
  formatGroupCliResult,
  MAX_BATCH_ENTRIES,
  DEFAULT_TOTAL_BUDGET_MS,
  BACKGROUND_LOG_DIR,
  BACKGROUND_LOG_MAX_BYTES,
  _backgroundChildren: backgroundChildren
};
