'use strict';

const { Worker } = require('node:worker_threads');
const settings = require('../settings.js');
const trace = require('../trace.js');

const MODES = new Set(['off', 'ask', 'allowlist', 'allow']);
const DECISIONS = new Set(['allow-once', 'allow-session', 'deny']);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const sessions = new Map();

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sessionKey(projectDir, chatId) {
  return String(projectDir || '') + '\0' + String(chatId || '');
}

function getSession(projectDir, chatId) {
  const key = sessionKey(projectDir, chatId);
  let session = sessions.get(key);
  if (!session) {
    session = {
      projectDir,
      chatId,
      grants: new Set(),
      allowedCallIds: new Map(),
      deniedCallIds: new Set(),
      pending: new Map()
    };
    sessions.set(key, session);
  }
  return session;
}

function clearGrants(projectDir, chatId) {
  if (projectDir && chatId) sessions.delete(sessionKey(projectDir, chatId));
}

function normalizeConfig(raw, source, enabled) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.has(value.mode) ? value.mode : 'ask';
  const maxTimeoutMs = Number.isFinite(value.maxTimeoutMs)
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.round(value.maxTimeoutMs)))
    : MAX_TIMEOUT_MS;
  const defaultTimeoutMs = Number.isFinite(value.defaultTimeoutMs)
    ? Math.max(1, Math.min(maxTimeoutMs, Math.round(value.defaultTimeoutMs)))
    : Math.min(DEFAULT_TIMEOUT_MS, maxTimeoutMs);
  return {
    enabled: enabled !== false,
    mode,
    allowlist: Array.isArray(value.allowlist) ? value.allowlist.filter((x) => typeof x === 'string') : [],
    defaultTimeoutMs,
    maxTimeoutMs,
    source
  };
}

function effectiveConfig(projectDir, tool) {
  const resolved = settings.getResolved(projectDir);
  const project = settings.getProject(projectDir);
  const app = settings.getApp();
  if (tool === 'shell') {
    const projectValue = project && project.tools && project.tools.shell;
    const appValue = app && app.tools && app.tools.shell;
    const value = projectValue || appValue || {};
    const source = projectValue ? 'project' : (appValue ? 'app' : 'default');
    const enabled = !!(resolved && resolved.tools && resolved.tools.shell && resolved.tools.shell.enabled);
    return normalizeConfig(value, source, enabled);
  }
  if (tool.startsWith('mcp__')) {
    const projectValue = project && project.mcp && project.mcp.authorization;
    const appValue = app && app.mcp && app.mcp.authorization;
    const value = projectValue || appValue || {};
    return normalizeConfig(value, projectValue ? 'project' : (appValue ? 'app' : 'default'), true);
  }
  return normalizeConfig({ mode: 'off' }, 'default', false);
}

function getAuthorization(projectDir) {
  return {
    tools: { shell: effectiveConfig(projectDir, 'shell') },
    mcp: effectiveConfig(projectDir, 'mcp__any__tool')
  };
}

function setAuthorization(projectDir, patch) {
  if (!projectDir || typeof projectDir !== 'string') throw typedError('EBADINPUT', 'projectDir is required');
  if (!patch || typeof patch !== 'object') throw typedError('EBADINPUT', 'authorization patch is required');
  const project = settings.getProject(projectDir);
  const next = {};
  if (patch.tools && patch.tools.shell) {
    const shell = normalizeConfig(patch.tools.shell, 'project', true);
    next.tools = Object.assign({}, project.tools, {
      shell: Object.assign({}, project.tools && project.tools.shell, {
        mode: shell.mode,
        allowlist: shell.allowlist,
        defaultTimeoutMs: shell.defaultTimeoutMs,
        maxTimeoutMs: shell.maxTimeoutMs
      })
    });
  }
  if (patch.mcp) {
    const mcpAuth = normalizeConfig(patch.mcp, 'project', true);
    next.mcp = Object.assign({}, project.mcp, {
      authorization: {
        mode: mcpAuth.mode,
        allowlist: mcpAuth.allowlist,
        defaultTimeoutMs: mcpAuth.defaultTimeoutMs,
        maxTimeoutMs: mcpAuth.maxTimeoutMs
      }
    });
  }
  if (!Object.keys(next).length) throw typedError('EBADINPUT', 'tools.shell or mcp authorization is required');
  settings.setProject(projectDir, next);
  return getAuthorization(projectDir);
}

