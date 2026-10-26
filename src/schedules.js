'use strict';

// Scheduled wake-ups: a durable "wake this chat later" queue.
//
// A schedule is a row in the app database naming a chat, a message and a due
// time (optionally repeating, optionally also due when a background job
// settles). A single unref'd ticker looks for due rows and starts a normal
// persisted turn in the chat with the message, through the same runner
// `start_chat` uses, so the woken turn has the chat's own model, prompt,
// tool permissions and cancellation. A wake that was due while mouaif was
// down fires once on the next start; a repeating schedule is re-armed from
// "now", never replayed.
const { randomUUID } = require('node:crypto');
const { err } = require('./util.js');

const MIN_DELAY_MS = 10 * 1000;
const MIN_EVERY_MS = 60 * 1000;
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_CHAT = 20;
const MAX_RUNS = 100;
const DEFAULT_RECURRING_RUNS = 10;
const MAX_MESSAGE_CHARS = 2000;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60 * 1000;
const TICK_MS = 5000;
const MAX_FIRED_PER_TICK = 5;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

const CREATE = `
  CREATE TABLE IF NOT EXISTS wake_schedule (
    id          TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    message     TEXT NOT NULL,
    due_at      INTEGER NOT NULL,
    every_ms    INTEGER,
    runs_left   INTEGER,
    job_id      TEXT,
    job_scope   TEXT,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_run_at INTEGER,
    run_count   INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wake_schedule_due ON wake_schedule (status, due_at);
  CREATE INDEX IF NOT EXISTS idx_wake_schedule_chat ON wake_schedule (project_dir, chat_id, status)
`;

const UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

// parseDuration("90s" | "15m" | "2h" | "1d" | "1h30m" | 45) -> milliseconds.
// A bare number means seconds. Anything else is an error, never a guess.
function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value * 1000);
  if (typeof value !== 'string' || !value.trim()) throw err('EBADINPUT', 'A duration like "90s", "15m", "2h" or "1d" is required');
  const text = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const parts = text.match(/^(\d+(?:\.\d+)?[smhd])+$/);
  if (!parts) throw err('EBADINPUT', 'Invalid duration "' + value + '": use units s, m, h or d, for example "90s", "15m", "1h30m"');
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += Number(amount) * UNITS[unit];
  if (!(total > 0)) throw err('EBADINPUT', 'Duration must be positive');
  return Math.round(total);
}

function rowToSchedule(row) {
  return { id: row.id, projectDir: row.project_dir, chatId: row.chat_id, message: row.message, dueAt: row.due_at,
    everyMs: row.every_ms, runsLeft: row.runs_left, jobId: row.job_id, jobScope: row.job_scope ? JSON.parse(row.job_scope) : null,
    status: row.status, createdAt: row.created_at, lastRunAt: row.last_run_at, runCount: row.run_count,
    attempts: row.attempts, lastError: row.last_error };
}

