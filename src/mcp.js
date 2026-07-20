'use strict';

// MCP — Model Context Protocol client.
//
// Implements docs/decisions.md §18: per-project MCP server registry,
// stdio JSON-RPC transport, tool discovery, and tool execution. The
// AI client (src/ai.js) intercepts tool_call events whose name matches
// `mcp__<serverSlug>__<toolName>` and dispatches them through the
// `callTool()` surface below; the rest of the server stays plain
// JSON-RPC and Node, with the @modelcontextprotocol/sdk scoped to this
// module.
//
// Scope: one project directory = one MCP session. The set of servers
// is per-project (in <projectDir>/.mcp.json under servers; legacy
// <projectDir>/.mouaif.json mcp.servers is read as a fallback).
// The runtime state (child processes, live tool lists) is in-memory
// only; the last-known tool list per server is persisted in the app
// SQLite store (settings.getMcpToolCache), not in the project file.
// Servers are stopped on `process.exit`.
//
// Public surface:
//
//   listServers(projectDir)         -> [{ id, name, command, args, env, cwd, enabled, status, tools? }]
//   getServer(projectDir, serverId) -> the server record or null
//   addServer(projectDir, opts)     -> the new server record
//   updateServer(projectDir, id, patch) -> the updated record or null
//   removeServer(projectDir, serverId) -> boolean
//
//   startServer(projectDir, serverId) -> the running session or throws
//   stopServer(projectDir, serverId)  -> boolean
//   stopAll()                          -> void (used on shutdown)
//
//   listDiscoveredTools(projectDir, serverId) -> [{ name, description, inputSchema }]
//   callTool(projectDir, serverSlug, toolName, args) -> { ok, content, isError? }
//
// Errors are typed: EMCP_NOTFOUND, EMCP_DISABLED, EMCP_DUPLICATE,
// EMCP_START, EMCP_TRANSPORT, EMCP_RPC, EMCP_TIMEOUT, EMCP_NOSESSION.
//
// The SDK is loaded lazily so the rest of the server boots even when
// the SDK fails to load for any reason. The require() result is cached
// in `sdk` so a per-server call costs nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings.js');

// ---- SDK lazy load ------------------------------------------------------

let sdk = null;
let sdkLoadError = null;
function getSdk() {
  if (sdk) return sdk;
  if (sdkLoadError) throw sdkLoadError;
  try {
    const clientMod = require('@modelcontextprotocol/sdk/client/index.js');
    const stdioMod = require('@modelcontextprotocol/sdk/client/stdio.js');
    sdk = {
      Client: clientMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport
    };
    return sdk;
  } catch (e) {
    sdkLoadError = new Error('Failed to load @modelcontextprotocol/sdk: ' + (e.message || e));
    sdkLoadError.code = 'EMODULE';
    throw sdkLoadError;
  }
}

// ---- Helpers ------------------------------------------------------------

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function newServerId() {
  // Short hex id; uniqueness is project-scoped.
  return crypto.randomBytes(4).toString('hex');
}

// Slug used in tool names: lowercased, non-alnum collapsed to underscores,
// leading/trailing underscores stripped, capped at 48 chars. Matches the
// standard MCP convention so model output stays unambiguous.
function slugify(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'srv';
}

// Compose the model-facing tool name. Anything <serverSlug>__<toolName>
// is reserved for MCP-discovered tools so the AI client can route them
// without colliding with built-in tool names like `shell`.
function composedToolName(serverSlug, toolName) {
  return 'mcp__' + serverSlug + '__' + toolName;
}

function parseServerSlugAndToolName(composedName) {
  if (typeof composedName !== 'string') return null;
  if (!composedName.startsWith('mcp__')) return null;
  const rest = composedName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  const serverSlug = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverSlug || !toolName) return null;
  return { serverSlug, toolName };
}

// Per-server denylist (decision §16's runtime env policy) plus a few
// extra vars an MCP server must not be allowed to override. We strip
// these from both the inherited env and the per-server map.
const ENV_DENYLIST = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'NODE_DISABLE_COLORS',
  'ELECTRON_RUN_AS_NODE'
]);

function buildChildEnv(perServerEnv) {
  const env = Object.assign({}, process.env);
  // Strip denylisted keys from the parent env.
  for (const k of Object.keys(env)) {
    if (ENV_DENYLIST.has(k)) delete env[k];
  }
  // Per-server env overrides. We do not strip denylist keys from the
  // explicit per-server env — if the user wants to set NODE_OPTIONS
  // for a specific MCP server, that's their call. Built-in tooling
  // (like our own spawn here) still works correctly.
  if (perServerEnv && typeof perServerEnv === 'object') {
    for (const [k, v] of Object.entries(perServerEnv)) {
      if (ENV_DENYLIST.has(k)) continue;
      if (typeof v === 'string') env[k] = v;
      else if (v == null) delete env[k];
    }
  }
  return env;
}

// ---- Project-level registry --------------------------------------------

const MCP_FILE = '.mcp.json';

function getMcpPath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, MCP_FILE);
}

function readMcpFile(projectDir) {
  const file = getMcpPath(projectDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    const error = new Error(`Failed to parse ${file}: ${e.message}`);
    error.code = 'MCP_PROJECT_PARSE_ERROR';
    error.cause = e;
    throw error;
  }
}

function writeMcpFile(projectDir, obj) {
  const file = getMcpPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj || {}, null, 2) + '\n', 'utf8');
}

function readProjectConfig(projectDir) {
  const config = readMcpFile(projectDir);
  if (config) {
    const list = Array.isArray(config.servers) ? config.servers : [];
    return { mcp: config, list, source: MCP_FILE };
  }

  // Back-compat: older projects stored MCP under .mouaif.json -> mcp.servers.
  const project = settings.getProject(projectDir);
  const mcp = (project && typeof project === 'object' && project.mcp && typeof project.mcp === 'object')
    ? project.mcp
    : {};
  const list = Array.isArray(mcp.servers) ? mcp.servers : [];
  return { mcp, list, source: settings.PROJECT_FILE };
}

function writeProjectConfig(projectDir, mcp) {
  // Merge into the existing file instead of replacing it: .mcp.json also
  // carries the authorization block written by tools/authorization.js
  // (setAuthorization), and a blanket overwrite would silently drop the
  // user's MCP allow/allowlist policy on every server CRUD. A corrupt or
  // missing file falls back to the incoming object.
  let base = {};
  try { base = readMcpFile(projectDir) || {}; } catch { /* replace corrupt file */ }
  const out = Object.assign({}, base, mcp || { servers: [] });
  // Strip any legacy inline toolCache keys: the cache lives in the app
  // SQLite store now, and leaving a copy here would both bloat the
  // project file and go stale.
  if (Array.isArray(out.servers)) {
    out.servers = out.servers.map((s) => {
      if (!s || typeof s !== 'object') return s;
      if (!Object.prototype.hasOwnProperty.call(s, 'toolCache')) return s;
      const clone = Object.assign({}, s);
      delete clone.toolCache;
      return clone;
    });
  }
  writeMcpFile(projectDir, out);
}

function normalizeServerEntry(raw, usedSlugs) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (typeof raw.command !== 'string' || !raw.command.trim()) return null;
  const name = raw.name.trim();
  let slug = typeof raw.slug === 'string' && raw.slug ? slugify(raw.slug) : slugify(name);
  if (!slug) slug = 'srv';
  // Ensure slug uniqueness within the project; auto-suffix on collision.
  let candidate = slug;
  let n = 2;
  while (usedSlugs.has(candidate)) {
    candidate = slug + '_' + n;
    n++;
  }
  usedSlugs.add(candidate);

  const args = Array.isArray(raw.args) ? raw.args.filter(a => typeof a === 'string') : [];
  const env = (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env))
    ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === 'string' || v == null))
    : {};
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : '';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newServerId(),
    name,
    slug: candidate,
    command: raw.command.trim(),
    args,
    env,
    cwd,
    enabled: raw.enabled === true, // default off
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function normalizeAll(rawList) {
  const usedSlugs = new Set();
  const out = [];
  for (const r of rawList) {
    const n = normalizeServerEntry(r, usedSlugs);
    if (n) out.push(n);
  }
  return out;
}

