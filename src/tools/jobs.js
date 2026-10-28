'use strict';

// Model-facing waits for time, chats, subagents and groups. Shell processes
// are observed with ordinary shell commands, not job lifecycle tools.
const { createWaitRegistry, MAX_TIMEOUT_MS } = require('./waits.js');
const { buildObserver, MAX_IDS } = require('./waitTargets.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['wait_for']);
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = MAX_TIMEOUT_MS / 1000;
const waits = createWaitRegistry();

const SPECS = Object.freeze({
  wait_for: { type: 'function', function: {
    name: 'wait_for',
    description: 'Pause this turn without burning requests. until "duration" sleeps for `seconds`; "chat" waits for other chats of this project; "subagent" and "group" wait for turn-scoped children or groups. Pass target ids in `ids`, with `mode` "all" (default) or "any". One wait is capped at ' + MAX_WAIT_SECONDS + ' seconds. A timeout means something is still running; call wait_for again. Waiting never stops anything. For shell processes use the shell commands returned by shell async:true.',
    parameters: { type: 'object', properties: {
      until: { type: 'string', enum: ['duration', 'chat', 'subagent', 'group'], description: 'What to wait for.' },
      seconds: { type: 'number', minimum: 1, maximum: MAX_WAIT_SECONDS, description: 'Seconds to sleep, or the longest to wait (default ' + DEFAULT_WAIT_SECONDS + ', max ' + MAX_WAIT_SECONDS + ').' },
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IDS, description: 'Chat ids, subagent callIds or groupIds to wait for (the kind is set by `until`).' },
      mode: { type: 'string', enum: ['all', 'any'], description: 'With several ids: return when all have finished (default) or when the first has.' }
    }, required: ['until'], additionalProperties: false } } }
});

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

async function runObservedWait(args, opts, seconds) {
  const ids = args.ids;
  if (!ids) throw err('EBADINPUT', 'ids is required when until is "' + args.until + '"');
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
  if (args.until !== 'duration') return runObservedWait(args, opts, seconds);
  if (args.ids || args.mode) throw err('EBADINPUT', 'duration does not accept ids or mode');
  const outcome = await waits.wait({ until: 'duration', timeoutMs: seconds * 1000,
    intervalMs: 1000, signal: opts && opts.signal });
  if (outcome.error) throw err(outcome.error.code, outcome.error.message);
  const result = { ok: true, until: args.until, waitedMs: outcome.waitedMs,
    satisfied: outcome.satisfied, timedOut: outcome.timedOut, cancelled: !!outcome.cancelled };
  if (outcome.cancelled) { result.ok = false; result.message = 'The wait was cancelled with the turn; nothing else was stopped.'; }
  return result;
}

const RUNNERS = { wait_for: runWaitFor };

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
