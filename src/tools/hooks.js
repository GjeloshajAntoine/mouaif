'use strict';

// Model-facing hook tools (docs/features/hooks.md, spec phase 3):
//
//   hook_create  add a hook to this chat (or, if the user allows it on the
//                card, to every chat). ALWAYS shows the approval card, even
//                when the tool is Allow or a session grant exists.
//   hook_list    the hooks that apply to this chat, with their last decision.
//   hook_delete  remove one of this chat's hooks. App hooks are removed in
//                Settings → Hooks only.
//
// Rules from the spec: command or script handlers only (no network handlers),
// scope `chat` by default, the card can only lower the scope, subagents get
// none of these tools, and tool hooks never match them (src/hooks.js
// HOOK_TOOLS), so a hook cannot lock the user out of cleanup.
const hooks = require('../hooks.js');
const chatHooks = require('../chatHooks.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(hooks.HOOK_TOOLS);
const SCOPES = Object.freeze(['chat', 'app']);
// A script the model writes is shown in full on the approval card, which
// caps a value at 12000 characters; stay well under it.
const MAX_MODEL_SCRIPT = 8 * 1024;

const EVENT_TEXT = Object.freeze({
  'prompt.submit': 'when a prompt is sent',
  'tool.before': 'before',
  'tool.after': 'after',
  'turn.start': 'when a turn starts',
  'turn.end': 'when a turn finishes',
  'turn.error': 'when a turn fails or is stopped',
  attention: 'before a notification'
});

const SPECS = Object.freeze({
  hook_create: { type: 'function', function: {
    name: 'hook_create',
    description: 'Add a hook: a command or script mouaif runs at a fixed point of this chat\'s turns, so a rule keeps applying without you remembering it ("from now on block force pushes here", "keep going until npm test passes"). The user always sees an approval card with the command verbatim and picks where it applies; it may lower the scope you ask for. '
      + 'Events: prompt.submit (before a prompt is saved: block, add context), tool.before (before a tool call: block, ask for approval, rewrite arguments, add context), tool.after (add context), turn.start / turn.error (watch), turn.end (may start one follow-up turn, max 3 in a row), attention (may silence a notification). '
      + 'The hook gets the event as JSON on stdin and runs in the chat\'s working folder. It answers by exit code (0 = carry on, 2 = block with stderr as the reason) or JSON on stdout: {"decision":"block"|"ask"|"continue","reason","updatedArgs","context","followUp","suppress"}. Plain text on stdout becomes context for you. '
      + 'Hooks can only add checks: none can approve a call. Not available to subagents.',
    parameters: { type: 'object', properties: {
      event: { type: 'string', enum: hooks.EVENTS.slice(), description: 'When the hook runs.' },
      name: { type: 'string', description: 'A short human name, also used for the hook id (max 80 characters).' },
      command: { type: 'string', description: 'A command line run by the system shell (max 4096 bytes). Give command or script, not both.' },
      script: { type: 'string', description: 'An inline script body (max ' + MAX_MODEL_SCRIPT + ' bytes), run with `shell`.' },
      shell: { type: 'string', enum: hooks.SHELLS.slice(), description: 'Interpreter for `script` (default bash). A node script may use require or import.' },
      match: { type: 'object', description: 'Optional filter; all present keys must match. tool / family / argText only for tool.before and tool.after.', properties: {
        tool: { type: 'array', items: { type: 'string' }, description: 'Tool names; * matches anything (mcp__github__*).' },
        family: { type: 'array', items: { type: 'string', enum: hooks.FAMILIES.slice() }, description: 'Tool groups.' },
        argText: { type: 'string', description: 'A regular expression searched in the call\'s arguments as JSON.' },
        origin: { type: 'array', items: { type: 'string', enum: hooks.ORIGINS.slice() }, description: 'Who sent the turn\'s prompt.' }
      }, additionalProperties: false },
      timeoutMs: { type: 'number', description: 'Timeout, 500–60000 ms (default 5000). Use more for a hook that runs tests.' },
      failClosed: { type: 'boolean', description: 'prompt.submit / tool.before only: block when the hook fails or times out.' },
      subagents: { type: 'boolean', description: 'Tool events only: also run for subagents\' tool calls.' },
      scope: { type: 'string', enum: SCOPES.slice(), description: 'chat (default): only this chat. app: every chat in every project; the user can lower it to chat on the card.' },
      note: { type: 'string', description: 'Why this hook exists, in one sentence; shown with the hook.' }
    }, required: ['event'], additionalProperties: false } } },
  hook_list: { type: 'function', function: {
    name: 'hook_list',
    description: 'List the hooks that apply to this chat: the app\'s hooks (every chat) and this chat\'s own, with their event, match, command, status, who added them and their last decision.',
    parameters: { type: 'object', properties: {
      scope: { type: 'string', enum: ['all', 'chat', 'app'], description: 'Which hooks (default all).' }
    }, required: [], additionalProperties: false } } },
  hook_delete: { type: 'function', function: {
    name: 'hook_delete',
    description: 'Delete one of this chat\'s own hooks by id (from hook_list). App hooks can only be removed by the user in Settings → Hooks.',
    parameters: { type: 'object', properties: {
      hookId: { type: 'string', description: 'The hook id.' }
    }, required: ['hookId'], additionalProperties: false } } }
});

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
}