// The discovered tool list is persisted in the app SQLite store (see
// settings.getMcpToolCache/setMcpToolCache) so a stopped server still
// shows what it advertised the last time it ran (and the model can
// still see its surface in the tools catalog). The cache is refreshed
// on every successful start / tools/list refresh, and cleared when the
// server is removed. The runtime state (child process, live session)
// stays in-memory; only the last-known tool descriptors are persisted.
//
// Older builds stored the cache inline in .mcp.json under each server
// entry's `toolCache` key. loadToolCache migrates those rows into the
// DB on first read and strips the key the next time the config file is
// written, so the project file shrinks back to just the server config.
function normalizeToolCache(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(t => t && typeof t.name === 'string' && t.name)
    .map(t => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} }
    }));
}

// Returns the persisted cache for a server. Migration path: if the DB
// has no row but the raw config entry still carries an inline
// `toolCache`, move it into the DB (best-effort) and mark the source
// entry for stripping on the next config write.
function loadToolCache(projectDir, rawEntry) {
  if (!rawEntry || !rawEntry.id) return [];
  const fromDb = settings.getMcpToolCache(projectDir, rawEntry.id);
  if (Array.isArray(fromDb)) return normalizeToolCache(fromDb);
  const legacy = normalizeToolCache(rawEntry.toolCache);
  if (legacy.length) {
    rawEntry._stripToolCache = true;
    try { settings.setMcpToolCache(projectDir, rawEntry.id, legacy); } catch { /* ignore */ }
  }
  return legacy;
}

function persistToolCache(projectDir, serverId, tools) {
  try { settings.setMcpToolCache(projectDir, serverId, normalizeToolCache(tools)); } catch { /* ignore */ }
}

function clearToolCache(projectDir, serverId) {
  try { settings.deleteMcpToolCache(projectDir, serverId); } catch { /* ignore */ }
}

// ---- In-memory runtime state -------------------------------------------

// Per-project, per-server session: child process, MCP client, discovered
// tool list, status. Cleared on stop() and on process exit. The key is
// `${projectDir}::${serverId}`. We also keep a projectDir -> serverId
// index for quick fan-out (e.g. "all sessions for a project").
const _sessions = new Map();
const _byProject = new Map(); // projectDir -> Set<serverId>

function keyOf(projectDir, serverId) { return projectDir + '::' + serverId; }

function trackSession(projectDir, serverId, session) {
  _sessions.set(keyOf(projectDir, serverId), session);
  if (!_byProject.has(projectDir)) _byProject.set(projectDir, new Set());
  _byProject.get(projectDir).add(serverId);
}

function untrackSession(projectDir, serverId) {
  _sessions.delete(keyOf(projectDir, serverId));
  const set = _byProject.get(projectDir);
  if (set) {
    set.delete(serverId);
    if (set.size === 0) _byProject.delete(projectDir);
  }
}

function getSession(projectDir, serverId) {
  return _sessions.get(keyOf(projectDir, serverId)) || null;
}

function findSessionBySlug(projectDir, serverSlug) {
  const set = _byProject.get(projectDir);
  if (!set) return null;
  for (const id of set) {
    const s = _sessions.get(keyOf(projectDir, id));
    if (s && s.entry && s.entry.slug === serverSlug) return { id, session: s };
  }
  return null;
}

// ---- CRUD ---------------------------------------------------------------

function listServers(projectDir) {
  const { list } = readProjectConfig(projectDir);
  const rawById = new Map(list.map(s => [s && s.id, s]));
  const normalized = normalizeAll(list);
  return normalized.map((entry) => decorate(entry, projectDir, rawById.get(entry.id)));
}

function getServer(projectDir, serverId) {
  const { list } = readProjectConfig(projectDir);
  const normalized = normalizeAll(list);
  const entry = normalized.find(s => s.id === serverId) || null;
  if (!entry) return null;
  return decorate(entry, projectDir, list.find(s => s && s.id === serverId));
}

function decorate(entry, projectDir, rawEntry) {
  const session = getSession(projectDir, entry.id);
  const status = session ? session.status : 'stopped';
  // Live tools win; the persisted cache (app DB) is the fallback so a
  // stopped server still shows what it advertised the last time it ran.
  const cache = loadToolCache(projectDir, rawEntry || entry);
  const tools = session ? session.tools.slice() : cache;
  const error = session && session.error ? session.error : null;
  const decorated = Object.assign({}, entry, { env: redactEnv(entry.env), status, tools });
  if (error) decorated.error = error;
  return decorated;
}

function redactEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    out[key] = { configured: typeof value === 'string' };
  }
  return out;
}

function addServer(projectDir, opts) {
  if (!opts || typeof opts !== 'object') throw err('EBADINPUT', 'opts required');
  if (typeof opts.name !== 'string' || !opts.name.trim()) throw err('EBADINPUT', 'name is required');
  if (typeof opts.command !== 'string' || !opts.command.trim()) throw err('EBADINPUT', 'command is required');
  const { list } = readProjectConfig(projectDir);
  const usedIds = new Set(list.map(s => s && s.id));
  let id = newServerId();
  while (usedIds.has(id)) id = newServerId();
  const entry = normalizeServerEntry(Object.assign({}, opts, { id }), new Set());
  if (!entry) throw err('EBADINPUT', 'invalid server entry');
  const next = list.concat([entry]);
  writeProjectConfig(projectDir, { servers: next });
  return decorate(entry, projectDir);
}

function updateServer(projectDir, serverId, patch) {
  if (!serverId) return null;
  const { list } = readProjectConfig(projectDir);
  const normalized = normalizeAll(list);
  const idx = normalized.findIndex(s => s.id === serverId);
  if (idx < 0) return null;
  // Stop the running session synchronously (don't await — the caller
  // wants a fast PATCH) so the next start reflects the new config.
  // untrackSession runs inside stopServer, so the entry is removed
  // from the in-memory map by the time this function returns even
  // though the child is still being torn down. The untrack is
  // synchronous; the shutdown is async.
  const session = getSession(projectDir, serverId);
  if (session) {
    // Fire-and-forget the actual shutdown; the bookkeeping is sync.
    Promise.resolve(session.shutdown()).catch(() => {});
    untrackSession(projectDir, serverId);
  }
  const cleanPatch = Object.assign({}, patch || {});
  if (!Object.prototype.hasOwnProperty.call(cleanPatch, 'env')) cleanPatch.env = normalized[idx].env;
  const merged = Object.assign({}, normalized[idx], cleanPatch, { id: serverId });
  // Re-slug only if the name changed and the user did not pin a slug.
  if (patch && typeof patch.name === 'string' && !patch.slug) {
    const others = normalized.filter((_, i) => i !== idx);
    const used = new Set(others.map(o => o.slug));
    let candidate = slugify(merged.name);
    if (!candidate) candidate = 'srv';
    let n = 2;
    while (used.has(candidate)) { candidate = slugify(merged.name) + '_' + n; n++; }
    merged.slug = candidate;
  }
  const renormalized = normalizeServerEntry(merged, new Set(normalized.filter((_, i) => i !== idx).map(o => o.slug)));
  if (!renormalized) return null;
  normalized[idx] = renormalized;
  writeProjectConfig(projectDir, { servers: normalized });
  return decorate(renormalized, projectDir);
}

function removeServer(projectDir, serverId) {
  if (!serverId) return false;
  stopServer(projectDir, serverId).catch(() => {});
  const { list } = readProjectConfig(projectDir);
  const before = list.length;
  const next = list.filter(s => s && s.id !== serverId);
  if (next.length === before) return false;
  writeProjectConfig(projectDir, { servers: next });
  // The tool cache is keyed by server id; drop it with the server.
  clearToolCache(projectDir, serverId);
  return true;
}

// ---- Lifecycle ----------------------------------------------------------