function regexMatch(pattern, value, timeoutMs = 1) {
  return new Promise((resolve) => {
    const source = String(pattern || '');
    const anchored = source.startsWith('^') ? source : '^(?:' + source + ')$';
    let settled = false;
    let worker;
    try {
      worker = new Worker(
        "const { parentPort, workerData } = require('node:worker_threads');" +
        "parentPort.once('message', (data) => {" +
        "try { parentPort.postMessage(new RegExp(data.pattern).test(data.value)); }" +
        "catch { parentPort.postMessage(false); }});",
        { eval: true }
      );
    } catch {
      resolve(false);
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result === true);
    };
    let timer = null;
    worker.once('online', () => {
      timer = setTimeout(() => finish(false), timeoutMs);
      worker.postMessage({ pattern: anchored, value: String(value || '') });
    });
    worker.once('message', finish);
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}

async function matchesAllowlist(summary, allowlist) {
  for (const pattern of allowlist || []) {
    if (await regexMatch(pattern, summary, 1)) return true;
  }
  return false;
}

function clampTimeout(requested, config) {
  const value = Number.isFinite(requested) ? Math.round(requested) : config.defaultTimeoutMs;
  return Math.max(1, Math.min(config.maxTimeoutMs, value));
}

async function authorize(input) {
  const projectDir = input && input.projectDir;
  const chatId = input && input.chatId;
  const tool = input && input.tool;
  const callId = input && input.callId;
  if (!projectDir || !chatId || !tool || !callId) {
    throw typedError('EBADINPUT', 'projectDir, chatId, tool, and callId are required');
  }
  const config = effectiveConfig(projectDir, tool);
  if (!config.enabled || config.mode === 'off') throw typedError('ETOOL_DISABLED', tool + ' is disabled');

  const session = getSession(projectDir, chatId);
  if (session.deniedCallIds.has(callId)) throw typedError('EDENIED', 'user denied');
  if (session.grants.has(tool)) return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
  if (session.allowedCallIds.get(callId) === tool) {
    session.allowedCallIds.delete(callId);
    return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
  }
  if (config.mode === 'allow') return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
  if (config.mode === 'allowlist' && await matchesAllowlist(input.summary || input.cmd || '', config.allowlist)) {
    return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
  }

  const existing = session.pending.get(callId);
  if (existing) return existing.publicResult;

  let resolveWait;
  let rejectWait;
  const wait = new Promise((resolve, reject) => { resolveWait = resolve; rejectWait = reject; });
  if (input.flow === 'retry') wait.catch(() => {});
  const publicResult = {
    decision: 'prompt',
    pendingId: callId,
    timeoutMs: clampTimeout(input.timeoutMs, config),
    wait
  };
  session.pending.set(callId, {
    tool,
    flow: input.flow === 'retry' ? 'retry' : 'wait',
    resolve: resolveWait,
    reject: rejectWait,
    publicResult
  });
  return publicResult;
}

function appendAudit(projectDir, chatId, tool, callId, decision) {
  try {
    const project = settings.getProject(projectDir);
    const chat = Array.isArray(project.chats) && project.chats.find((item) => item && item.id === chatId);
    if (!chat || chat.trace !== true) return;
    const stream = trace.open(projectDir, chatId);
    trace.write(stream, 'system', { event: 'auth_decision', tool, callId, decision });
    trace.close(stream);
  } catch { /* audit failure must not execute or deny a tool */ }
}

function recordDecision(projectDir, chatId, callId, decision) {
  if (!DECISIONS.has(decision)) throw typedError('EBADINPUT', 'invalid authorization decision');
  const session = sessions.get(sessionKey(projectDir, chatId));
  const pending = session && session.pending.get(callId);
  if (!pending) throw typedError('ENOTFOUND', 'authorization request not found');
  session.pending.delete(callId);

  if (decision === 'allow-session') session.grants.add(pending.tool);
  if (decision === 'allow-once' && pending.flow === 'retry') session.allowedCallIds.set(callId, pending.tool);
  if (decision === 'deny') session.deniedCallIds.add(callId);

  appendAudit(projectDir, chatId, pending.tool, callId, decision);
  if (decision === 'deny') pending.reject(typedError('EDENIED', 'user denied'));
  else pending.resolve({ decision: 'allow' });
  return { ok: true };
}

module.exports = {
  MODES,
  getAuthorization,
  setAuthorization,
  authorize,
  recordDecision,
  clearGrants,
  regexMatch,
  matchesAllowlist,
  _sessions: sessions
};