'use strict';

// Model-facing tools for a long-running run: run_start opens it with a goal and
// limits, run_status reads what is left, run_end closes it. The user's own
// controls (pause, resume, stop) are not tools; see src/runs.js.
const runs = require('../runs.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['run_start', 'run_status', 'run_end']);

const SPECS = Object.freeze({
  run_start: { type: 'function', function: {
    name: 'run_start',
    description: 'Open a long-running run for this chat with a goal and limits, before a task that will span many turns (scheduled wake-ups, background jobs). mouaif enforces the limits at turn boundaries: when a limit is reached the next wake is replaced by a final "wrap up" turn and no more wakes are delivered. The user can pause, resume or stop the run from the chat. A run that has nothing running or scheduled for 10 minutes gets a reminder, and is marked stalled after three. One run per chat; end the current one with run_end first. Without a run, wake-ups still work but have no budget.',
    parameters: { type: 'object', properties: {
      goal: { type: 'string', description: 'What this run is trying to achieve (max ' + runs.MAX_GOAL_CHARS + ' characters). Shown to the user and repeated in reminders.' },
      maxTurns: { type: 'integer', minimum: 1, maximum: runs.MAX_TURNS, description: 'Most turns started by wake-ups and reminders (default ' + runs.DEFAULT_MAX_TURNS + ').' },
      maxCostUsd: { type: 'number', minimum: 0.01, description: 'Stop after this much spend since the run started, in US dollars. Only priced turns count. Omit for no cost limit.' },
      maxHours: { type: 'number', minimum: 0.1, maximum: runs.MAX_HOURS, description: 'Wall-clock limit in hours (default ' + runs.DEFAULT_MAX_HOURS + ', max ' + runs.MAX_HOURS + ').' }
    }, required: ['goal'], additionalProperties: false } } },
  run_status: { type: 'function', function: {
    name: 'run_status',
    description: 'Read this chat\u2019s run: status (running, paused, stopped, exhausted, ended, stalled), turns used and left, cost so far, time left. Check it when you wake. If the status is not running, stop working on the task and tell the user.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  run_end: { type: 'function', function: {
    name: 'run_end',
    description: 'End this chat\u2019s run: the task is finished, failed or blocked. Cancels the chat\u2019s pending wake-ups and notifies the user. Give a short summary of the result.',
    parameters: { type: 'object', properties: {
      outcome: { type: 'string', enum: ['done', 'failed', 'blocked'], description: 'How the run ended (default done).' },
      summary: { type: 'string', description: 'What was achieved, or what is blocking (max ' + runs.MAX_SUMMARY_CHARS + ' characters).' }
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
    if (schema.minimum !== undefined && value < schema.minimum) throw err('EBADINPUT', key + ' must be at least ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw err('EBADINPUT', key + ' must be at most ' + schema.maximum);
    if (schema.enum && !schema.enum.includes(value)) throw err('EBADINPUT', 'unknown ' + key + ': ' + value);
  }
}

function target(opts) {
  if (!opts || !opts.projectDir || !opts.chatId) throw err('EBADINPUT', 'A run belongs to a chat; none is open');
  return { projectDir: opts.projectDir, chatId: opts.chatId };
}

// runRunTool(name, args, opts, manager?) -> { ok, content, result }
async function runRunTool(name, args, opts, manager) {
  try {
    if (!NAMES.includes(name)) throw err('EUNKNOWN_TOOL', 'Unknown run tool: ' + name);
    validate(name, args);
    const ctx = target(opts);
    const m = manager || runs.sharedManager(opts && opts.lifecycle);
    let result;
    if (name === 'run_start') result = { ok: true, run: m.start(ctx, args) };
    else if (name === 'run_status') {
      const run = m.status(ctx);
      result = run ? { ok: true, run, shouldContinue: run.status === 'running' }
        : { ok: true, run: null, message: 'This chat has no run. Use run_start to set a goal and limits.' };
    } else result = { ok: true, run: m.end(ctx, args) };
    return { ok: true, content: JSON.stringify(result), result };
  } catch (e) {
    const code = e.code || 'ERUN';
    const result = { ok: false, code, error: { code, message: e.message || String(e) } };
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = { NAMES, SPECS, runRunTool };
