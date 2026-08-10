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

  const reconstructed = messages.reconstructUpstreamHistory([
    { role: 'user', content: 'first' },
    { role: 'tool', phase: 'call', toolCallId: 'call_complete', name: 'shell', args: { cmd: 'echo ok' }, content: '{}' },
    { role: 'tool', phase: 'result', toolCallId: 'call_complete', name: 'shell', content: '{"stdout":"ok"}' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: 'finished' },
    { role: 'tool', phase: 'result', toolCallId: 'orphan_result', name: 'shell', content: '{}' },
    { role: 'tool', phase: 'call', toolCallId: 'call_without_result', name: 'shell', args: { cmd: 'echo interrupted' }, content: '{}' },
    { role: 'user', content: 'continue' }
  ]);
  assert.deepEqual(reconstructed.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
  assert.equal(reconstructed[1].tool_calls[0].id, 'call_complete');
  assert.equal(reconstructed[2].tool_call_id, 'call_complete');
  assert.equal(reconstructed.some((m) => JSON.stringify(m).includes('call_without_result')), false);
  assert.equal(reconstructed.some((m) => m.role === 'assistant' && !String(m.content || '').trim() && !m.tool_calls), false);

  // Text emitted before a tool call is persisted as a separate assistant UI
  // segment. Replay must merge it back with tool_calls to preserve the exact
  // live request shape (and therefore the provider's cached prompt prefix).
  const mergedToolTurn = messages.reconstructUpstreamHistory([
    { role: 'user', content: 'inspect it' },
    { role: 'assistant', content: 'I will inspect the file.' },
    { role: 'tool', phase: 'call', toolCallId: 'call_merge', name: 'read_file', args: { path: 'a.js' } },
    { role: 'tool', phase: 'result', toolCallId: 'call_merge', name: 'read_file', content: '{"body":"ok"}' },
    { role: 'assistant', content: 'Done.' }
  ]);
  assert.deepEqual(mergedToolTurn.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(mergedToolTurn[1].content, 'I will inspect the file.');
  assert.equal(mergedToolTurn[1].tool_calls[0].function.name, 'read_file');

  const longId = 'tool_search_files_' + 'x'.repeat(40);
  const portable = messages.reconstructUpstreamHistory([
    { role: 'tool', phase: 'call', toolCallId: longId, name: 'search_files', args: { query: 'x' }, content: '{}' },
    { role: 'tool', phase: 'result', toolCallId: longId, name: 'search_files', content: '{"matches":[]}' },
    { role: 'tool', phase: 'call', toolCallId: 'duplicate', name: 'read_file', args: {}, content: '{}' },
    { role: 'tool', phase: 'result', toolCallId: 'duplicate', name: 'read_file', content: '{}' },
    { role: 'tool', phase: 'call', toolCallId: 'duplicate', name: 'read_file', args: {}, content: '{}' },
    { role: 'tool', phase: 'result', toolCallId: 'duplicate', name: 'read_file', content: '{}' }
  ]);
  assert.match(portable[0].tool_calls[0].id, /^call_history_/);
  assert.equal(portable[0].tool_calls[0].id, portable[1].tool_call_id);
  assert.notEqual(portable[2].tool_calls[0].id, portable[4].tool_calls[0].id);
  const withoutTools = messages.reconstructUpstreamHistory([
    { role: 'user', content: 'question' },
    { role: 'tool', phase: 'call', toolCallId: 'call_1', name: 'shell', args: {}, content: '{}' },
    { role: 'tool', phase: 'result', toolCallId: 'call_1', name: 'shell', content: '{}' },
    { role: 'assistant', content: 'answer' }
  ], null, { includeTools: false });
  assert.deepEqual(withoutTools.map((m) => m.role), ['user', 'assistant']);

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
  // Prompt caching marks the single combined system block with
  // cache_control. The system is sent as an array (a plain string would
  // silently drop the cache_control field).
  assert.deepEqual(anthropic.body.system, [
    {
      type: 'text',
      text: 'profile\n\ntagged file\n\ncustom prompt',
      cache_control: { type: 'ephemeral' }
    }
  ]);
  assert.equal(anthropic.headers['anthropic-beta'], undefined);
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  const gemini = ai.BUILDERS.gemini({ id: 'gemini-test', apiKey: 'x' }, [
    { role: 'system', content: 'profile' },
    { role: 'system', content: 'tagged file' },
    { role: 'system', content: 'custom prompt' },
    { role: 'user', content: 'question' }
  ], true);
  assert.equal(gemini.body.systemInstruction.parts[0].text, 'profile\n\ntagged file\n\ncustom prompt');

  console.log('chat trace: 20 assertions passed');
} finally {
  fs.rmSync(projectDir, { recursive: true, force: true });
}