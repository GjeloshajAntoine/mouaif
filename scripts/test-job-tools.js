'use strict';
// wait_for, job_status and job_cancel against real background commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupCli = require('../src/tools/groupCli.js');
const jobs = require('../src/tools/jobs.js');

const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-job-tools-')));
const owner = { projectDir, chatId: 'chat-a', workspaceChatId: undefined };

async function start(cmd, who = owner) {
  const out = await groupCli.runGroupCli({
    projectDir, ownerProjectDir: who.projectDir, chatId: who.chatId, invocationId: who.workspaceChatId,
    args: { commands: [{ cmd, async: true }] }
  });
  const entry = out.results[0];
  assert.ok(entry.ok, 'job started: ' + JSON.stringify(entry));
  return entry.result.jobId;
}
const call = (name, args, who = owner, extra = {}) => jobs.runJobTool(name, args, { ...who, ...extra });

// The wait ticker is unref'd (the server keeps the loop alive); a bare script must too.
const keepAlive = setInterval(() => {}, 1000);

async function main() {
  // Specs: three tools, every required field declared, nothing extra allowed.
  assert.deepEqual([...jobs.NAMES], ['wait_for', 'job_status', 'job_cancel']);
  for (const name of jobs.NAMES) {
    const fn = jobs.SPECS[name].function;
    assert.equal(fn.name, name);
    assert.equal(fn.parameters.additionalProperties, false);
  }

  // They are in the native catalog and gated through the mouaif family.
  const catalog = require('../src/server-handlers-tools.js').listNativeTools();
  const authz = require('../src/tools/authorization.js');
  for (const name of jobs.NAMES) {
    const entry = catalog.find((tool) => tool.name === name);
    assert.ok(entry && entry.source === 'mouaif', name + ' is in the catalog under mouaif');
    assert.equal(authz.configToolName(name), 'mouaif');
    assert.ok(authz.TOOL_FAMILIES.mouaif.includes(name));
  }

  // Validation fails closed, with typed codes.
  assert.equal((await call('wait_for', {})).result.code, 'EBADINPUT');
  assert.equal((await call('wait_for', { until: 'job' })).result.code, 'EBADINPUT', 'job wait needs a jobId');
  assert.equal((await call('wait_for', { until: 'chat' })).result.code, 'EBADINPUT');
  assert.equal((await call('wait_for', { until: 'duration', seconds: 9999 })).result.code, 'EBADINPUT');
  assert.equal((await call('wait_for', { until: 'duration', extra: 1 })).result.code, 'EBADINPUT');
  assert.equal((await call('job_cancel', {})).result.code, 'EBADINPUT');
  assert.equal((await call('job_status', { jobId: 'job-nope' })).result.code, 'ENOTARGET');

  // duration: sleeps, and a turn abort ends it early without an error.
  const slept = await call('wait_for', { until: 'duration', seconds: 1 });
  assert.ok(slept.ok && slept.result.satisfied && slept.result.waitedMs >= 900, JSON.stringify(slept.result));
  const controller = new AbortController();
  const sleeping = call('wait_for', { until: 'duration', seconds: 60 }, owner, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const aborted = await sleeping;
  assert.equal(aborted.result.cancelled, true);
  assert.equal(aborted.ok, false);

  // A job that finishes: wait_for returns its outcome and log tail.
  const quick = await start('echo hello-from-job && exit 3');
  const done = await call('wait_for', { until: 'job', jobId: quick, seconds: 20 });
  assert.equal(done.result.satisfied, true, JSON.stringify(done.result));
  assert.equal(done.result.outcome, 'failed');
  assert.equal(done.result.job.exitCode, 3);
  assert.match(done.result.job.logTail, /hello-from-job/);

  // job_status: list, one job with tail, tailBytes 0 drops the tail.
  const listed = await call('job_status', {});
  assert.ok(listed.result.jobs.some((job) => job.jobId === quick));
  const one = await call('job_status', { jobId: quick, tailBytes: 0 });
  assert.equal(one.result.job.state, 'failed');
  assert.equal(one.result.job.logTail, undefined);

  // A timeout is not a failure: the job is reported as still running.
  const slow = await start('sleep 30');
  const timedOut = await call('wait_for', { until: 'job', jobId: slow, seconds: 1 });
  assert.equal(timedOut.result.timedOut, true);
  assert.equal(timedOut.result.job.state, 'running');
  assert.match(timedOut.result.message, /Still running/);

  // Another chat, and a nested invocation of the same chat, cannot see it.
  for (const stranger of [{ projectDir, chatId: 'chat-b' }, { projectDir, chatId: 'chat-a', workspaceChatId: 'nested' }]) {
    assert.equal((await call('job_status', { jobId: slow }, stranger)).result.code, 'ENOTARGET');
    assert.equal((await call('job_cancel', { jobId: slow }, stranger)).result.code, 'ENOTARGET');
    assert.equal((await call('wait_for', { until: 'job', jobId: slow, seconds: 1 }, stranger)).result.code, 'ENOTARGET');
    assert.deepEqual((await call('job_status', {}, stranger)).result.jobs, []);
  }
  assert.equal((await call('job_status', { jobId: slow })).result.job.state, 'running', 'strangers did not touch it');

  // job_cancel stops the whole process group and the job settles as cancelled.
  const cancelled = await call('job_cancel', { jobId: slow });
  assert.ok(cancelled.ok, JSON.stringify(cancelled.result));
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.result.stillRunning, false);
  assert.equal(cancelled.result.job.state, 'cancelled');
  const again = await call('job_cancel', { jobId: slow });
  assert.equal(again.result.alreadyFinished, true, 'cancelling twice is safe');
  const afterCancel = await call('wait_for', { until: 'job', jobId: slow, seconds: 5 });
  assert.equal(afterCancel.result.outcome, 'cancelled');
  assert.equal(afterCancel.result.satisfied, true);

  // A command that ignores SIGTERM still dies after the grace period.
  const stubborn = await start("trap '' TERM; sleep 30");
  const killed = await call('job_cancel', { jobId: stubborn });
  assert.equal(killed.result.job.state, 'cancelled', JSON.stringify(killed.result));
  assert.equal(groupCli._backgroundChildren.size, 0, 'no live background child is left behind');

  // Cancelling does not relabel a command that failed on its own.
  const failing = await start('exit 7');
  assert.equal((await call('wait_for', { until: 'job', jobId: failing, seconds: 10 })).result.outcome, 'failed');
  const late = await call('job_cancel', { jobId: failing });
  assert.equal(late.result.alreadyFinished, true);
  assert.equal(late.result.job.state, 'failed');

  console.log('job tools: wait_for, job_status, job_cancel, scoping and process-group cancel passed');
}

main().then(() => { clearInterval(keepAlive); fs.rmSync(projectDir, { recursive: true, force: true }); process.exit(0); },
  (e) => { fs.rmSync(projectDir, { recursive: true, force: true }); console.error(e); process.exit(1); });
