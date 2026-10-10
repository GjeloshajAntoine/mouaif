'use strict';
// Precedence + dispatch + reconnect regression. All configuration is temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-model-precedence-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const settings = require('../src/settings.js');
const agents = require('../src/agents.js');
const chats = require('../src/chats.js');
const ai = require('../src/ai.js');
const auth = require('../src/tools/authorization.js');
const realFetch = global.fetch;
const model = { id: 'parent', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' };
const pin = (id, providerId = 'openai-compatible') => ({ modelId: id, providerId });
const defaults = id => ({ subagentModelId: id, subagentProviderId: 'ollama' });
const requests = [];
global.fetch = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
  if (url.includes('/api/chat')) return new Response(JSON.stringify({ message: { content: 'Done' }, done: true }) + '\n');
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
async function main() {
  settings.setApp({ providers: [{ id: 'openai-compatible', baseUrl: 'http://fixture/v1', apiKey: 'fixture-secret' },
    { id: 'ollama', baseUrl: 'http://second/v1' }] });
  settings.setProject(projectDir, { tools: { subagent: { mode: 'allow' } }, ...defaults('project'),
    agents: [{ name: 'Named', content: 'NAMED' }, { name: 'Broken', content: 'BROKEN', modelId: 'missing' }],
    defaultAgent: { content: 'DEFAULT', ...pin('default-pin') },
    models: [{ id: 'same', provider: 'openai-compatible' }, { id: 'same', provider: 'ollama' },
    { id: 'safe', provider: 'openai-compatible', baseUrl: 'http://evil', apiKey: 'evil' }] });
  const table = [
    [{ override: pin('override'), agent: pin('agent'), chat: defaults('chat'), project: defaults('project') }, 'override', 'approval'],
    [{ agent: pin('agent'), chat: defaults('chat'), project: defaults('project') }, 'agent', 'agent'],
    [{ agent: {}, chat: defaults('chat'), project: defaults('project') }, 'chat', 'chat default'],
    [{ agent: {}, chat: {}, project: defaults('project') }, 'project', 'project default'],
    [{}, 'parent', 'chat model'],
    [{ override: pin('override'), agent: { modelId: 'missing' } }, 'override', 'approval'],
    [{ agent: pin('agent'), chat: { subagentModelId: 'invalid' } }, 'agent', 'agent']
  ];
  for (const [input, id, source] of table) {
    const result = agents.resolveSubagentModel({ projectDir, model, ...input });
    assert.equal(result.model.id, id);
    assert.equal(result.source, source);
  }
  assert.equal(agents.resolveSubagentModel({ projectDir, model, agent: pin('same', 'ollama') }).model.provider, 'ollama');
  assert.throws(() => agents.resolveSubagentModel({ projectDir, model, agent: { modelId: 'missing' } }), { code: 'EUNKNOWN_MODEL' });
  assert.throws(() => agents.resolveSubagentModel({ projectDir, model, override: { modelId: 'same' } }), { code: 'EBADINPUT' });
  assert.throws(() => agents.resolveSubagentModel({ projectDir, model, chat: { subagentModelId: 'same' } }), { code: 'EBADINPUT' });
  const chat = chats.createChat(projectDir, {});
  chats.updateChat(projectDir, chat.id, defaults('chat'));
  assert.equal(chats.getChat(projectDir, chat.id).subagentModelId, 'chat');
  assert.equal(chats.listChats(projectDir).find(row => row.id === chat.id).subagentProviderId, 'ollama');
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.id, 'chat');
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, '', model).model.id, 'default-pin');
  assert.throws(() => agents.subagentModelForCall(projectDir, chat.id, 'Unknown', model, pin('override')), { code: 'EUNKNOWN_AGENT' });
  chats.updateChat(projectDir, chat.id, { subagentModelId: '' });
  assert.equal(chats.getChat(projectDir, chat.id).subagentProviderId, null);
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.id, 'project');
  assert.throws(() => chats.updateChat(projectDir, chat.id, { subagentModelId: 'bad' }), { code: 'EBADINPUT' });
  settings.close();
  assert.equal(chats.getChat(projectDir, chat.id).subagentModelId, null, 'clear survives DB reopen');
  chats.updateChat(projectDir, chat.id, defaults('chat'));
  async function run(id, agent, override) {
    const events = [];
    if (override) settings.setProject(projectDir, { tools: { subagent: { mode: 'ask' } } });
    const pending = ai.runSingleToolCall({ id, name: 'subagent', arguments: JSON.stringify({ task: 'Review', agent }) }, {
      opts: { model, projectDir, chatId: chat.id, enabledTools: ['subagent'] },
      onEvent: (name, data) => events.push({ name, data })
    });
    if (override) {
      for (let i = 0; i < 100 && !events.some(event => event.name === 'authorization_required'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      auth.recordDecision(projectDir, chat.id, id, 'allow-once', { modelOverride: override });
    }
    return { output: await pending, events };
  }
  let runResult = await run('chat-default', 'Named');
  assert.equal(runResult.output.exec.ok, true, JSON.stringify(runResult.output));
  assert.equal(requests.at(-1).body.model, 'chat');
  runResult = await run('default-pin', '');
  assert.equal(runResult.output.exec.ok, true);
  assert.equal(requests.at(-1).body.model, 'default-pin');
  runResult = await run('safe', 'Broken', pin('safe'));
  assert.equal(runResult.output.exec.ok, true, 'broken lower-priority pin cannot block override');
  assert.equal(requests.at(-1).body.model, 'safe');
  assert.ok(requests.at(-1).url.startsWith('http://fixture/'), 'project URL never replaces app URL');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer fixture-secret');
  settings.setProject(projectDir, { tools: { subagent: { mode: 'ask' } } });
  const events = [];
  const asking = ai.runSingleToolCall({ id: 'approve', name: 'subagent', arguments: JSON.stringify({ task: 'Review', agent: 'Named' }) }, {
    opts: { model, projectDir, chatId: chat.id, enabledTools: ['subagent'] },
    onEvent: (name, data) => events.push({ name, data })
  });
  for (let i = 0; i < 100 && !events.some(event => event.name === 'authorization_required'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const prompt = events.find(event => event.name === 'authorization_required');
  assert.deepEqual(prompt.data.subagentModel, { providerId: 'ollama', modelId: 'chat', source: 'chat default' });
  assert.deepEqual(auth.listPending(projectDir, chat.id)[0].subagentModel, prompt.data.subagentModel, 'reconnect uses same effective default');
  auth.recordDecision(projectDir, chat.id, 'approve', 'allow-once', { modelOverride: pin('same', 'ollama') });
  assert.equal((await asking).exec.ok, true);
  assert.equal(requests.at(-1).body.model, 'same');
  assert.ok(requests.at(-1).url.startsWith('http://second/'));
  assert.equal(chats.getChat(projectDir, chat.id).subagentModelId, 'chat', 'approval never persists a model default');
  const tools = require('../src/tools/mouaif.js');
  assert.ok(tools.SPECS.update_chat.function.parameters.properties.subagentModelId);
  const updated = await tools.runAppTool('update_chat', { chatId: chat.id, ...defaults('tool-default') }, { projectDir });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.result.chat.subagentModelId, 'tool-default');
  assert.equal(chats.getChat(projectDir, chat.id).subagentModelId, 'tool-default');
  // Exercise real REST handlers in-process; never start/restart the host CLI.
  const { Readable } = require('node:stream');
  async function request(handler, method, pathname, body) {
    const req = Readable.from([JSON.stringify({ projectDir, ...body })]);
    req.method = method;
    req.headers = {};
    const res = { statusCode: 0, body: '', setHeader() {}, writeHead(code) { this.statusCode = code; },
      end(value) { this.body += value || ''; } };
    await handler(req, res, { pathname, query: { projectDir } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  const { handleChats } = require('../src/server-handlers-chats.js');
  const { handleSettings } = require('../src/server-handlers-settings.js');
  const httpChat = await request(handleChats, 'PATCH', '/api/chats/' + chat.id, defaults('http-default'));
  assert.equal(httpChat.status, 200);
  assert.equal(httpChat.body.chat.subagentModelId, 'http-default');
  const invalid = await request(handleChats, 'PATCH', '/api/chats/' + chat.id, { subagentProviderId: '' });
  assert.equal(invalid.status, 400);
  const cleared = await request(handleChats, 'PATCH', '/api/chats/' + chat.id, { subagentModelId: '' });
  assert.equal(cleared.body.chat.subagentProviderId, null);
  const httpProject = await request(handleSettings, 'PUT', '/api/settings/project', defaults('http-project'));
  assert.equal(httpProject.status, 200);
  assert.equal(httpProject.body.project.subagentModelId, 'http-project');
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.id, 'http-project');
  settings.setApp(defaults('app-default'));
  settings.unsetProjectKeys(projectDir, ['subagentModelId', 'subagentProviderId']);
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.id, 'app-default');
  settings.setProject(projectDir, { subagentModelId: '', subagentProviderId: '' });
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.id, 'parent', 'explicit empty project masks app default');
  const { handleAgents } = require('../src/server-handlers-prompts.js');
  const pinned = await request(handleAgents, 'PATCH', '/api/agents/Named', pin('same', 'ollama'));
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.agent.providerId, 'ollama');
  const defaultPin = await request(handleAgents, 'PATCH', '/api/agents/_default', pin('same', 'openai-compatible'));
  assert.equal(defaultPin.status, 200);
  assert.equal(defaultPin.body.agent.providerId, 'openai-compatible');
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, 'Named', model).model.provider, 'ollama');
  assert.equal(agents.subagentModelForCall(projectDir, chat.id, '', model).model.provider, 'openai-compatible');
  console.log('agents model precedence: table, named/default agent, DB persistence, safe hydration, override and reconnect passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = realFetch;
  settings.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