// draft(args) -> { hook, scope } — the hook hook_create would add, validated.
// Throws a HookError / EBADINPUT on a bad request. Used for the approval card
// (before the user is asked) and again by the runner.
function draft(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err('EBADINPUT', 'arguments must be an object');
  const allowed = Object.keys(SPECS.hook_create.function.parameters.properties);
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw err('EBADINPUT', 'unknown argument: ' + key);
  if (args.handler !== undefined || args.kind !== undefined) throw err('EBADINPUT', 'only command or script hooks can be created');
  const hasCommand = typeof args.command === 'string' && args.command.trim();
  const hasScript = typeof args.script === 'string' && args.script.trim();
  if (hasCommand && hasScript) throw err('EBADINPUT', 'give command or script, not both');
  if (hasScript && Buffer.byteLength(args.script) > MAX_MODEL_SCRIPT) throw err('EBADINPUT', 'script is longer than ' + MAX_MODEL_SCRIPT + ' bytes');
  const scope = args.scope === undefined ? 'chat' : args.scope;
  if (!SCOPES.includes(scope)) throw err('EBADINPUT', 'scope must be chat or app');
  const raw = {
    id: slug(args.name) || hooks.newId(),
    event: args.event,
    name: args.name,
    match: args.match,
    handler: hasCommand ? { kind: 'command', command: args.command } : { kind: 'command', shell: args.shell, script: hasScript ? args.script : '' },
    timeoutMs: args.timeoutMs,
    failClosed: args.failClosed === true,
    subagents: args.subagents === true,
    createdBy: 'model',
    note: args.note
  };
  if (raw.id && !/^[a-z0-9]/.test(raw.id)) raw.id = 'h-' + raw.id;
  let hook;
  try { hook = hooks.normalizeHook(raw); }
  catch (e) { throw err('EBADINPUT', String(e.message || e).replace(/^hooks\[0\]\./, '')); }
  return { hook, scope };
}

function matchText(hook) {
  const m = hook.match || {};
  const bits = [];
  if (m.tool) bits.push(m.tool.join(', '));
  if (m.family) bits.push(m.family.join(', ') + ' tools');
  if (m.argText) bits.push('arguments matching /' + m.argText + '/');
  if (m.origin) bits.push('sent by ' + m.origin.join(', '));
  return bits.join(' · ');
}

// describe(args) -> { title, text } for the approval card. The card's title
// says the hook persists; the text shows the command or script verbatim.
function describe(args) {
  const { hook, scope } = draft(args);
  const where = scope === 'app' ? 'in every chat' : 'in this chat';
  const tool = hook.event === 'tool.before' || hook.event === 'tool.after';
  const what = tool
    ? EVENT_TEXT[hook.event] + ' ' + ((hook.match && (hook.match.tool || hook.match.family)) ? 'matching tool calls' : 'every tool call')
    : EVENT_TEXT[hook.event];
  const title = 'Add a hook that runs ' + what + ' ' + where;
  const lines = [title + '.', 'Event: ' + hook.event];
  const m = matchText(hook);
  if (m) lines.push('Match: ' + m);
  if (hook.handler.command) lines.push('Command: ' + hook.handler.command);
  else lines.push('Script (' + hook.handler.shell + '):\n' + hook.handler.script);
  const flags = [hook.timeoutMs + ' ms timeout', hook.failClosed ? 'blocks on failure' : '', hook.subagents ? 'includes subagents' : ''].filter(Boolean);
  lines.push(flags.join(' · '));
  if (hook.note) lines.push('Why: ' + hook.note);
  lines.push('It keeps running on later turns until it is deleted.');
  return { title, text: lines.join('\n'), scope, hook };
}

function summarize(hook, extra = {}) {
  const out = { id: hook.id, event: hook.event, enabled: hook.enabled !== false };
  if (hook.name) out.name = hook.name;
  if (hook.match) out.match = hook.match;
  out.handler = hook.handler.command ? { command: hook.handler.command } : { shell: hook.handler.shell, script: hook.handler.script };
  if (hook.createdBy) out.createdBy = hook.createdBy;
  if (hook.note) out.note = hook.note;
  return Object.assign(out, extra);
}

