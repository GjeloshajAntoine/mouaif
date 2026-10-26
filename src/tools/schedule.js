'use strict';

// Model-facing tools for scheduled wake-ups: schedule_wake (wake this chat
// later, once or repeatedly, optionally also when a background job settles),
// schedule_list and schedule_cancel. The queue and the ticker that delivers
// wakes live in src/schedules.js; a wake is an ordinary turn started in the
// chat with the saved message.
const backgroundJobs = require('./backgroundJobs.js');
const schedules = require('../schedules.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['schedule_wake', 'schedule_list', 'schedule_cancel']);

const SPECS = Object.freeze({
  schedule_wake: { type: 'function', function: {
    name: 'schedule_wake',
    description: 'Wake this chat later with a message, so a long task can continue without you polling. Give `in` (a delay such as "90s", "15m", "2h", "1d") or `at` (an ISO 8601 time, 30 days ahead at most). When it is due, mouaif starts a new turn in this chat with your message. Add `every` to repeat (at least 1 minute, up to `maxRuns` times, default ' + schedules.DEFAULT_RECURRING_RUNS + '). Add `jobId` to also wake as soon as that background job settles, with `in`/`at` as the deadline. Schedules survive a restart; a wake missed while mouaif was down fires once on the next start. The woken turn uses this chat’s normal tool permissions. Write the message as instructions to your future self, with everything you will need.',
    parameters: { type: 'object', properties: {
      message: { type: 'string', description: 'What to do on waking (max ' + schedules.MAX_MESSAGE_CHARS + ' characters). It arrives as a user message.' },
      in: { type: 'string', description: 'Delay before the wake: "90s", "15m", "2h", "1d" or "1h30m". Minimum 10s.' },
      at: { type: 'string', description: 'Absolute wake time as an ISO 8601 timestamp, e.g. "2026-10-27T09:00:00Z".' },
      every: { type: 'string', description: 'Repeat interval after each wake, same format as `in`, minimum 1m.' },
      maxRuns: { type: 'integer', minimum: 1, maximum: schedules.MAX_RUNS, description: 'Stop after this many wakes (default ' + schedules.DEFAULT_RECURRING_RUNS + ' with `every`, otherwise 1).' },
      jobId: { type: 'string', description: 'A background job id from group_cli: also wake when it finishes.' }
    }, required: ['message'], additionalProperties: false } } },
  schedule_list: { type: 'function', function: {
    name: 'schedule_list',
    description: 'List this chat’s pending scheduled wake-ups: id, message, next due time, repeat and runs left.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  schedule_cancel: { type: 'function', function: {
    name: 'schedule_cancel',
    description: 'Cancel one of this chat’s pending scheduled wake-ups by id (from schedule_wake or schedule_list).',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'The schedule id, e.g. "wake-…".' }
    }, required: ['id'], additionalProperties: false } } }
});

function validate(name, args) {
  const spec = SPECS[name].function.parameters;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err('EBADINPUT', 'arguments must be an object');
  for (const key of spec.required) if (args[key] === undefined) throw err('EBADINPUT', key + ' is required');
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.properties[key];
    if (!schema) throw err('EBADINPUT', 'unknown argument: ' + key);
    if (schema.type === 'string' && typeof value !== 'string') throw err('EBADINPUT', key + ' must be a string');
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) throw err('EBADINPUT', key + ' must be an integer');
    if (schema.minimum !== undefined && value < schema.minimum) throw err('EBADINPUT', key + ' must be at least ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw err('EBADINPUT', key + ' must be at most ' + schema.maximum);
  }
}

function present(row, now) {
  return { id: row.id, message: row.message, dueAt: new Date(row.dueAt).toISOString(),
    dueInSeconds: Math.max(0, Math.round((row.dueAt - now) / 1000)),
    every: row.everyMs ? Math.round(row.everyMs / 1000) + 's' : null, runsLeft: row.runsLeft, runCount: row.runCount,
    jobId: row.jobId, lastError: row.lastError };
}

