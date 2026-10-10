'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistry } = require('../src/tools/backgroundJobs.js');
const jobs = require('../src/tools/backgroundJobs.js');
const groupCli = require('../src/tools/groupCli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-jobs-'));
const scope = { projectDir: root, chatId: 'one' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let clock = 0;
  const registry = createRegistry({ now: () => clock, retentionMs: 100, maxJobs: 2 });
  const first = registry.create(scope, { workingDir: root });
  const second = registry.create(scope, { workingDir: root });
  assert.notEqual(first.jobId, second.jobId);
  assert.throws(() => registry.get({ ...scope, chatId: 'two' }, first.jobId), { code: 'ENOTARGET' });
  assert.throws(() => registry.get({ ...scope, invocationId: 'nested-run' }, first.jobId), { code: 'ENOTARGET' });
  assert.throws(() => registry.create({ projectDir: 'relative' }, {}), { code: 'EBADINPUT' });
  assert.throws(() => registry.get({ ...scope, projectDir: root + '-other' }, first.jobId), { code: 'ENOTARGET' });
  registry.settle(scope, first.jobId, { state: 'failed', exitCode: 7 });
  assert.equal(registry.get(scope, first.jobId).exitCode, 7);
  assert.equal(registry.settle(scope, first.jobId, { state: 'completed', exitCode: 0 }).state, 'failed');
  const copy = registry.get(scope, first.jobId);
  copy.state = 'running';
  assert.equal(registry.get(scope, first.jobId).state, 'failed');
  clock = 99;
  assert.throws(() => registry.create(scope, {}), { code: 'ETOOL_CAP' });
  clock = 100;
  assert.throws(() => registry.get(scope, first.jobId), { code: 'ENOTARGET' });
  assert.equal(registry.get(scope, second.jobId).state, 'running', 'active handles do not expire');
  const third = registry.create(scope, {});
  registry.settle(scope, third.jobId, { state: 'cancelled', signal: 'SIGTERM' });
  assert.equal(registry.get(scope, third.jobId).state, 'cancelled');
  assert.equal(registry.list({ ...scope, chatId: 'two' }).length, 0);
  assert.equal(registry.list(scope).length, 2);

  // Working folder and owning project are deliberately different.
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const out = await groupCli.runGroupCli({
    projectDir: cwd, ownerProjectDir: root, chatId: scope.chatId,
    args: { commands: [
      { cmd: 'sleep 0.1; echo done', async: true },
      { cmd: 'sleep 0.1; exit 7', async: true }
    ] },
    onBackgroundExit() { throw new Error('observer failure'); }
  });
  assert.equal(out.runningCount, 2);
  const ids = out.results.map((entry) => entry.result.jobId);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) {
    assert.equal(jobs.get(scope, id).workingDir, cwd);
    assert.throws(() => jobs.get({ projectDir: cwd, chatId: scope.chatId }, id), { code: 'ENOTARGET' });
    assert.ok(groupCli.formatGroupCliResult(out).includes(id));
  }
  for (let i = 0; i < 100 && ids.some((id) => jobs.get(scope, id).state === 'running'); i++) await pause(20);
  assert.equal(jobs.get(scope, ids[0]).state, 'completed');
  assert.equal(jobs.get(scope, ids[0]).exitCode, 0);
  assert.equal(jobs.get(scope, ids[1]).state, 'failed');
  assert.equal(jobs.get(scope, ids[1]).exitCode, 7);
  // The child registry can be empty without erasing completion metadata.
  for (let i = 0; i < 100 && groupCli._backgroundChildren.size; i++) await pause(20);
  assert.equal(groupCli._backgroundChildren.size, 0);
  await pause(30); // let best-effort log close finish before fixture cleanup
  assert.equal(jobs.get(scope, ids[0]).state, 'completed');
  assert.equal(jobs.list(scope).length, 2);
  console.log('background jobs: scoped handles, retention, cap and exit outcomes passed');
}

main().then(() => fs.rmSync(root, { recursive: true, force: true })).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
