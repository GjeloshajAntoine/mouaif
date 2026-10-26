'use strict';

// Model-facing tools for long-running work: wait_for (sleep, or block until a
// background command settles), job_status (list jobs / read one with a log
// tail) and job_cancel (stop one). They sit on top of the process-local job
// registry (backgroundJobs.js), the wait engine (waits.js) and the cancel hook
// in groupCli.js. Jobs are scoped to the calling project, chat and nested
// invocation, exactly as group_cli scopes them when it starts a command.
const fsp = require('node:fs/promises');
const path = require('node:path');
const backgroundJobs = require('./backgroundJobs.js');
const { createWaitRegistry, MAX_TIMEOUT_MS } = require('./waits.js');
const { buildObserver, MAX_IDS } = require('./waitTargets.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['wait_for', 'job_status', 'job_cancel']);
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = MAX_TIMEOUT_MS / 1000;
const DEFAULT_TAIL_BYTES = 4000;
const MAX_TAIL_BYTES = 16000;
const CANCEL_SETTLE_MS = 5000;

const waits = createWaitRegistry();

const SPECS = Object.freeze({
  wait_for: { type: 'function', function: {
    name: 'wait_for',
    description: 'Pause this turn without burning requests. until "duration" sleeps for `seconds`. until "job" blocks until background command(s) from group_cli (async: true) finish. until "chat" waits for other chats of this project (for example ones started with start_chat) to stop running; a chat that is not running counts as finished, and a chat cannot wait for itself. until "subagent" waits for background subagent(s) you launched (callId), and until "group" for a subagent group (groupId) to settle; both only work in the turn that launched them. Pass one target in `jobId`, or up to ' + MAX_IDS + ' in `ids` with `mode` "all" (default) or "any". One wait is capped at ' + MAX_WAIT_SECONDS + ' seconds; a timeout means something is still running, so call wait_for again. A finished job returns its outcome (completed, failed, cancelled or lost), exit code and log tail; other targets return their state. Waiting never stops anything.',
    parameters: { type: 'object', properties: {
      until: { type: 'string', enum: ['duration', 'job', 'chat', 'subagent', 'group'], description: 'What to wait for.' },
      seconds: { type: 'number', minimum: 1, maximum: MAX_WAIT_SECONDS, description: 'Seconds to sleep, or the longest to wait (default ' + DEFAULT_WAIT_SECONDS + ', max ' + MAX_WAIT_SECONDS + ').' },
      jobId: { type: 'string', description: 'For until "job": one job id returned by group_cli.' },
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IDS, description: 'Job ids, chat ids, subagent callIds or groupIds to wait for (the kind is set by `until`).' },
      mode: { type: 'string', enum: ['all', 'any'], description: 'With several ids: return when all have finished (default) or when the first has.' }
    }, required: ['until'], additionalProperties: false } } },
  job_status: { type: 'function', function: {
    name: 'job_status',
    description: 'Inspect background commands started from this chat with group_cli (async: true). Without jobId it lists them (state, exit code, log path, start and end time). With jobId it returns that job plus the last `tailBytes` of its log. Jobs are remembered for a day. If mouaif restarts while a job runs, mouaif stops the command and the job is reported as `lost`; the log file stays on disk.',
    parameters: { type: 'object', properties: {
      jobId: { type: 'string', description: 'A job id from group_cli. Omit to list every job of this chat.' },
      tailBytes: { type: 'integer', minimum: 0, maximum: MAX_TAIL_BYTES, description: 'How much of the log end to return with jobId (default ' + DEFAULT_TAIL_BYTES + ', max ' + MAX_TAIL_BYTES + ', 0 for none).' }
    }, required: [], additionalProperties: false } } },
  job_cancel: { type: 'function', function: {
    name: 'job_cancel',
    description: 'Stop a background command started from this chat: SIGTERM to its process group, SIGKILL after a few seconds. Cancelling is not a rollback; whatever the command already did stays done. Cancelling a finished job is a no-op that reports its final state.',
    parameters: { type: 'object', properties: {
      jobId: { type: 'string', description: 'The job id returned by group_cli.' }
    }, required: ['jobId'], additionalProperties: false } } }
});

