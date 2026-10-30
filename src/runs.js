'use strict';

// Long-running runs: a budget, user controls and a watchdog for a chat that
// keeps working across many turns (scheduled wake-ups, recurring tasks).
//
// A run is one row per chat in the app database. A recurring task opens one
// automatically (startRecurring) with limits sized to its schedule; the user
// can pause, resume or stop it from the chat, and mouaif enforces it at turn
// boundaries: the scheduler asks the manager before delivering each wake. A
// plain run that goes quiet without a next step is nudged, then marked stalled;
// a recurring task has its schedule as the next step and simply ends when the
// schedule does. Nothing here interrupts a turn that is already streaming,
// except the user's explicit Stop.
const { err } = require('./util.js');

const ACTIVE = Object.freeze(['running', 'paused']);
const DEFAULT_MAX_TURNS = 50;
const MAX_TURNS = 500;
const DEFAULT_MAX_HOURS = 24;
const MAX_HOURS = 168;
const MAX_GOAL_CHARS = 500;
const MAX_SUMMARY_CHARS = 2000;
const IDLE_NUDGE_MS = 10 * 60 * 1000;
const MAX_NUDGES = 3;
// An open-ended recurring task gets a year and a large turn allowance; a stricter
// maxRuns / until / maxCostUsd from the schedule replaces them.
const RECURRING_MAX_TURNS = 100000;
const RECURRING_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const KEEP_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

const CREATE = `
  CREATE TABLE IF NOT EXISTS agent_run (
    project_dir TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    goal        TEXT NOT NULL,
    status      TEXT NOT NULL,
    max_turns   INTEGER NOT NULL,
    max_cost    REAL,
    deadline_at INTEGER NOT NULL,
    turns_used  INTEGER NOT NULL DEFAULT 0,
    start_cost  REAL NOT NULL DEFAULT 0,
    nudges      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    end_reason  TEXT,
    summary     TEXT,
    kind        TEXT NOT NULL DEFAULT 'run',
    PRIMARY KEY (project_dir, chat_id)
  )
`;

function rowToRun(row) {
  return { projectDir: row.project_dir, chatId: row.chat_id, goal: row.goal, status: row.status,
    maxTurns: row.max_turns, maxCost: row.max_cost, deadlineAt: row.deadline_at, turnsUsed: row.turns_used,
    startCost: row.start_cost, nudges: row.nudges, createdAt: row.created_at, updatedAt: row.updated_at,
    endedAt: row.ended_at, endReason: row.end_reason, summary: row.summary, kind: row.kind || 'run' };
}

