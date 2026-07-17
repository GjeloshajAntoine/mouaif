'use strict';

// Regression test: a model selected from a live provider catalog is not
// necessarily present in the project's optional models array. The server must
// hydrate it from the explicitly selected provider connection rather than
// silently taking the first configured provider.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-live-model-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const server = require('../src/index.js');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, '.mouaif.json'), JSON.stringify({ models: [] }, null, 2));

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

try {
  server.settings.setApp({
    providers: [
      { id: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-openai-stale', auth: 'apikey' },
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', auth: 'apikey' }
    ]
  });

  const live = server.resolveModel('anthropic/claude-sonnet-4', projectDir, 'openrouter');
  check('live model keeps explicit OpenRouter provider', live.provider === 'openrouter', JSON.stringify(live));
  check('live model uses OpenRouter base URL', live.baseUrl === 'https://openrouter.ai/api/v1', live.baseUrl);
  check('live model uses OpenRouter credential', live.apiKey === 'sk-or-test');
  check('live model keeps upstream slug', live.id === 'anthropic/claude-sonnet-4', live.id);

  let missing = null;
  try { server.resolveModel('anthropic/claude-sonnet-4', projectDir); }
  catch (err) { missing = err; }
  check('live model without provider remains rejected', missing && missing.code === 'EMODEL_NOT_FOUND', missing && missing.code);

  let unknown = null;
  try { server.resolveModel('model-x', projectDir, 'unknown-provider'); }
  catch (err) { unknown = err; }
  check('unknown provider remains rejected', unknown && unknown.code === 'EMODEL_NOT_FOUND', unknown && unknown.code);

  const chat = server.chats.createChat(projectDir, { title: 'Live model chat' });
  const updated = server.chats.updateChat(projectDir, chat.id, {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4'
  });
  check('chat persists selected provider', updated && updated.providerId === 'openrouter', JSON.stringify(updated));
  check('chat persists selected live model', updated && updated.modelId === 'anthropic/claude-sonnet-4', JSON.stringify(updated));
  const reopened = server.chats.getChat(projectDir, chat.id);
  check('chat restores provider/model pair', reopened && reopened.providerId === 'openrouter' && reopened.modelId === 'anthropic/claude-sonnet-4', JSON.stringify(reopened));
} finally {
  server.settings.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('---');
console.log('passed: ' + passed);
console.log('failed: ' + failed);
if (failed) process.exit(1);