function scopeOf(opts) {
  return { projectDir: opts && opts.projectDir, chatId: opts && opts.chatId,
    invocationId: opts && opts.workspaceChatId };
}

function validate(name, args) {
  const spec = SPECS[name].function.parameters;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err('EBADINPUT', 'arguments must be an object');
  for (const key of spec.required) {
    if (args[key] === undefined) throw err('EBADINPUT', key + ' is required');
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.properties[key];
    if (!schema) throw err('EBADINPUT', 'unknown argument: ' + key);
    if (schema.type === 'string' && typeof value !== 'string') throw err('EBADINPUT', key + ' must be a string');
    if (schema.type === 'number' && !Number.isFinite(value)) throw err('EBADINPUT', key + ' must be a number');
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) throw err('EBADINPUT', key + ' must be an integer');
    if (schema.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw err('EBADINPUT', key + ' must be an array of strings');
      if (schema.minItems && value.length < schema.minItems) throw err('EBADINPUT', key + ' needs at least ' + schema.minItems + ' item');
      if (schema.maxItems && value.length > schema.maxItems) throw err('EBADINPUT', key + ' allows at most ' + schema.maxItems + ' items');
    }
    if (schema.minimum !== undefined && value < schema.minimum) throw err('EBADINPUT', key + ' must be at least ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw err('EBADINPUT', key + ' must be at most ' + schema.maximum);
    if (schema.enum && !schema.enum.includes(value)) throw err('EBADINPUT', 'unknown ' + key + ': ' + value);
  }
}

// The registry stores workingDir + a log path relative to it. Both come from
// group_cli, but the tail read still refuses to leave the working folder.
async function readTail(job, tailBytes) {
  if (!tailBytes || !job.logPath || !job.workingDir) return null;
  const root = path.resolve(job.workingDir);
  const file = path.resolve(root, job.logPath);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: size > length, bytes: size };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function publicJob(job) {
  return { jobId: job.jobId, state: job.state, exitCode: job.exitCode, signal: job.signal,
    startedAt: job.startedAt, finishedAt: job.finishedAt, logPath: job.logPath, pid: job.pid == null ? null : job.pid,
    ...(job.state === 'lost' ? { note: 'mouaif restarted while this ran and stopped it; read the log for how far it got' } : {}) };
}

async function withTail(job, tailBytes) {
  const tail = await readTail(job, tailBytes);
  return tail ? { ...publicJob(job), logTail: tail.text, logTruncated: tail.truncated, logBytes: tail.bytes } : publicJob(job);
}

// Chats, subagents, groups and several jobs at once: validated up front, then
// polled by the wait engine through the observer from waitTargets.js.
async function runObservedWait(args, opts, seconds) {
  const ids = args.ids || (args.jobId ? [args.jobId] : null);
  if (!ids) throw err('EBADINPUT', args.until === 'job' ? 'jobId or ids is required when until is "job"' : 'ids is required when until is "' + args.until + '"');
  const { observe, until } = buildObserver({ kind: args.until, ids, mode: args.mode }, opts);
  const outcome = await waits.wait({ until, observe, timeoutMs: seconds * 1000, intervalMs: 1000, signal: opts && opts.signal });
  if (outcome.error) throw err(outcome.error.code, outcome.error.message);
  let seen = outcome.detail;
  if (!seen) { try { seen = observe().detail; } catch { seen = null; } }
  const result = { ok: true, until: args.until, mode: args.mode || 'all', waitedMs: outcome.waitedMs,
    satisfied: outcome.satisfied, timedOut: outcome.timedOut, cancelled: !!outcome.cancelled,
    outcome: outcome.outcome || null };
  if (seen) Object.assign(result, { settled: seen.settled, total: seen.total, targets: seen.targets });
  if (outcome.cancelled) { result.ok = false; result.message = 'The wait was cancelled with the turn; nothing it watched was stopped.'; }
  else if (outcome.timedOut) result.message = 'Not finished after ' + seconds + 's (' + (seen ? seen.settled + ' of ' + seen.total + ' finished' : 'still running') + '). Call wait_for again.';
  else if (args.until === 'chat') result.message = 'Use get_chat with includeMessages to read what the chat produced.';
  return result;
}