// createScheduleStore({ getDb, now }) -> store. Methods throw ESTORE when the
// database cannot be opened; the scheduler treats that as "nothing due".
function createScheduleStore({ getDb = () => require('./settings.js').getDb(), now = Date.now } = {}) {
  let db = null;
  function open() {
    if (db) return db;
    try {
      const handle = getDb();
      handle.exec(CREATE);
      handle.prepare("DELETE FROM wake_schedule WHERE status != 'pending' AND COALESCE(last_run_at, created_at) <= ?")
        .run(now() - KEEP_FINISHED_MS);
      db = handle;
      return db;
    } catch (e) { throw err('ESTORE', 'Schedule store unavailable: ' + (e && e.message)); }
  }
  return {
    create(schedule) {
      const d = open();
      const pending = d.prepare("SELECT COUNT(*) AS n FROM wake_schedule WHERE project_dir = ? AND chat_id = ? AND status = 'pending'")
        .get(schedule.projectDir, schedule.chatId).n;
      if (pending >= MAX_PENDING_PER_CHAT) {
        throw err('ETOOL_CAP', 'This chat already has ' + MAX_PENDING_PER_CHAT + ' pending schedules; cancel one first');
      }
      const id = 'wake-' + randomUUID();
      d.prepare(`INSERT INTO wake_schedule (id, project_dir, chat_id, message, due_at, every_ms, runs_left, job_id, job_scope, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, schedule.projectDir, schedule.chatId, schedule.message,
        schedule.dueAt, schedule.everyMs || null, schedule.runsLeft == null ? null : schedule.runsLeft,
        schedule.jobId || null, schedule.jobScope ? JSON.stringify(schedule.jobScope) : null, now());
      return { id, pending: pending + 1 };
    },
    get(projectDir, chatId, id) {
      const row = open().prepare('SELECT * FROM wake_schedule WHERE id = ? AND project_dir = ? AND chat_id = ?').get(id, projectDir, chatId);
      return row ? rowToSchedule(row) : null;
    },
    list(projectDir, chatId) {
      return open().prepare("SELECT * FROM wake_schedule WHERE project_dir = ? AND chat_id = ? AND status = 'pending' ORDER BY due_at")
        .all(projectDir, chatId).map(rowToSchedule);
    },
    cancel(projectDir, chatId, id, reason = 'cancelled') {
      const result = open().prepare("UPDATE wake_schedule SET status = 'cancelled', last_error = ? WHERE id = ? AND project_dir = ? AND chat_id = ? AND status = 'pending'")
        .run(reason === 'cancelled' ? null : reason, id, projectDir, chatId);
      return result.changes > 0;
    },
    // Pending rows that are due by the clock, or that wait on a job.
    candidates(time) {
      return open().prepare("SELECT * FROM wake_schedule WHERE status = 'pending' AND (due_at <= ? OR job_id IS NOT NULL) ORDER BY due_at")
        .all(time).map(rowToSchedule);
    },
    // Push the due time out so a crash mid-delivery re-fires later, not never.
    lease(id, until) {
      return open().prepare("UPDATE wake_schedule SET due_at = ? WHERE id = ? AND status = 'pending'").run(until, id).changes > 0;
    },
    fired(row, time) {
      const recurring = row.everyMs && (row.runsLeft == null || row.runsLeft > 1);
      open().prepare('UPDATE wake_schedule SET status = ?, due_at = ?, runs_left = ?, run_count = run_count + 1, attempts = 0, last_run_at = ?, last_error = NULL, job_id = NULL, job_scope = NULL WHERE id = ?')
        .run(recurring ? 'pending' : 'done', recurring ? time + row.everyMs : row.dueAt,
          row.runsLeft == null ? null : row.runsLeft - 1, time, row.id);
      return recurring ? 'pending' : 'done';
    },
    retry(row, time, message) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      open().prepare('UPDATE wake_schedule SET status = ?, attempts = ?, due_at = ?, last_error = ? WHERE id = ?')
        .run(failed ? 'failed' : 'pending', attempts, time + 30000 * attempts, String(message).slice(0, 500), row.id);
      return failed ? 'failed' : 'pending';
    },
    release(row, time) {
      // The chat is busy: try again soon without counting an attempt.
      open().prepare('UPDATE wake_schedule SET due_at = ? WHERE id = ?').run(time, row.id);
    }
  };
}

function wakeText(row, reason, jobState) {
  const bits = ['Scheduled wake-up'];
  if (row.everyMs) bits.push('repeating, run ' + (row.runCount + 1) + (row.runsLeft != null ? ' of ' + (row.runCount + row.runsLeft) : ''));
  if (reason === 'job' && jobState) bits.push('job ' + row.jobId + ' is ' + jobState.state + (jobState.exitCode != null ? ' (exit ' + jobState.exitCode + ')' : ''));
  return '⏰ ' + bits.join(' · ') + '\n\n' + row.message;
}

// createScheduler({ store, now, startTurn, getChat, getJob, lifecycle }) -> { tick, start, stop }
function createScheduler({ store, now = Date.now, startTurn, getChat, getJob, lifecycle = {}, tickMs = TICK_MS } = {}) {
  let timer = null;
  let ticking = false;
  async function fire(row, reason, jobState) {
    const time = now();
    let chat = null;
    try { chat = getChat(row.projectDir, row.chatId); } catch { chat = null; }
    if (!chat) { store.cancel(row.projectDir, row.chatId, row.id, 'chat no longer exists'); return 'cancelled'; }
    if (!chat.modelId) { store.retry({ ...row, attempts: MAX_ATTEMPTS - 1 }, time, 'the chat has no model selected'); return 'failed'; }
    store.lease(row.id, time + LEASE_MS);
    let result;
    try {
      result = await startTurn({ projectDir: row.projectDir, chatId: row.chatId, modelId: chat.modelId,
        providerId: chat.providerId || '', content: wakeText(row, reason, jobState) }, lifecycle);
    } catch (e) { result = { ok: false, code: e.code || 'EINTERNAL', error: e.message || String(e) }; }
    if (result && result.ok) return store.fired(row, now());
    if (result && result.code === 'EALREADY_RUNNING') { store.release(row, now() + 15000); return 'busy'; }
    return store.retry(row, now(), (result && (result.error || result.code)) || 'could not start the chat');
  }
  async function tick() {
    if (ticking) return [];
    ticking = true;
    const outcomes = [];
    try {
      const time = now();
      let rows;
      try { rows = store.candidates(time); } catch { return outcomes; }
      for (const row of rows) {
        if (outcomes.length >= MAX_FIRED_PER_TICK) break;
        let reason = row.dueAt <= time ? 'time' : null;
        let jobState = null;
        if (row.jobId && row.jobScope) {
          try { jobState = getJob(row.jobScope, row.jobId); } catch { jobState = { state: 'lost' }; }
          if (!reason && jobState.state !== 'running') reason = 'job';
        }
        if (!reason) continue;
        outcomes.push({ id: row.id, outcome: await fire(row, reason, jobState), reason });
      }
    } finally { ticking = false; }
    return outcomes;
  }
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      timer.unref();
      // Wakes that came due while mouaif was down fire once, promptly.
      const first = setTimeout(() => { tick().catch(() => {}); }, 1000);
      first.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

let shared = null;
function sharedStore() {
  if (!shared) shared = createScheduleStore();
  return shared;
}

// startScheduler({ lifecycle }) -> scheduler. Wires the real chat runner.
function startScheduler({ lifecycle } = {}) {
  const scheduler = createScheduler({
    store: sharedStore(),
    startTurn: (body, life) => require('./server-handlers-chats.js').startChatTurn(body, life),
    getChat: (projectDir, chatId) => require('./chats.js').getChat(projectDir, chatId),
    getJob: (scope, jobId) => require('./tools/backgroundJobs.js').get(scope, jobId),
    lifecycle
  });
  scheduler.start();
  return scheduler;
}

module.exports = {
  parseDuration, createScheduleStore, createScheduler, startScheduler, sharedStore,
  MIN_DELAY_MS, MIN_EVERY_MS, MAX_HORIZON_MS, MAX_PENDING_PER_CHAT, MAX_RUNS, DEFAULT_RECURRING_RUNS,
  MAX_MESSAGE_CHARS, MAX_ATTEMPTS, LEASE_MS
};
