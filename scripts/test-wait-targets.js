'use strict';
// wait_for on several jobs, other chats, subagents and subagent groups.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-wait-targets-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
const otherProject = path.join(root, 'other');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(otherProject, { recursive: true });
const chats = require('../src/chats.js');
const shared = require('../src/server-shared.js');
const backgroundJobs = require('../src/tools/backgroundJobs.js');
const { Scope } = require('../src/tools/subagent-orchestration.js');
const jobs = require('../src/tools/jobs.js');

const keepAlive = setInterval(() => {}, 1000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const self = chats.createChat(projectDir, { title: 'Orchestrator' });
const workerA = chats.createChat(projectDir, { title: 'Worker A' });
const workerB = chats.createChat(projectDir, { title: 'Worker B' });
const foreign = chats.createChat(otherProject, { title: 'Elsewhere' });
const ctx = (extra = {}) => ({ projectDir, chatId: self.id, ...extra });
const wait = (args, opts) => jobs.runJobTool('wait_for', args, opts || ctx());
const running = (chat, on) => shared.runningChats[on ? 'add' : 'delete'](shared.runningKey(projectDir, chat.id));

async function main() {
  // ---- validation ---------------------------------------------------------
  const code = async (args, opts) => (await wait(args, opts)).result.code;
  assert.equal(await code({ until: 'chat' }), 'EBADINPUT', 'ids required');
  assert.equal(await code({ until: 'chat', ids: [] }), 'EBADINPUT');
  assert.equal(await code({ until: 'chat', ids: Array.from({ length: 21 }, (_, i) => 'c' + i) }), 'EBADINPUT');
  assert.equal(await code({ until: 'chat', ids: [workerA.id], mode: 'some' }), 'EBADINPUT');
  assert.equal(await code({ until: 'chat', ids: [1] }), 'EBADINPUT');
  assert.equal(await code({ until: 'job', jobId: 'job-x', ids: ['job-y'] }), 'EBADINPUT', 'jobId and ids are exclusive');
  assert.equal(await code({ until: 'bogus', ids: ['x'] }), 'EBADINPUT');

  // ---- chats --------------------------------------------------------------------
  assert.equal(await code({ until: 'chat', ids: [self.id] }), 'EDEADLOCK', 'a chat cannot wait for itself');
  assert.equal(await code({ until: 'chat', ids: ['no-such-chat'] }), 'ENOTARGET');
  assert.equal(await code({ until: 'chat', ids: [foreign.id] }), 'ENOTARGET', 'chats of another project are out of reach');

  let result = (await wait({ until: 'chat', ids: [workerA.id], seconds: 5 })).result;
  assert.equal(result.satisfied, true, 'an idle chat counts as finished');
  assert.equal(result.outcome, 'idle');
  assert.equal(result.targets[0].title, 'Worker A');
  assert.match(result.message, /get_chat/);

  running(workerA, true);
  running(workerB, true);
  result = (await wait({ until: 'chat', ids: [workerA.id, workerB.id], seconds: 1 })).result;
  assert.equal(result.timedOut, true);
  assert.equal(result.settled, 0);
  assert.equal(result.total, 2);
  assert.match(result.message, /0 of 2 finished/);

  setTimeout(() => running(workerA, false), 1300);
  const any = (await wait({ until: 'chat', ids: [workerA.id, workerB.id], mode: 'any', seconds: 10 })).result;
  assert.equal(any.satisfied, true);
  assert.equal(any.outcome, 'any-settled');
  assert.equal(any.settled, 1);
  assert.deepEqual(any.targets.map((t) => t.state), ['idle', 'running']);

  setTimeout(() => running(workerB, false), 1300);
  const all = (await wait({ until: 'chat', ids: [workerA.id, workerB.id, workerA.id], seconds: 10 })).result;
  assert.equal(all.satisfied, true);
  assert.equal(all.outcome, 'all-settled');
  assert.equal(all.total, 2, 'duplicate ids collapse');

  // The wait ends with the turn.
  running(workerA, true);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const aborted = (await wait({ until: 'chat', ids: [workerA.id], seconds: 60 }, ctx({ signal: controller.signal }))).result;
  assert.equal(aborted.cancelled, true);
  assert.equal(aborted.ok, false);
  running(workerA, false);

  // Shell jobs are no longer model-facing wait targets.
  assert.equal(await code({ until: 'job', ids: ['old-job'] }), 'EBADINPUT');

  // ---- subagents and groups ----------------------------------------------------------------
  assert.equal(await code({ until: 'subagent', ids: ['call-1'] }), 'EUNSUPPORTED', 'needs a delegating turn');
  const orchestration = new Scope(projectDir, self.id, null);
  const sub = (extra = {}) => ctx({ orchestrationScope: orchestration, ...extra });
  assert.equal(await code({ until: 'subagent', ids: ['call-unknown'] }, sub()), 'EUNKNOWN_CALL');
  assert.equal(await code({ until: 'subagent', ids: ['call-unknown'] }, sub({ orchestrationAuthor: 'someone-else' })), 'EPARENT_ONLY');

  let finishChild;
  orchestration.start('call-1', 'reviewer', () => new Promise((resolve) => { finishChild = () => resolve({ ok: true, result: { text: 'looks good' } }); }), () => {});
  await pause(30);
  const waiting = (await wait({ until: 'subagent', ids: ['call-1'], seconds: 1 }, sub())).result;
  assert.equal(waiting.timedOut, true);
  assert.equal(waiting.targets[0].state, 'running');
  setTimeout(() => finishChild(), 1200);
  const child = (await wait({ until: 'subagent', ids: ['call-1'], seconds: 10 }, sub())).result;
  assert.equal(child.satisfied, true);
  assert.equal(child.outcome, 'completed');
  assert.equal(child.targets[0].text, 'looks good');
  assert.equal(child.targets[0].ok, true);

  const created = orchestration.dispatch('subagent_group_create', { name: 'review', objective: 'review it',
    members: [{ memberId: 'm1', role: 'reviewer', workspace: 'w1' }, { memberId: 'm2', role: 'tester', workspace: 'w2', dependsOn: ['m1'] }] });
  assert.equal(await code({ until: 'group', ids: ['group-nope'] }, sub()), 'EUNKNOWN_GROUP');
  const finishers = {};
  for (const [callId, memberId] of [['call-m1', 'm1'], ['call-m2', 'm2']]) {
    orchestration.start(callId, 'worker', () => new Promise((resolve) => { finishers[memberId] = () => resolve({ ok: true, result: { text: memberId } }); }), () => {}, { groupId: created.groupId, memberId });
  }
  await pause(30);
  const groupWait = (await wait({ until: 'group', ids: [created.groupId], seconds: 1 }, sub())).result;
  assert.equal(groupWait.timedOut, true);
  setTimeout(() => finishers.m1(), 600);
  setTimeout(() => finishers.m2 && finishers.m2(), 1800);
  const group = (await wait({ until: 'group', ids: [created.groupId], seconds: 15 }, sub())).result;
  assert.equal(group.satisfied, true, JSON.stringify(group));
  assert.equal(group.outcome, 'completed');
  assert.deepEqual(group.targets[0].members.map((m) => m.state), ['completed', 'completed']);

  // A child cannot wait on itself.
  let finishRunning;
  const live = orchestration.start('call-3', 'worker', () => new Promise((resolve) => { finishRunning = () => resolve({ ok: true, result: { text: 'x' } }); }), () => {});
  await pause(30);
  const nested = orchestration.child(live);
  assert.equal(await code({ until: 'subagent', ids: ['call-3'] }, ctx({ orchestrationScope: nested, orchestrationAuthor: live.author })), 'EDEADLOCK');
  finishRunning();

  console.log('wait targets: several jobs, chats, subagents and groups, modes, ownership and cancellation passed');
}

main().then(() => { clearInterval(keepAlive); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); },
  (e) => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
