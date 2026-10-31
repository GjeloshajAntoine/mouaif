'use strict';

// Model-facing tools for webhook-triggered turns: webhook_create (give this
// chat a secret link that starts a turn when it is called), webhook_status and
// webhook_delete. The store, the public /hook/<uuid> endpoint and the delivery
// queue live in src/webhooks.js (docs/features/webhook-turns.md).
const webhooks = require('../webhooks.js');
const { err } = require('../util.js');

const NAMES = Object.freeze(['webhook_create', 'webhook_status', 'webhook_delete']);

const SPECS = Object.freeze({
  webhook_create: { type: 'function', function: {
    name: 'webhook_create',
    description: 'Give this chat a webhook: a secret link (/hook/<uuid>) that starts a new turn in this chat every time it is called, with your prompt followed by the data the call carried (method, query, headers, body). Use it when the user wants the chat to react to an outside event (a CI build, a form, a monitoring alert, another script). Each run starts a fresh context at its own prompt: it sees neither earlier runs nor this conversation, so put everything a run needs in the prompt or in a project file. Calls that arrive while the chat is busy wait their turn. A chat has one webhook: calling this again changes its prompt and method but keeps the link. The user sees the link with a copy button above the composer.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', description: 'The instructions each run starts with (max ' + webhooks.MAX_PROMPT_CHARS + ' characters). The received data is appended below it.' },
      method: { type: 'string', enum: ['POST', 'GET', 'ANY'], description: 'The HTTP method the link accepts: POST (default, data in the body), GET (data in the query string) or ANY (both).' }
    }, required: ['prompt'], additionalProperties: false } } },
  webhook_status: { type: 'function', function: {
    name: 'webhook_status',
    description: 'Show this chat’s webhook, if any: its link path, method, prompt, whether it is active or paused, and the latest calls with their status.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  webhook_delete: { type: 'function', function: {
    name: 'webhook_delete',
    description: 'Delete this chat’s webhook. Its link stops working at once and its call history is removed; turns it already started stay in the chat.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }
});

function validate(name, args) {
  const spec = SPECS[name].function.parameters;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw err('EBADINPUT', 'arguments must be an object');
  for (const key of spec.required) if (args[key] === undefined) throw err('EBADINPUT', key + ' is required');
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.properties[key];
    if (!schema) throw err('EBADINPUT', 'unknown argument: ' + key);
    if (schema.type === 'string' && typeof value !== 'string') throw err('EBADINPUT', key + ' must be a string');
  }
}

function summarizeEvent(e) {
  return { id: e.id, receivedAt: new Date(e.receivedAt).toISOString(), method: e.method, status: e.status, run: e.run, error: e.error };
}

function createRunners({ store = webhooks.sharedStore(),
  getChat = (projectDir, chatId) => require('../chats.js').getChat(projectDir, chatId) } = {}) {
  function target(opts) {
    if (!opts || !opts.projectDir || !opts.chatId) throw err('EBADINPUT', 'Webhooks belong to a chat; none is open');
    return { projectDir: opts.projectDir, chatId: opts.chatId };
  }
  return {
    webhook_create(args, opts) {
      const { projectDir, chatId } = target(opts);
      const prompt = webhooks.normalizePrompt(args.prompt);
      const method = webhooks.normalizeMethod(args.method);
      const chat = getChat(projectDir, chatId);
      if (!chat) throw err('ENOTARGET', 'This chat does not exist');
      if (!chat.modelId) throw err('EBADINPUT', 'Select a model for this chat first; a webhook run needs one');
      const { hook, created } = store.upsert({ projectDir, chatId, prompt, method });
      const view = webhooks.present(hook);
      return { ok: true, created, ...view,
        note: view.url ? undefined : 'The link is ' + view.path + ' on the address mouaif is reached at; the user can copy the full link from the bar above the composer.' };
    },
    webhook_status(args, opts) {
      const { projectDir, chatId } = target(opts);
      const hook = store.forChat(projectDir, chatId);
      if (!hook) return { ok: true, webhook: null };
      return { ok: true, webhook: webhooks.present(hook), calls: store.events(hook.id, 10).map(summarizeEvent) };
    },
    webhook_delete(args, opts) {
      const { projectDir, chatId } = target(opts);
      const hook = store.forChat(projectDir, chatId);
      if (!hook) throw err('ENOTARGET', 'This chat has no webhook');
      store.remove(hook.id);
      return { ok: true, deleted: true, id: hook.id };
    }
  };
}

let defaultRunners = null;

// runWebhookTool(name, args, opts) -> { ok, content, result }
async function runWebhookTool(name, args, opts, runners) {
  try {
    if (!NAMES.includes(name)) throw err('EUNKNOWN_TOOL', 'Unknown webhook tool: ' + name);
    validate(name, args);
    const table = runners || (defaultRunners = defaultRunners || createRunners());
    const result = table[name](args, opts || {});
    return { ok: result.ok !== false, content: JSON.stringify(result), result };
  } catch (e) {
    const code = e.code || 'EWEBHOOK';
    const result = { ok: false, code, error: { code, message: e.message || String(e) } };
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = { NAMES, SPECS, runWebhookTool, createRunners };