async function runWaitFor(args, opts) {
  const seconds = args.seconds == null ? DEFAULT_WAIT_SECONDS : args.seconds;
  const scope = scopeOf(opts);
  if (args.jobId && args.ids) throw err('EBADINPUT', 'give jobId or ids, not both');
  if (args.until !== 'duration' && (args.until !== 'job' || args.ids)) return runObservedWait(args, opts, seconds);
  if (args.until === 'job' && !args.jobId) throw err('EBADINPUT', 'jobId or ids is required when until is "job"');
  const outcome = await waits.wait({
    scope, until: args.until === 'job' ? 'shell:' + args.jobId : 'duration',
    timeoutMs: seconds * 1000, intervalMs: 1000, signal: opts && opts.signal
  });
  if (outcome.error) throw err(outcome.error.code, outcome.error.message);
  const result = { ok: true, until: args.until, waitedMs: outcome.waitedMs,
    satisfied: outcome.satisfied, timedOut: outcome.timedOut, cancelled: !!outcome.cancelled };
  if (outcome.cancelled) { result.ok = false; result.message = 'The wait was cancelled with the turn; the job, if any, keeps running.'; }
  if (args.until === 'job' && !outcome.cancelled) {
    const job = backgroundJobs.get(scope, args.jobId);
    Object.assign(result, { outcome: outcome.outcome || job.state }, { job: await withTail(job, DEFAULT_TAIL_BYTES) });
    if (outcome.timedOut) result.message = 'Still running after ' + seconds + 's. Call wait_for again or job_status for the log.';
  }
  return result;
}

async function runJobStatus(args, opts) {
  const scope = scopeOf(opts);
  if (!args.jobId) {
    const list = backgroundJobs.list(scope).sort((a, b) => b.startedAt - a.startedAt).map(publicJob);
    return { ok: true, jobs: list, running: list.filter((job) => job.state === 'running').length };
  }
  const job = backgroundJobs.get(scope, args.jobId);
  const tailBytes = args.tailBytes == null ? DEFAULT_TAIL_BYTES : args.tailBytes;
  return { ok: true, job: await withTail(job, tailBytes) };
}

async function runJobCancel(args, opts) {
  const scope = scopeOf(opts);
  const { cancelBackgroundJob } = require('./groupCli.js');
  const { alreadyFinished } = cancelBackgroundJob(scope, args.jobId);
  if (!alreadyFinished) {
    // Give the process group a moment to exit so the model sees the settled state.
    const deadline = Date.now() + CANCEL_SETTLE_MS;
    while (Date.now() < deadline && backgroundJobs.get(scope, args.jobId).state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const job = backgroundJobs.get(scope, args.jobId);
  return { ok: true, alreadyFinished, cancelled: job.state === 'cancelled',
    stillRunning: job.state === 'running', job: await withTail(job, DEFAULT_TAIL_BYTES) };
}

const RUNNERS = { wait_for: runWaitFor, job_status: runJobStatus, job_cancel: runJobCancel };

// runJobTool(name, args, opts) -> { ok, content, result }
//   opts: the dispatcher's callOpts (projectDir, chatId, workspaceChatId, signal)
async function runJobTool(name, args, opts) {
  try {
    if (!RUNNERS[name]) throw err('EUNKNOWN_TOOL', 'Unknown job tool: ' + name);
    validate(name, args);
    const result = await RUNNERS[name](args, opts || {});
    return { ok: result.ok !== false, content: JSON.stringify(result), result };
  } catch (e) {
    const code = e.code || 'EJOBS';
    const result = { ok: false, code, error: { code, message: e.message || String(e) } };
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = { NAMES, SPECS, runJobTool, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS };
