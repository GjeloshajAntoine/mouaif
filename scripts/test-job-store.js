'use strict';
// Background jobs survive a restart as metadata: finished jobs keep their
// outcome, jobs that were running become `lost`, and scope rules still hold.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-job-store-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const settings = require('../src/settings.js');
const { createJobStore } = require('../src/tools/jobStore.js');
const { createRegistry } = require('../src/tools/backgroundJobs.js');

const scope = { projectDir: root, chatId: 'chat-a' };
const other = { projectDir: root, chatId: 'chat-b' };
const nested = { projectDir: root, chatId: 'chat-a', invocationId: 'child' };

function boot(bootId, now) {
  return createRegistry({ now, store: createJobStore({ getDb: settings.getDb, bootId, now }) });
}

let clock = 1_000_000;
const first = boot('boot-1', () => clock);
const done = first.create(scope, { workingDir: root, logPath: '.mouaif/logs/done.log' });
const running = first.create(scope, { workingDir: root, logPath: '.mouaif/logs/running.log' });
const foreign = first.create(other, { workingDir: root });
first.attach(scope, running.jobId, { pid: 4242 });
first.settle(scope, done.jobId, { state: 'failed', exitCode: 3 });

// "Restart": a new process opens the same database with a new boot id.
clock += 5000;
const second = boot('boot-2', () => clock);

const finished = second.get(scope, done.jobId);
assert.equal(finished.state, 'failed');
assert.equal(finished.exitCode, 3);
assert.equal(finished.logPath, '.mouaif/logs/done.log');

const lost = second.get(scope, running.jobId);
assert.equal(lost.state, 'lost', 'a job running at restart is lost');
assert.equal(lost.pid, 4242);
assert.equal(lost.finishedAt, clock);
assert.equal(lost.workingDir, root);

// Scope rules still hold for recovered jobs.
for (const stranger of [other, nested, { projectDir: root + '-x', chatId: 'chat-a' }]) {
  assert.throws(() => second.get(stranger, done.jobId), { code: 'ENOTARGET' });
}
assert.deepEqual(second.list(scope).map((job) => job.jobId).sort(), [done.jobId, running.jobId].sort());
assert.deepEqual(second.list(other).map((job) => job.jobId), [foreign.jobId], 'the other chat has its own job (also lost)');
assert.equal(second.get(other, foreign.jobId).state, 'lost');
assert.deepEqual(second.list(nested), []);

// A job started after the restart is live and listed beside recovered ones.
const fresh = second.create(scope, { workingDir: root });
assert.equal(second.list(scope).length, 3);
assert.equal(second.get(scope, fresh.jobId).state, 'running');
// Opening the store again in the same boot must not mark live jobs lost.
const again = createRegistry({ store: createJobStore({ getDb: settings.getDb, bootId: 'boot-2', now: () => clock }) });
assert.equal(again.get(scope, fresh.jobId).state, 'running');

// Waits see a lost job as settled, so a wait never hangs on it.
const { createWaitRegistry } = require('../src/tools/waits.js');
const waits = createWaitRegistry({ jobRegistry: second });
waits.wait({ scope, until: 'shell:' + running.jobId, timeoutMs: 1000 }).then((result) => {
  assert.equal(result.satisfied, true);
  assert.equal(result.outcome, 'lost');

  // Finished jobs are pruned after the retention window.
  clock += 25 * 60 * 60 * 1000;
  const third = boot('boot-3', () => clock);
  assert.throws(() => third.get(scope, done.jobId), { code: 'ENOTARGET' });
  assert.deepEqual(third.list(scope).map((job) => [job.jobId, job.state]), [[fresh.jobId, 'lost']], 'only the job running at the last restart is kept');

  // Without a usable database the registry still works in memory.
  const memoryOnly = createRegistry({ store: createJobStore({ getDb() { throw new Error('no db'); } }) });
  const job = memoryOnly.create(scope, { workingDir: root });
  assert.equal(memoryOnly.get(scope, job.jobId).state, 'running');

  console.log('job store: persistence, lost on restart, scope, retention and no-db fallback passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
const keepAlive = setInterval(() => {}, 1000);
