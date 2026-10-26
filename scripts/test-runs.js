'use strict';
// Long-running runs: budget, user controls (pause/resume/stop), the scheduler
// gate and the stall watchdog, against a real SQLite store with a fake clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-runs-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const settings = require('../src/settings.js');
const runs = require('../src/runs.js');
const schedules = require('../src/schedules.js');
const runTool = require('../src/tools/run.js');
const scheduleTool = require('../src/tools/schedule.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let clock = Date.parse('2026-10-26T12:00:00Z');
const now = () => clock;
const projectDir = root;
const CHAT = 'chat-a';
const chats = { [CHAT]: { modelId: 'm1', providerId: 'p1', title: 'Long job' }, other: { modelId: 'm1' } };
const getChat = (dir, id) => chats[id] || null;

let cost = 0;
let running = new Set();
let cancelledTurns = [];
const alerts = [];
const started = [];
const scheduleStore = schedules.createScheduleStore({ getDb: settings.getDb, now });
const store = runs.createRunStore({ getDb: settings.getDb, now });
const manager = runs.createRunManager({
  store, now, getChat,
  getCost: () => cost,
  cancelSchedules: (dir, id, reason) => scheduleStore.list(dir, id).filter((row) => scheduleStore.cancel(dir, id, row.id, reason)).length,
  hasPendingSchedule: (dir, id) => scheduleStore.list(dir, id).length > 0,
  isChatRunning: (dir, id) => running.has(id),
  cancelTurn: (dir, id) => { cancelledTurns.push(id); return running.has(id); },
  startTurn: async (body) => { started.push(body); return { ok: true }; },
  notify: (alert) => alerts.push(alert),
  idleNudgeMs: 10 * MIN
});
const scheduler = schedules.createScheduler({
  store: scheduleStore, now, getChat, getJob: () => ({ state: 'running' }),
  startTurn: async (body) => { started.push(body); return { ok: true }; },
  hooks: { gate: (dir, id) => manager.gate(dir, id), delivered: (dir, id, gate) => manager.delivered(dir, id, gate), onTick: () => manager.watch() }
});
const ctx = { projectDir, chatId: CHAT };
const tool = (name, args, opts) => runTool.runRunTool(name, args, opts || ctx, manager);
const wakeRunners = scheduleTool.createRunners({ store: scheduleStore, now, getChat, runOf: (dir, id) => manager.get(dir, id) });
const wake = (args) => scheduleTool.runScheduleTool('schedule_wake', args, ctx, wakeRunners);

async function main() {
  // ---- specs and validation ------------------------------------------------------
  assert.deepEqual([...runTool.NAMES], ['run_start', 'run_status', 'run_end']);
  const bad = async (name, args, code, opts) => assert.equal((await tool(name, args, opts)).result.code, code, name + JSON.stringify(args));
  await bad('run_start', {}, 'EBADINPUT');
  await bad('run_start', { goal: ' ' }, 'EBADINPUT');
  await bad('run_start', { goal: 'x'.repeat(501) }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', maxTurns: 0 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', maxTurns: 501 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', maxTurns: 1.5 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', maxCostUsd: 0 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', maxHours: 169 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x', bogus: 1 }, 'EBADINPUT');
  await bad('run_start', { goal: 'x' }, 'EBADINPUT', { projectDir });
  await bad('run_start', { goal: 'x' }, 'ENOTARGET', { projectDir, chatId: 'gone' });
  await bad('run_end', {}, 'ENOTARGET');
  await bad('run_end', { outcome: 'maybe' }, 'EBADINPUT');
  assert.equal((await tool('run_status', {})).result.run, null, 'no run yet');

  // ---- start / status / end -----------------------------------------------------------
  cost = 1.5;
  const started1 = await tool('run_start', { goal: 'Migrate the docs', maxTurns: 3, maxCostUsd: 0.5, maxHours: 2 });
  assert.ok(started1.ok, JSON.stringify(started1.result));
  assert.equal(started1.result.run.status, 'running');
  assert.equal(started1.result.run.turnsLeft, 3);
  assert.equal(started1.result.run.minutesLeft, 120);
  assert.equal(started1.result.run.costUsed, 0, 'spend is counted from the start of the run');
  await bad('run_start', { goal: 'again' }, 'EEXISTS');
  cost = 1.7;
  const status = (await tool('run_status', {})).result;
  assert.equal(status.shouldContinue, true);
  assert.equal(status.run.costUsed, 0.2);

  // ---- the scheduler gate ------------------------------------------------------------------
  const wakes = async (n) => { for (let i = 0; i < n; i++) await wake({ message: 'step ' + (i + 1), in: '1m' }); };
  await wakes(1);
  clock += 2 * MIN;
  started.length = 0;
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['done']);
  assert.match(started[0].content, /Scheduled wake-up/);
  assert.equal(manager.view(manager.get(projectDir, CHAT)).turnsUsed, 1, 'a delivered wake costs a turn');

  // Pausing holds wakes without losing them.
  manager.pause(projectDir, CHAT);
  assert.equal(manager.view(manager.get(projectDir, CHAT)).status, 'paused');
  await wake({ message: 'held one', in: '1m' });
  clock += 2 * MIN;
  started.length = 0;
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['held']);
  assert.equal(started.length, 0);
  assert.equal(scheduleStore.list(projectDir, CHAT).length, 1, 'the wake is still queued');
  assert.throws(() => manager.pause(projectDir, CHAT), { code: 'ENOTARGET' }, 'cannot pause twice');
  clock += 40_000;
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['held'], 'still held on the next look');
  manager.resume(projectDir, CHAT);
  clock += 40_000;
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['done'], 'delivered after resume');
  assert.equal(manager.view(manager.get(projectDir, CHAT)).turnsUsed, 2);
  assert.throws(() => manager.resume(projectDir, CHAT), { code: 'ENOTARGET' });

  // The last allowed turn runs; then the budget is spent and the next wake becomes the wrap-up.
  await wakes(1);
  clock += 2 * MIN;
  await scheduler.tick();
  assert.equal(manager.view(manager.get(projectDir, CHAT)).turnsLeft, 0);
  await wake({ message: 'one too many', in: '1m' });
  await wake({ message: 'queued behind it', in: '5m' });
  clock += 2 * MIN;
  started.length = 0;
  alerts.length = 0;
  const wrap = await scheduler.tick();
  assert.deepEqual(wrap.map((o) => o.outcome), ['done']);
  assert.match(started[0].content, /Run budget reached/);
  assert.match(started[0].content, /turn budget used/);
  assert.doesNotMatch(started[0].content, /one too many/, 'the wrap-up replaces the wake message');
  const spent = manager.view(manager.get(projectDir, CHAT));
  assert.equal(spent.status, 'exhausted');
  assert.equal(scheduleStore.list(projectDir, CHAT).length, 0, 'the budget cancels everything still queued');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /budget/i);
  assert.equal((await wake({ message: 'more', in: '1m' })).result.code, 'ERUN_ENDED', 'no new wakes once the run is over');
  assert.equal((await tool('run_status', {})).result.shouldContinue, false);

  // ---- end, restart, cost and time budgets -------------------------------------------------------
  const ended = await tool('run_end', { outcome: 'done', summary: 'All pages moved.' });
  assert.equal(ended.result.run.alreadyEnded, true, 'ending a finished run is harmless');
  const second = await tool('run_start', { goal: 'Second run', maxCostUsd: 0.25 });
  assert.equal(second.result.run.turnsUsed, 0, 'a new run starts fresh');
  cost += 0.3;
  await wakes(1);
  clock += 2 * MIN;
  started.length = 0;
  await scheduler.tick();
  assert.match(started[0].content, /cost budget used/);
  assert.equal(manager.get(projectDir, CHAT).status, 'exhausted');

  await tool('run_start', { goal: 'Time boxed', maxHours: 0.1 });
  await wakes(1);
  clock += 7 * MIN; // past 6 minutes
  started.length = 0;
  await scheduler.tick();
  assert.match(started[0].content, /time budget used/);

  // run_end cancels pending wakes and tells the user.
  await tool('run_start', { goal: 'Short one' });
  await wake({ message: 'later', in: '2h' });
  alerts.length = 0;
  const finished = await tool('run_end', { outcome: 'blocked', summary: 'Needs a credential.' });
  assert.equal(finished.result.run.status, 'ended');
  assert.equal(finished.result.run.endReason, 'blocked');
  assert.equal(finished.result.run.summary, 'Needs a credential.');
  assert.equal(finished.result.run.schedulesCancelled, 1);
  assert.equal(scheduleStore.list(projectDir, CHAT).length, 0);
  assert.equal(alerts.length, 1);

  // ---- stop ------------------------------------------------------------------------------------------
  await tool('run_start', { goal: 'Stoppable' });
  await wake({ message: 'queued', in: '1h' });
  running.add(CHAT);
  cancelledTurns = [];
  const stopped = manager.stop(projectDir, CHAT);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.schedulesCancelled, 1);
  assert.equal(stopped.turnCancelled, true, 'stop aborts the streaming turn');
  assert.deepEqual(cancelledTurns, [CHAT]);
  assert.throws(() => manager.stop(projectDir, CHAT), { code: 'ENOTARGET' });
  running.clear();
  assert.equal((await wake({ message: 'after stop', in: '1m' })).result.code, 'ERUN_ENDED');

  // A wake that raced a stop is cancelled instead of delivered.
  scheduleStore.create({ projectDir, chatId: CHAT, message: 'raced', dueAt: clock + 60_000, runsLeft: 1 });
  clock += 2 * MIN;
  started.length = 0;
  assert.deepEqual((await scheduler.tick()).map((o) => o.outcome), ['cancelled']);
  assert.equal(started.length, 0);

  // ---- the watchdog -----------------------------------------------------------------------------------------
  await tool('run_start', { goal: 'Watched', maxTurns: 20 });
  alerts.length = 0;
  started.length = 0;
  assert.deepEqual(await manager.watch(), [], 'just went idle: nothing yet');
  clock += 5 * MIN;
  assert.deepEqual(await manager.watch(), []);
  // Something scheduled, or a turn streaming, means it is not stalled.
  await wake({ message: 'next check', in: '30m' });
  clock += 20 * MIN;
  assert.deepEqual(await manager.watch(), [], 'a pending wake keeps it alive');
  for (const row of scheduleStore.list(projectDir, CHAT)) scheduleStore.cancel(projectDir, CHAT, row.id);
  running.add(CHAT);
  clock += 20 * MIN;
  assert.deepEqual(await manager.watch(), [], 'a streaming turn keeps it alive');
  running.delete(CHAT);
  assert.deepEqual(await manager.watch(), [], 'the idle clock restarts when the turn ends');
  clock += 11 * MIN;
  assert.deepEqual((await manager.watch()).map((e) => e.event), ['nudged']);
  assert.match(started.at(-1).content, /Run check-in/);
  assert.match(started.at(-1).content, /Watched/);
  assert.match(started.at(-1).content, /run_end/);
  assert.equal(manager.get(projectDir, CHAT).nudges, 1);
  assert.equal(manager.get(projectDir, CHAT).turnsUsed, 1, 'a reminder costs a turn');
  // Calling run_status counts as progress and clears the reminders.
  await tool('run_status', {});
  assert.equal(manager.get(projectDir, CHAT).nudges, 0);
  // Ignored reminders end in a stall and an alert.
  for (let i = 0; i < 3; i++) {
    clock += 11 * MIN;
    assert.deepEqual((await manager.watch()).map((e) => e.event), ['nudged'], 'reminder ' + (i + 1));
  }
  assert.equal(manager.get(projectDir, CHAT).nudges, 3);
  clock += 11 * MIN;
  assert.deepEqual((await manager.watch()).map((e) => e.event), ['stalled']);
  assert.equal(manager.get(projectDir, CHAT).status, 'stalled');
  assert.match(alerts.at(-1).title, /stalled/i);
  assert.deepEqual(await manager.watch(), [], 'a stalled run is left alone');
  // A budget that ran out while idle is reported as exhausted, not nudged.
  await tool('run_start', { goal: 'Out of time', maxHours: 0.1 });
  await manager.watch();
  clock += 11 * MIN;
  assert.deepEqual((await manager.watch()).map((e) => e.event), ['exhausted']);

  // An unusable store never throws out of the hooks.
  const dead = runs.createRunManager({ store: runs.createRunStore({ getDb() { throw new Error('locked'); } }), now });
  assert.deepEqual(await dead.watch(), []);
  assert.deepEqual(dead.gate(projectDir, CHAT), { action: 'send' });

  console.log('runs: budget, pause/resume/stop, scheduler gate, run_end, nudges and stall detection passed');
}

main().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); },
  (e) => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
