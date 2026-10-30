'use strict';

// Model-facing tools for scheduled wake-ups and recurring tasks: schedule_wake
// (wake this chat later, once or on a repeat), schedule_list and schedule_cancel.
// A repeat is the chat's one recurring task: a prompt that runs in this same
// chat at a fixed interval or at a clock time, until it is cancelled. The queue and the ticker that delivers
// wakes live in src/schedules.js; a wake is an ordinary turn started in the
// chat with the saved message.
const schedules = require('../schedules.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['schedule_wake', 'schedule_list', 'schedule_cancel']);

const SPECS = Object.freeze({
  schedule_wake: { type: 'function', function: {
    name: 'schedule_wake',
    description: 'Run a prompt in this chat later, once or on a repeat. Use it when the user wants something to happen at a regular time ("every morning", "every 30 minutes") and to continue a long task without polling. Each time it is due, mouaif starts a new turn in this same chat with your message, with a fresh context that begins at that message: it does not see earlier runs, so anything a run must pass on goes in a file in the project. First time: `in` (a delay such as "90s", "15m", "2h", "1d") or `at` (an ISO 8601 time, 30 days ahead at most). To repeat, add `every` (a fixed interval, at least 1 minute) or `time` (a 24-hour clock time such as "09:00", with optional `days` and `timezone`; the first run is the next such time unless you also give `in` or `at`). A repeat goes on until cancelled; `maxRuns` and `until` end it sooner. A chat has one recurring task: setting a new one replaces the old one, while one-off wakes can be added alongside it. A run never starts while the previous turn is still working, and missed runs are skipped, not replayed. Schedules survive a restart. The woken turn uses this chat’s normal tool permissions. Write the message as instructions to your future self, with everything you will need.',
    parameters: { type: 'object', properties: {
      message: { type: 'string', description: 'The prompt to run (max ' + schedules.MAX_MESSAGE_CHARS + ' characters). It arrives as a user message.' },
      in: { type: 'string', description: 'Delay before the first run: "90s", "15m", "2h", "1d" or "1h30m". Minimum 10s.' },
      at: { type: 'string', description: 'Absolute time of the first run as an ISO 8601 timestamp, e.g. "2026-10-27T09:00:00Z".' },
      every: { type: 'string', description: 'Repeat on a fixed interval, same format as `in`, minimum 1m. Counted from the planned time, so it does not drift.' },
      time: { type: 'string', description: 'Repeat at this 24-hour clock time, e.g. "09:00". Follows daylight saving in `timezone`.' },
      days: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, description: 'With `time`: the weekdays to run on (default every day).' },
      timezone: { type: 'string', description: 'With `time`: an IANA timezone such as "Europe/Brussels" (default: the timezone of the machine mouaif runs on). Pass the user’s if you know it.' },
      maxRuns: { type: 'integer', minimum: 1, maximum: schedules.MAX_RUNS, description: 'Stop after this many runs. Omit to repeat until cancelled.' },
      until: { type: 'string', description: 'Stop repeating after this ISO 8601 time. Omit to repeat until cancelled.' },
      maxCostUsd: { type: 'number', minimum: 0.01, description: 'A safety net for a repeat: stop after this much spend, in US dollars, counted from now. Only priced turns count.' }
    }, required: ['message'], additionalProperties: false } } },
  schedule_list: { type: 'function', function: {
    name: 'schedule_list',
    description: 'List this chat’s pending schedules: its recurring task (if any) and one-off wakes, each with id, message, next due time, repeat and runs left.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  schedule_cancel: { type: 'function', function: {
    name: 'schedule_cancel',
    description: 'Cancel one of this chat’s pending schedules by id (from schedule_wake or schedule_list). Without an id it cancels the chat’s recurring task.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'The schedule id, e.g. "wake-…". Omit to cancel the recurring task.' }
    }, required: [], additionalProperties: false } } }
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
    if (schema.type === 'number' && !Number.isFinite(value)) throw err('EBADINPUT', key + ' must be a number');
    if (schema.type === 'array') {
      if (!Array.isArray(value)) throw err('EBADINPUT', key + ' must be a list');
      for (const item of value) if (typeof item !== 'string' || (schema.items.enum && !schema.items.enum.includes(item.toLowerCase().slice(0, 3)))) throw err('EBADINPUT', key + ' may only contain ' + schema.items.enum.join(', '));
    }
    if (schema.minimum !== undefined && value < schema.minimum) throw err('EBADINPUT', key + ' must be at least ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw err('EBADINPUT', key + ' must be at most ' + schema.maximum);
  }
}

function present(row, now) {
  const repeats = !!(row.everyMs || row.spec);
  return { id: row.id, message: row.message, dueAt: new Date(row.dueAt).toISOString(),
    dueInSeconds: Math.max(0, Math.round((row.dueAt - now) / 1000)),
    recurring: repeats, repeat: schedules.describeRepeat(row),
    every: row.everyMs ? Math.round(row.everyMs / 1000) + 's' : null, runsLeft: row.runsLeft, runCount: row.runCount,
    until: row.untilAt ? new Date(row.untilAt).toISOString() : null, lastError: row.lastError };
}

