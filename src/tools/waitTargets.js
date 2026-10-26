'use strict';

// Observers for wait_for targets beyond a single shell job: several jobs,
// other chats of the project, delegated subagents and subagent groups. Each
// builder validates ownership up front (so a bad id fails the call instead of
// waiting out its timeout) and returns an `observe()` for the wait engine
// that reports `{ done, outcome, detail }` without blocking.
//
//   job       every id must be a job owned by the calling project/chat/invocation
//   chat      a chat of the same project, never the calling chat (it would
//             wait for itself); a chat that is not running counts as settled
//   subagent  a child of the calling turn's local scope (parent only)
//   group     a subagent group created in the calling turn's local scope
const backgroundJobs = require('./backgroundJobs.js');
const { err } = require('../util.js');

const MAX_IDS = 20;
const TERMINAL = ['completed', 'failed', 'cancelled', 'blocked'];

function cut(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function subagentScope(ctx) {
  const scope = ctx.orchestrationScope;
  if (!scope) throw err('EUNSUPPORTED', 'Subagent and group waits only work inside a turn that can delegate');
  if (ctx.orchestrationAuthor && ctx.orchestrationAuthor !== scope.owner?.author) {
    throw err('EPARENT_ONLY', 'Only the local parent can wait on its children');
  }
  return scope;
}

const KINDS = {
  job(id, ctx) {
    const scope = { projectDir: ctx.projectDir, chatId: ctx.chatId, invocationId: ctx.workspaceChatId };
    backgroundJobs.get(scope, id);
    return () => {
      const job = backgroundJobs.get(scope, id);
      return { done: job.state !== 'running', state: job.state,
        detail: { id, state: job.state, exitCode: job.exitCode, logPath: job.logPath } };
    };
  },
  chat(id, ctx) {
    if (!ctx.projectDir) throw err('EBADINPUT', 'A project is required to wait on a chat');
    if (id === ctx.chatId) throw err('EDEADLOCK', 'A chat cannot wait for itself to finish');
    const chats = require('../chats.js');
    const shared = require('../server-shared.js');
    const chat = chats.getChat(ctx.projectDir, id);
    if (!chat) throw err('ENOTARGET', 'No chat "' + id + '" in this project');
    return () => {
      const running = shared.runningChats.has(shared.runningKey(ctx.projectDir, id));
      return { done: !running, state: running ? 'running' : 'idle',
        detail: { id, title: cut(chat.title, 120), state: running ? 'running' : 'idle' } };
    };
  },
  subagent(id, ctx) {
    const scope = subagentScope(ctx);
    scope.get(id); // EUNKNOWN_CALL, or EDEADLOCK for self and ancestors
    return () => {
      const row = scope.get(id);
      const status = scope.status(row);
      return { done: !!row.finalized || TERMINAL.includes(status.state), state: status.state,
        detail: { id, state: status.state, ok: status.ok, agent: status.agent, lastLine: cut(status.lastLine, 300),
          text: cut(status.text, 2000), error: status.error } };
    };
  },
  group(id, ctx) {
    const scope = subagentScope(ctx);
    scope.groups.get(id); // EUNKNOWN_GROUP
    return () => {
      const status = scope.groups.status(scope.groups.get(id));
      return { done: status.settled, state: status.state,
        detail: { id, name: status.name, state: status.state,
          members: status.members.map((member) => ({ memberId: member.memberId, state: member.state })) } };
    };
  }
};

// buildObserver({ kind, ids, mode }, ctx) -> { observe, until }
//   ids   1..MAX_IDS target ids
//   mode  "all" (default): done when every target settled; "any": the first one
function buildObserver({ kind, ids, mode = 'all' }, ctx) {
  const make = KINDS[kind];
  if (!make) throw err('EBADINPUT', 'unknown wait target: ' + kind);
  if (!Array.isArray(ids) || !ids.length) throw err('EBADINPUT', 'at least one id is required');
  if (ids.length > MAX_IDS) throw err('EBADINPUT', 'at most ' + MAX_IDS + ' ids per wait');
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) throw err('EBADINPUT', 'ids must be non-empty strings');
  if (mode !== 'all' && mode !== 'any') throw err('EBADINPUT', 'mode must be "all" or "any"');
  const unique = [...new Set(ids.map((id) => id.trim()))];
  const observers = unique.map((id) => make(id, ctx));
  const observe = () => {
    const seen = observers.map((fn) => fn());
    const settled = seen.filter((entry) => entry.done).length;
    const done = mode === 'any' ? settled > 0 : settled === seen.length;
    return { done, outcome: seen.length === 1 ? seen[0].state : (done ? mode + '-settled' : 'waiting'),
      detail: { mode, settled, total: seen.length, targets: seen.map((entry) => ({ ...entry.detail, settled: entry.done })) } };
  };
  return { observe, until: kind + ':' + unique.join(',') };
}

module.exports = { buildObserver, MAX_IDS };