// Dependencies are injectable so tests can drive the clock and the store.
function createRunners({ store = schedules.sharedStore(), now = Date.now,
  getChat = (projectDir, chatId) => require('../chats.js').getChat(projectDir, chatId),
  checkJob = (scope, jobId) => backgroundJobs.get(scope, jobId),
  runOf = (projectDir, chatId) => { try { return require('../runs.js').sharedManager().get(projectDir, chatId); } catch { return null; } },
  limits = {} } = {}) {
  const minDelayMs = limits.minDelayMs == null ? schedules.MIN_DELAY_MS : limits.minDelayMs;
  const minEveryMs = limits.minEveryMs == null ? schedules.MIN_EVERY_MS : limits.minEveryMs;
  function target(opts) {
    if (!opts || !opts.projectDir || !opts.chatId) throw err('EBADINPUT', 'Schedules belong to a chat; none is open');
    return { projectDir: opts.projectDir, chatId: opts.chatId };
  }
  return {
    schedule_wake(args, opts) {
      const { projectDir, chatId } = target(opts);
      const message = args.message.trim();
      if (!message) throw err('EBADINPUT', 'message must not be empty');
      if (message.length > schedules.MAX_MESSAGE_CHARS) throw err('EBADINPUT', 'message is longer than ' + schedules.MAX_MESSAGE_CHARS + ' characters');
      if ((args.in == null) === (args.at == null)) throw err('EBADINPUT', 'give exactly one of `in` or `at`');
      const time = now();
      let dueAt;
      if (args.in != null) dueAt = time + schedules.parseDuration(args.in);
      else {
        dueAt = Date.parse(args.at);
        if (!Number.isFinite(dueAt)) throw err('EBADINPUT', '`at` must be an ISO 8601 timestamp such as "2026-10-27T09:00:00Z"');
      }
      if (dueAt < time + minDelayMs) throw err('EBADINPUT', 'The wake must be at least ' + Math.round(minDelayMs / 1000) + ' seconds from now');
      if (dueAt > time + schedules.MAX_HORIZON_MS) throw err('EBADINPUT', 'The wake is more than 30 days away');
      let everyMs = null;
      if (args.every != null) {
        everyMs = schedules.parseDuration(args.every);
        if (everyMs < minEveryMs) throw err('EBADINPUT', '`every` must be at least ' + Math.round(minEveryMs / 1000) + ' seconds');
      }
      if (args.maxRuns != null && !everyMs && args.maxRuns !== 1) throw err('EBADINPUT', '`maxRuns` only makes sense with `every`');
      const runsLeft = everyMs ? (args.maxRuns == null ? schedules.DEFAULT_RECURRING_RUNS : args.maxRuns) : 1;
      const run = runOf(projectDir, chatId);
      if (run && !['running', 'paused'].includes(run.status)) {
        throw err('ERUN_ENDED', 'This chat\u2019s run is ' + run.status + (run.endReason ? ' (' + run.endReason + ')' : '') + '; do not schedule more work. Tell the user, or ask them to start again.');
      }
      const chat = getChat(projectDir, chatId);
      if (!chat) throw err('ENOTARGET', 'This chat does not exist');
      if (!chat.modelId) throw err('EBADINPUT', 'Select a model for this chat first; a wake needs one to run');
      let jobScope = null;
      if (args.jobId) {
        jobScope = { projectDir, chatId, invocationId: opts.workspaceChatId };
        checkJob(jobScope, args.jobId); // ENOTARGET for a job this chat does not own
      }
      const created = store.create({ projectDir, chatId, message, dueAt, everyMs, runsLeft, jobId: args.jobId || null, jobScope });
      return { ok: true, id: created.id, dueAt: new Date(dueAt).toISOString(), dueInSeconds: Math.round((dueAt - time) / 1000),
        every: everyMs ? Math.round(everyMs / 1000) + 's' : null, runsLeft, jobId: args.jobId || null, pendingInChat: created.pending };
    },
    schedule_list(args, opts) {
      const { projectDir, chatId } = target(opts);
      const time = now();
      const list = store.list(projectDir, chatId).map((row) => present(row, time));
      return { ok: true, schedules: list, count: list.length };
    },
    schedule_cancel(args, opts) {
      const { projectDir, chatId } = target(opts);
      const cancelled = store.cancel(projectDir, chatId, args.id);
      if (!cancelled) {
        const row = store.get(projectDir, chatId, args.id);
        if (!row) throw err('ENOTARGET', 'No schedule "' + args.id + '" in this chat');
        return { ok: true, cancelled: false, status: row.status, message: 'It was already ' + row.status };
      }
      return { ok: true, cancelled: true, id: args.id };
    }
  };
}

let defaultRunners = null;

// runScheduleTool(name, args, opts) -> { ok, content, result }
async function runScheduleTool(name, args, opts, runners) {
  try {
    if (!NAMES.includes(name)) throw err('EUNKNOWN_TOOL', 'Unknown schedule tool: ' + name);
    validate(name, args);
    const table = runners || (defaultRunners = defaultRunners || createRunners());
    const result = table[name](args, opts || {});
    return { ok: result.ok !== false, content: JSON.stringify(result), result };
  } catch (e) {
    const code = e.code || 'ESCHEDULE';
    const result = { ok: false, code, error: { code, message: e.message || String(e) } };
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = { NAMES, SPECS, runScheduleTool, createRunners };
