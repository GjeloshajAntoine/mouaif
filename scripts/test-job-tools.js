'use strict';
// wait_for, job_status and job_cancel against real background commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jobs = require('../src/tools/jobs.js');

const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-job-tools-')));
const owner = { projectDir, chatId: 'chat-a', workspaceChatId: undefined };

const call = (name, args, who = owner, extra = {}) => jobs.runJobTool(name, args, { ...who, ...extra });

// The wait ticker is unref'd (the server keeps the loop alive); a bare script must too.
const keepAlive = setInterval(() => {}, 1000);

async function main() {
  // Specs: three tools, every required field declared, nothing extra allowed.
  assert.deepEqual([...jobs.NAMES], ['wait_for']);
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
  assert.equal((await call('job_cancel', {})).result.code, 'EUNKNOWN_TOOL');
  assert.equal((await call('job_status', { jobId: 'job-nope' })).result.code, 'EUNKNOWN_TOOL');

  // duration: sleeps, and a turn abort ends it early without an error.
  const slept = await call('wait_for', { until: 'duration', seconds: 1 });
  assert.ok(slept.ok && slept.result.satisfied && slept.result.waitedMs >= 900, JSON.stringify(slept.result));
  const controller = new AbortController();
  const sleeping = call('wait_for', { until: 'duration', seconds: 60 }, owner, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const aborted = await sleeping;
  assert.equal(aborted.result.cancelled, true);
  assert.equal(aborted.ok, false);

  for (const name of ['group_cli', 'job_status', 'job_cancel']) {
    assert.ok(!catalog.some((tool) => tool.name === name), name + ' is not advertised');
  }
  assert.equal(jobs.SPECS.wait_for.function.parameters.properties.jobId, undefined);
  assert.equal((await call('wait_for', { until: 'duration', jobId: 'old' })).result.code, 'EBADINPUT');
  console.log('wait tools: simplified catalog, rejected legacy arguments, duration and cancellation passed');
}

main().then(() => { clearInterval(keepAlive); fs.rmSync(projectDir, { recursive: true, force: true }); process.exit(0); },
  (e) => { fs.rmSync(projectDir, { recursive: true, force: true }); console.error(e); process.exit(1); });
