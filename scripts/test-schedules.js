'use strict';
// schedule_wake / schedule_list / schedule_cancel and the ticker that delivers
// wakes, against a real SQLite store with a fake clock and a fake chat runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-schedules-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const settings = require('../src/settings.js');
const schedules = require('../src/schedules.js');
const tool = require('../src/tools/schedule.js');
const { createRegistry } = require('../src/tools/backgroundJobs.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let clock = Date.parse('2026-10-26T12:00:00Z');
const now = () => clock;
const chats = { 'chat-a': { modelId: 'm1', providerId: 'p1' }, 'chat-b': { modelId: 'm1' }, 'chat-nomodel': {} };
const getChat = (projectDir, chatId) => chats[chatId] || null;
const jobs = createRegistry({ now });
const store = schedules.createScheduleStore({ getDb: settings.getDb, now });
const runners = tool.createRunners({ store, now, getChat, checkJob: (scope, id) => jobs.get(scope, id) });
const projectDir = root;
const ctx = (chatId = 'chat-a', extra = {}) => ({ projectDir, chatId, ...extra });
const run = (name, args, opts) => tool.runScheduleTool(name, args, opts || ctx(), runners);

async function main() {
  // ---- durations -----------------------------------------------------------
  assert.equal(schedules.parseDuration('90s'), 90_000);
  assert.equal(schedules.parseDuration('15m'), 15 * MIN);
  assert.equal(schedules.parseDuration('1h30m'), 90 * MIN);
  assert.equal(schedules.parseDuration('2d'), 48 * HOUR);
  assert.equal(schedules.parseDuration(45), 45_000);
  for (const bad of ['', 'soon', '10', '-5m', '5x', '1h 30', '0s', null, {}]) {
    if (bad === '10') { assert.equal(schedules.parseDuration(bad), 10_000, 'a bare number is seconds'); continue; }
    assert.throws(() => schedules.parseDuration(bad), { code: 'EBADINPUT' }, String(bad));
  }

  // ---- specs and validation --------------------------------------------------
  assert.deepEqual([...tool.NAMES], ['schedule_wake', 'schedule_list', 'schedule_cancel']);
  for (const name of tool.NAMES) assert.equal(tool.SPECS[name].function.parameters.additionalProperties, false);
  const bad = async (args, code, opts) => assert.equal((await run('schedule_wake', args, opts)).result.code, code, JSON.stringify(args));
  await bad({}, 'EBADINPUT');
  await bad({ message: 'x' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', at: '2026-10-27T00:00:00Z' }, 'EBADINPUT');
  await bad({ message: '  ', in: '5m' }, 'EBADINPUT');
  await bad({ message: 'x'.repeat(2001), in: '5m' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5s' }, 'EBADINPUT');
  await bad({ message: 'x', in: '31d' }, 'EBADINPUT');
  await bad({ message: 'x', at: 'tomorrow' }, 'EBADINPUT');
  await bad({ message: 'x', at: '2020-01-01T00:00:00Z' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', every: '30s' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', maxRuns: 3 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', every: '5m', maxRuns: 101 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', bogus: 1 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m' }, 'EBADINPUT', { projectDir });
  await bad({ message: 'x', in: '5m' }, 'EBADINPUT', ctx('chat-nomodel'));
  await bad({ message: 'x', in: '5m' }, 'ENOTARGET', ctx('chat-gone'));
  await bad({ message: 'x', in: '5m', jobId: 'job-nope' }, 'ENOTARGET');

  // ---- create / list / cancel ---------------------------------------------------
  const once = await run('schedule_wake', { message: 'check the build', in: '2h' });
  assert.ok(once.ok, JSON.stringify(once.result));
  assert.equal(once.result.dueInSeconds, 7200);
  assert.equal(once.result.runsLeft, 1);
  assert.equal(once.result.dueAt, new Date(clock + 2 * HOUR).toISOString());
  const byTime = await run('schedule_wake', { message: 'at a time', at: new Date(clock + 3 * HOUR).toISOString() });
  assert.equal(byTime.result.dueInSeconds, 10800);
  const repeating = await run('schedule_wake', { message: 'poll', in: '10m', every: '15m', maxRuns: 2 });
  assert.equal(repeating.result.runsLeft, 2);
  assert.equal(repeating.result.every, '900s');
  const listed = await run('schedule_list', {});
  assert.equal(listed.result.count, 3);
  assert.deepEqual(listed.result.schedules.map((s) => s.message), ['poll', 'check the build', 'at a time'], 'ordered by due time');
  assert.deepEqual((await run('schedule_list', {}, ctx('chat-b'))).result.schedules, [], 'another chat sees nothing');
  assert.equal((await run('schedule_cancel', { id: once.result.id }, ctx('chat-b'))).result.code, 'ENOTARGET', 'another chat cannot cancel it');
  const cancelled = await run('schedule_cancel', { id: byTime.result.id });
  assert.equal(cancelled.result.cancelled, true);
  const again = await run('schedule_cancel', { id: byTime.result.id });
  assert.equal(again.result.cancelled, false);
  assert.equal(again.result.status, 'cancelled');
  assert.equal((await run('schedule_cancel', { id: 'wake-nope' })).result.code, 'ENOTARGET');
  assert.equal((await run('schedule_list', {})).result.count, 2);

  // The per-chat cap.
  for (let i = 0; i < schedules.MAX_PENDING_PER_CHAT - 2; i++) assert.ok((await run('schedule_wake', { message: 'fill ' + i, in: '20h' }, ctx('chat-b'))).ok || true);
  const capChat = ctx('capped');
  chats.capped = { modelId: 'm' };
  for (let i = 0; i < schedules.MAX_PENDING_PER_CHAT; i++) assert.ok((await run('schedule_wake', { message: 'n' + i, in: '1h' }, capChat)).ok);
  await bad({ message: 'one too many', in: '1h' }, 'ETOOL_CAP', capChat);

  // ---- the ticker -----------------------------------------------------------------
  const started = [];
  let nextResult = { ok: true };
  const scheduler = schedules.createScheduler({
    store, now, getChat,
    getJob: (scope, id) => jobs.get(scope, id),
    startTurn: async (body) => { started.push(body); return typeof nextResult === 'function' ? nextResult(body) : nextResult; }
  });
  // Only chat-a matters from here: drop the filler schedules.
  for (const chat of ['chat-b', 'capped']) for (const s of store.list(projectDir, chat)) store.cancel(projectDir, chat, s.id);

  assert.deepEqual(await scheduler.tick(), [], 'nothing is due yet');
  assert.equal(started.length, 0);

  clock += 10 * MIN; // the repeating one (10m) is due
  let outcomes = await scheduler.tick();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'pending', 'a repeating schedule is re-armed');
  assert.equal(started.length, 1);
  assert.equal(started[0].chatId, 'chat-a');
  assert.equal(started[0].modelId, 'm1');
  assert.equal(started[0].providerId, 'p1');
  assert.match(started[0].content, /Scheduled wake-up/);
  assert.match(started[0].content, /repeating, run 1 of 2/);
  assert.match(started[0].content, /poll$/);
  assert.deepEqual(await scheduler.tick(), [], 'a fired wake is not delivered twice in the same tick window');
  let row = (await run('schedule_list', {})).result.schedules.find((s) => s.message === 'poll');
  assert.equal(row.dueInSeconds, 15 * 60, 're-armed from now');
  assert.equal(row.runsLeft, 1);
  assert.equal(row.runCount, 1);

  // The chat is busy: the wake waits, and a busy chat costs no attempt.
  clock += 15 * MIN;
  nextResult = { ok: false, code: 'EALREADY_RUNNING', error: 'busy' };
  outcomes = await scheduler.tick();
  assert.equal(outcomes[0].outcome, 'busy');
  row = store.list(projectDir, 'chat-a').find((s) => s.message === 'poll');
  assert.equal(row.attempts, 0);
  assert.equal(row.runCount, 1);
  clock += 20_000;
  nextResult = { ok: true };
  outcomes = await scheduler.tick();
  assert.equal(outcomes[0].outcome, 'done', 'the last run of a repeating schedule completes it');
  assert.equal(store.list(projectDir, 'chat-a').some((s) => s.message === 'poll'), false);

  // A one-shot wake fires once and is done.
  clock += 2 * HOUR;
  started.length = 0;
  outcomes = await scheduler.tick();
  assert.deepEqual(outcomes.map((o) => o.outcome), ['done']);
  assert.match(started[0].content, /check the build$/);
  assert.deepEqual(await scheduler.tick(), []);

  // Failures retry with backoff and then give up.
  const flaky = await run('schedule_wake', { message: 'flaky', in: '1m' });
  clock += 2 * MIN;
  nextResult = { ok: false, code: 'EPROVIDER', error: 'provider down' };
  const verdicts = [];
  for (let i = 0; i < 3; i++) { verdicts.push((await scheduler.tick())[0].outcome); clock += 5 * MIN; }
  assert.deepEqual(verdicts, ['pending', 'pending', 'failed']);
  assert.equal(store.get(projectDir, 'chat-a', flaky.result.id).status, 'failed');
  assert.match(store.get(projectDir, 'chat-a', flaky.result.id).lastError, /provider down/);
  nextResult = { ok: true };

  // A deleted chat cancels its wakes instead of erroring forever.
  chats.doomed = { modelId: 'm' };
  const doomed = await run('schedule_wake', { message: 'ghost', in: '1m' }, ctx('doomed'));
  delete chats.doomed;
  clock += 2 * MIN;
  started.length = 0;
  assert.equal((await scheduler.tick())[0].outcome, 'cancelled');
  assert.equal(started.length, 0);
  assert.equal(store.get(projectDir, 'doomed', doomed.result.id).status, 'cancelled');

  // A wake linked to a job fires when the job settles, before its deadline.
  const jobScope = { projectDir, chatId: 'chat-a' };
  const job = jobs.create(jobScope, { workingDir: root });
  const linked = await run('schedule_wake', { message: 'build finished?', in: '6h', jobId: job.jobId });
  assert.equal(linked.result.jobId, job.jobId);
  clock += 5 * MIN;
  started.length = 0;
  assert.deepEqual(await scheduler.tick(), [], 'a running job does not wake it');
  jobs.settle(jobScope, job.jobId, { state: 'failed', exitCode: 2 });
  outcomes = await scheduler.tick();
  assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['done', 'job']]);
  assert.match(started[0].content, new RegExp(job.jobId + ' is failed \\(exit 2\\)'));
  // ...and the deadline still wakes it when the job never settles.
  const stuck = jobs.create(jobScope, { workingDir: root });
  await run('schedule_wake', { message: 'deadline', in: '1h', jobId: stuck.jobId });
  clock += 61 * MIN;
  started.length = 0;
  outcomes = await scheduler.tick();
  assert.deepEqual(outcomes.map((o) => o.reason), ['time']);

  // Downtime: a wake that came due while mouaif was down fires once, and a
  // repeating one is not replayed for every missed interval.
  await run('schedule_wake', { message: 'missed one-shot', in: '1h' });
  await run('schedule_wake', { message: 'missed repeating', in: '1h', every: '5m', maxRuns: 50 });
  clock += 48 * HOUR;
  started.length = 0;
  outcomes = await scheduler.tick();
  assert.equal(outcomes.length, 2);
  assert.equal(started.length, 2);
  assert.deepEqual(await scheduler.tick(), [], 'no replay of the missed intervals');
  assert.equal(store.list(projectDir, 'chat-a').filter((s) => s.message === 'missed repeating').length, 1);

  for (const s of store.list(projectDir, 'chat-a')) if (s.message === 'missed repeating') store.cancel(projectDir, 'chat-a', s.id);

  // A crash while delivering leaves a lease, so the wake re-fires later, not never.
  const leased = await run('schedule_wake', { message: 'leased', in: '1m' });
  clock += 2 * MIN;
  const row2 = store.list(projectDir, 'chat-a').find((s) => s.id === leased.result.id);
  store.lease(row2.id, clock + schedules.LEASE_MS);
  const ids = async () => (await scheduler.tick()).map((o) => o.id);
  assert.equal((await ids()).includes(leased.result.id), false, 'leased wake is not re-fired immediately');
  clock += schedules.LEASE_MS + 1;
  assert.equal((await ids()).includes(leased.result.id), true, 'but fires once the lease lapses');

  // Overlapping ticks do not deliver twice.
  await run('schedule_wake', { message: 'overlap', in: '1m' });
  clock += 2 * MIN;
  started.length = 0;
  let release;
  nextResult = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const slow = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await scheduler.tick(), [], 'a tick in progress blocks another');
  release();
  assert.equal((await slow).length, 1);
  assert.equal(started.length, 1);
  nextResult = { ok: true };

  // An unavailable store means "nothing due", never a crash.
  const dead = schedules.createScheduler({ store: schedules.createScheduleStore({ getDb() { throw new Error('locked'); } }),
    startTurn: async () => ({ ok: true }), getChat, getJob: () => ({ state: 'running' }) });
  assert.deepEqual(await dead.tick(), []);
  assert.equal((await tool.runScheduleTool('schedule_list', {}, ctx(), tool.createRunners({
    store: schedules.createScheduleStore({ getDb() { throw new Error('locked'); } }), now, getChat }))).result.code, 'ESTORE');

  // The ticker is unref'd and can be stopped.
  const live = schedules.createScheduler({ store, startTurn: async () => ({ ok: true }), getChat, getJob: () => ({}), tickMs: 20 });
  live.start(); live.start(); live.stop();

  console.log('schedules: durations, validation, caps, scope, delivery, retries, job links, downtime and leases passed');
}

main().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); },
  (e) => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
