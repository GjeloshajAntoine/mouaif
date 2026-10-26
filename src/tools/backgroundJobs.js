'use strict';

// Live handles are process-local metadata only: no output, credentials,
// ChildProcess or callbacks. An optional `store` (src/tools/jobStore.js)
// writes the same metadata through to the app database, so a job can still be
// looked up after a restart (as `lost` if it was running when the process
// died). Callers must pass the owning project/chat, never just a guessed job ID.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { err } = require('../util.js');
const RETENTION_MS = 60 * 60 * 1000;
const MAX_JOBS = 2048;

function createRegistry({ now = Date.now, retentionMs = RETENTION_MS, maxJobs = MAX_JOBS, store = null } = {}) {
  const jobs = new Map();
  function scopeOf(scope) {
    if (!scope || typeof scope.projectDir !== 'string' || !path.isAbsolute(scope.projectDir)
    || (scope.chatId != null && typeof scope.chatId !== 'string')
    || (scope.invocationId != null && typeof scope.invocationId !== 'string')) {
    throw err('EBADINPUT', 'Background jobs require an absolute owning project directory and optional string chat/invocation IDs');
    }
    // Match settings.canonicalProjectDir: lexical absolute path, not realpath.
    // Nested callers share a transcript chat but not an execution identity.
    return JSON.stringify([path.resolve(scope.projectDir), scope.chatId || '', scope.invocationId || '']);
  }
  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (job.finishedAt != null && job.finishedAt <= cutoff) jobs.delete(id);
    }
  }
  function find(scope, jobId) {
    prune();
    const key = scopeOf(scope);
    const job = jobs.get(jobId);
    if (job) {
      if (job.scope !== key) throw err('ENOTARGET', 'Unknown or expired background job');
      return job;
    }
    // Not live in this process: a job from before a restart, or one whose
    // in-memory handle expired. The store only answers for the owning scope.
    const saved = store && store.get(key, jobId);
    if (!saved) throw err('ENOTARGET', 'Unknown or expired background job');
    return { ...saved, scope: key };
  }
  function snapshot(job) {
    const { scope, ...value } = job;
    return { ...value };
  }
  return {
    create(scope, metadata) {
      const key = scopeOf(scope);
      prune();
      // Never evict an active job or an unexpired terminal handle. Reject
      // before spawning instead, making the retention promise deterministic.
      if (jobs.size >= maxJobs) throw err('ETOOL_CAP', 'Background job registry is full; retry after terminal handles expire');
      const job = {
        scope: key, jobId: 'job-' + randomUUID(), state: 'running',
        startedAt: now(), finishedAt: null, exitCode: null, signal: null,
        logPath: metadata.logPath || null, workingDir: metadata.workingDir, pid: null
      };
      jobs.set(job.jobId, job);
      if (store) store.save(job);
      return snapshot(job);
    },
    // Record facts learned after the process started (its pid).
    attach(scope, jobId, fields) {
      const job = find(scope, jobId);
      if (fields && fields.pid != null) job.pid = fields.pid;
      if (store && jobs.has(jobId)) store.save(job);
      return snapshot(job);
    },
    settle(scope, jobId, outcome) {
      const job = find(scope, jobId);
      if (job.state !== 'running') return snapshot(job);
      if (!['completed', 'failed', 'cancelled'].includes(outcome.state)) {
        throw err('EBADINPUT', 'Invalid terminal background job state');
      }
      Object.assign(job, {
        state: outcome.state, finishedAt: now(),
        exitCode: outcome.exitCode == null ? null : outcome.exitCode,
        signal: outcome.signal || null
      });
      if (store) store.save(job);
      return snapshot(job);
    },
    get(scope, jobId) { return snapshot(find(scope, jobId)); },
    list(scope) {
      const key = scopeOf(scope);
      prune();
      const live = Array.from(jobs.values()).filter((job) => job.scope === key);
      const seen = new Set(live.map((job) => job.jobId));
      const saved = store ? store.list(key).filter((job) => !seen.has(job.jobId)).map((job) => ({ ...job, scope: key })) : [];
      return [...saved, ...live].map(snapshot);
    }
  };
}

const registry = createRegistry({ store: require('./jobStore.js').createJobStore() });
module.exports = { ...registry, createRegistry, RETENTION_MS, MAX_JOBS };