function createRunStore({ getDb = () => require('./settings.js').getDb(), now = Date.now } = {}) {
  let db = null;
  function open() {
    if (db) return db;
    try {
      const handle = getDb();
      handle.exec(CREATE);
      if (!handle.prepare('PRAGMA table_info(agent_run)').all().some((c) => c.name === 'kind')) {
        handle.exec("ALTER TABLE agent_run ADD COLUMN kind TEXT NOT NULL DEFAULT 'run'");
      }
      handle.prepare("DELETE FROM agent_run WHERE status NOT IN ('running', 'paused') AND COALESCE(ended_at, updated_at) <= ?")
        .run(now() - KEEP_ENDED_MS);
      db = handle;
      return db;
    } catch (e) { throw err('ESTORE', 'Run store unavailable: ' + (e && e.message)); }
  }
  return {
    get(projectDir, chatId) {
      const row = open().prepare('SELECT * FROM agent_run WHERE project_dir = ? AND chat_id = ?').get(projectDir, chatId);
      return row ? rowToRun(row) : null;
    },
    // One run per chat: a finished one is replaced, a live one is an error.
    start(run) {
      const d = open();
      const existing = this.get(run.projectDir, run.chatId);
      if (existing && ACTIVE.includes(existing.status)) throw err('EEXISTS', 'This chat already has a ' + existing.status + ' run; call run_end first');
      const time = now();
      d.prepare(`INSERT OR REPLACE INTO agent_run (project_dir, chat_id, goal, status, max_turns, max_cost, deadline_at, turns_used, start_cost, nudges, created_at, updated_at, kind)
        VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, 0, ?, ?, ?)`).run(run.projectDir, run.chatId, run.goal, run.maxTurns,
        run.maxCost == null ? null : run.maxCost, run.deadlineAt, run.startCost || 0, time, time, run.kind || 'run');
      return this.get(run.projectDir, run.chatId);
    },
    // Change the goal and limits of an active run (a recurring task being replaced).
    retarget(projectDir, chatId, { goal, maxTurns, maxCost, deadlineAt, startCost }) {
      open().prepare("UPDATE agent_run SET goal = ?, max_turns = ?, max_cost = ?, deadline_at = ?, start_cost = ?, turns_used = 0, nudges = 0, updated_at = ? WHERE project_dir = ? AND chat_id = ? AND status IN ('running', 'paused')")
        .run(goal, maxTurns, maxCost == null ? null : maxCost, deadlineAt, startCost || 0, now(), projectDir, chatId);
      return this.get(projectDir, chatId);
    },
    // Rename the goal of an active run (the recurring task's prompt was edited).
    setGoal(projectDir, chatId, goal) {
      return open().prepare("UPDATE agent_run SET goal = ?, updated_at = ? WHERE project_dir = ? AND chat_id = ? AND status IN ('running', 'paused')")
        .run(goal, now(), projectDir, chatId).changes > 0;
    },
    // Move an active run to a new status. `from` guards against racing controls.
    setStatus(projectDir, chatId, status, { from = ACTIVE, reason = null, summary = null } = {}) {
      const time = now();
      const ended = !ACTIVE.includes(status);
      const marks = from.map(() => '?').join(', ');
      return open().prepare(`UPDATE agent_run SET status = ?, updated_at = ?, ended_at = ?, end_reason = COALESCE(?, end_reason), summary = COALESCE(?, summary)
        WHERE project_dir = ? AND chat_id = ? AND status IN (${marks})`)
        .run(status, time, ended ? time : null, reason, summary, projectDir, chatId, ...from).changes > 0;
    },
    countTurn(projectDir, chatId) {
      open().prepare("UPDATE agent_run SET turns_used = turns_used + 1, nudges = 0, updated_at = ? WHERE project_dir = ? AND chat_id = ? AND status = 'running'")
        .run(now(), projectDir, chatId);
    },
    countNudge(projectDir, chatId) {
      open().prepare("UPDATE agent_run SET nudges = nudges + 1, turns_used = turns_used + 1, updated_at = ? WHERE project_dir = ? AND chat_id = ? AND status = 'running'")
        .run(now(), projectDir, chatId);
    },
    touch(projectDir, chatId) {
      open().prepare("UPDATE agent_run SET nudges = 0, updated_at = ? WHERE project_dir = ? AND chat_id = ? AND status = 'running'")
        .run(now(), projectDir, chatId);
    },
    running() {
      return open().prepare("SELECT * FROM agent_run WHERE status = 'running'").all().map(rowToRun);
    }
  };
}

// The run bar's one-line goal for a recurring task's prompt.
function goalOf(text) { return String(text || '').trim().replace(/\s+/g, ' ').slice(0, MAX_GOAL_CHARS); }