function target(opts) {
  if (!opts || !opts.projectDir || !opts.chatId) throw err('EBADINPUT', 'Hooks tools need an open chat');
  if (opts.nestedSubagent) throw err('EPARENT_ONLY', 'Subagents cannot manage hooks');
  return { projectDir: opts.projectDir, chatId: opts.chatId };
}

const runners = {
  hook_create(args, opts) {
    const { projectDir, chatId } = target(opts);
    const { hook, scope: requested } = draft(args);
    // The approval card sends the scope the user picked; it can only lower
    // the request. No pick (a decision without the card's payload) = chat.
    const picked = opts.hookScope === 'app' || opts.hookScope === 'chat' ? opts.hookScope : 'chat';
    const scope = requested === 'app' && picked === 'app' ? 'app' : 'chat';
    if (scope === 'app') {
      const config = hooks.getConfig();
      // Free across the app list and this chat's hooks, so one id names one hook here.
      const ids = new Set(config.list.map((h) => h.id).concat(chatHooks.list(projectDir, chatId).map((x) => x.hook.id)));
      let id = hook.id;
      for (let i = 2; ids.has(id); i++) id = hook.id.slice(0, 34) + '-' + i;
      hook.id = id;
      hooks.setConfig({ enabled: config.enabled, list: config.list.concat(hook) });
      return { ok: true, hookId: id, scope: 'app', status: 'active', requestedScope: requested,
        note: config.enabled ? undefined : 'Hooks are paused app-wide (Settings → Hooks); this hook runs once they are turned back on.' };
    }
    const row = chatHooks.add(projectDir, chatId, hook, 'model');
    return { ok: true, hookId: row.hook.id, scope: 'chat', status: row.status,
      ...(requested !== 'chat' ? { requestedScope: requested, note: 'The user kept this hook to this chat.' } : {}) };
  },
  hook_list(args, opts) {
    const { projectDir, chatId } = target(opts);
    const which = args.scope || 'all';
    const config = hooks.getConfig();
    const last = new Map();
    try {
      for (const run of hooks.listRuns({ projectDir, chatId, limit: 200 })) if (!last.has(run.hook)) last.set(run.hook, run);
    } catch { /* log unavailable */ }
    const lastOf = (id) => {
      const r = last.get(id);
      return r ? { lastRun: { decision: r.decision, at: new Date(r.at).toISOString(), ...(r.error ? { error: r.error } : {}) } } : {};
    };
    const out = { ok: true, hooksOn: config.enabled };
    if (which !== 'chat') out.app = config.list.map((h) => summarize(h, lastOf(h.id)));
    if (which !== 'app') {
      out.chat = chatHooks.list(projectDir, chatId).map((x) => summarize(x.hook,
        Object.assign({ status: x.status, createdBy: x.createdBy }, lastOf(x.hook.id))));
    }
    return out;
  },
  hook_delete(args, opts) {
    const { projectDir, chatId } = target(opts);
    const id = String(args.hookId || '');
    if (chatHooks.remove(projectDir, chatId, id)) return { ok: true, deleted: true, hookId: id };
    if (hooks.getConfig().list.some((h) => h.id === id)) {
      throw err('EAPP_HOOK', 'Hook "' + id + '" applies to every chat; only the user can delete it, in Settings → Hooks.');
    }
    throw err('ENOTARGET', 'This chat has no hook "' + id + '"');
  }
};

function validateSimple(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err('EBADINPUT', 'arguments must be an object');
  const spec = SPECS[name].function.parameters;
  for (const key of spec.required) if (args[key] === undefined) throw err('EBADINPUT', key + ' is required');
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.properties[key];
    if (!schema) throw err('EBADINPUT', 'unknown argument: ' + key);
    if (schema.type === 'string' && typeof value !== 'string') throw err('EBADINPUT', key + ' must be a string');
    if (schema.enum && !schema.enum.includes(value)) throw err('EBADINPUT', key + ' must be one of ' + schema.enum.join(', '));
  }
}

// runHookTool(name, args, opts) -> { ok, content, result }
async function runHookTool(name, args, opts) {
  try {
    if (!NAMES.includes(name)) throw err('EUNKNOWN_TOOL', 'Unknown hook tool: ' + name);
    if (name !== 'hook_create') validateSimple(name, args || {});
    const result = runners[name](args || {}, opts || {});
    return { ok: result.ok !== false, content: JSON.stringify(result), result };
  } catch (e) {
    const code = e.code || (e instanceof hooks.HookError ? 'EBADINPUT' : 'EHOOKTOOL');
    const result = { ok: false, code, error: { code, message: e.message || String(e) } };
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = { NAMES, SPECS, SCOPES, MAX_MODEL_SCRIPT, draft, describe, runHookTool };
