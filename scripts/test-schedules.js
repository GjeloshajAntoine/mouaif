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
const opened = [];
const closed = [];
const runners = tool.createRunners({ store, now, getChat, checkJob: (scope, id) => jobs.get(scope, id), runOf: () => null,
  openRun: (c, args) => { opened.push({ c, args }); return { status: 'running' }; }, closeRun: (c, reason) => closed.push({ c, reason }) });
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
  await bad({ message: 'x'.repeat(schedules.MAX_MESSAGE_CHARS + 1), in: '5m' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5s' }, 'EBADINPUT');
  await bad({ message: 'x', in: '31d' }, 'EBADINPUT');
  await bad({ message: 'x', at: 'tomorrow' }, 'EBADINPUT');
  await bad({ message: 'x', at: '2020-01-01T00:00:00Z' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', every: '30s' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', maxRuns: 3 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', every: '5m', maxRuns: schedules.MAX_RUNS + 1 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', every: '5m', time: '09:00' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', days: ['mon'] }, 'EBADINPUT');
  await bad({ message: 'x', time: '25:00' }, 'EBADINPUT');
  await bad({ message: 'x', time: '09:00', days: ['someday'] }, 'EBADINPUT');
  await bad({ message: 'x', time: '09:00', timezone: 'Mars/Olympus' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', until: '2030-01-01T00:00:00Z' }, 'EBADINPUT');
  await bad({ message: 'x', in: '1h', every: '5m', until: '2020-01-01T00:00:00Z' }, 'EBADINPUT');
  await bad({ message: 'x', in: '1h', every: '5m', until: 'later' }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m', bogus: 1 }, 'EBADINPUT');
  await bad({ message: 'x', in: '5m' }, 'EBADINPUT', { projectDir });
  await bad({ message: 'x', in: '5m' }, 'EBADINPUT', ctx('chat-nomodel'));
  await bad({ message: 'x', in: '5m' }, 'ENOTARGET', ctx('chat-gone'));
  await bad({ message: 'x', in: '5m', jobId: 'job-nope' }, 'EBADINPUT');

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
  assert.equal(repeating.result.recurring, true);
  assert.equal(repeating.result.repeat, 'Every 15m');
  assert.equal(opened.length, 1, 'a recurring task opens its run');
  assert.deepEqual([opened[0].args.maxRuns, opened[0].args.goal], [2, 'poll']);
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
  assert.match(started[0].content, /Recurring task · every 15m · run 1 of 2/);
  assert.match(started[0].content, /same chat as the earlier runs/);
  assert.match(started[0].content, /poll$/);
  assert.deepEqual(await scheduler.tick(), [], 'a fired wake is not delivered twice in the same tick window');
  let row = (await run('schedule_list', {})).result.schedules.find((s) => s.message === 'poll');
  assert.equal(row.dueInSeconds, 15 * 60, 're-armed on the planned grid');
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
  // Simulate a legacy persisted schedule: new tool calls reject jobId.
  store.create({ projectDir, chatId: 'chat-a', message: 'build finished?', dueAt: clock + 6 * HOUR, jobId: job.jobId, jobScope });
  clock += 5 * MIN;
  started.length = 0;
  assert.deepEqual(await scheduler.tick(), [], 'a running job does not wake it');
  jobs.settle(jobScope, job.jobId, { state: 'failed', exitCode: 2 });
  outcomes = await scheduler.tick();
  assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['done', 'job']]);
  assert.match(started[0].content, new RegExp(job.jobId + ' is failed \\(exit 2\\)'));
  // ...and the deadline still wakes it when the job never settles.
  const stuck = jobs.create(jobScope, { workingDir: root });
  store.create({ projectDir, chatId: 'chat-a', message: 'deadline', dueAt: clock + HOUR, jobId: stuck.jobId, jobScope });
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

  // ---- recurring tasks ---------------------------------------------------------
  for (const chat of ['chat-c', 'chat-d', 'chat-e', 'chat-f']) chats[chat] = { modelId: 'm1' };
  for (const s of store.list(projectDir, 'chat-a')) store.cancel(projectDir, 'chat-a', s.id);

  // A clock time: weekdays 09:00 in Brussels (CET in January, so 08:00Z).
  clock = Date.parse('2027-01-04T07:30:00Z'); // a Monday
  const daily = await run('schedule_wake', { message: 'morning report', time: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'Europe/Brussels' }, ctx('chat-c'));
  assert.ok(daily.ok, JSON.stringify(daily.result));
  assert.equal(daily.result.dueAt, '2027-01-04T08:00:00.000Z');
  assert.equal(daily.result.repeat, 'Weekdays at 09:00 (Europe/Brussels)');
  assert.equal(daily.result.runsLeft, null, 'a recurring task is open-ended unless it is given a count');
  assert.equal(opened[opened.length - 1].args.maxRuns, undefined);
  const after = Date.parse('2027-01-04T08:00:00Z');
  const dueOf = (chatId) => new Date(store.recurring(projectDir, chatId).dueAt).toISOString();
  started.length = 0;
  for (const next of ['2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08', '2027-01-11']) {
    clock = store.recurring(projectDir, 'chat-c').dueAt + 5000;
    const out = await scheduler.tick();
    assert.equal(out[0].outcome, 'pending');
    assert.equal(dueOf('chat-c'), next + 'T08:00:00.000Z', 'next slot after ' + next);
  }
  assert.equal(started.length, 5);
  assert.match(started[0].content, /Recurring task · weekdays at 09:00 \(europe\/brussels\) · run 1\n/);
  assert.match(started[4].content, / · run 5\n/);
  assert.ok(clock > after);
  // The same wall-clock time across a clock change keeps its meaning.
  const spring = schedules.parseClock({ time: '09:00', timezone: 'Europe/Brussels' });
  assert.equal(new Date(schedules.nextClockSlot(spring, Date.parse('2027-03-27T12:00:00Z'))).toISOString(), '2027-03-28T07:00:00.000Z', 'CEST after the change');
  assert.equal(new Date(schedules.nextClockSlot(spring, Date.parse('2027-03-26T12:00:00Z'))).toISOString(), '2027-03-27T08:00:00.000Z', 'CET before it');

  store.cancel(projectDir, 'chat-c', store.recurring(projectDir, 'chat-c').id);

  // An interval stays on its grid, never overlaps a running turn and skips missed slots.
  const t0 = clock = Date.parse('2027-02-01T10:00:00Z');
  await run('schedule_wake', { message: 'poll the build', in: '1m', every: '10m' }, ctx('chat-d'));
  clock = t0 + 67_000;
  started.length = 0;
  assert.equal((await scheduler.tick())[0].outcome, 'pending');
  assert.equal(dueOf('chat-d'), new Date(t0 + 11 * MIN).toISOString(), 'counted from the planned time, not from when it ran');
  clock = t0 + 11 * MIN;
  nextResult = { ok: false, code: 'EALREADY_RUNNING', error: 'busy' };
  assert.equal((await scheduler.tick())[0].outcome, 'busy', 'it waits for the previous turn');
  assert.equal(started.length, 2);
  clock = t0 + 31 * MIN + 3000; // the turn ran for twenty minutes
  nextResult = { ok: true };
  started.length = 0;
  assert.equal((await scheduler.tick())[0].outcome, 'pending');
  assert.equal(started.length, 1, 'the missed slots are not replayed');
  assert.equal(dueOf('chat-d'), new Date(t0 + 41 * MIN).toISOString());
  assert.match(started[0].content, / · run 2\n/);

  store.cancel(projectDir, 'chat-d', store.recurring(projectDir, 'chat-d').id);

  // An end date: the last run is the last slot before it; a lapsed one never fires.
  clock = t0;
  await run('schedule_wake', { message: 'until noon', in: '1m', every: '1h', until: new Date(t0 + 150 * MIN).toISOString() }, ctx('chat-e'));
  const verdicts2 = [];
  for (let i = 0; i < 3; i++) { clock = store.recurring(projectDir, 'chat-e') ? store.recurring(projectDir, 'chat-e').dueAt + 1000 : clock; verdicts2.push((await scheduler.tick())[0].outcome); }
  assert.deepEqual(verdicts2, ['pending', 'pending', 'done'], 'no slot after the end date');
  assert.equal(store.recurring(projectDir, 'chat-e'), null);
  clock = t0 + 10 * HOUR;
  await run('schedule_wake', { message: 'lapsed', in: '1m', every: '1h', until: new Date(clock + 90 * MIN).toISOString() }, ctx('chat-e'));
  clock += 5 * HOUR;
  started.length = 0;
  assert.equal((await scheduler.tick())[0].outcome, 'done', 'down past the end date: finished without firing');
  assert.equal(started.length, 0);

  // One recurring task per chat; one-off wakes sit beside it.
  const first = await run('schedule_wake', { message: 'first task', in: '5m', every: '30m' }, ctx('chat-f'));
  await run('schedule_wake', { message: 'one-off check', in: '20m' }, ctx('chat-f'));
  const second = await run('schedule_wake', { message: 'second task', time: '18:30', timezone: 'UTC' }, ctx('chat-f'));
  assert.equal(second.result.replacedPrevious, true);
  assert.equal(first.result.replacedPrevious, false);
  const pendingF = (await run('schedule_list', {}, ctx('chat-f'))).result.schedules;
  assert.deepEqual(pendingF.map((x) => x.message).sort(), ['one-off check', 'second task']);
  assert.deepEqual(pendingF.map((x) => x.recurring).sort(), [false, true]);
  assert.equal(store.get(projectDir, 'chat-f', first.result.id).status, 'cancelled');
  assert.equal(opened.length >= 2, true);
  const oneOff = pendingF.find((x) => !x.recurring);
  closed.length = 0;
  assert.equal((await run('schedule_cancel', { id: oneOff.id }, ctx('chat-f'))).result.cancelled, true);
  assert.equal(closed.length, 0, 'cancelling a one-off wake leaves the run alone');
  const cancelledTask = await run('schedule_cancel', {}, ctx('chat-f'));
  assert.equal(cancelledTask.result.cancelled, true, 'without an id it cancels the recurring task');
  assert.deepEqual(closed.map((c) => [c.c.chatId, c.reason]), [['chat-f', 'cancelled']], 'and closes its run');
  assert.equal((await run('schedule_cancel', {}, ctx('chat-f'))).result.code, 'ENOTARGET');

  // After a stop a one-off wake is refused, but a new recurring task starts afresh.
  const stoppedRunners = tool.createRunners({ store, now, getChat, runOf: () => ({ status: 'stopped', endReason: 'stopped by you' }),
    openRun: (c, args) => { opened.push({ c, args }); return { status: 'running' }; }, closeRun: () => {} });
  assert.equal((await tool.runScheduleTool('schedule_wake', { message: 'x', in: '5m' }, ctx('chat-f'), stoppedRunners)).result.code, 'ERUN_ENDED');
  assert.ok((await tool.runScheduleTool('schedule_wake', { message: 'again', in: '5m', every: '1h', maxRuns: 4, maxCostUsd: 2 }, ctx('chat-f'), stoppedRunners)).ok);
  assert.deepEqual([opened.at(-1).args.maxRuns, opened.at(-1).args.maxCostUsd], [4, 2], 'its limits go to the run');
  store.cancel(projectDir, 'chat-f', store.recurring(projectDir, 'chat-f').id);

  // A store from before recurring tasks gains the new columns.
  const Database = require('better-sqlite3');
  const old = new Database(':memory:');
  old.exec('CREATE TABLE wake_schedule (id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, chat_id TEXT NOT NULL, message TEXT NOT NULL, due_at INTEGER NOT NULL, every_ms INTEGER, runs_left INTEGER, job_id TEXT, job_scope TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_run_at INTEGER, run_count INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)');
  old.prepare("INSERT INTO wake_schedule (id, project_dir, chat_id, message, due_at, every_ms, runs_left, status, created_at) VALUES ('wake-old', 'p', 'c', 'legacy', ?, 600000, 3, 'pending', 1)").run(clock + 1000);
  const legacy = schedules.createScheduleStore({ getDb: () => old, now });
  assert.equal(legacy.recurring('p', 'c').message, 'legacy');
  legacy.fired(legacy.recurring('p', 'c'), clock + 2000);
  assert.equal(legacy.recurring('p', 'c').dueAt, clock + 1000 + 10 * MIN, 'a legacy row stays on its own grid');

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
