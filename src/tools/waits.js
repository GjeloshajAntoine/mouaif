'use strict';

// Internal foundation only; intentionally not advertised/authorized as a tool.
const jobs = require('./backgroundJobs.js');
const { err } = require('../util.js');
const MAX_TIMEOUT_MS = 240000;
const MIN_INTERVAL_MS = 100;
const MAX_WAITS = 256;

function createWaitRegistry({ now = Date.now, jobRegistry = jobs, tickMs = 50, maxWaits = MAX_WAITS } = {}) {
  const pending = new Set();
  let ticker = null;
  function stopIfEmpty() {
    if (!pending.size && ticker) { clearInterval(ticker); ticker = null; }
  }
  function settle(wait, result) {
    if (!pending.delete(wait)) return;
    if (wait.signal) wait.signal.removeEventListener('abort', wait.onAbort);
    stopIfEmpty();
    wait.resolve({ target: wait.target, waitedMs: Math.max(0, now() - wait.startedAt),
      polls: wait.polls, satisfied: false, timedOut: false, ...result });
  }
  function check(wait) {
    if (!pending.has(wait)) return;
    const time = now();
    if (wait.signal && wait.signal.aborted) {
      settle(wait, { ok: false, cancelled: true, reason: 'cancelled' });
      return;
    }
    if (wait.target === 'duration') {
      if (time >= wait.deadline) settle(wait, { ok: true, satisfied: true });
      return;
    }
    // Timeout is authoritative. No late observation extends the budget.
    if (time >= wait.deadline) {
      settle(wait, { ok: true, timedOut: true, reason: 'timeout' });
      return;
    }
    if (time < wait.nextCheck) return;
    wait.polls++;
    wait.nextCheck = time + wait.intervalMs;
    try {
      const job = jobRegistry.get(wait.scope, wait.jobId);
      if (job.state !== 'running') {
        settle(wait, { ok: true, satisfied: true, detail: job, outcome: job.state });
      }
    } catch (e) {
      settle(wait, { ok: false, error: { code: e.code || 'ENOTARGET', message: e.message } });
    }
  }
  function tick() { for (const wait of pending) check(wait); }
  return {
    wait({ scope, until, timeoutMs = 180000, intervalMs = 5000, signal } = {}) {
      if (typeof until !== 'string' || !until.trim()) throw err('EBADINPUT', 'until is required');
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(intervalMs) || intervalMs < 1) {
        throw err('EBADINPUT', 'Wait timeout and poll interval must be positive finite numbers');
      }
      const duration = until === 'duration';
      const jobId = until.startsWith('shell:') ? until.slice(6) : '';
      if (!duration && !jobId) {
        // In particular, recursive chat/subagent/group waits are not safe
        // without a landed server-owned execution graph adapter.
        throw err('EUNSUPPORTED', 'Only duration and scoped shell job waits are implemented');
      }
      if (pending.size >= maxWaits) throw err('ETOOL_CAP', 'Too many pending waits');
      if (signal && signal.aborted) return Promise.resolve({ ok: false, target: until,
        satisfied: false, timedOut: false, cancelled: true, reason: 'cancelled', waitedMs: 0, polls: 0 });
      // Validate ownership before retaining anything. A nested invocation
      // cannot see a parent's job just because it shares the transcript chat.
      if (!duration) jobRegistry.get(scope, jobId);
      return new Promise((resolve) => {
        const startedAt = now();
        const wait = { scope: scope && { ...scope }, target: until, jobId, signal, resolve, startedAt,
          deadline: startedAt + Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs)),
          intervalMs: Math.max(MIN_INTERVAL_MS, Math.min(MAX_TIMEOUT_MS, Math.round(intervalMs))),
          nextCheck: startedAt, polls: 0 };
        wait.onAbort = () => settle(wait, { ok: false, cancelled: true, reason: 'cancelled' });
        pending.add(wait);
        if (signal) signal.addEventListener('abort', wait.onAbort, { once: true });
        check(wait);
        if (pending.size && !ticker) {
          ticker = setInterval(tick, tickMs);
          ticker.unref();
        }
      });
    },
    // Explicit scope required by the job registry; no logs/output read.
    check(scope) { return { ok: true, backgroundCommands: jobRegistry.list(scope) }; },
    tick,
    pendingCount() { return pending.size; },
    hasTicker() { return !!ticker; }
  };
}

module.exports = { createWaitRegistry, MAX_TIMEOUT_MS, MIN_INTERVAL_MS, MAX_WAITS };