// createRunManager({ store, now, getCost, scheduleStore, isChatRunning, cancelTurn,
//   startTurn, getChat, notify }) -> manager
function createRunManager({ store, now = Date.now, getCost = () => 0, cancelSchedules = () => 0, hasPendingSchedule = () => false,
  isChatRunning = () => false, cancelTurn = () => false, startTurn, getChat = () => null, notify = () => {}, describeSchedule = () => null,
  idleNudgeMs = IDLE_NUDGE_MS, lifecycle = {} } = {}) {
  const idleSince = new Map();

  function key(run) { return run.projectDir + '\u0000' + run.chatId; }
  function view(run) {
    if (!run) return null;
    const costUsed = Math.max(0, getCost(run.projectDir, run.chatId) - run.startCost);
    const time = now();
    return { goal: run.goal, status: run.status, turnsUsed: run.turnsUsed, maxTurns: run.maxTurns,
      turnsLeft: Math.max(0, run.maxTurns - run.turnsUsed), costUsed: Math.round(costUsed * 10000) / 10000,
      maxCost: run.maxCost, deadlineAt: new Date(run.deadlineAt).toISOString(),
      minutesLeft: Math.max(0, Math.round((run.deadlineAt - time) / 60000)), nudges: run.nudges,
      startedAt: new Date(run.createdAt).toISOString(), endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
      endReason: run.endReason, summary: run.summary, kind: run.kind,
      schedule: run.kind === 'recurring' ? describeSchedule(run.projectDir, run.chatId) : null };
  }
  // Why this run may not take another turn, or null.
  function budgetReason(run) {
    if (run.turnsUsed >= run.maxTurns) return 'turn budget used (' + run.turnsUsed + ' of ' + run.maxTurns + ' turns)';
    if (now() >= run.deadlineAt) return 'time budget used';
    if (run.maxCost != null && getCost(run.projectDir, run.chatId) - run.startCost >= run.maxCost) {
      return 'cost budget used ($' + run.maxCost + ')';
    }
    return null;
  }
  function alert(run, title, body) {
    try { notify({ projectDir: run.projectDir, chatId: run.chatId, title, body }); } catch { /* best-effort */ }
  }

  const manager = {
    view,
    budgetReason,
    get(projectDir, chatId) { return store.get(projectDir, chatId); },

    start(ctx, args) {
      const { projectDir, chatId } = ctx;
      const chat = getChat(projectDir, chatId);
      if (!chat) throw err('ENOTARGET', 'This chat does not exist');
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!goal) throw err('EBADINPUT', 'goal is required');
      if (goal.length > MAX_GOAL_CHARS) throw err('EBADINPUT', 'goal is longer than ' + MAX_GOAL_CHARS + ' characters');
      const maxTurns = args.maxTurns == null ? DEFAULT_MAX_TURNS : args.maxTurns;
      const hours = args.maxHours == null ? DEFAULT_MAX_HOURS : args.maxHours;
      const run = store.start({ projectDir, chatId, goal, maxTurns, maxCost: args.maxCostUsd == null ? null : args.maxCostUsd,
        deadlineAt: now() + hours * 3600 * 1000, startCost: getCost(projectDir, chatId) });
      return view(run);
    },
    status(ctx) {
      const run = store.get(ctx.projectDir, ctx.chatId);
      if (run && run.status === 'running') store.touch(ctx.projectDir, ctx.chatId);
      return view(run);
    },
    // A recurring task opens (or re-targets) the chat's run. Its limits are a safety
    // net sized to the schedule: the count or end date it was given, otherwise a
    // year and a large turn allowance, plus an optional spend cap.
    startRecurring(ctx, args) {
      const { projectDir, chatId } = ctx;
      const goal = goalOf(args.goal);
      const limits = { goal, maxTurns: args.maxRuns == null ? RECURRING_MAX_TURNS : args.maxRuns,
        maxCost: args.maxCostUsd == null ? null : args.maxCostUsd,
        deadlineAt: args.untilAt == null ? now() + RECURRING_MAX_MS : args.untilAt, startCost: getCost(projectDir, chatId) };
      const existing = store.get(projectDir, chatId);
      if (existing && ACTIVE.includes(existing.status)) {
        if (existing.kind === 'recurring') return view(store.retarget(projectDir, chatId, limits));
        return view(existing);
      }
      return view(store.start({ projectDir, chatId, kind: 'recurring', ...limits }));
    },
    // The user changed the recurring task's prompt: keep the run's goal in step.
    setRecurringGoal(projectDir, chatId, message) {
      return store.setGoal(projectDir, chatId, goalOf(message));
    },
    // The recurring task was cancelled by the assistant: close its run quietly.
    closeRecurring(projectDir, chatId, reason) {
      const run = store.get(projectDir, chatId);
      if (!run || run.kind !== 'recurring' || !ACTIVE.includes(run.status)) return false;
      return store.setStatus(projectDir, chatId, 'ended', { reason: reason || 'done' });
    },
    // The assistant says it is done (or cannot continue).
    end(ctx, args) {
      const run = store.get(ctx.projectDir, ctx.chatId);
      if (!run) throw err('ENOTARGET', 'This chat has no run');
      if (!ACTIVE.includes(run.status)) return { ...view(run), alreadyEnded: true };
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, MAX_SUMMARY_CHARS) : '';
      store.setStatus(ctx.projectDir, ctx.chatId, 'ended', { reason: args.outcome || 'done', summary });
      const cancelled = cancelSchedules(ctx.projectDir, ctx.chatId, 'the run ended');
      const ended = store.get(ctx.projectDir, ctx.chatId);
      alert(ended, 'Run ' + (args.outcome || 'done'), run.goal.slice(0, 120));
      return { ...view(ended), schedulesCancelled: cancelled };
    },

    // ---- user controls -------------------------------------------------------
    pause(projectDir, chatId) {
      const ok = store.setStatus(projectDir, chatId, 'paused', { from: ['running'], reason: 'paused by you' });
      if (!ok) throw err('ENOTARGET', 'There is no running run to pause');
      return view(store.get(projectDir, chatId));
    },
    resume(projectDir, chatId) {
      const ok = store.setStatus(projectDir, chatId, 'running', { from: ['paused'] });
      if (!ok) throw err('ENOTARGET', 'There is no paused run to resume');
      store.touch(projectDir, chatId);
      return view(store.get(projectDir, chatId));
    },
    stop(projectDir, chatId) {
      const ok = store.setStatus(projectDir, chatId, 'stopped', { reason: 'stopped by you' });
      if (!ok) throw err('ENOTARGET', 'There is no active run to stop');
      const cancelled = cancelSchedules(projectDir, chatId, 'the run was stopped');
      const turnCancelled = !!cancelTurn(projectDir, chatId);
      return { ...view(store.get(projectDir, chatId)), schedulesCancelled: cancelled, turnCancelled };
    },

    // ---- scheduler hooks -----------------------------------------------------------
    // Decide what to do with a wake that is due. Wakes of chats without a run
    // are unaffected.
    gate(projectDir, chatId) {
      let run;
      try { run = store.get(projectDir, chatId); } catch { return { action: 'send' }; }
      if (!run) return { action: 'send' };
      if (run.status === 'paused') return { action: 'hold' };
      if (run.status !== 'running') return { action: 'cancel', reason: 'the run is ' + run.status };
      const reason = budgetReason(run);
      if (reason) {
        store.setStatus(projectDir, chatId, 'exhausted', { from: ['running'], reason });
        alert(run, 'Run budget reached', run.goal.slice(0, 120) + ' — ' + reason);
        return { action: 'final', reason };
      }
      return { action: 'send' };
    },
    delivered(projectDir, chatId, gate) {
      try {
        if (gate && gate.action === 'final') cancelSchedules(projectDir, chatId, 'the run budget was reached');
        else store.countTurn(projectDir, chatId);
      } catch { /* accounting must not block a delivered wake */ }
    },

    // ---- watchdog ------------------------------------------------------------------
    // A run with nothing streaming, nothing scheduled and no next step has
    // stalled: nudge it, then give up and tell the user.
    async watch() {
      let runs;
      try { runs = store.running(); } catch { return []; }
      const events = [];
      const seen = new Set();
      for (const run of runs) {
        const id = key(run);
        seen.add(id);
        if (isChatRunning(run.projectDir, run.chatId) || hasPendingSchedule(run.projectDir, run.chatId)) { idleSince.delete(id); continue; }
        if (run.kind === 'recurring') {
          // The schedule is the next step. With none left (count or end date
          // reached, or it failed) the task is over; no check-in is needed.
          store.setStatus(run.projectDir, run.chatId, 'ended', { from: ['running'], reason: 'schedule finished' });
          alert(run, 'Recurring task finished', run.goal.slice(0, 120));
          events.push({ chatId: run.chatId, event: 'finished' });
          idleSince.delete(id);
          continue;
        }
        const since = idleSince.get(id) || now();
        idleSince.set(id, since);
        if (now() - since < idleNudgeMs) continue;
        idleSince.set(id, now());
        const reason = budgetReason(run);
        if (reason) {
          store.setStatus(run.projectDir, run.chatId, 'exhausted', { from: ['running'], reason });
          alert(run, 'Run budget reached', run.goal.slice(0, 120) + ' — ' + reason);
          events.push({ chatId: run.chatId, event: 'exhausted' });
          continue;
        }
        if (run.nudges >= MAX_NUDGES) {
          store.setStatus(run.projectDir, run.chatId, 'stalled', { from: ['running'], reason: 'no progress after ' + MAX_NUDGES + ' reminders' });
          cancelSchedules(run.projectDir, run.chatId, 'the run stalled');
          alert(run, 'Run stalled', run.goal.slice(0, 120) + ' — the assistant stopped making progress and needs you.');
          events.push({ chatId: run.chatId, event: 'stalled' });
          continue;
        }
        const chat = getChat(run.projectDir, run.chatId);
        if (!chat || !chat.modelId || typeof startTurn !== 'function') continue;
        let result;
        try {
          result = await startTurn({ projectDir: run.projectDir, chatId: run.chatId, modelId: chat.modelId, providerId: chat.providerId || '',
            content: '⏰ Run check-in · nothing is running or scheduled\n\nYour long-running task is still open: "' + run.goal
              + '"\n\nContinue the work or schedule your next check with schedule_wake. If it is finished or you are blocked, summarize the result and ask the user to stop the run using the run bar.' }, lifecycle);
        } catch (e) { result = { ok: false }; }
        if (result && result.ok) { store.countNudge(run.projectDir, run.chatId); events.push({ chatId: run.chatId, event: 'nudged' }); }
      }
      for (const id of [...idleSince.keys()]) if (!seen.has(id)) idleSince.delete(id);
      return events;
    }
  };
  return manager;
}