// Dependencies are injectable so tests can drive the clock and the store.
// openRun / closeRun tie the chat's recurring task to its (hidden) run, which
// carries the safety limits and the user's pause and stop controls.
function createRunners({ store = schedules.sharedStore(), now = Date.now,
  getChat = (projectDir, chatId) => require('../chats.js').getChat(projectDir, chatId),
  runOf = (projectDir, chatId) => { try { return require('../runs.js').sharedManager().get(projectDir, chatId); } catch { return null; } },
  openRun = (ctx, args) => require('../runs.js').sharedManager().startRecurring(ctx, args),
  closeRun = (ctx, reason) => require('../runs.js').sharedManager().closeRecurring(ctx.projectDir, ctx.chatId, reason),
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
      if (args.every != null && args.time != null) throw err('EBADINPUT', 'give `every` or `time`, not both');
      if ((args.days != null || args.timezone != null) && args.time == null) throw err('EBADINPUT', '`days` and `timezone` only make sense with `time`');
      const repeats = args.every != null || args.time != null;
      if (!repeats && (args.maxRuns != null || args.until != null || args.maxCostUsd != null)) {
        throw err('EBADINPUT', '`maxRuns`, `until` and `maxCostUsd` only make sense with `every` or `time`');
      }
      if (args.in != null && args.at != null) throw err('EBADINPUT', 'give only one of `in` or `at`');
      if (args.in == null && args.at == null && args.time == null) throw err('EBADINPUT', 'give `in` or `at`, or `time` for a daily schedule');
      const time = now();
      let everyMs = null;
      if (args.every != null) {
        everyMs = schedules.parseDuration(args.every);
        if (everyMs < minEveryMs) throw err('EBADINPUT', '`every` must be at least ' + Math.round(minEveryMs / 1000) + ' seconds');
      }
      const spec = args.time != null ? schedules.parseClock({ time: args.time, days: args.days, timezone: args.timezone }) : null;
      let dueAt;
      if (args.in != null) dueAt = time + schedules.parseDuration(args.in);
      else if (args.at != null) {
        dueAt = Date.parse(args.at);
        if (!Number.isFinite(dueAt)) throw err('EBADINPUT', '`at` must be an ISO 8601 timestamp such as "2026-10-27T09:00:00Z"');
      } else dueAt = schedules.nextClockSlot(spec, time + minDelayMs);
      if (dueAt == null) throw err('EBADINPUT', 'No such time in the next week');
      if (dueAt < time + minDelayMs) throw err('EBADINPUT', 'The wake must be at least ' + Math.round(minDelayMs / 1000) + ' seconds from now');
      if (dueAt > time + schedules.MAX_HORIZON_MS) throw err('EBADINPUT', 'The wake is more than 30 days away');
      let untilAt = null;
      if (args.until != null) {
        untilAt = Date.parse(args.until);
        if (!Number.isFinite(untilAt)) throw err('EBADINPUT', '`until` must be an ISO 8601 timestamp such as "2026-12-31T00:00:00Z"');
        if (untilAt < dueAt) throw err('EBADINPUT', '`until` is before the first run');
      }
      const runsLeft = repeats ? (args.maxRuns == null ? null : args.maxRuns) : 1;
      const ctx = { projectDir, chatId };
      // A finished run keeps one-off wakes from restarting the work on their own;
      // a new recurring task is a fresh request and opens a new run.
      const run = runOf(projectDir, chatId);
      if (!repeats && run && !['running', 'paused'].includes(run.status)) {
        throw err('ERUN_ENDED', 'This chat\u2019s run is ' + run.status + (run.endReason ? ' (' + run.endReason + ')' : '') + '; do not schedule more work. Tell the user, or ask them to start again.');
      }
      const chat = getChat(projectDir, chatId);
      if (!chat) throw err('ENOTARGET', 'This chat does not exist');
      if (!chat.modelId) throw err('EBADINPUT', 'Select a model for this chat first; a wake needs one to run');
      // Legacy persisted job-linked wakes remain deliverable by the queue, but
      // new model-facing schedules are time-based only.
      const created = store.create({ projectDir, chatId, message, dueAt, everyMs, spec, untilAt, runsLeft });
      const result = { ok: true, id: created.id, dueAt: new Date(dueAt).toISOString(), dueInSeconds: Math.round((dueAt - time) / 1000),
        every: everyMs ? Math.round(everyMs / 1000) + 's' : null, runsLeft, pendingInChat: created.pending };
      if (repeats) {
        const row = store.get(projectDir, chatId, created.id);
        result.recurring = true;
        result.repeat = schedules.describeRepeat(row);
        result.until = untilAt ? new Date(untilAt).toISOString() : null;
        result.replacedPrevious = created.replaced > 0;
        result.run = openRun(ctx, { goal: message, repeat: result.repeat, maxRuns: args.maxRuns, untilAt, maxCostUsd: args.maxCostUsd });
      }
      return result;
    },
    schedule_list(args, opts) {
      const { projectDir, chatId } = target(opts);
      const time = now();
      const list = store.list(projectDir, chatId).map((row) => present(row, time));
      return { ok: true, schedules: list, count: list.length };
    },
    schedule_cancel(args, opts) {
      const { projectDir, chatId } = target(opts);
      let id = args.id;
      if (id == null) {
        const task = store.recurring(projectDir, chatId);
        if (!task) throw err('ENOTARGET', 'This chat has no recurring task');
        id = task.id;
      }
      const row = store.get(projectDir, chatId, id);
      const cancelled = store.cancel(projectDir, chatId, id);
      if (!cancelled) {
        if (!row) throw err('ENOTARGET', 'No schedule "' + id + '" in this chat');
        return { ok: true, cancelled: false, status: row.status, message: 'It was already ' + row.status };
      }
      if (row && (row.everyMs || row.spec)) { try { closeRun({ projectDir, chatId }, 'cancelled'); } catch { /* the run is bookkeeping */ } }
      return { ok: true, cancelled: true, id };
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