// startServer: spawn the child, open a stdio transport, run the MCP
// `initialize` handshake, discover the server's tool list, and store
// the session. Returns the decorated server record. Throws on any
// failure with a typed code so the HTTP layer can branch.
async function startServer(projectDir, serverId) {
  const { list } = readProjectConfig(projectDir);
  const entry = normalizeAll(list).find(s => s.id === serverId);
  if (!entry) throw err('EMCP_NOTFOUND', 'Server not found', { serverId });
  if (entry.enabled === false) throw err('EMCP_DISABLED', 'Server is disabled', { serverId });

  // Reject overlapping starts.
  const existing = getSession(projectDir, serverId);
  if (existing && existing.status !== 'errored' && existing.status !== 'stopped') {
    return decorate(entry, projectDir);
  }
  if (existing) {
    // Clean up a dead session before re-spawning.
    try { await existing.shutdown(); } catch { /* ignore */ }
    untrackSession(projectDir, serverId);
  }

  const { Client, StdioClientTransport } = getSdk();
  const cwd = entry.cwd
    ? (path.isAbsolute(entry.cwd) ? entry.cwd : path.resolve(projectDir, entry.cwd))
    : projectDir;
  // Sanity check: cwd must be inside projectDir (decision §4's
  // "outside project" rule, applied to the spawn directory).
  const cwdResolved = path.resolve(cwd);
  const projectResolved = path.resolve(projectDir);
  const rel = path.relative(projectResolved, cwdResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Server cwd must be inside the project directory', { cwd: cwdResolved });
  }
  const env = buildChildEnv(entry.env);

  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env,
    cwd: cwdResolved,
    stderr: 'pipe'
  });

  // Track stderr so a misbehaving server's logs are visible from
  // /api/mcp/servers/:id for debugging. Cap the buffer to avoid
  // unbounded memory growth in a long-lived server.
  const stderrBuf = [];
  const STDERR_CAP = 16 * 1024;
  if (transport.stderr && typeof transport.stderr.on === 'function') {
    transport.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      if (stderrBuf.length < STDERR_CAP) {
        const remaining = STDERR_CAP - stderrBuf.reduce((n, c) => n + c.length, 0);
        if (remaining > 0) stderrBuf.push(s.slice(0, Math.max(0, remaining)));
      }
    });
  }

  const client = new Client({
    name: 'mouaif',
    version: require('./package-version.js')
  }, { capabilities: {} });

  const session = {
    entry,
    client,
    transport,
    status: 'starting',
    tools: [],
    error: null,
    stderr: stderrBuf,
    async shutdown() {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
    }
  };
  trackSession(projectDir, serverId, session);

  try {
    await client.connect(transport, { timeout: 30000 });
  } catch (e) {
    session.status = 'errored';
    session.error = { code: 'EMCP_START', message: (e && e.message) || String(e) };
    try { await session.shutdown(); } catch { /* ignore */ }
    untrackSession(projectDir, serverId);
    throw err('EMCP_START', 'Failed to start MCP server: ' + (e && e.message || e), { serverId });
  }

  // Discover tools. Some servers return a paginated list; walk cursors
  // until exhausted. A failure here is non-fatal — the server may be
  // a "resources only" server that exposes no tools.
  let discovered = [];
  try {
    let cursor;
    for (let i = 0; i < 16; i++) { // 16 pages * 100 = 1600 tools; more than any real server
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10000 });
      const list = (page && page.tools) || [];
      discovered = discovered.concat(list);
      cursor = page && page.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    session.status = 'errored';
    session.error = { code: 'EMCP_RPC', message: 'tools/list failed: ' + (e && e.message || e) };
    try { await session.shutdown(); } catch { /* ignore */ }
    untrackSession(projectDir, serverId);
    throw err('EMCP_RPC', 'MCP server failed to list tools: ' + (e && e.message || e), { serverId });
  }

  // Normalize tool descriptors: name (required), description, inputSchema.
  // The shape stored here is what the AI client turns into the
  // model-facing tool spec.
  session.tools = normalizeToolCache(discovered);
  // Persist the last-known tool list so a stopped server still shows
  // what it advertised (and the model can still see its surface in
  // the tools catalog). The write is best-effort — a disk failure
  // should not abort the start.
  try { persistToolCache(projectDir, serverId, session.tools); } catch { /* ignore */ }

  // Wire transport-close -> errored status so the next call surfaces
  // EMCP_TRANSPORT instead of a hung connection.
  try {
    transport.onclose = () => {
      if (_sessions.get(keyOf(projectDir, serverId)) === session) {
        session.status = 'errored';
        session.error = { code: 'EMCP_TRANSPORT', message: 'Server process exited' };
      }
    };
  } catch { /* transport may not expose onclose */ }

  session.status = 'ready';
  return decorate(entry, projectDir);
}

async function stopServer(projectDir, serverId) {
  if (!serverId) return false;
  const session = getSession(projectDir, serverId);
  if (!session) return false;
  try { await session.shutdown(); } catch { /* ignore */ }
  untrackSession(projectDir, serverId);
  return true;
}

