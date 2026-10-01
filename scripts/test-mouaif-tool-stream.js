'use strict';

// Exercise the real model-facing dispatcher and authorization gate, without
// external providers or touching the running app's store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-stream-test-'));
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
process.env.MOUAIF_HOME = home;
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const authz = require('../src/tools/authorization.js');
const { streamChat } = require('../src/ai-stream.js');
const originalFetch = global.fetch;
let nextId = 0;

async function call(chat, args, { mode = 'allow', decision, advertised = mode !== 'off' } = {}) {
  authz.setAuthorization(projectDir, { tools: { mouaif: { mode } } });
  const id = 'mouaif-call-' + ++nextId;
  const events = [];
  let rounds = 0;
  let returned;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const spec = body.tools.find((tool) => tool.function.name === 'mouaif');
    assert.equal(!!spec, advertised, 'the advertised spec follows the effective authorization mode');
    if (spec) assert.ok(spec.function.parameters.properties.action.enum.includes(args.action));
    let delta;
    if (rounds++ === 0) {
      delta = { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'mouaif', arguments: JSON.stringify(args) } }] };
    } else {
      const row = body.messages.find((message) => message.role === 'tool' && message.name === 'mouaif');
      assert.ok(row, 'the next model turn receives the tool result');
      returned = JSON.parse(row.content);
      delta = { content: 'Done' };
    }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const streamed = await streamChat({
    model: { id: 'fixture-model', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir, chatId: chat.id, chat, promptSize: 'average',
    messages: [{ role: 'user', content: 'Run the requested mouaif action.' }],
    onEvent(type, payload) {
      events.push({ type, payload });
      if (type === 'authorization_required') {
        assert.equal(payload.tool, 'mouaif');
        assert.ok(decision, 'ask mode must have an explicit test decision');
        authz.recordDecision(projectDir, chat.id, payload.callId, decision);
      }
    }
  });
  assert.equal(streamed.ok, true);
  assert.equal(rounds, 2);
  const result = events.find((event) => event.type === 'tool_result');
  assert.ok(result, 'the UI receives a tool result card');
  return { ...result.payload, returned, events };
}

async function main() {
  const host = chats.createChat(projectDir, { title: 'Host' });
  let out = await call(host, { action: 'create', title: 'Created by tool', topic: 'Opening draft' });
  assert.equal(out.ok, true);
  const createdId = out.result.chat.id;
  assert.equal(chats.getChat(projectDir, createdId).draft, 'Opening draft');
  assert.equal(out.returned.chat.id, createdId);

  out = await call(host, { action: 'update', chatId: createdId, title: 'Renamed by tool' }, { mode: 'ask', decision: 'allow-once' });
  assert.equal(out.ok, true);
  assert.ok(out.events.some((event) => event.type === 'authorization_required'));
  assert.equal(chats.getChat(projectDir, createdId).title, 'Renamed by tool');

  out = await call(host, { action: 'update', chatId: createdId, title: 'Must not change' }, { mode: 'ask', decision: 'deny' });
  assert.equal(out.ok, false);
  assert.equal(chats.getChat(projectDir, createdId).title, 'Renamed by tool');

  out = await call(host, { action: 'update', chatId: createdId, title: 'Still must not change' }, { mode: 'off' });
  assert.equal(out.ok, false);
  assert.equal(out.result.code, 'ETOOL_DISABLED');
  assert.equal(chats.getChat(projectDir, createdId).title, 'Renamed by tool');

  chats.updateChat(projectDir, host.id, { toolAuth: { native: { mouaif: { mode: 'off' } } } });
  out = await call(chats.getChat(projectDir, host.id), { action: 'list' }, { advertised: false });
  assert.equal(out.ok, false, 'per-chat off overrides project allow');
  chats.updateChat(projectDir, host.id, { toolAuth: null });

  out = await call(host, { action: 'create', modelId: 'missing-model', providerId: 'ghost' });
  assert.equal(out.ok, false);
  assert.equal(out.returned.code, 'EBADINPUT', 'typed errors reach the next model turn');
  assert.equal(chats.countChats(projectDir), 2);

  settings.setProject(projectDir, { models: [{ id: 'private', provider: 'openai-compatible', apiKey: 'fixture-secret' }] });
  out = await call(host, { action: 'settings_get', scope: 'project' });
  assert.equal(out.ok, true);
  assert.equal(out.returned.settings.models[0].apiKey, undefined);
  assert.equal(out.returned.settings.models[0].hasApiKey, true);
  assert.ok(!JSON.stringify(out).includes('fixture-secret'));

  fs.writeFileSync(path.join(projectDir, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGvCAAxBgMBAJ2DqQAAAAAASUVORK5CYII=', 'base64'));
  out = await call(host, { action: 'attach', path: 'shot.png' });
  assert.equal(out.ok, true);
  assert.equal(chats.getChat(projectDir, host.id).draftAttachments.length, 1);
  assert.equal(messages.getMessageCount(projectDir, host.id), 0, 'draft attachment does not start a turn');
  assert.ok(!JSON.stringify(out).includes('data:image'), 'image bytes never enter the textual tool result');

  out = await call(host, { action: 'delete', chatId: createdId });
  assert.equal(out.ok, false);
  assert.equal(out.returned.code, 'ECONFIRM');
  assert.ok(chats.getChat(projectDir, createdId));
  out = await call(host, { action: 'delete', chatId: createdId, confirm: true });
  assert.equal(out.ok, true);
  assert.equal(chats.getChat(projectDir, createdId), null);
  console.log('mouaif tool stream: dispatch, result cards, authorization, errors, redaction, attachments, and deletion passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  settings.close();
  fs.rmSync(home, { recursive: true, force: true });
});
