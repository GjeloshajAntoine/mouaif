'use strict';

// Regression coverage for the chat Stop path. A provider can surface an
// AbortController cancellation as EUPSTREAM (or throw while unwinding). Stop
// must not turn that normal user action into a persisted red error row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-stop-'));
process.env.MOUAIF_HOME = home;
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);

const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const shared = require('../src/server-shared.js');
const { startChatTurn } = require('../src/server-handlers-chats.js');
const originalStream = shared.ai.streamChat;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFinished(chatId) {
  const key = shared.runningKey(projectDir, chatId);
  for (let i = 0; i < 100 && shared.runningChats.has(key); i++) await tick();
  assert.equal(shared.runningChats.has(key), false, 'stopped run settles');
}

async function runStoppedTurn(chatId, outcome) {
  let release;
  shared.ai.streamChat = ({ signal }) => new Promise((resolve, reject) => {
    release = () => outcome === 'throw'
      ? reject(new Error('provider aborted while stopping'))
      : resolve({ ok: false, error: { code: 'EUPSTREAM', message: 'upstream aborted' } });
    signal.addEventListener('abort', () => {}, { once: true });
  });
  const started = await startChatTurn({
    projectDir,
    chatId,
    modelId: 'mock',
    providerId: 'openai-compatible',
    content: 'Stop this turn'
  });
  assert.equal(started.ok, true, 'turn starts before Stop');
  const controller = shared.runningChatCancels.get(shared.runningKey(projectDir, chatId));
  assert.ok(controller, 'running turn has a cancellation controller');
  controller.abort(new Error('user cancelled chat'));
  release();
  await waitFinished(chatId);
  return messages.listMessages(projectDir, chatId);
}

(async () => {
  settings.setApp({ providers: [{ id: 'openai-compatible', baseUrl: 'http://fixture/v1', apiKey: 'test' }] });
  settings.setProject(projectDir, { models: [{ id: 'mock', provider: 'openai-compatible' }] });

  const returnedError = await runStoppedTurn(chats.createChat(projectDir, { title: 'returned error' }).id, 'return');
  assert.equal(returnedError.filter((m) => m.role === 'system').length, 0,
    'an aborted EUPSTREAM result does not persist an error row');
  assert.equal(returnedError.some((m) => String(m.content).includes('EUPSTREAM')), false,
    'Stop does not persist EUPSTREAM cancellation text');

  const thrownError = await runStoppedTurn(chats.createChat(projectDir, { title: 'thrown error' }).id, 'throw');
  assert.equal(thrownError.filter((m) => m.role === 'system').length, 0,
    'an abort-time throw does not persist an error row');

  console.log('PASS chat Stop cancellation: returned and thrown provider aborts settle without persisted error cards');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  shared.ai.streamChat = originalStream;
  fs.rmSync(home, { recursive: true, force: true });
});