async function stopAll() {
  const all = Array.from(_sessions.entries());
  await Promise.allSettled(all.map(([, s]) => s.shutdown()));
  _sessions.clear();
  _byProject.clear();
}

// Re-discover tools without restarting the process. Used by the
// "Refresh" UI button. Returns the discovered tool list.
async function listDiscoveredTools(projectDir, serverId) {
  const session = getSession(projectDir, serverId);
  if (!session) throw err('EMCP_NOSESSION', 'Server is not running', { serverId });
  if (session.status !== 'ready') throw err('EMCP_NOSESSION', 'Server is not ready', { serverId });
  let discovered = [];
  try {
    let cursor;
    for (let i = 0; i < 16; i++) {
      const page = await session.client.listTools(cursor ? { cursor } : undefined, { timeout: 10000 });
      discovered = discovered.concat((page && page.tools) || []);
      cursor = page && page.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    throw err('EMCP_RPC', 'tools/list failed: ' + (e && e.message || e), { serverId });
  }
  session.tools = normalizeToolCache(discovered);
  // Keep the persisted cache in sync when the user taps Refresh.
  try { persistToolCache(projectDir, serverId, session.tools); } catch { /* ignore */ }
  return session.tools.slice();
}

// ---- Tool dispatch ------------------------------------------------------

// callTool: route a model tool_call to the right server and return the
// normalized result. `serverSlug` is the slug the model saw in the
// tool name; `toolName` is the bare tool name from the server. Used
// directly by src/ai.js when intercepting a tool_call.
async function callTool(projectDir, serverSlug, toolName, args) {
  const found = findSessionBySlug(projectDir, serverSlug);
  if (!found) throw err('EMCP_NOSESSION', 'MCP server not running: ' + serverSlug, { serverSlug });
  const { session } = found;
  if (session.status !== 'ready') {
    throw err('EMCP_NOSESSION', 'MCP server not ready: ' + serverSlug, { serverSlug, status: session.status });
  }
  // Confirm the tool is in the discovered list. The MCP spec allows
  // the client to call any tool the server has; this is a defensive
  // check against a stale slug or a tool that disappeared after start.
  const tool = session.tools.find(t => t.name === toolName);
  if (!tool) throw err('EMCP_NOTFOUND', 'Tool not found on MCP server: ' + toolName, { serverSlug, toolName });

  // args must be a JSON object; the MCP spec requires an object even
  // when empty. Defensive: a string or null from upstream gets coerced
  // to {} so we never send `null` over the wire.
  let callArgs = args;
  if (callArgs == null) callArgs = {};
  else if (typeof callArgs !== 'object' || Array.isArray(callArgs)) {
    throw err('EBADINPUT', 'tool args must be a JSON object', { toolName });
  }

  let result;
  try {
    result = await session.client.callTool({ name: toolName, arguments: callArgs }, undefined, { timeout: 60000 });
  } catch (e) {
    throw err('EMCP_RPC', 'tools/call failed: ' + (e && e.message || e), { serverSlug, toolName });
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, content: [{ type: 'text', text: 'MCP server returned no result' }], isError: true };
  }
  // MCP tool results are { content: [...], isError?: bool }. content
  // is an array of typed blocks (text, image, resource, etc). The
  // model-facing shape we forward is the same — the chat UI renders
  // each block in order.
  return {
    ok: result.isError !== true,
    content: Array.isArray(result.content) ? result.content : [],
    isError: result.isError === true
  };
}

// composedToolNameFor and parseComposedToolName are exported so
// src/ai.js can match the model-facing tool name without duplicating
// the convention.
function composedToolNameFor(serverEntry, tool) {
  return composedToolName(serverEntry.slug, tool.name);
}

