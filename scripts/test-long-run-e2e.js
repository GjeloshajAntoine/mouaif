'use strict';
// A long-running chat end to end, with no real provider: the model opens a run
// and schedules a wake through the real tool dispatcher, the real scheduler
// delivers it through the real chat runner, and the user's REST controls pause
// and stop it. Only the model (global fetch / shared.ai.streamChat) is faked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-long-run-'));
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
process.env.MOUAIF_HOME = path.join(home, 'store');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const shared = require('../src/server-shared.js');
const schedules = require('../src/schedules.js');
const runs = require('../src/runs.js');
const { handleChats } = require('../src/server-handlers-chats.js');
const aiStream = require('../src/ai-stream.js');

const keepAlive = setInterval(() => {}, 1000);
const originalFetch = global.fetch;
const originalStream = shared.ai.streamChat;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const lifecycle = {};

async function http(method, url, body) {
  const [pathname, query] = url.split('?');
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = { method, on(name, callback) {
    if (name === 'data' && payload) process.nextTick(() => callback(payload));
    if (name === 'end') process.nextTick(callback);
  }, headers: {}, url };
  const res = { status: 0, data: '', writeHead(status) { this.status = status; }, setHeader() {}, write(chunk) { this.data += chunk; }, end(chunk) { this.data += chunk || ''; } };
  await handleChats(req, res, { pathname, query: Object.fromEntries(new URLSearchParams(query || '')) }, null, lifecycle);
  return { status: res.status, body: res.data ? JSON.parse(res.data) : null };
}

