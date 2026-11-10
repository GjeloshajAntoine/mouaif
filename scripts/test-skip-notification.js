'use strict';
// skip_notification: a recurring task's run that found nothing relevant finishes
// without a completion push. Only the model (global fetch / shared.ai.streamChat)
// and the push sender are faked.
//   1. ai-stream offers the tool only in a scheduled run, past the chat's tool
//      filter, and answers it without an approval card.
//   2. The chat runner leaves the completion push out for a run that called it,
//      and still sends it for a run that did not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skip-notification-'));
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
process.env.MOUAIF_HOME = path.join(home, 'store');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const shared = require('../src/server-shared.js');
const schedules = require('../src/schedules.js');
const runs = require('../src/runs.js');
const push = require('../src/push.js');
const aiStream = require('../src/ai-stream.js');

const keepAlive = setInterval(() => {}, 1000);
const originalFetch = global.fetch;
const originalStream = shared.ai.streamChat;
const originalPushAll = push.sendPushToAll;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const lifecycle = {};
const stream = (delta) => new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

async function turn(chatId, extra, firstRound) {
  const events = [];
  const advertised = [];
  let rounds = 0;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    advertised.push((request.tools || []).map((tool) => tool.function.name));
    if (rounds++ === 0 && firstRound) return stream(firstRound);
    return stream({ content: 'Nothing new.' });
  };
  const out = await aiStream.streamChat(Object.assign({
    model: { id: 'gamma', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir, chatId, promptSize: 'average', messages: [{ role: 'user', content: 'Check the alerts' }],
    onEvent: (type, payload) => events.push({ type, payload }), lifecycle
  }, extra));
  return { out, events, advertised };
}

const skipCall = { tool_calls: [{ index: 0, id: 'q1', type: 'function', function: { name: 'skip_notification', arguments: JSON.stringify({ reason: 'no new alerts' }) } }] };

async function main() {
  settings.setApp({ providers: [{ id: 'openai-compatible', apiKey: 'k', baseUrl: 'http://fixture/v1' }] });
  // Every tool asks for approval, so a missing approval card proves the bypass.
  settings.setProject(projectDir, { models: [{ id: 'gamma', provider: 'openai-compatible', label: 'Gamma' }], tools: { mouaif: { mode: 'allow' }, chats: { mode: 'ask' }, shell: { mode: 'ask' } } });
  const chat = chats.createChat(projectDir, { title: 'Alerts' });
  chats.updateChat(projectDir, chat.id, { modelId: 'gamma', providerId: 'openai-compatible' });

  // ---- 1. The tool surface ------------------------------------------------------------------------
  let r = await turn(chat.id, { scheduledRun: true, enabledTools: ['shell'] }, skipCall);
  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  assert.ok(r.advertised[0].includes('skip_notification'), 'a scheduled run is offered the tool, past the chat’s tool filter');
  const result = r.events.find((e) => e.type === 'tool_result' && e.payload.name === 'skip_notification');
  assert.ok(result, 'the call is answered');
  assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.result, { ok: true, notification: 'skipped', reason: 'no new alerts' });
  assert.equal(r.events.some((e) => e.type === 'authorization_required'), false, 'no approval card, which would itself notify');

  r = await turn(chat.id, {}, skipCall);
  assert.equal(r.advertised[0].includes('skip_notification'), false, 'an ordinary turn is not offered the tool');
  const forged = r.events.find((e) => e.type === 'tool_result' && e.payload.name === 'skip_notification');
  assert.ok(!forged || forged.payload.ok === false, 'an ordinary turn cannot run it');

  // ---- 2. The completion push ---------------------------------------------------------------------
  const pushes = [];
  push.sendPushToAll = (options) => pushes.push(options);
  const manager = runs.sharedManager(lifecycle);
  const store = schedules.sharedStore();
  const scheduled = await require('../src/tools/schedule.js').runScheduleTool('schedule_wake',
    { message: 'Check the alerts; skip the notification if there are none', in: '1m', every: '1h' }, { projectDir, chatId: chat.id });
  assert.equal(scheduled.ok, true, JSON.stringify(scheduled.result));
  const scheduler = schedules.createScheduler({
    store,
    startTurn: (body, life) => require('../src/server-handlers-chats.js').startChatTurn(body, life),
    getChat: (dir, id) => chats.getChat(dir, id),
    getJob: () => ({ state: 'running' }),
    lifecycle,
    hooks: { gate: (dir, id) => manager.gate(dir, id), delivered: (dir, id, gate) => manager.delivered(dir, id, gate), onTick: () => manager.watch() }
  });
  const seen = [];
  let quiet = true;
  shared.ai.streamChat = async (args) => {
    seen.push(args);
    if (quiet) {
      args.onEvent('tool_call', { id: 'q1', name: 'skip_notification', args: {} });
      args.onEvent('tool_result', { id: 'q1', name: 'skip_notification', ok: true, result: { ok: true, notification: 'skipped' } });
    }
    args.onEvent('message', { delta: quiet ? 'No new alerts.' : 'Two new P1 alerts.' });
    args.onEvent('done', { usage: {} });
    return { ok: true };
  };
  const runOnce = async () => {
    store.lease(scheduled.result.id, Date.now() - 1000);
    await scheduler.tick();
    for (let i = 0; i < 200 && shared.runningChats.has(shared.runningKey(projectDir, chat.id)); i++) await tick();
  };
  await runOnce();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scheduledRun, true, 'the chat runner marks a recurring task’s turn');
  assert.equal(pushes.length, 0, 'a run that skipped its notification sends none');
  quiet = false;
  await runOnce();
  assert.equal(seen.length, 2);
  assert.equal(pushes.length, 1, 'the next run, which did not skip, notifies');
  assert.equal(pushes[0].body, 'Two new P1 alerts.');
  assert.equal(pushes[0].data.kind, 'completion');

  // A one-off wake in the same chat is not a run of the recurring task.
  const once = await require('../src/tools/schedule.js').runScheduleTool('schedule_wake',
    { message: 'Check the deploy', in: '1m' }, { projectDir, chatId: chat.id });
  assert.equal(once.ok, true, JSON.stringify(once.result));
  store.lease(once.result.id, Date.now() - 1000);
  await scheduler.tick();
  for (let i = 0; i < 200 && shared.runningChats.has(shared.runningKey(projectDir, chat.id)); i++) await tick();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].scheduledRun, false, 'a one-off wake is not offered the tool');

  console.log('skip_notification: offered only in scheduled runs, answered without approval, and drops only that run’s completion push');
}

main().then(() => 0, (e) => { console.error(e); return 1; }).then((code) => {
  global.fetch = originalFetch;
  shared.ai.streamChat = originalStream;
  push.sendPushToAll = originalPushAll;
  clearInterval(keepAlive);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
});