// ensureEnabledServers(projectDir) -> Promise<[{ id, name, status, tools }]>
//
// Called when the user opens a chat (via /api/tools/list) so a project
// whose MCP servers are enabled starts them lazily — the same behavior
// the Settings UI documents ("open a chat that references a stopped
// server"). Without this, the child process and tool cache are
// in-memory only, so a server restart (or a new chat after one) leaves
// `status: 'stopped'` and `/api/tools/list` returns an empty MCP tool
// list. We only auto-start servers that are both configured *and*
// enabled; a disabled server stays stopped even on chat open.
//
// Each start is fire-and-forget: failures are captured in the result
// (never thrown) so one bad server does not block the chat from
// loading. A server that fails to start is recorded as 'errored' and
// surfaced in the Settings UI; the rest of the enabled set still
// starts.
async function ensureEnabledServers(projectDir) {
  const { list } = readProjectConfig(projectDir);
  const normalized = normalizeAll(list);
  const enabled = normalized.filter(s => s && s.enabled === true);
  if (!enabled.length) return [];
  const results = [];
  for (const entry of enabled) {
    const existing = getSession(projectDir, entry.id);
    if (existing && existing.status === 'ready') {
      results.push(decorate(entry, projectDir));
      continue;
    }
    if (existing && existing.status === 'starting') {
      // Another request is already spawning it; report the current
      // state without double-starting. The caller re-polls later.
      results.push(decorate(entry, projectDir));
      continue;
    }
    try {
      const started = await startServer(projectDir, entry.id);
      results.push(started);
    } catch (e) {
      results.push(Object.assign({}, entry, {
        env: redactEnv(entry.env),
        status: 'errored',
        tools: [],
        error: { code: (e && e.code) || 'EMCP_START', message: (e && e.message) || String(e) }
      }));
    }
  }
  return results;
}

// listComposedToolSpecs(projectDir) -> the model-facing tool spec list.
// Each entry is { name, description, parameters, serverSlug, toolName }.
// The AI client merges these into the upstream tools array.
function listComposedToolSpecs(projectDir) {
  const out = [];
  const seen = new Set();
  // 1) Live sessions first — the running process is the source of truth.
  for (const serverId of (_byProject.get(projectDir) || new Set())) {
    const session = _sessions.get(keyOf(projectDir, serverId));
    if (!session || session.status !== 'ready' || !session.entry.enabled) continue;
    seen.add(serverId);
    const entry = session.entry;
    for (const tool of session.tools) {
      out.push({
        name: composedToolName(entry.slug, tool.name),
        description: tool.description || ('MCP tool: ' + entry.name + '/' + tool.name),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        serverSlug: entry.slug,
        toolName: tool.name
      });
    }
  }
  // 2) Enabled-but-stopped servers fall back to the persisted tool
  //    cache. The model sees the same surface it saw the last time
  //    the server ran; a call will surface EMCP_NOSESSION until the
  //    user starts it again, which is the honest signal.
  try {
    const { list } = readProjectConfig(projectDir);
    const rawById = new Map(list.map(s => [s && s.id, s]));
    for (const entry of normalizeAll(list)) {
      if (!entry || entry.enabled !== true || seen.has(entry.id)) continue;
      const cache = loadToolCache(projectDir, rawById.get(entry.id) || entry);
      if (!cache.length) continue;
      for (const tool of cache) {
        out.push({
          name: composedToolName(entry.slug, tool.name),
          description: tool.description || ('MCP tool: ' + entry.name + '/' + tool.name),
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          serverSlug: entry.slug,
          toolName: tool.name
        });
      }
    }
  } catch { /* config unreadable; live sessions still advertised */ }
  return out;
}

// ---- Shutdown wiring ---------------------------------------------------

let _shuttingDown = false;
function installShutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const handler = () => { stopAll().catch(() => {}); };
  process.once('exit', handler);
  process.once('SIGINT', () => { handler(); process.exit(0); });
  process.once('SIGTERM', () => { handler(); process.exit(0); });
}

module.exports = {
  // constants
  ENV_DENYLIST,
  MCP_FILE,
  getMcpPath,
  // helpers (exported for tests)
  slugify,
  composedToolName,
  parseServerSlugAndToolName,
  buildChildEnv,
  // CRUD
  listServers,
  getServer,
  addServer,
  updateServer,
  removeServer,
  // lifecycle
  startServer,
  stopServer,
  stopAll,
  installShutdown,
  ensureEnabledServers,
  // discovery + dispatch
  listDiscoveredTools,
  callTool,
  composedToolNameFor,
  listComposedToolSpecs,
  normalizeToolCache,
  loadToolCache,
  persistToolCache,
  clearToolCache,
  // for tests + diagnostics
  _sessions,
  _byProject
};
