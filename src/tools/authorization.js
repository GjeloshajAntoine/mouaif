'use strict';

const { Worker } = require('node:worker_threads');
const fs = require('fs');
const path = require('path');
const settings = require('../settings.js');
const trace = require('../trace.js');

const MODES = new Set(['off', 'ask', 'allowlist', 'allow']);
const DECISIONS = new Set(['allow-once', 'allow-session', 'allow-always', 'deny']);
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

// Reject every pending authorization wait for a chat. Called when the
// SSE client disconnects mid-run: a tool call parked on `await
// authResult.wait` would otherwise hold the chat's running marker
// forever (the upstream-abort signal does not fire while the loop is
// waiting on a user decision, not a fetch), so every retry bounced off
// 409 EALREADY_RUNNING and the chat looked frozen. Rejecting with
// EDENIED unwinds the tool loop through its normal error path, which
// clears the marker and persists the failure.
function cancelSession(projectDir, chatId) {
  if (!projectDir || !chatId) return 0;
  const session = sessions.get(sessionKey(projectDir, chatId));
  if (!session || !session.pending.size) return 0;
  let count = 0;
  for (const [callId, pending] of session.pending) {
    session.pending.delete(callId);
    try { pending.reject(typedError('EDENIED', 'client disconnected')); } catch { /* already settled */ }
    count++;
  }
  return count;
}