async function main() {
  settings.setApp({ providers: [{ id: 'openai-compatible', apiKey: 'k', baseUrl: 'http://fixture/v1' }] });
  settings.setProject(projectDir, { models: [{ id: 'gamma', provider: 'openai-compatible', label: 'Gamma' }], tools: { mouaif: { mode: 'allow' } } });
  const chat = chats.createChat(projectDir, { title: 'Nightly migration' });
  chats.updateChat(projectDir, chat.id, { modelId: 'gamma', providerId: 'openai-compatible' });
  const chatId = chat.id;
  const stream = (calls) => new Response('data: ' + JSON.stringify({ choices: [{ delta: calls }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

  // ---- 1. A run exists (agents cannot open one) and the model schedules its own wake -----------------
  const manager = runs.sharedManager(lifecycle);
  const opened = manager.start({ projectDir, chatId }, { goal: 'Migrate all docs to the new layout', maxTurns: 2, maxHours: 4 });
  assert.equal(opened.status, 'running');
  const events = [];
  let rounds = 0;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const names = request.tools.map((tool) => tool.function.name);
    for (const name of ['schedule_wake', 'schedule_list', 'schedule_cancel']) {
      assert.ok(names.includes(name), name + ' is advertised to the model');
    }
    for (const name of ['run_start', 'run_status', 'run_end', 'wait_for', 'job_status', 'job_cancel']) {
      assert.ok(!names.includes(name), name + ' is not an agent tool');
    }
    if (rounds++ === 0) {
      return stream({ tool_calls: [
        { index: 0, id: 'c2', type: 'function', function: { name: 'schedule_wake', arguments: JSON.stringify({ in: '30m', message: 'Check the migration job and continue.' }) } },
        { index: 1, id: 'c3', type: 'function', function: { name: 'schedule_list', arguments: '{}' } }
      ] });
    }
    return stream({ content: 'Scheduled; I will check back in 30 minutes.' });
  };
  const turn = await aiStream.streamChat({
    model: { id: 'gamma', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir, chatId, promptSize: 'average', messages: [{ role: 'user', content: 'Start the migration' }],
    onEvent: (type, payload) => events.push({ type, payload }), lifecycle
  });
  assert.equal(turn.ok, true);
  const result = (name) => events.find((event) => event.type === 'tool_result' && event.payload.name === name);
  assert.equal(result('schedule_wake').payload.ok, true, JSON.stringify(result('schedule_wake').payload));
  assert.equal(result('schedule_list').payload.result.count, 1);

  const scheduleStore = schedules.sharedStore();
  assert.equal(manager.get(projectDir, chatId).goal, 'Migrate all docs to the new layout');
  const [pending] = scheduleStore.list(projectDir, chatId);
  assert.equal(pending.message, 'Check the migration job and continue.');

  // ---- 2. The user's REST controls ------------------------------------------------------------------
  let r = await http('GET', '/api/chats/' + chatId + '/run?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(r.status, 200);
  assert.equal(r.body.run.status, 'running');
  assert.equal(r.body.run.turnsLeft, 2);
  assert.equal((await http('GET', '/api/chats/nope/run?projectDir=' + encodeURIComponent(projectDir))).status, 404);
  assert.equal((await http('GET', '/api/chats/' + chatId + '/run')).status, 400);
  assert.equal((await http('POST', '/api/chats/' + chatId + '/run', { projectDir, action: 'explode' })).status, 400);
  assert.equal((await http('POST', '/api/chats/' + chatId + '/run', { action: 'pause' })).status, 400);
  r = await http('POST', '/api/chats/' + chatId + '/run', { projectDir, action: 'pause' });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.status, 'paused');
  assert.equal((await http('POST', '/api/chats/' + chatId + '/run', { projectDir, action: 'pause' })).status, 409, 'cannot pause a paused run');

  // ---- 3. The scheduler delivers wakes through the real chat runner ------------------------------------
  const seen = [];
  shared.ai.streamChat = async (args) => {
    seen.push(args);
    args.onEvent('message', { delta: 'Checked.' });
    args.onEvent('done', { usage: {} });
    return { ok: true };
  };
  const scheduler = schedules.createScheduler({
    store: scheduleStore,
    startTurn: (body, life) => require('../src/server-handlers-chats.js').startChatTurn(body, life),
    getChat: (dir, id) => chats.getChat(dir, id),
    getJob: () => ({ state: 'running' }),
    lifecycle,
    hooks: { gate: (dir, id) => manager.gate(dir, id), delivered: (dir, id, gate) => manager.delivered(dir, id, gate), onTick: () => manager.watch() }
  });
  const waitIdle = async () => { for (let i = 0; i < 200 && shared.runningChats.has(shared.runningKey(projectDir, chatId)); i++) await tick(); };
  scheduleStore.lease(pending.id, Date.now() - 1000); // the 30 minutes have passed
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['held'], 'a paused run holds its wake');
  assert.equal(seen.length, 0);
  r = await http('POST', '/api/chats/' + chatId + '/run', { projectDir, action: 'resume' });
  assert.equal(r.body.run.status, 'running');
  scheduleStore.lease(pending.id, Date.now() - 1000);
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['done']);
  await waitIdle();
  assert.equal(seen.length, 1, 'the wake ran a real turn');
  const transcript = messages.listMessages(projectDir, chatId);
  const wakeMessage = transcript.filter((m) => m.role === 'user').at(-1);
  assert.match(wakeMessage.content, /Scheduled wake-up/);
  assert.match(wakeMessage.content, /Check the migration job and continue\./);
  assert.equal(transcript.at(-1).role, 'assistant');
  assert.equal(transcript.at(-1).content, 'Checked.');
  assert.equal(manager.view(manager.get(projectDir, chatId)).turnsUsed, 1);

  // ---- 4. The budget ends the run with a wrap-up turn ----------------------------------------------------------
  const second = await require('../src/tools/schedule.js').runScheduleTool('schedule_wake', { in: '1h', message: 'Keep going.' }, { projectDir, chatId });
  assert.equal(second.ok, true);
  scheduleStore.lease(second.result.id, Date.now() - 1000);
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['done']);
  await waitIdle();
  assert.equal(manager.view(manager.get(projectDir, chatId)).turnsLeft, 0);
  const third = await require('../src/tools/schedule.js').runScheduleTool('schedule_wake', { in: '1h', message: 'Over budget.' }, { projectDir, chatId });
  scheduleStore.lease(third.result.id, Date.now() - 1000);
  await scheduler.tick();
  await waitIdle();
  const last = messages.listMessages(projectDir, chatId).filter((m) => m.role === 'user').at(-1);
  assert.match(last.content, /Run budget reached/);
  assert.equal(manager.get(projectDir, chatId).status, 'exhausted');
  r = await http('GET', '/api/chats/' + chatId + '/run?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(r.body.run.status, 'exhausted');
  assert.match(r.body.run.endReason, /turn budget/);
  assert.equal(manager.view(manager.get(projectDir, chatId)).status, 'exhausted');

  // ---- 5. Stop aborts a streaming turn ------------------------------------------------------------------------------
  const fresh = manager.start({ projectDir, chatId }, { goal: 'Second goal' });
  assert.equal(fresh.status, 'running');
  let release;
  shared.ai.streamChat = (args) => new Promise((resolve) => {
    release = () => resolve({ ok: false, error: { code: 'ECANCEL', message: 'cancelled' } });
    args.signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'ECANCEL', message: 'cancelled' } }), { once: true });
  });
  const started = await require('../src/server-handlers-chats.js').startChatTurn({ projectDir, chatId, modelId: 'gamma', providerId: 'openai-compatible', content: 'long turn' }, lifecycle);
  assert.equal(started.ok, true);
  assert.equal(shared.runningChats.has(shared.runningKey(projectDir, chatId)), true);
  r = await http('POST', '/api/chats/' + chatId + '/run', { projectDir, action: 'stop' });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.status, 'stopped');
  assert.equal(r.body.run.turnCancelled, true);
  await waitIdle();
  assert.equal(shared.runningChats.has(shared.runningKey(projectDir, chatId)), false, 'the streaming turn was aborted');
  if (release) release();

  // ---- 6. A recurring task runs in the same chat and keeps its attachments -------------------------------------
  const task = chats.createChat(projectDir, { title: 'Morning report' });
  chats.updateChat(projectDir, task.id, { modelId: 'gamma', providerId: 'openai-compatible' });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  messages.appendMessage(projectDir, task.id, { role: 'user', content: 'Use this logo in the report', attachments: [{ type: 'image', mimeType: 'image/png', dataUrl: png, name: 'logo.png' }] });
  messages.appendMessage(projectDir, task.id, { role: 'assistant', content: 'Understood, I will use it every morning.' });
  const recurring = await require('../src/tools/schedule.js').runScheduleTool('schedule_wake',
    { message: 'Write the morning report and save it as report.md', in: '1m', every: '1h' }, { projectDir, chatId: task.id });
  assert.equal(recurring.ok, true, JSON.stringify(recurring.result));
  r = await http('GET', '/api/chats/' + task.id + '/run?projectDir=' + encodeURIComponent(projectDir));
  assert.deepEqual([r.body.run.kind, r.body.run.status, r.body.run.schedule.text], ['recurring', 'running', 'Every hour']);
  seen.length = 0;
  shared.ai.streamChat = async (args) => {
    seen.push(args);
    args.onEvent('message', { delta: 'Report written.' });
    args.onEvent('done', { usage: {} });
    return { ok: true };
  };
  const waitTask = async () => { for (let i = 0; i < 200 && shared.runningChats.has(shared.runningKey(projectDir, task.id)); i++) await tick(); };
  for (let run = 1; run <= 2; run++) {
    scheduleStore.lease(recurring.result.id, Date.now() - 1000);
    assert.deepEqual((await scheduler.tick()).filter((o) => o.id === recurring.result.id).map((o) => o.outcome), ['pending'], 'run ' + run + ' is re-armed');
    await waitTask();
  }
  assert.equal(seen.length, 2);
  const taskUsers = messages.listMessages(projectDir, task.id).filter((m) => m.role === 'user');
  assert.equal(taskUsers.length, 3, 'every run is a message in the one chat');
  assert.deepEqual(taskUsers.slice(1).map((m) => m.content), ['Write the morning report and save it as report.md', 'Write the morning report and save it as report.md'], 'each run starts with only the prompt');
  const images = (args) => args.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []);
  assert.deepEqual(images(seen[1]), [png], 'the attachment is still sent with the second run');
  assert.ok(seen[1].messages.some((m) => typeof m.content === 'string' && m.content.includes('Report written.')), 'and so is what the first run produced');
  assert.equal(manager.view(manager.get(projectDir, task.id)).turnsUsed, 2);
  // Every run stays in the chat, is marked as a scheduled run and can be listed.
  const taskMessages = messages.listMessages(projectDir, task.id);
  const scheduled = taskMessages.filter((m) => m.origin);
  assert.deepEqual(scheduled.map((m) => [m.origin.kind, m.origin.run, m.origin.scheduleId]), [['schedule', 1, recurring.result.id], ['schedule', 2, recurring.result.id]]);
  assert.equal(taskMessages.filter((m) => m.role === 'user' && !m.origin).length, 1, 'a typed message has no origin');
  r = await http('GET', '/api/chats/' + task.id + '/runs?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.runs.map((x) => [x.seq, x.run]), scheduled.map((m) => [m.seq, m.origin.run]));
  assert.ok(r.body.runs.every((x) => typeof x.ts === 'string' && x.scheduleId === recurring.result.id));
  assert.equal(taskMessages.length > 5, true, 'nothing was dropped: both runs and their replies are still there');
  assert.equal((await http('GET', '/api/chats/nope/runs?projectDir=' + encodeURIComponent(projectDir))).status, 404);
  assert.equal((await http('GET', '/api/chats/' + task.id + '/runs')).status, 400);
  r = await http('GET', '/api/chats/' + task.id + '/run?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(r.body.scheduledRuns, 2);
  // A user cannot mark a message as a scheduled run through the HTTP route.
  const forged = messages.appendMessage(projectDir, task.id, { role: 'user', content: 'forged', origin: { kind: 'other', run: 1, scheduleId: 'x' } });
  assert.equal(forged.origin, undefined, 'only a schedule origin is kept');
  messages.replaceMessages(projectDir, task.id, taskMessages);
  assert.equal(messages.listMessages(projectDir, task.id).filter((m) => m.origin).length, 2, 'the marker survives a rewrite of the transcript');
  r = await http('POST', '/api/chats/' + task.id + '/run', { projectDir, action: 'stop' });
  assert.equal(r.body.run.schedulesCancelled, 1);
  assert.equal(scheduleStore.recurring(projectDir, task.id), null);

  console.log('long run e2e: wake scheduled through the dispatcher, wake through the chat runner, REST pause/resume/stop, budget wrap-up and a recurring task passed');
}

main().then(() => 0, (e) => { console.error(e); return 1; }).then((code) => {
  global.fetch = originalFetch;
  shared.ai.streamChat = originalStream;
  clearInterval(keepAlive);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
});
