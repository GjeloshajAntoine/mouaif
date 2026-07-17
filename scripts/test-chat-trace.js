'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-trace-project-'));
const messages = require('../src/messages.js');
const trace = require('../src/trace.js');
const ai = require('../src/ai.js');

try {
  const chatId = 'a1b2c3d4';
  const user = messages.appendMessage(projectDir, chatId, { role: 'user', content: 'hello' });
  const call = messages.appendMessage(projectDir, chatId, {
    role: 'tool', phase: 'call', toolCallId: 'call_1', name: 'shell', args: { cmd: 'echo ok' }, content: '{"cmd":"echo ok"}'
  });
  const result = messages.appendMessage(projectDir, chatId, {
    role: 'tool', phase: 'result', toolCallId: 'call_1', name: 'shell', ok: true, content: '{"stdout":"ok"}'
  });
  const assistant = messages.appendMessage(projectDir, chatId, {
    role: 'assistant', content: 'done', modelId: 'test', usage: { promptTokens: 3, completionTokens: 1 }
  });
  const reopened = messages.listMessages(projectDir, chatId);
  assert.equal(reopened.length, 4);
  assert.deepEqual(reopened[1].args, { cmd: 'echo ok' });
  assert.equal(reopened[2].phase, 'result');
  assert.equal(reopened[2].ok, true);

  const file = trace.exportMessages(projectDir, chatId, [user, call, result, assistant]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.type), ['user_message', 'tool_call', 'tool_result', 'assistant_message']);
  assert.equal(lines[0].content, 'hello');
  assert.equal(lines[3].content, 'done');

  const anthropic = ai.BUILDERS.anthropic({ id: 'claude', apiKey: 'x' }, [
    { role: 'system', content: 'profile' },
    { role: 'system', content: 'tagged file' },
    { role: 'system', content: 'custom prompt' },
    { role: 'user', content: 'question' }
  ], true);
  assert.equal(anthropic.body.system, 'profile\n\ntagged file\n\ncustom prompt');
  const gemini = ai.BUILDERS.gemini({ id: 'gemini-test', apiKey: 'x' }, [
    { role: 'system', content: 'profile' },
    { role: 'system', content: 'tagged file' },
    { role: 'system', content: 'custom prompt' },
    { role: 'user', content: 'question' }
  ], true);
  assert.equal(gemini.body.systemInstruction.parts[0].text, 'profile\n\ntagged file\n\ncustom prompt');

  console.log('chat trace: 11 assertions passed');
} finally {
  fs.rmSync(projectDir, { recursive: true, force: true });
}