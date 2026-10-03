'use strict';

// Isolated catalog + background/HTTP turn coverage. No real provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-model-tools-'));
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
process.env.MOUAIF_HOME = home;
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const tools = require('../src/tools/mouaif.js');
const shared = require('../src/server-shared.js');
const { handleChatStream } = require('../src/server-handlers-chats.js');
const originalList = shared.ai.listModels;
const originalStream = shared.ai.streamChat;
const opts = { projectDir };
const call = (name, args) => tools.runAppTool(name, args, opts);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFinished(chatId) {
  for (let i = 0; i < 100 && shared.runningChats.has(shared.runningKey(projectDir, chatId)); i++) await tick();
  assert.equal(shared.runningChats.has(shared.runningKey(projectDir, chatId)), false);
}

async function main() {
  settings.setApp({ providers: [
    { id: 'openai-compatible', apiKey: 'DO_NOT_RETURN', baseUrl: 'http://fixture/v1' },
    { id: 'ollama' }, { id: 'anthropic' }
  ] });
  settings.setProject(projectDir, { models: [
    { id: 'alpha', provider: 'openai-compatible', label: 'Alpha saved', apiKey: 'DO_NOT_RETURN' },
    { id: 'beta', provider: 'ollama', label: 'Beta saved' }
  ] });
  const queried = [];
  shared.ai.listModels = async (provider) => {
    queried.push(provider);
    if (provider === 'anthropic') throw Object.assign(new Error('Offline fixture'), { code: 'EUNREACHABLE' });
    return provider === 'ollama' ? [{ id: 'alpha', label: 'Alpha local' }]
      : [{ id: 'alpha', label: 'Duplicate' }, { id: 'gamma', label: 'Gamma live', apiKey: 'DO_NOT_RETURN' }];
  };
  let out = await call('search_models', { query: 'ALPHA', limit: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.result.total, 2, 'provider/model identity deduplicates only exact pairs');
  assert.equal(out.result.nextOffset, 1);
  assert.equal(out.result.failures[0].code, 'EUNREACHABLE');
  assert.equal(out.content.includes('DO_NOT_RETURN'), false);
  const page = await call('search_models', { query: 'alpha', offset: out.result.nextOffset, limit: 1 });
  assert.equal(page.result.nextOffset, null);
  assert.equal(page.result.models[0].source, 'project');
  assert.equal(page.result.models[0].label, 'Alpha saved');
  const before = queried.length;
  out = await call('search_models', { providerId: 'openai-compatible' });
  assert.equal(out.result.models.length, 2);
  assert.equal(queried.length, before, 'search reuses the shared live cache');
  out = await call('search_models', { includeLive: false });
  assert.equal(out.result.total, 2);
  assert.equal(queried.length, before, 'saved-only search never fetches');
  assert.equal((await call('search_models', { query: 'not-found' })).result.total, 0);
  for (const args of [{ providerId: 'ghost' }, { limit: 101 }, { offset: -1 }, { includeLive: 'yes' }]) {
    assert.equal((await call('search_models', args)).result.code, 'EBADINPUT');
  }
  const found = (await call('search_models', { query: 'gamma' })).result.models[0];
  out = await call('create_chat', { title: 'Selected', providerId: found.providerId, modelId: found.modelId });
  assert.equal(out.ok, true);
  const chatId = out.result.chat.id;
  assert.equal(chats.getChat(projectDir, chatId).modelId, 'gamma');
  assert.equal((await call('update_chat', { chatId, modelId: 'beta' })).ok, true);
  assert.equal(chats.getChat(projectDir, chatId).providerId, 'ollama', 'new saved model infers its own provider');
  assert.equal((await call('update_chat', { chatId, ...found })).result.code, 'EBADINPUT', 'copy only providerId/modelId, not catalog metadata');
  assert.equal((await call('update_chat', { chatId, providerId: found.providerId, modelId: found.modelId })).ok, true);

  const blank = chats.createChat(projectDir, {});
  assert.equal((await call('start_chat', { chatId: blank.id, content: 'Hello' })).result.code, 'EBADINPUT');
  assert.equal((await call('start_chat', { chatId: 'missing', content: 'Hello' })).result.code, 'ENOTFOUND');
  for (const content of ['', '  ', 'x'.repeat(200001)]) {
    assert.equal((await call('start_chat', { chatId, content })).result.code, 'EBADINPUT');
  }
  assert.equal(messages.listMessages(projectDir, chatId).length, 0);
  let running;
  let complete;
  shared.ai.streamChat = (args) => {
    running = args;
    return new Promise((resolve) => {
      complete = (error) => {
        if (error) resolve({ ok: false, error: { code: 'EUPSTREAM', message: error } });
        else {
          args.onEvent('message', { delta: 'Background reply' });
          args.onEvent('done', { usage: {} });
          resolve({ ok: true });
        }
      };
    });
  };
  out = await call('start_chat', { chatId, content: 'First prompt' });
  assert.equal(out.ok, true);
  assert.equal(out.result.started, true);
  assert.equal(out.result.url, '#/chat/' + chatId);
  assert.equal(shared.runningChats.has(shared.runningKey(projectDir, chatId)), true);
  assert.equal(running.model.id, 'gamma');
  assert.equal(running.chatId, chatId);
  assert.equal(messages.listMessages(projectDir, chatId)[0].content, 'First prompt');
  assert.equal((await call('start_chat', { chatId, content: 'Duplicate' })).result.code, 'EALREADY_RUNNING');
  assert.equal(messages.listMessages(projectDir, chatId).length, 1, 'busy rejection does not append');
  complete();
  await waitFinished(chatId);
  assert.equal(messages.listMessages(projectDir, chatId).at(-1).content, 'Background reply');
  out = await call('get_chat', { chatId, includeMessages: true });
  assert.equal(out.result.chat.messages.at(-1).role, 'assistant');

  await call('start_chat', { chatId, content: 'Fails later' });
  complete('Background fixture failure');
  await waitFinished(chatId);
  assert.match(messages.listMessages(projectDir, chatId).at(-1).content, /Background fixture failure/);
  await call('start_chat', { chatId, content: 'Cancel me' });
  shared.runningChatCancels.get(shared.runningKey(projectDir, chatId)).abort();
  assert.equal(running.signal.aborted, true, 'background turns use the normal cancel controller');
  complete('Cancelled');
  await waitFinished(chatId);

  // The existing HTTP entry still opens SSE and persists the same turn.
  const body = { projectDir, modelId: 'gamma', providerId: 'openai-compatible', content: 'HTTP prompt' };
  const req = { on(name, callback) {
    if (name === 'data') process.nextTick(() => callback(Buffer.from(JSON.stringify(body))));
    if (name === 'end') process.nextTick(callback);
  } };
  const res = { status: 0, data: '', ended: false,
    writeHead(status) { this.status = status; }, write(chunk) { this.data += chunk; },
    end(chunk) { this.data += chunk || ''; this.ended = true; }
  };
  const httpTurn = handleChatStream(req, res, chatId, null);
  await tick();
  assert.equal(res.status, 200);
  complete();
  await httpTurn;
  assert.equal(res.ended, true);
  assert.match(res.data, /event: done/);
  assert.equal(messages.listMessages(projectDir, chatId).at(-2).content, 'HTTP prompt');
  console.log('PASS chat model tools: search/paging/cache/redaction, model selection, background start/busy/error/cancel, HTTP SSE parity');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  shared.ai.listModels = originalList;
  shared.ai.streamChat = originalStream;
  shared.MODEL_LIST_CACHE.clear();
  fs.rmSync(home, { recursive: true, force: true });
});
