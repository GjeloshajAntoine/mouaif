'use strict';

// Scheduled wake-ups and recurring tasks: a durable "wake this chat later" queue.
//
// A schedule is a row in the app database naming a chat, a message and a due
// time (optionally repeating, optionally also due when a background job
// settles). A repeating row is either a fixed interval or a wall-clock time
// ("weekdays at 09:00" in a timezone) and keeps going until it is cancelled or
// reaches its optional count or end date. A single unref'd ticker looks for due
// rows and starts a normal persisted turn in the chat with the message,
// through the same runner `start_chat` uses, so the woken turn has the chat's
// own model, prompt, tool permissions, history and cancellation. A wake that
// was due while mouaif was down fires once on the next start. A repeating
// schedule never replays missed slots and never overlaps itself: a slot that
// comes due while the previous turn still streams waits for it to finish, and
// the next slot is the first one after that.
const { randomUUID } = require('node:crypto');
const { err } = require('./util.js');

const MIN_DELAY_MS = 10 * 1000;
const MIN_EVERY_MS = 60 * 1000;
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_CHAT = 20;
const MAX_RUNS = 10000;
const MAX_MESSAGE_CHARS = 4000;
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
    last_error  TEXT,
    anchor_at   INTEGER,
    until_at    INTEGER,
    spec        TEXT
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

const DAY_NAMES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

function localZone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }

// Milliseconds the zone is ahead of UTC at the instant `utcMs`.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs))) parts[p.type] = Number(p.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(utcMs / 1000) * 1000;
}

// The UTC instant at which the wall clock in `timeZone` reads y-mo-d h:mi. A
// time skipped by a clock change lands just after the gap.
function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

// parseClock({ time: "09:00", days?: ["mon", ...], timezone? }) -> spec
function parseClock({ time, days, timezone } = {}) {
  const m = typeof time === 'string' ? time.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/) : null;
  if (!m) throw err('EBADINPUT', '`time` must be a 24-hour clock time such as "09:00"');
  const tz = timezone == null ? localZone() : String(timezone);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw err('EBADINPUT', 'Unknown timezone "' + tz + '": use an IANA name such as "Europe/Brussels" or "UTC"'); }
  let set = [0, 1, 2, 3, 4, 5, 6];
  if (days != null) {
    if (!Array.isArray(days) || !days.length) throw err('EBADINPUT', '`days` must list at least one of ' + DAY_NAMES.join(', '));
    set = [...new Set(days.map((d) => DAY_NAMES.indexOf(String(d).toLowerCase().slice(0, 3))))].sort();
    if (set.some((i) => i < 0)) throw err('EBADINPUT', '`days` may only contain ' + DAY_NAMES.join(', '));
  }
  return { time: String(Number(m[1])).padStart(2, '0') + ':' + m[2], days: set, tz };
}

// The first slot of a clock schedule strictly after `afterMs`, or null.
function nextClockSlot(spec, afterMs) {
  const [h, mi] = spec.time.split(':').map(Number);
  const local = new Date(afterMs + zoneOffsetMs(afterMs, spec.tz));
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    if (!spec.days.includes(day.getUTCDay())) continue;
    const slot = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, spec.tz);
    if (slot > afterMs) return slot;
  }
  return null;
}

// The next slot of a repeating row after `time`. Slots stay on the planned
// grid (no drift) and missed ones are skipped, never replayed.
function nextSlot(row, time) {
  const anchor = row.anchorAt || row.dueAt;
  if (row.spec) return nextClockSlot(row.spec, Math.max(time, anchor));
  if (!row.everyMs) return null;
  return anchor + (Math.floor(Math.max(0, time - anchor) / row.everyMs) + 1) * row.everyMs;
}

function describeRepeat(row) {
  if (row.spec) {
    const days = row.spec.days;
    const label = days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends'
      : days.map((d) => DAY_NAMES[d]).join(', ');
    return label + ' at ' + row.spec.time + ' (' + row.spec.tz + ')';
  }
  if (!row.everyMs) return null;
  const ms = row.everyMs;
  for (const [unit, word, size] of [['d', 'day', UNITS.d], ['h', 'hour', UNITS.h], ['m', 'minute', UNITS.m], ['s', 'second', UNITS.s]]) {
    if (ms % size === 0) return ms === size ? 'Every ' + word : 'Every ' + ms / size + unit;
  }
  return 'Every ' + Math.round(ms / 1000) + 's';
}