let shared = null;
function sharedManager(lifecycle) {
  if (shared) return shared;
  const schedules = require('./schedules.js');
  const chats = require('./chats.js');
  const store = createRunStore();
  const scheduleStore = schedules.sharedStore();
  shared = createRunManager({
    store, lifecycle,
    getCost: (projectDir, chatId) => {
      try { const c = chats.chatTotalCost(projectDir, chatId); return c && c.known !== false ? c.total : (c && c.total) || 0; } catch { return 0; }
    },
    cancelSchedules: (projectDir, chatId, reason) => {
      let n = 0;
      try { for (const row of scheduleStore.list(projectDir, chatId)) if (scheduleStore.cancel(projectDir, chatId, row.id, reason)) n++; } catch { /* store unavailable */ }
      return n;
    },
    describeSchedule: (projectDir, chatId) => {
      try {
        const row = scheduleStore.recurring(projectDir, chatId);
        return row ? schedules.describeRecurring(row) : null;
      } catch { return null; }
    },
    hasPendingSchedule: (projectDir, chatId) => { try { return scheduleStore.list(projectDir, chatId).length > 0; } catch { return false; } },
    isChatRunning: (projectDir, chatId) => {
      const s = require('./server-shared.js');
      return s.runningChats.has(s.runningKey(projectDir, chatId));
    },
    cancelTurn: (projectDir, chatId) => {
      const s = require('./server-shared.js');
      const controller = s.runningChatCancels.get(s.runningKey(projectDir, chatId));
      if (!controller) return false;
      try { controller.abort(new Error('run stopped by the user')); } catch { /* settled */ }
      return true;
    },
    startTurn: (body, life) => require('./server-handlers-chats.js').startChatTurn(body, life),
    getChat: (projectDir, chatId) => chats.getChat(projectDir, chatId),
    notify: ({ projectDir, chatId, title, body }) => {
      let chatTitle = '';
      try { const c = chats.getChat(projectDir, chatId); chatTitle = (c && c.title) || ''; } catch { /* metadata only */ }
      require('./push.js').sendPushToAll({ title: chatTitle ? chatTitle + ' · ' + title : title, body, chatId, projectDir,
        tag: 'chat-' + chatId + '-run', data: { kind: 'run', chatId, projectDir, url: '/#/chat/' + chatId + '?projectDir=' + encodeURIComponent(projectDir) },
        actions: [{ action: 'open', title: 'Open chat' }] });
    }
  });
  return shared;
}

module.exports = { createRunStore, createRunManager, sharedManager, ACTIVE, DEFAULT_MAX_TURNS, MAX_TURNS,
  DEFAULT_MAX_HOURS, MAX_HOURS, MAX_GOAL_CHARS, MAX_SUMMARY_CHARS, IDLE_NUDGE_MS, MAX_NUDGES };