function normalizeConfig(raw, source, enabled, tool) {
  const value = raw && typeof raw === 'object' ? raw : {};
  // Binary-mode tools only support { off, ask } — clamp any legacy
  // allowlist / allow values to `ask` so a hand-edited project file
  // from a future migration can't bypass the prompt.
  let mode = MODES.has(value.mode) ? value.mode : 'ask';
  if (tool && BINARY_MODE_TOOLS.has(tool) && mode !== 'off' && mode !== 'ask') mode = 'ask';
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

// Tools whose authorization is project-scoped (in addition to MCP, which
// has its own block under project.mcp.authorization). The same shape
// works for any future native tool: { mode, allowlist, defaultTimeoutMs,
// maxTimeoutMs } under project.tools.<name>.
const NATIVE_TOOLS = new Set(['shell', 'subagent', 'file', 'ask_user']);
// Tools that only support a binary `off` / `ask` mode. `ask_user` is
// the first of its kind: the model can't predict the user's answer,
// so allowlist / allow make no sense. The authorization module still
// owns the gate (so the rest of the pipeline — UI cards, the SSE
// event, the audit log — works the same), but the mode enum is
// narrowed to { off, ask }.
const BINARY_MODE_TOOLS = new Set(['ask_user']);
const FILE_TOOL_NAMES = new Set(['read_file', 'list_files', 'search_files', 'write_file', 'edit_file']);
const MCP_FILE = '.mcp.json';

function getMcpConfig(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return {};
  const file = path.join(projectDir, MCP_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMcpConfig(projectDir, config) {
  const file = path.join(projectDir, MCP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config || {}, null, 2) + '\n', 'utf8');
}

// Model-facing file operations share the single project.tools.file gate.
// Keep the original operation name for session grants and audit events, but
// resolve enablement and authorization mode through the canonical family.
function configToolName(tool) {
  return FILE_TOOL_NAMES.has(tool) ? 'file' : tool;
}

// Split `mcp__<serverSlug>__<toolName>` into its parts. Returns null for
// anything that is not a well-formed MCP tool name.
function parseMcpName(tool) {
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return null;
  const rest = tool.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  return { slug: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

// True when an authorization entry actually carries a decision
// (anything with a mode counts, including `mode: 'ask'`).
function hasMcpOverride(entry) {
  return !!(entry && typeof entry === 'object' && typeof entry.mode === 'string' && entry.mode);
}

// MCP authorization is layered, most specific first (decisions §18):
//   1. authorization.tools.<composedName>   — one tool on one server
//   2. authorization.servers.<serverSlug>   — every tool on that server
//   3. authorization                        — the project-wide MCP gate
//   4. app.mcp.authorization                — app-level default
// The per-server / per-tool maps only apply to the project layer: the
// app store has no server registry, so it keeps the single shared gate.
function mcpLayeredConfig(projectDir, project, app, tool) {
  const mcpConfig = getMcpConfig(projectDir);
  const auth = (mcpConfig && mcpConfig.authorization) || (project && project.mcp && project.mcp.authorization) || {};
  const parsed = parseMcpName(tool);
  if (parsed) {
    const toolValue = auth.tools && auth.tools[tool];
    if (hasMcpOverride(toolValue)) return { value: toolValue, source: 'project-tool' };
    const serverValue = auth.servers && auth.servers[parsed.slug];
    if (hasMcpOverride(serverValue)) return { value: serverValue, source: 'project-server' };
  }
  if (hasMcpOverride(auth)) return { value: auth, source: 'project' };
  const appValue = app && app.mcp && app.mcp.authorization;
  if (appValue && typeof appValue === 'object') return { value: appValue, source: 'app' };
  return { value: {}, source: 'default' };
}

// The persisted per-server / per-tool maps for a project's MCP
// authorization. Used by getAuthorization so the REST surface (and the
// Settings UI) can render every override, including ones whose tool is
// not currently advertised.
function mcpOverrideMaps(projectDir) {
  const mcpConfig = getMcpConfig(projectDir);
  const auth = (mcpConfig && mcpConfig.authorization) || {};
  const servers = (auth.servers && typeof auth.servers === 'object' && !Array.isArray(auth.servers)) ? auth.servers : {};
  const tools = (auth.tools && typeof auth.tools === 'object' && !Array.isArray(auth.tools)) ? auth.tools : {};
  return { auth, servers, tools };
}

function effectiveConfig(projectDir, tool) {
  tool = configToolName(tool);
  const resolved = settings.getResolved(projectDir);
  const project = settings.getProject(projectDir);
  const app = settings.getApp();
  if (NATIVE_TOOLS.has(tool)) {
    const projectValue = project && project.tools && project.tools[tool];
    const appValue = app && app.tools && app.tools[tool];
    const value = projectValue || appValue || {};
    const source = projectValue ? 'project' : (appValue ? 'app' : 'default');
    // Built-in tools are part of the base agent surface and are always
    // discoverable. Authorization mode is the gate: `ask` prompts on first
    // use, `allow` runs directly, and `off` explicitly disables execution.
    // Keep accepting legacy `enabled` fields in project files, but do not let
    // a missing/false flag make a base tool disappear from the model.
    return normalizeConfig(value, source, true, tool);
  }
  if (tool.startsWith('mcp__')) {
    const { value, source } = mcpLayeredConfig(projectDir, project, app, tool);
    return normalizeConfig(value, source, true, tool);
  }
  return normalizeConfig({ mode: 'off' }, 'default', false, tool);
}

function getAuthorization(projectDir) {
  // mcp.servers / mcp.tools mirror the persisted override maps (not the
  // layered result) so the Settings UI can render every configured
  // override, including ones whose tool or server is currently stopped.
  const { servers, tools: toolOverrides } = mcpOverrideMaps(projectDir);
  const mcp = effectiveConfig(projectDir, 'mcp__any__tool');
  mcp.servers = servers;
  mcp.tools = toolOverrides;
  return {
    tools: {
      shell: effectiveConfig(projectDir, 'shell'),
      subagent: effectiveConfig(projectDir, 'subagent'),
      file: effectiveConfig(projectDir, 'file'),
      ask_user: effectiveConfig(projectDir, 'ask_user')
    },
    mcp
  };
}

// Shape a normalized MCP auth entry for persistence. `off` / `allow` /
// `ask` write only { mode }; `allowlist` also writes the pattern list.
// Everything else (timeouts) is dropped — the shared gate's timeouts
// still apply to every MCP call.
function mcpPersistShape(cfg) {
  const out = { mode: cfg.mode };
  if (cfg.mode === 'allowlist') out.allowlist = cfg.allowlist;
  return out;
}

function setAuthorization(projectDir, patch) {
  if (!projectDir || typeof projectDir !== 'string') throw typedError('EBADINPUT', 'projectDir is required');
  if (!patch || typeof patch !== 'object') throw typedError('EBADINPUT', 'authorization patch is required');
  const project = settings.getProject(projectDir);
  const next = {};
  // Each native tool (shell, file, ...) gets its own block under
  // project.tools.<name>. The shape is the same: { mode, allowlist,
  // defaultTimeoutMs, maxTimeoutMs }. The caller's `enabled` flag is
  // owned by the project tools toggle (a different setting) and is
  // not duplicated here.
  for (const name of NATIVE_TOOLS) {
    if (patch.tools && patch.tools[name]) {
      const cfg = normalizeConfig(patch.tools[name], 'project', true);
      next.tools = Object.assign({}, next.tools, project.tools);
      next.tools[name] = Object.assign({}, project.tools && project.tools[name], {
        mode: cfg.mode,
        allowlist: cfg.allowlist,
        defaultTimeoutMs: cfg.defaultTimeoutMs,
        maxTimeoutMs: cfg.maxTimeoutMs
      });
    }
  }
  if (patch.mcp) {
    const p = patch.mcp;
    const hasShape = (typeof p.mode === 'string' && p.mode)
      || (p.servers && typeof p.servers === 'object' && !Array.isArray(p.servers))
      || (p.tools && typeof p.tools === 'object' && !Array.isArray(p.tools));
    if (!hasShape) throw typedError('EBADINPUT', 'mcp authorization must set mode, servers, or tools');
    const mcpConfig = getMcpConfig(projectDir);
    const auth = (mcpConfig && mcpConfig.authorization && typeof mcpConfig.authorization === 'object')
      ? Object.assign({}, mcpConfig.authorization)
      : {};
    if (typeof p.mode === 'string' && p.mode) {
      // The shared gate. Tighten the persisted shape the same way the
      // overrides are stored (off/allow/ask write only { mode }).
      const mcpAuth = normalizeConfig(p, 'project', true);
      const shaped = mcpPersistShape(mcpAuth);
      shaped.defaultTimeoutMs = mcpAuth.defaultTimeoutMs;
      shaped.maxTimeoutMs = mcpAuth.maxTimeoutMs;
      auth.mode = shaped.mode;
      if (Object.prototype.hasOwnProperty.call(shaped, 'allowlist')) auth.allowlist = shaped.allowlist;
      else delete auth.allowlist;
      auth.defaultTimeoutMs = shaped.defaultTimeoutMs;
      auth.maxTimeoutMs = shaped.maxTimeoutMs;
    }
    for (const key of ['servers', 'tools']) {
      const map = p[key];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      if (!auth[key] || typeof auth[key] !== 'object' || Array.isArray(auth[key])) auth[key] = {};
      for (const [name, entry] of Object.entries(map)) {
        if (typeof name !== 'string' || !name) continue;
        if (entry == null) { delete auth[key][name]; continue; }
        const cfg = normalizeConfig(entry, 'project', true);
        auth[key][name] = mcpPersistShape(cfg);
      }
      // Drop empty maps so .mcp.json stays small and honest.
      if (!Object.keys(auth[key]).length) delete auth[key];
    }
    writeMcpConfig(projectDir, Object.assign({}, mcpConfig, { authorization: auth }));
  }
  if (!Object.keys(next).length && !patch.mcp) throw typedError('EBADINPUT', 'tools.shell, tools.file, or mcp authorization is required');
  if (Object.keys(next).length) settings.setProject(projectDir, next);
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
  // Binary-mode tools (`ask_user`) must ALWAYS reach the prompt: the user
  // is the only source of truth, so no session state may silently resolve
  // the gate. A stale deny or grant would otherwise short-circuit here and
  // the dispatcher would fall back to a `cancelled: true` result even
  // though the user was never asked (or already answered a re-issued call).
  if (!BINARY_MODE_TOOLS.has(tool)) {
    if (session.deniedCallIds.has(callId)) throw typedError('EDENIED', 'user denied');
    if (session.grants.has(tool)) return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
    if (session.allowedCallIds.get(callId) === tool) {
      session.allowedCallIds.delete(callId);
      return { decision: 'allow', timeoutMs: clampTimeout(input.timeoutMs, config) };
    }
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

function recordDecision(projectDir, chatId, callId, decision, payload) {
  if (!DECISIONS.has(decision)) throw typedError('EBADINPUT', 'invalid authorization decision');
  const session = sessions.get(sessionKey(projectDir, chatId));
  const pending = session && session.pending.get(callId);
  if (!pending) throw typedError('ENOTFOUND', 'authorization request not found');
  session.pending.delete(callId);

  // Binary-mode tools never earn session/persistent state from a decision:
  // an allow is for this one question only, and a deny must not block a
  // re-issued call later in the session. Otherwise a single Dismiss would
  // make every subsequent ask_user auto-cancel without ever prompting.
  const binary = BINARY_MODE_TOOLS.has(pending.tool);
  if (decision === 'allow-session' && !binary) session.grants.add(pending.tool);
  if (decision === 'allow-always' && !binary) {
    const family = configToolName(pending.tool);
    if (NATIVE_TOOLS.has(family)) {
      const current = effectiveConfig(projectDir, family);
      setAuthorization(projectDir, { tools: { [family]: {
        mode: 'allow',
        allowlist: current.allowlist,
        defaultTimeoutMs: current.defaultTimeoutMs,
        maxTimeoutMs: current.maxTimeoutMs
      } } });
    } else if (family.startsWith('mcp__')) {
      // "Always allow" on an MCP call pins THAT tool (and nothing else)
      // to mode 'allow'. Writing the shared gate to 'allow' would
      // silently auto-approve every other server and tool in the
      // project — the opposite of the per-MCP, per-tool granularity the
      // gate now exposes.
      setAuthorization(projectDir, { mcp: { tools: { [pending.tool]: { mode: 'allow' } } } });
    }
    session.grants.add(pending.tool);
  }
  if (decision === 'allow-once' && pending.flow === 'retry' && !binary) session.allowedCallIds.set(callId, pending.tool);
  if (decision === 'deny' && !binary) session.deniedCallIds.add(callId);

  appendAudit(projectDir, chatId, pending.tool, callId, decision);
  if (decision === 'deny') pending.reject(typedError('EDENIED', 'user denied'));
  else {
    // `ask_user` carries a structured answer alongside the decision
    // so the runner can hand the user's { choice, extra } to the
    // model. For every other tool `payload` is undefined and the
    // wait() resolves to the original { decision: 'allow' } shape.
    if (payload && typeof payload === 'object') {
      pending.resolve({ decision: 'allow', payload });
    } else {
      pending.resolve({ decision: 'allow' });
    }
  }
  return { ok: true };
}

module.exports = {
  MODES,
  FILE_TOOL_NAMES,
  getAuthorization,
  setAuthorization,
  authorize,
  recordDecision,
  clearGrants,
  cancelSession,
  regexMatch,
  matchesAllowlist,
  configToolName,
  parseMcpName,
  _sessions: sessions
};