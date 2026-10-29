'use strict';

// Durable copy of the background job registry (src/tools/backgroundJobs.js).
//
// The registry keeps live handles in memory; this store writes each job's
// metadata through to the app SQLite store so a job can still be looked
// up after a restart. It holds metadata only: no output, command
// text, credentials or process handles. A job that was `running` when its
// process died is marked `lost` the first time the store is opened by the
// next process, because mouaif reaps its background children on exit and the
// real outcome is unknown. The log file on disk is the record of what ran.
const { randomUUID } = require('node:crypto');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const BOOT_ID = randomUUID();

const CREATE = `
  CREATE TABLE IF NOT EXISTS background_job (
    job_id      TEXT PRIMARY KEY,
    scope       TEXT NOT NULL,
    state       TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code   INTEGER,
    signal      TEXT,
    log_path    TEXT,
    working_dir TEXT,
    pid         INTEGER,
    boot_id     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_background_job_scope ON background_job (scope, started_at)
`;

function rowToJob(row) {
  return { jobId: row.job_id, state: row.state, startedAt: row.started_at, finishedAt: row.finished_at,
    exitCode: row.exit_code, signal: row.signal, logPath: row.log_path, workingDir: row.working_dir,
    pid: row.pid };
}

// createJobStore({ getDb, now }) -> { save, get, list, reconcile, available }
//
// `getDb` returns the shared app database. Every method is best-effort: a
// store that cannot be opened (a test process without MOUAIF_HOME, a locked
// database) turns persistence off instead of failing the command that was
// being tracked.
function createJobStore({ getDb = () => require('../settings.js').getDb(), now = Date.now,
  retentionMs = RETENTION_MS, bootId = BOOT_ID } = {}) {
  let db = null;
  let broken = false;
  function open() {
    if (db || broken) return db;
    try {
      const handle = getDb();
      handle.exec(CREATE);
      db = handle;
      const lost = now();
      handle.prepare("UPDATE background_job SET state = 'lost', finished_at = ? WHERE state = 'running' AND boot_id != ?")
        .run(lost, bootId);
      handle.prepare('DELETE FROM background_job WHERE finished_at IS NOT NULL AND finished_at <= ?')
        .run(lost - retentionMs);
    } catch { broken = true; db = null; }
    return db;
  }
  function guard(fn, fallback) {
    const handle = open();
    if (!handle) return fallback;
    try { return fn(handle); } catch { return fallback; }
  }
  return {
    available() { return !!open(); },
    save(job) {
      guard((handle) => handle.prepare(`
        INSERT INTO background_job (job_id, scope, state, started_at, finished_at, exit_code, signal, log_path, working_dir, pid, boot_id)
        VALUES (@jobId, @scope, @state, @startedAt, @finishedAt, @exitCode, @signal, @logPath, @workingDir, @pid, @bootId)
        ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at,
          exit_code = excluded.exit_code, signal = excluded.signal, pid = excluded.pid`).run({
        jobId: job.jobId, scope: job.scope, state: job.state, startedAt: job.startedAt,
        finishedAt: job.finishedAt == null ? null : job.finishedAt, exitCode: job.exitCode == null ? null : job.exitCode,
        signal: job.signal || null, logPath: job.logPath || null, workingDir: job.workingDir || null,
        pid: job.pid == null ? null : job.pid, bootId }));
    },
    // Rows are returned only to the scope that owns them.
    get(scope, jobId) {
      return guard((handle) => {
        const row = handle.prepare('SELECT * FROM background_job WHERE job_id = ? AND scope = ?').get(jobId, scope);
        return row ? rowToJob(row) : null;
      }, null);
    },
    list(scope) {
      return guard((handle) => handle.prepare('SELECT * FROM background_job WHERE scope = ? ORDER BY started_at')
        .all(scope).map(rowToJob), []);
    }
  };
}

module.exports = { createJobStore, RETENTION_MS, BOOT_ID };