function rowToSchedule(row) {
  return { id: row.id, projectDir: row.project_dir, chatId: row.chat_id, message: row.message, dueAt: row.due_at,
    everyMs: row.every_ms, runsLeft: row.runs_left, jobId: row.job_id, jobScope: row.job_scope ? JSON.parse(row.job_scope) : null,
    status: row.status, createdAt: row.created_at, lastRunAt: row.last_run_at, runCount: row.run_count,
    attempts: row.attempts, lastError: row.last_error, anchorAt: row.anchor_at, untilAt: row.until_at,
    spec: row.spec ? JSON.parse(row.spec) : null };
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
      const columns = new Set(handle.prepare('PRAGMA table_info(wake_schedule)').all().map((c) => c.name));
      for (const [name, type] of [['anchor_at', 'INTEGER'], ['until_at', 'INTEGER'], ['spec', 'TEXT']]) {
        if (!columns.has(name)) handle.exec('ALTER TABLE wake_schedule ADD COLUMN ' + name + ' ' + type);
      }
      handle.prepare("DELETE FROM wake_schedule WHERE status != 'pending' AND COALESCE(last_run_at, created_at) <= ?")
        .run(now() - KEEP_FINISHED_MS);
      db = handle;
      return db;
    } catch (e) { throw err('ESTORE', 'Schedule store unavailable: ' + (e && e.message)); }
  }
  return {
    // A repeating schedule (an interval or a clock spec) replaces the chat's
    // existing one: a chat has one recurring task, and any number of one-off wakes.
    create(schedule) {
      const d = open();
      const repeats = !!(schedule.everyMs || schedule.spec);
      let replaced = 0;
      if (repeats) {
        replaced = d.prepare("UPDATE wake_schedule SET status = 'cancelled', last_error = 'replaced by a new recurring task' WHERE project_dir = ? AND chat_id = ? AND status = 'pending' AND (every_ms IS NOT NULL OR spec IS NOT NULL)")
          .run(schedule.projectDir, schedule.chatId).changes;
      }
      const pending = d.prepare("SELECT COUNT(*) AS n FROM wake_schedule WHERE project_dir = ? AND chat_id = ? AND status = 'pending'")
        .get(schedule.projectDir, schedule.chatId).n;
      if (pending >= MAX_PENDING_PER_CHAT) {
        throw err('ETOOL_CAP', 'This chat already has ' + MAX_PENDING_PER_CHAT + ' pending schedules; cancel one first');
      }
      const id = 'wake-' + randomUUID();
      d.prepare(`INSERT INTO wake_schedule (id, project_dir, chat_id, message, due_at, every_ms, runs_left, job_id, job_scope, status, created_at, anchor_at, until_at, spec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(id, schedule.projectDir, schedule.chatId, schedule.message,
        schedule.dueAt, schedule.everyMs || null, schedule.runsLeft == null ? null : schedule.runsLeft,
        schedule.jobId || null, schedule.jobScope ? JSON.stringify(schedule.jobScope) : null, now(),
        schedule.dueAt, schedule.untilAt || null, schedule.spec ? JSON.stringify(schedule.spec) : null);
      return { id, pending: pending + 1, replaced };
    },
    // The chat's pending recurring task, or null.
    recurring(projectDir, chatId) {
      const row = open().prepare("SELECT * FROM wake_schedule WHERE project_dir = ? AND chat_id = ? AND status = 'pending' AND (every_ms IS NOT NULL OR spec IS NOT NULL) ORDER BY due_at LIMIT 1")
        .get(projectDir, chatId);
      return row ? rowToSchedule(row) : null;
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
      const repeats = !!(row.everyMs || row.spec);
      const next = repeats && (row.runsLeft == null || row.runsLeft > 1) ? nextSlot(row, time) : null;
      const recurring = next != null && (row.untilAt == null || next <= row.untilAt);
      open().prepare('UPDATE wake_schedule SET status = ?, due_at = ?, anchor_at = ?, runs_left = ?, run_count = run_count + 1, attempts = 0, last_run_at = ?, last_error = NULL, job_id = NULL, job_scope = NULL WHERE id = ?')
        .run(recurring ? 'pending' : 'done', recurring ? next : row.dueAt, recurring ? next : (row.anchorAt || row.dueAt),
          row.runsLeft == null ? null : row.runsLeft - 1, time, row.id);
      return recurring ? 'pending' : 'done';
    },
    // The end date passed before this slot could run: finish without firing.
    expire(row) {
      open().prepare("UPDATE wake_schedule SET status = 'done', last_error = 'ended: past its end date' WHERE id = ? AND status = 'pending'").run(row.id);
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

// A recurring task starts every run with exactly its prompt: the earlier runs
// are already in the chat. A one-off wake is labelled, so the assistant knows
// the message came from its own schedule.
function wakeText(row, reason, jobState) {
  if ((row.everyMs || row.spec) && reason !== 'job') return row.message;
  const bits = ['Scheduled wake-up'];
  if (row.everyMs || row.spec) bits.push('repeating, run ' + (row.runCount + 1) + (row.runsLeft != null ? ' of ' + (row.runCount + row.runsLeft) : ''));
  if (reason === 'job' && jobState) bits.push('job ' + row.jobId + ' is ' + jobState.state + (jobState.exitCode != null ? ' (exit ' + jobState.exitCode + ')' : ''));
  return '⏰ ' + bits.join(' · ') + '\n\n' + row.message;
}

// createScheduler({ store, now, startTurn, getChat, getJob, lifecycle }) -> { tick, start, stop }
function finalText(reason) {
  return '\u23f0 Run budget reached \u00b7 ' + reason + '\n\nStop the long-running task now. Summarize what was done, what remains and what the user should decide next. Do not schedule further wake-ups.';
}

// hooks (optional, from src/runs.js):
//   gate(projectDir, chatId)          -> { action: 'send' | 'hold' | 'cancel' | 'final', reason? }
//   delivered(projectDir, chatId, gate) after a wake started a turn
//   onTick()                           once per tick (the run watchdog)
function createScheduler({ store, now = Date.now, startTurn, getChat, getJob, lifecycle = {}, tickMs = TICK_MS, hooks = {} } = {}) {
  let timer = null;
  let ticking = false;
  async function fire(row, reason, jobState) {
    const time = now();
    let chat = null;
    try { chat = getChat(row.projectDir, row.chatId); } catch { chat = null; }
    if (!chat) { store.cancel(row.projectDir, row.chatId, row.id, 'chat no longer exists'); return 'cancelled'; }
    if (!chat.modelId) { store.retry({ ...row, attempts: MAX_ATTEMPTS - 1 }, time, 'the chat has no model selected'); return 'failed'; }
    if (row.untilAt && time > row.untilAt) { store.expire(row); return 'done'; }
    let gate = { action: 'send' };
    if (hooks.gate) { try { gate = hooks.gate(row.projectDir, row.chatId) || gate; } catch { /* a broken gate must not eat wakes */ } }
    if (gate.action === 'hold') { store.release(row, time + 30000); return 'held'; }
    if (gate.action === 'cancel') { store.cancel(row.projectDir, row.chatId, row.id, gate.reason || 'blocked by the run'); return 'cancelled'; }
    store.lease(row.id, time + LEASE_MS);
    let result;
    try {
      result = await startTurn({ projectDir: row.projectDir, chatId: row.chatId, modelId: chat.modelId,
        providerId: chat.providerId || '', content: gate.action === 'final' ? finalText(gate.reason) : wakeText(row, reason, jobState),
        origin: gate.action !== 'final' && (row.everyMs || row.spec) ? { kind: 'schedule', scheduleId: row.id, run: row.runCount + 1 } : undefined }, lifecycle);
    } catch (e) { result = { ok: false, code: e.code || 'EINTERNAL', error: e.message || String(e) }; }
    if (result && result.ok) {
      const settled = store.fired(row, now());
      if (hooks.delivered) { try { hooks.delivered(row.projectDir, row.chatId, gate); } catch { /* accounting only */ } }
      return settled;
    }
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
      if (hooks.onTick) { try { await hooks.onTick(); } catch { /* the watchdog is best-effort */ } }
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
    lifecycle,
    hooks: (() => {
      const manager = require('./runs.js').sharedManager(lifecycle);
      return { gate: (projectDir, chatId) => manager.gate(projectDir, chatId),
        delivered: (projectDir, chatId, gate) => manager.delivered(projectDir, chatId, gate),
        onTick: () => manager.watch() };
    })()
  });
  scheduler.start();
  return scheduler;
}

module.exports = {
  parseDuration, createScheduleStore, createScheduler, startScheduler, sharedStore,
  MIN_DELAY_MS, MIN_EVERY_MS, MAX_HORIZON_MS, MAX_PENDING_PER_CHAT, MAX_RUNS,
  parseClock, nextClockSlot, nextSlot, describeRepeat,
  MAX_MESSAGE_CHARS, MAX_ATTEMPTS, LEASE_MS
};
