'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { getEventListeners } = require('node:events');
const { createWaitRegistry, MAX_TIMEOUT_MS } = require('../src/tools/waits.js');
const { createRegistry } = require('../src/tools/backgroundJobs.js');
const scope = { projectDir: '/tmp/waits', chatId: 'chat', invocationId: 'child' };

async function main() {
  let clock = 0;
  const jobs = createRegistry({ now: () => clock });
  const waits = createWaitRegistry({ now: () => clock, jobRegistry: jobs, maxWaits: 2 });
  const job = jobs.create(scope, {});
  assert.throws(() => waits.wait({ scope, until: 'chat:chat' }), { code: 'EUNSUPPORTED' });
  assert.throws(() => waits.wait({ scope, until: 'subagent:self' }), { code: 'EUNSUPPORTED' });
  assert.throws(() => waits.wait({ scope, until: 'group:ancestor' }), { code: 'EUNSUPPORTED' });
  assert.throws(() => waits.wait({ scope, until: 'duration', timeoutMs: NaN }), { code: 'EBADINPUT' });
  assert.throws(() => waits.wait({ scope: { ...scope, invocationId: 'parent' }, until: 'shell:' + job.jobId }), { code: 'ENOTARGET' });
  const controller = new AbortController();
  const waiting = waits.wait({ scope, until: 'shell:' + job.jobId, signal: controller.signal, intervalMs: 1 });
  const duration = waits.wait({ until: 'duration', timeoutMs: 999999 });
  assert.equal(waits.pendingCount(), 2);
  assert.throws(() => waits.wait({ until: 'duration' }), { code: 'ETOOL_CAP' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  assert.equal((await waiting).cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(waits.pendingCount(), 1);
  clock = MAX_TIMEOUT_MS - 1;
  waits.tick();
  assert.equal(waits.pendingCount(), 1);
  clock++;
  waits.tick();
  assert.equal((await duration).satisfied, true);
  assert.equal(waits.hasTicker(), false);
  const timeout = waits.wait({ scope, until: 'shell:' + job.jobId, timeoutMs: 10 });
  clock += 10;
  waits.tick();
  assert.equal((await timeout).timedOut, true);
  for (const state of ['completed', 'failed', 'cancelled']) {
    const target = jobs.create(scope, {});
    jobs.settle(scope, target.jobId, { state, exitCode: state === 'completed' ? 0 : 1 });
    const result = await waits.wait({ scope, until: 'shell:' + target.jobId });
    assert.equal(result.satisfied, true, 'settlement, not success');
    assert.equal(result.outcome, state);
  }
  const completedController = new AbortController();
  const completed = waits.wait({ until: 'duration', timeoutMs: 1, signal: completedController.signal });
  clock++;
  waits.tick();
  await completed;
  assert.equal(getEventListeners(completedController.signal, 'abort').length, 0);
  const disappearingJobs = createRegistry({ now: () => clock, retentionMs: 1 });
  const disappearing = disappearingJobs.create(scope, {});
  const shortWaits = createWaitRegistry({ now: () => clock, jobRegistry: disappearingJobs });
  const lost = shortWaits.wait({ scope, until: 'shell:' + disappearing.jobId, intervalMs: 100 });
  disappearingJobs.settle(scope, disappearing.jobId, { state: 'completed' });
  clock += 100;
  shortWaits.tick();
  assert.equal((await lost).error.code, 'ENOTARGET', 'expired is not completion');
  assert.equal(shortWaits.pendingCount(), 0);
  assert.equal(shortWaits.hasTicker(), false);
  const cancelled = await waits.wait({ until: 'duration', signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(waits.pendingCount(), 0);
  assert.equal(waits.check(scope).backgroundCommands.length, 4);
  assert.equal(waits.check({ ...scope, invocationId: 'other' }).backgroundCommands.length, 0);
  const child = spawnSync(process.execPath, ['-e', "require('./src/tools/waits.js').createWaitRegistry().wait({until:'duration'});"], {
    cwd: require('node:path').join(__dirname, '..'), timeout: 2000
  });
  assert.equal(child.status, 0, 'unref ticker does not keep a worker alive');
  console.log('waits: timeout clamp, duration, cancellation cleanup, cap, scoped outcomes and unref passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
