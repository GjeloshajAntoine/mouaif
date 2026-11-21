'use strict';
// The app event stream (src/app-events.js, docs/features/live-events.md):
// every store write tells open pages, with no handler involved, and a share
// caller only hears about its own project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-app-events-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const appEvents = require('../src/app-events.js');
const shared = require('../src/server-shared.js');
const authz = require('../src/tools/authorization.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function client(filter) {
  const frames = [];
  let onClose = null;
  const req = { on(event, cb) { if (event === 'close') onClose = cb; } };
  const res = { writeHead() {}, write(chunk) { frames.push(String(chunk)); } };
  appEvents.handleSSE(req, res, filter);
  return {
    events() {
      return frames.filter((f) => f.startsWith('event: ')).map((f) => {
        const [head, body] = f.split('\n');
        return { event: head.slice(7), data: JSON.parse(body.slice(6)) };
      });
    },
    clear() { frames.length = 0; },
    close() { onClose(); }
  };
}

async function main() {
  const projectDir = path.join(tmp, 'project');
  const otherDir = path.join(tmp, 'other');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(otherDir);
  settings.setProject(projectDir, {});
  settings.setProject(otherDir, {});
  const chat = chats.createChat(projectDir, {});
  const other = chats.createChat(otherDir, {});
  const page = client();
  const caller = client((event, data) => appEvents.PROJECT_EVENTS.has(event) && data.projectDir === projectDir);

  // A row written straight to the store (a background subagent's late result
  // has no handler and no stream) reaches the page.
  messages.appendMessage(projectDir, chat.id, { role: 'user', content: 'hi' });
  messages.appendMessage(projectDir, chat.id, { role: 'assistant', content: 'one' });
  messages.appendMessage(otherDir, other.id, { role: 'user', content: 'elsewhere' });
  await flush();
  let rows = page.events().filter((e) => e.event === 'chat_rows');
  assert.deepEqual(rows.find((e) => e.data.chatId === chat.id).data, { projectDir, chatId: chat.id, nextSeq: 2 });
  assert.equal(rows.filter((e) => e.data.chatId === chat.id).length, 1, 'writes in one tick coalesce into one notice');
  assert.equal(rows.length, 2);
  assert.deepEqual(caller.events().map((e) => e.data.chatId), [chat.id], 'a share caller hears only its project');
  console.log('PASS appendMessage sends one coalesced chat_rows per chat');

  page.clear();
  messages.replaceMessages(projectDir, chat.id, [{ role: 'user', content: 'only' }]);
  await flush();
  assert.deepEqual(page.events().map((e) => [e.event, e.data.nextSeq]), [['chat_rows', 1]]);
  page.clear();
  messages.clearMessages(projectDir, chat.id);
  await flush();
  assert.deepEqual(page.events().map((e) => [e.event, e.data.nextSeq]), [['chat_rows', 0]]);
  console.log('PASS replace and clear send chat_rows with the lower cursor');

  // A background subagent that bills after its turn ended writes no row: the
  // page must still hear that the saved Total moved.
  page.clear();
  caller.clear();
  messages.addChatCost(projectDir, chat.id, 0.01);
  messages.addChatCost(projectDir, chat.id, 0.02);
  messages.addChatCost(otherDir, other.id, 0.03);
  await flush();
  const costs = page.events().filter((e) => e.event === 'chat_cost');
  assert.deepEqual(costs.filter((e) => e.data.chatId === chat.id).map((e) => e.data), [{ projectDir, chatId: chat.id }], 'cost writes in one tick coalesce');
  assert.equal(costs.length, 2);
  assert.deepEqual(caller.events().filter((e) => e.event === 'chat_cost').map((e) => e.data.chatId), [chat.id], 'a share caller hears only its project');
  assert.equal(page.events().filter((e) => e.event === 'chat_rows').length, 0, 'no rows were written');
  console.log('PASS addChatCost sends one coalesced chat_cost per chat');

  // A run's start and end; the end comes after the rows written just before.
  page.clear();
  const key = shared.runningKey(projectDir, chat.id);
  shared.runningChats.add(key);
  shared.runningChats.add(key);
  messages.appendMessage(projectDir, chat.id, { role: 'assistant', content: 'last' });
  shared.runningChats.delete(key);
  shared.runningChats.delete(key);
  await flush();
  assert.deepEqual(page.events().map((e) => e.event + ':' + (e.event === 'chat_run' ? e.data.running : e.data.nextSeq)),
    ['chat_run:true', 'chat_rows:1', 'chat_run:false']);
  assert.equal(shared.runningChats.has(key), false);
  console.log('PASS chat_run on start and end, after the last rows');

  // A parked approval and its decision.
  page.clear();
  settings.setProject(projectDir, { tools: { shell: { mode: 'ask' } } });
  const result = await authz.authorize({ projectDir, chatId: chat.id, tool: 'shell', callId: 'call-1', cmd: 'ls' });
  assert.equal(result.decision, 'prompt');
  result.wait.catch(() => {});
  authz.recordDecision(projectDir, chat.id, 'call-1', 'allow-once');
  await flush();
  assert.deepEqual(page.events().filter((e) => e.event === 'auth_pending').map((e) => e.data),
    [{ projectDir, chatId: chat.id, callId: 'call-1', open: true }, { projectDir, chatId: chat.id, callId: 'call-1', open: false }]);
  console.log('PASS auth_pending on park and decision');

  // Project and app notices.
  page.clear();
  caller.clear();
  const projectHooks = require('../src/projectHooks.js');
  projectHooks.setTrust(projectDir, 'h1');
  projectHooks.setTrust(projectDir, 'h2', 'ext:demo');
  projectHooks.revoke(projectDir, 'ext:demo');
  require('../src/app-context.js').set({ projectDir, chatId: chat.id, extensionId: 'x', surfaceId: 'v', title: 'View' }, { content: [{ type: 'text', text: 'ctx' }] });
  require('../src/share-store.js').updatePeer('nobody', { lastSeen: 'now' });
  require('../src/share-store.js').updatePeer('nobody', { machine: 'm' });
  await flush();
  assert.deepEqual(page.events().map((e) => e.event + ':' + e.data.what + (e.data.chatId ? ':' + e.data.chatId : '')),
    ['project_changed:hooks', 'project_changed:extensions', 'project_changed:app_context:' + chat.id, 'app_changed:share']);
  assert.deepEqual(caller.events().map((e) => e.event + ':' + e.data.what), ['project_changed:hooks', 'project_changed:extensions', 'project_changed:app_context'],
    'a share caller gets its project\'s notices and no app-wide ones');
  console.log('PASS hooks, extensions, app context and share writes send their notices');

  page.clear();
  require('../src/runs.js').createRunStore().start({ projectDir, chatId: chat.id, goal: 'g', maxTurns: 3, deadlineAt: Date.now() + 60000 });
  require('../src/webhooks.js').createWebhookStore().upsert({ projectDir, chatId: chat.id, prompt: 'p', method: 'POST' });
  require('../src/chatHooks.js').removeChat(projectDir, chat.id);
  await flush();
  assert.deepEqual(page.events().map((e) => e.data.what + ':' + e.data.chatId), ['run:' + chat.id, 'webhook:' + chat.id, 'chat_hooks:' + chat.id]);
  console.log('PASS run, webhook and chat hook writes send their notices');

  page.close();
  caller.close();
  assert.equal(appEvents.clients.size, 0);
  page.clear();
  messages.appendMessage(projectDir, chat.id, { role: 'user', content: 'nobody listening' });
  await flush();
  assert.equal(page.events().length, 0);
  console.log('PASS a closed client gets nothing');
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('app events tests passed');
  process.exit(0);
}, (e) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
