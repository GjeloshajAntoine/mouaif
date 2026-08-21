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
// Scope: MCP servers can be configured per project (in
// <projectDir>/.mcp.json under servers; legacy <projectDir>/.mouaif.json
// mcp.servers is read as a fallback) or app-wide (in the app SQLite
// store under mcp.servers). A project sees the union — app entries
// first, then project entries — with project entries winning on
// duplicate slugs (the settings resolution order, decisions §2).
// App-scoped entries carry scope: 'app' in API responses; project
// entries are scope: 'project'.
// The runtime state (child processes, live tool lists) is in-memory
// only; the last-known tool list per server is persisted in the app
// SQLite store (settings.getMcpToolCache), not in the project file.
// Servers are stopped on `process.exit`.
//
// Public surface:
//
//   listServers(projectDir)         -> [{ id, name, command, args, env, cwd, scope, status, tools? }]
//   getServer(projectDir, serverId) -> the server record or null
//   addServer(projectDir, opts)     -> the new server record (opts.scope: 'project'|'app')
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
// Errors are typed: EMCP_NOTFOUND, EMCP_DUPLICATE,
// EMCP_START, EMCP_TRANSPORT, EMCP_RPC, EMCP_TIMEOUT, EMCP_NOSESSION.
//
// The SDK is loaded lazily so the rest of the server boots even when
// the SDK fails to load for any reason. The require() result is cached
// in `sdk` so a per-server call costs nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, pathToFileURL } = require('url');
const { err } = require('./util.js');
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
    const httpMod = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    sdk = {
      Client: clientMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport
    };
    return sdk;
  } catch (e) {
    sdkLoadError = new Error('Failed to load @modelcontextprotocol/sdk: ' + (e.message || e));
    sdkLoadError.code = 'EMODULE';
    throw sdkLoadError;
  }
}

// ---- Helpers ------------------------------------------------------------

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

function normalizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (typeof v === 'string') out[k.trim()] = v;
  }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) out[key] = { configured: true };
  return out;
}

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

// ---- Project + app registry ---------------------------------------------

const MCP_FILE = '.mcp.json';
const APP_SCOPE = 'app';
const PROJECT_SCOPE = 'project';

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

// ---- App-level registry ---------------------------------------------------
// App-scoped servers live in the app SQLite store (settings.setApp) under
// `mcp.servers` — same entry shape as project entries. They are visible to
// every project (the project entries win on a slug collision, matching the
// settings resolution order in decisions §2). A project can shadow an app
// entry with a same-named project entry; there is no other per-project
// filtering of app entries.

function readAppConfig() {
  let app = {};
  try { app = settings.getApp() || {}; } catch { app = {}; }
  const mcp = (app.mcp && typeof app.mcp === 'object' && !Array.isArray(app.mcp)) ? app.mcp : {};
  const list = Array.isArray(mcp.servers) ? mcp.servers : [];
  return { mcp, list, source: APP_SCOPE };
}

function writeAppConfig(mcp) {
  // Merge into the existing app.mcp block: it also carries the app-level
  // authorization fallback (tools/authorization.js), and a blanket
  // overwrite would drop the user's MCP policy on every server CRUD.
  let app = {};
  try { app = settings.getApp() || {}; } catch { app = {}; }
  const base = (app.mcp && typeof app.mcp === 'object' && !Array.isArray(app.mcp)) ? app.mcp : {};
  const out = Object.assign({}, base, mcp || { servers: [] });
  if (Array.isArray(out.servers)) {
    out.servers = out.servers.map((s) => {
      if (!s || typeof s !== 'object') return s;
      if (!Object.prototype.hasOwnProperty.call(s, 'toolCache')) return s;
      const clone = Object.assign({}, s);
      delete clone.toolCache;
      return clone;
    });
  }
  settings.setApp({ mcp: out });
}

// readAllConfigs(projectDir) -> { entries: [{ scope, raw }], byId: Map }
//
// The merged view every read path uses. Entries are the raw config objects
// (not normalized) so the write-back for update/remove can land on the
// right file. Project entries override app entries on slug collision — the
// project file is the user's most specific intent.
function readAllConfigs(projectDir) {
  // App entries are always in scope, with or without a project — a null
  // projectDir means "app-only view" (the Settings App tab), not "no
  // config at all".
  const appCfg = readAppConfig();
  let projectList = [];
  if (projectDir) {
    try { projectList = readProjectConfig(projectDir).list; } catch (e) { throw e; }
  }
  const entries = [];
  for (const raw of appCfg.list) {
    if (raw && typeof raw === 'object') entries.push({ scope: APP_SCOPE, raw });
  }
  for (const raw of projectList) {
    if (raw && typeof raw === 'object') entries.push({ scope: PROJECT_SCOPE, raw });
  }
  return { entries };
}

// Write back the full server list for one scope. `scope` is APP_SCOPE or
// PROJECT_SCOPE; `servers` is the normalized entry list to persist.
function writeConfigForScope(projectDir, scope, servers) {
  if (scope === APP_SCOPE) {
    writeAppConfig({ servers });
  } else {
    writeProjectConfig(projectDir, { servers });
  }
}

function normalizeServerEntry(raw, usedSlugs) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  const transport = raw.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'stdio' && (typeof raw.command !== 'string' || !raw.command.trim())) return null;
  if (transport === 'http' && (typeof raw.url !== 'string' || !raw.url.trim())) return null;
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
  const out = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newServerId(),
    name,
    slug: candidate,
    command: transport === 'stdio' ? raw.command.trim() : '',
    url: transport === 'http' ? raw.url.trim() : '',
    headers: normalizeHeaders(raw.headers),
    args,
    env,
    cwd,
    createdAt: raw.createdAt || new Date().toISOString()
  };
  // Only persist the transport field for HTTP — stdio is the implicit
  // default. The read path defaults to 'stdio' when the field is absent.
  if (transport === 'http') out.transport = 'http';
  return out;
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
// ── Schema shrinking ────────────────────────────────────────────────────
// MCP server inputSchema definitions are often extremely verbose: full
// property descriptions, $defs blocks, examples, titles, etc. These get
// serialized into the `tools` array on every upstream API turn, costing
// 10 K – 50 K+ prompt tokens per request. We shrink aggressively:
// keep property names, types, enums, required, items, and simple numeric
// constraints; drop descriptions, $defs, examples, titles, and defaults.
function shrinkMcpSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  // Recursion guard – deep but not infinite; stop at 8 levels.
  const _shrink = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    if (depth > 8) return { type: typeof node.type === 'string' ? node.type : 'object' };

    const out = {};

    // Always preserve type.
    if (typeof node.type === 'string') out.type = node.type;

    // Preserve enum — the model needs the exact values.
    if (Array.isArray(node.enum) && node.enum.length) out.enum = node.enum;

    // Preserve const — same reason.
    if (node.const !== undefined) out.const = node.const;

    // Preserve required (list of property names).
    if (Array.isArray(node.required) && node.required.length) out.required = node.required;

    // Preserve simple numeric/string constraints — they guide the model.
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) {
      if (node[k] !== undefined) out[k] = node[k];
    }

    // Recurse into properties, dropping descriptions.
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      out.properties = {};
      for (const [key, val] of Object.entries(node.properties)) {
        out.properties[key] = _shrink(val, depth + 1);
      }
    }

    // Recurse into items (array element schema).
    if (node.items && typeof node.items === 'object') {
      out.items = _shrink(node.items, depth + 1);
    }

    // Recurse into additionalProperties — keep only the bool/object form.
    if (node.additionalProperties === true || node.additionalProperties === false) {
      out.additionalProperties = node.additionalProperties;
    } else if (node.additionalProperties && typeof node.additionalProperties === 'object' && !Array.isArray(node.additionalProperties)) {
      out.additionalProperties = _shrink(node.additionalProperties, depth + 1);
    }

    // Keep oneOf / anyOf — common pattern in MCP schemas — recursed.
    for (const comb of ['oneOf', 'anyOf']) {
      if (Array.isArray(node[comb])) {
        out[comb] = node[comb].map((item) => _shrink(item, depth + 1));
      }
    }

    // Preserve allOf if present.
    if (Array.isArray(node.allOf)) {
      out.allOf = node.allOf.map((item) => _shrink(item, depth + 1));
    }

    return out;
  };

  return _shrink(schema || {}, 0);
}

// Minimal JSON Schema validator for outputSchema checking (spec 2025-06-18:
// "Clients SHOULD validate structured results against this schema"). Covers
// the subset shrinkMcpSchema preserves: type, enum, const, required,
// properties, items, additionalProperties, oneOf/anyOf/allOf, and the simple
// numeric/string constraints. Returns an error string on mismatch, null on
// success. Deliberately not a full validator — a miss just means we skip
// the warning, never that we reject a valid result.
function validateAgainstSchema(value, schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const at = path || '$';

  // const / enum first — they pin the value exactly.
  if (schema.const !== undefined && value !== schema.const) {
    return at + ': expected const ' + JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some(v => deepEqual(v, value))) {
    return at + ': not in enum';
  }

  if (typeof schema.type === 'string') {
    const t = schema.type;
    const ok =
      (t === 'string' && typeof value === 'string') ||
      (t === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (t === 'boolean' && typeof value === 'boolean') ||
      (t === 'null' && value === null) ||
      (t === 'array' && Array.isArray(value)) ||
      (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value));
    if (!ok) return at + ': expected ' + t + ', got ' + (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return at + ': below minimum ' + schema.minimum;
    if (schema.maximum !== undefined && value > schema.maximum) return at + ': above maximum ' + schema.maximum;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return at + ': shorter than minLength';
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return at + ': longer than maxLength';
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) return at + ': does not match pattern'; } catch { /* bad pattern: skip */ }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return at + ': fewer than minItems';
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return at + ': more than maxItems';
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        const e = validateAgainstSchema(value[i], schema.items, at + '[' + i + ']');
        if (e) return e;
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return at + ': missing required "' + key + '"';
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const key of Object.keys(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          const e = validateAgainstSchema(value[key], schema.properties[key], at + '.' + key);
          if (e) return e;
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return at + ': additional property "' + key + '"';
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          const e = validateAgainstSchema(value[key], schema.additionalProperties, at + '.' + key);
          if (e) return e;
        }
      }
    }
  }
  // Combinators: value must satisfy at least one of oneOf/anyOf, all of allOf.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const e = validateAgainstSchema(value, sub, at);
      if (e) return e;
    }
  }
  for (const comb of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[comb]) && schema[comb].length) {
      const ok = schema[comb].some(sub => validateAgainstSchema(value, sub, at) === null);
      if (!ok) return at + ': no ' + comb + ' branch matched';
    }
  }
  return null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

// Older builds stored the cache inline in .mcp.json under each server
// entry's `toolCache` key. loadToolCache migrates those rows into the
// DB on first read and strips the key the next time the config file is
// written, so the project file shrinks back to just the server config.
function normalizeToolCache(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(t => t && typeof t.name === 'string' && t.name)
    .map(t => {
      const out = {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: (t.inputSchema && typeof t.inputSchema === 'object')
          ? shrinkMcpSchema(t.inputSchema)
          : { type: 'object', properties: {} }
      };
      // outputSchema (spec 2025-06-18+): optional JSON Schema describing the
      // shape of structuredContent results. Preserved (shrunk) so clients can
      // validate structured results against it; omitted when the tool does
      // not declare one.
      if (t.outputSchema && typeof t.outputSchema === 'object' && !Array.isArray(t.outputSchema)) {
        out.outputSchema = shrinkMcpSchema(t.outputSchema);
      }
      return out;
    });
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
const _byProject = new Map(); // scopeKey -> Set<serverId>

// Sessions are keyed by the *context* the server runs in: a project dir
// when there is one, the string 'app' when the server was started without
// a project (app-scope start from the Settings UI). The same app-scoped
// server started from two different projects gets two sessions — each
// project's chat dispatches to its own child.
function scopeKey(projectDir) {
  return (projectDir && typeof projectDir === 'string' && projectDir.trim()) ? projectDir : 'app';
}

function keyOf(projectDir, serverId) { return scopeKey(projectDir) + '::' + serverId; }

function trackSession(projectDir, serverId, session) {
  _sessions.set(keyOf(projectDir, serverId), session);
  const key = scopeKey(projectDir);
  if (!_byProject.has(key)) _byProject.set(key, new Set());
  _byProject.get(key).add(serverId);
}

function untrackSession(projectDir, serverId) {
  _sessions.delete(keyOf(projectDir, serverId));
  const set = _byProject.get(scopeKey(projectDir));
  if (set) {
    set.delete(serverId);
    if (set.size === 0) _byProject.delete(scopeKey(projectDir));
  }
}

function getSession(projectDir, serverId) {
  return _sessions.get(keyOf(projectDir, serverId)) || null;
}

// findSessionBySlug stays inside the requested runtime context. In
// particular, a project chat must not reuse an app-context process:
// that process was initialized without the project's roots/list entry,
// so artifact tools would reject valid project paths as out of scope.
// App-scoped configuration is still available to every project; its
// process is simply started once per project when first called.
function findSessionBySlug(projectDir, serverSlug) {
  const key = scopeKey(projectDir);
  const set = _byProject.get(key);
  if (!set) return null;
  for (const id of set) {
    const s = _sessions.get(key + '::' + id);
    if (s && s.entry && s.entry.slug === serverSlug) return { id, session: s };
  }
  return null;
}

// ---- CRUD ---------------------------------------------------------------

// resolveMerged(projectDir) -> [{ entry, scope, raw }]
//
// The single read path every public surface uses. App entries come first,
// project entries second; a project entry with the same slug as an app
// entry shadows it (the app entry is dropped from the merged view).
// Normalization assigns ids + unique slugs, so the merged list is stable
// across calls within a boot.
function resolveMerged(projectDir) {
  const { entries } = readAllConfigs(projectDir);
  const appRaw = entries.filter(e => e.scope === APP_SCOPE).map(e => e.raw);
  const projectRaw = entries.filter(e => e.scope === PROJECT_SCOPE).map(e => e.raw);
  const appNorm = normalizeAll(appRaw);
  const projectNorm = normalizeAll(projectRaw);
  const projectSlugs = new Set(projectNorm.map(s => s.slug));
  const out = [];
  for (let i = 0; i < appNorm.length; i++) {
    if (projectSlugs.has(appNorm[i].slug)) continue; // project wins
    out.push({ entry: appNorm[i], scope: APP_SCOPE, raw: appRaw[i] });
  }
  for (let i = 0; i < projectNorm.length; i++) {
    out.push({ entry: projectNorm[i], scope: PROJECT_SCOPE, raw: projectRaw[i] });
  }
  return out;
}

function listServers(projectDir) {
  // Stable alphabetical sort by display name within the existing
  // app-before-project scope grouping (scope wins, then name), so the
  // listing is deterministic and friendly to scan regardless of storage
  // order. Case-insensitive, tie-broken by the raw name then storage
  // order (Array.prototype.sort is stable).
  return resolveMerged(projectDir)
    .sort((a, b) => {
      // Scope wins (app before project)
      if (a.scope !== b.scope) return a.scope === APP_SCOPE ? -1 : 1;
      const na = (a.entry.name || '').toLowerCase();
      const nb = (b.entry.name || '').toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return (a.entry.name || '') < (b.entry.name || '') ? -1
        : (a.entry.name || '') > (b.entry.name || '') ? 1 : 0;
    })
    .map(({ entry, scope, raw }) =>
      decorate(Object.assign({}, entry, { scope }), projectDir, raw));
}

function getServer(projectDir, serverId) {
  const found = resolveMerged(projectDir).find(r => r.entry.id === serverId);
  if (!found) return null;
  return decorate(Object.assign({}, found.entry, { scope: found.scope }), projectDir, found.raw);
}

function decorate(entry, projectDir, rawEntry) {
  const session = getSession(projectDir, entry.id);
  const status = session ? session.status : 'stopped';
  // Live tools win; the persisted cache (app DB) is the fallback so a
  // stopped server still shows what it advertised the last time it ran.
  const cache = loadToolCache(projectDir, rawEntry || entry);
  const tools = session ? session.tools.slice() : cache;
  const error = session && session.error ? session.error : null;
  // `enabled` reflects the per-server authorization gate (not `off`).
  // A disabled server surfaces its tools from cache but can never be
  // started on demand; a stopped-but-enabled one can. Absent auth data
  // (decorate also runs without a project) it defaults to enabled so
  // the Settings list is unchanged.
  const enabled = entry.enabled !== undefined ? entry.enabled : serverEnabled(projectDir, entry);
  const decorated = Object.assign({}, entry, { env: redactEnv(entry.env), headers: redactHeaders(entry.headers), status, tools, enabled });
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
  const transport = opts.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'stdio' && (typeof opts.command !== 'string' || !opts.command.trim())) throw err('EBADINPUT', 'command is required');
  if (transport === 'http' && (typeof opts.url !== 'string' || !opts.url.trim())) throw err('EBADINPUT', 'url is required');
  const scope = opts.scope === APP_SCOPE ? APP_SCOPE : PROJECT_SCOPE;
  if (scope === PROJECT_SCOPE && (!projectDir || typeof projectDir !== 'string' || !projectDir.trim())) {
    throw err('EBADINPUT', 'projectDir is required for a project-scoped server');
  }
  // Uniqueness is scope-local: an app entry and a project entry may share
  // a slug (the project one shadows the app one at merge time), but two
  // entries inside the same scope never collide.
  const scopeList = scope === APP_SCOPE ? readAppConfig().list : readProjectConfig(projectDir).list;
  const usedIds = new Set(scopeList.map(s => s && s.id));
  let id = newServerId();
  while (usedIds.has(id)) id = newServerId();
  const usedSlugs = new Set(normalizeAll(scopeList).map(s => s.slug));
  const entry = normalizeServerEntry(Object.assign({}, opts, { id }), usedSlugs);
  if (!entry) throw err('EBADINPUT', 'invalid server entry');
  const next = scopeList.concat([entry]);
  writeConfigForScope(projectDir, scope, next);
  return decorate(Object.assign({}, entry, { scope }), projectDir, entry);
}

// findInScope(projectDir, scope, serverId) -> { list, normalized, idx, scope } | null
//
// Update/remove must search each scope's *own* list, not the merged view:
// the merged view drops a shadowed app entry, but the entry still exists in
// the app store and the user can legitimately want to edit or delete it
// (the Settings App tab shows exactly that un-merged list).
function findInScope(projectDir, scope, serverId) {
  const list = scope === APP_SCOPE ? readAppConfig().list : readProjectConfig(projectDir).list;
  const normalized = normalizeAll(list);
  const idx = normalized.findIndex(s => s.id === serverId);
  if (idx < 0) return null;
  return { list, normalized, idx, scope };
}

function findServerAnyScope(projectDir, serverId) {
  // Project scope first: for a chat-facing lookup the project entry is
  // the one the model can actually see (it shadows an app entry on a
  // slug collision).
  if (projectDir) {
    const p = findInScope(projectDir, PROJECT_SCOPE, serverId);
    if (p) return p;
  }
  return findInScope(projectDir, APP_SCOPE, serverId);
}

function updateServer(projectDir, serverId, patch) {
  if (!serverId) return null;
  const found = findServerAnyScope(projectDir, serverId);
  if (!found) return null;
  const scope = found.scope;
  const normalized = found.normalized;
  const idx = found.idx;
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
  delete cleanPatch.scope; // scope is fixed at creation; use delete+add to move
  delete cleanPatch.projectDir; // transport detail, never persisted
  if (!Object.prototype.hasOwnProperty.call(cleanPatch, 'env')) cleanPatch.env = normalized[idx].env;
  if (!Object.prototype.hasOwnProperty.call(cleanPatch, 'headers')) cleanPatch.headers = normalized[idx].headers;
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
  writeConfigForScope(projectDir, scope, normalized);
  return decorate(Object.assign({}, renormalized, { scope }), projectDir, renormalized);
}

function removeServer(projectDir, serverId) {
  if (!serverId) return false;
  stopServer(projectDir, serverId).catch(() => {});
  const found = findServerAnyScope(projectDir, serverId);
  if (!found) return false;
  const scopeList = found.list;
  const before = scopeList.length;
  const next = scopeList.filter(s => s && s.id !== serverId);
  if (next.length === before) return false;
  writeConfigForScope(projectDir, found.scope, next);
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
  // Per-scope lookup (not the merged view) so a shadowed app entry can
  // still be started from the Settings App tab.
  const found = findServerAnyScope(projectDir, serverId);
  if (!found) throw err('EMCP_NOTFOUND', 'Server not found', { serverId });
  const entry = found.normalized[found.idx];

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

  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = getSdk();
  const hasProject = !!(projectDir && typeof projectDir === 'string' && projectDir.trim());
  let transport;
  if (entry.transport === 'http') {
    let endpoint;
    try { endpoint = new URL(entry.url); } catch { throw err('EBADINPUT', 'HTTP MCP URL is invalid', { serverId }); }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw err('EBADINPUT', 'HTTP MCP URL must start with http:// or https://', { serverId });
    }
    transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: entry.headers || {} }
    });
  } else {
    // Canonicalize an existing project root before comparing cwd values.
    // Projects opened through a symlink otherwise compare their real cwd
    // (for example /mnt/work/app) with the lexical projectDir alias
    // (/home/me/app) and incorrectly look outside the project.
    const projectResolved = hasProject ? canonicalProjectRoot(projectDir) : null;
    // cwd anchor: relative entry.cwd resolves against the canonical project.
    // Without a project context (app-scope start from the Settings UI) a
    // relative cwd has no anchor — fall back to the process cwd; absolute
    // cwd values still work. The project-containment check only applies
    // when there is a project to be contained in.
    const cwd = entry.cwd
      ? (path.isAbsolute(entry.cwd) ? entry.cwd : path.resolve(projectResolved || process.cwd(), entry.cwd))
      : (projectResolved || process.cwd());
    const cwdResolved = canonicalFilesystemPath(cwd);
    if (projectResolved) {
      // Sanity check: cwd must be inside projectDir (decision §4's
      // "outside project" rule, applied to the spawn directory).
      const rel = path.relative(projectResolved, cwdResolved);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw err('EOUTSIDE_PROJECT', 'Server cwd must be inside the project directory', { cwd: cwdResolved });
      }
    }
    const env = buildChildEnv(entry.env);
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      env,
      cwd: cwdResolved,
      stderr: 'pipe'
    });
  }

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
  }, {
    capabilities: {
      // roots: expose the active project as the MCP server's writable workspace.
      roots: { listChanged: false }
      // sampling: not supported — mouaif is a thin client, not an LLM host
      // elicitation: not supported — no UI for server-initiated user prompts
    }
  });

  // Advertising the roots capability is not enough: servers such as Chrome
  // DevTools MCP call roots/list before allowing an artifact write. Return the
  // active project as a file URL so their canonical path boundary matches ours.
  if (hasProject && typeof client.setRequestHandler === 'function') {
    const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const projectRoot = canonicalProjectRoot(projectDir);
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(projectRoot).href, name: path.basename(projectRoot) }]
    }));
  }

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

  // Handle notifications/tools/list_changed (spec: servers that declared
  // the listChanged capability SHOULD send it when tools change). Refresh
  // the live tool list + persisted cache in place so the next
  // listComposedToolSpecs / callTool sees the new surface without a
  // restart. Debounced — a server that adds tools in a burst sends one
  // notification per change and we only need one refresh.
  try {
    const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
    if (ToolListChangedNotificationSchema && typeof client.setNotificationHandler === 'function') {
      let refreshTimer = null;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(async () => {
          refreshTimer = null;
          if (_sessions.get(keyOf(projectDir, serverId)) !== session) return;
          try {
            let refreshed = [];
            let cursor;
            for (let i = 0; i < 16; i++) {
              const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10000 });
              refreshed = refreshed.concat((page && page.tools) || []);
              cursor = page && page.nextCursor;
              if (!cursor) break;
            }
            session.tools = normalizeToolCache(refreshed);
            try { persistToolCache(projectDir, serverId, session.tools); } catch { /* best-effort */ }
          } catch { /* a failed refresh keeps the last-known list */ }
        }, 250);
      });
    }
  } catch { /* SDK without notification support; tool list stays start-time */ }

  session.status = 'ready';
  return decorate(Object.assign({}, entry, { scope: found.scope }), projectDir);
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

// MCP servers commonly require absolute filesystem paths even though mouaif's
// model-facing convention is project-relative. Resolve standard output path
// arguments for every MCP server and keep them confined to the active project.
const MCP_OUTPUT_PATH_KEYS = new Set([
  'filePath',
  'outputPath',
  'outputDirPath',
  'requestFilePath',
  'responseFilePath'
]);

function canonicalFilesystemPath(value) {
  const absolute = path.resolve(value);
  let probe = absolute;
  const suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync(probe);
      return path.resolve(real, ...suffix.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function canonicalProjectRoot(projectDir) {
  return canonicalFilesystemPath(projectDir);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveMcpOutputPaths(projectDir, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const lexicalRoot = path.resolve(projectDir);
  const root = canonicalProjectRoot(projectDir);
  const next = Object.assign({}, args);
  for (const key of MCP_OUTPUT_PATH_KEYS) {
    const value = next[key];
    if (typeof value !== 'string' || !value.trim()) continue;

    let resolved;
    if (path.isAbsolute(value)) {
      const absolute = path.resolve(value);
      // An absolute path may use the symlink alias through which the project
      // was opened. Preserve its project-relative suffix while mapping it to
      // the canonical root advertised through MCP roots/list.
      const lexicalRelative = path.relative(lexicalRoot, absolute);
      resolved = isPathInside(lexicalRoot, absolute)
        ? path.resolve(root, lexicalRelative)
        : absolute;
    } else {
      resolved = path.resolve(root, value);
    }

    resolved = canonicalFilesystemPath(resolved);
    if (!isPathInside(root, resolved)) {
      throw err('EBADINPUT', key + ' must be inside the project directory', { key });
    }
    next[key] = resolved;
  }
  return next;
}

// callTool: route a model tool_call to the right server and return the
// normalized result. `serverSlug` is the slug the model saw in the
// tool name; `toolName` is the bare tool name from the server. Used
// directly by src/ai.js when intercepting a tool_call.
async function callTool(projectDir, serverSlug, toolName, args) {
  let found = findSessionBySlug(projectDir, serverSlug);
  // On-demand start: the model called a tool on a server that is
  // *enabled* (auth mode not `off`) but not currently running. Start it
  // transparently here, within the same awaited call, so the model just
  // sees a (possibly slower) result instead of an EMCP_NOSESSION
  // dead-end that forces the user to go start it by hand. A disabled
  // (`off`) server is never auto-started — only a server the user has
  // checked on can come up on demand.
  if (!found || found.session.status !== 'ready') {
    // Resolve the server by slug so we can (a) refuse to auto-start a
    // disabled server and (b) know the server's id for startServer.
    const entry = resolveMerged(projectDir).find(({ entry }) =>
      (entry.slug === serverSlug) || (slugify(entry.id || entry.name || '') === serverSlug));
    if (!entry) throw err('EMCP_NOSESSION', 'MCP server not running: ' + serverSlug, { serverSlug });
    if (!serverEnabled(projectDir, entry.entry)) {
      throw err('ETOOL_DISABLED', 'MCP server is disabled: ' + serverSlug, { serverSlug });
    }
    try {
      await startServer(projectDir, entry.entry.id);
    } catch (e) {
      // Surface the start failure as the tool result so the model sees a
      // typed error instead of a generic transport error.
      throw err((e && e.code) || 'EMCP_START', 'Failed to start MCP server: ' + ((e && e.message) || String(e)), { serverSlug });
    }
    found = findSessionBySlug(projectDir, serverSlug);
  }
  const { session } = found;
  if (!session || session.status !== 'ready') {
    throw err('EMCP_NOSESSION', 'MCP server not ready after start: ' + serverSlug, { serverSlug, status: session && session.status });
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

  callArgs = resolveMcpOutputPaths(projectDir, callArgs);

  let result;
  try {
    result = await session.client.callTool({ name: toolName, arguments: callArgs }, undefined, { timeout: 60000 });
  } catch (e) {
    throw err('EMCP_RPC', 'tools/call failed: ' + (e && e.message || e), { serverSlug, toolName });
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, content: [{ type: 'text', text: 'MCP server returned no result' }], isError: true };
  }
  // MCP tool results are { content: [...], structuredContent?, isError?: bool }.
  // content is an array of typed blocks (text, image, resource, etc).
  // structuredContent (spec 2025-06-18+) is JSON-typed result data for
  // programmatic use. The model-facing shape we forward is the same —
  // the chat UI renders each block in order.
  const out = {
    ok: result.isError !== true,
    content: Array.isArray(result.content) ? result.content : [],
    isError: result.isError === true
  };
  // Forward structuredContent when present (spec 2025-06-18). This is
  // server-produced result data, not LLM "structured outputs" — it lets
  // callers consume typed JSON without parsing text blocks.
  if (result.structuredContent !== undefined) {
    out.structuredContent = result.structuredContent;
    // Spec: "Clients SHOULD validate structured results against this schema."
    // The check is advisory — a mismatch is surfaced as a warning on the
    // result, never a rejection: the server may legitimately outrun its own
    // schema, and dropping real data would be worse than flagging it.
    if (tool.outputSchema) {
      const vErr = validateAgainstSchema(result.structuredContent, tool.outputSchema);
      if (vErr) {
        out.schemaWarning = 'structuredContent does not match outputSchema: ' + vErr;
      }
    }
  }
  return out;
}

// composedToolNameFor and parseComposedToolName are exported so
// src/ai.js can match the model-facing tool name without duplicating
// the convention.
function composedToolNameFor(serverEntry, tool) {
  return composedToolName(serverEntry.slug, tool.name);
}

// serverEnabled(projectDir, entry) -> boolean
//
// Decide whether a configured MCP server is "enabled" — i.e. its tools
// are exposed to the model and it is eligible for start. The per-server
// authorization mode is the enable signal (decisions §18): `off` means
// the user has disabled the checkbox and the server must NEVER
// auto-start nor be surfaced; any other mode (`ask`/`allow`/`allowlist`,
// default `ask`) means it is enabled. Falling back to the shared MCP
// gate when there is no per-server override matches how authorization
// resolves the server's effective mode everywhere else. Loading the
// authorization module here keeps mcp.js free of a hard dependency on
// it (the layering lives in authorization.js, which already loads
// mcp.js for slug resolution — so we stay one-directional and never
// import-cycle).
// serverEnabled(projectDir, entry) -> boolean
//
// Decide whether a configured MCP server is "enabled" — i.e. its tools
// are exposed to the model and it is eligible for start. The
// per-server authorization mode is the enable signal (decisions §18):
// `off` means the user has disabled the checkbox and the server must
// NEVER auto-start nor be surfaced; any other mode (`ask`/`allow`/
// `allowlist`, default `ask`) means it is enabled.
//
// This reads the authorization block DIRECTLY from the merged config
// (the same `readAllConfigs` inputs `resolveMerged` uses) instead of
// going through tools/authorization.getAuthorization. That's
// deliberate: getAuthorization resolves slugs by calling
// mcp.listServers, which calls decorate -> serverEnabled, which would
// recurse into getAuthorization — a module-init deadlock when
// authorization.js first loads mcp.js. Reading the raw authorization
// block here keeps the layering identical (per-server override >
// project gate > app gate) with no cycle.
function serverEnabled(projectDir, entry) {
  try {
    const slug = entry.slug || slugify(entry.id || entry.name || '');
    // Layering order, lowest precedence first: default 'ask' -> app gate
    // -> project gate -> per-server override. A lower layer that is
    // *present* always wins over the default, including an `off`; only a
    // missing layer falls through to the next.
    let mode = 'ask';
    try {
      const app = settings.getApp() || {};
      const appAuth = app && app.mcp && typeof app.mcp.authorization === 'object'
        ? app.mcp.authorization : {};
      if (appAuth && typeof appAuth.mode === 'string') {
        mode = appAuth.mode;
      }
    } catch { /* ignore app-fallback errors */ }
    // Project gate + per-server override live in the merged config files.
    const cfg = readProjectConfig(projectDir);
    const auth = cfg && cfg.mcp && typeof cfg.mcp.authorization === 'object'
      ? cfg.mcp.authorization : {};
    if (auth && typeof auth.mode === 'string') mode = auth.mode;
    if (auth.servers && typeof auth.servers === 'object' && !Array.isArray(auth.servers)) {
      const over = auth.servers[slug]
        || auth.servers[entry.id];
      if (over && typeof over === 'object' && typeof over.mode === 'string') mode = over.mode;
    }
    return mode !== 'off';
  } catch {
    // Authorization unavailable (module missing, config unreadable):
    // fall back to enabled so a configured server still works the way
    // it always has rather than silently disappearing.
    return true;
  }
}

// ensureServersRunning(projectDir) -> Promise<[{ id, name, status, tools }]>
//
// Called when the user opens a chat (via /api/tools/list). It is now a
// pure *status reporter*: it never spawns a configured MCP server. The
// user's explicit intent drives lifecycle:
//
//   - `off` (auth mode)         -> disabled: reported as such, never
//                                  surfaced nor startable from here.
//   - enabled-but-stopped       -> reported stopped with its persisted
//                                  tool cache (listComposedToolSpecs
//                                  falls back to it); the model's first
//                                  tool-call starts it on demand via
//                                  callTool, or the user taps the reload
//                                  control.
//   - enabled-and-running       -> reported ready.
//
// No child process is spawned here. On-demand start lives in callTool,
// and the explicit /api/mcp/servers/:id/start endpoint drives the reload
// button. This is what stops opening a chat from cold-starting every
// configured MCP server the user never explicitly asked to run.
function ensureServersRunning(projectDir) {
  const configured = resolveMerged(projectDir);
  if (!configured.length) return Promise.resolve([]);
  const results = [];
  for (const { entry, scope } of configured) {
    const enabled = serverEnabled(projectDir, entry);
    results.push(decorate(Object.assign({}, entry, { scope, enabled }), projectDir));
  }
  return Promise.resolve(results);
}

// listComposedToolSpecs(projectDir) -> the model-facing tool spec list.
// Each entry is { name, description, parameters, serverSlug, toolName }.
// The AI client merges these into the upstream tools array.
function listComposedToolSpecs(projectDir) {
  const out = [];
  const seen = new Set();
  // 1) Live sessions first — the running process is the source of truth.
  //    Both the project context and the 'app' context are scanned so an
  //    app-scoped server started from Settings (no project) still
  //    advertises its tools to a chat.
  for (const ctxKey of [scopeKey(projectDir), 'app']) {
    for (const serverId of (_byProject.get(ctxKey) || new Set())) {
      if (seen.has(serverId)) continue;
      const session = _sessions.get(ctxKey + '::' + serverId);
      if (!session || session.status !== 'ready') continue;
      seen.add(serverId);
      const entry = session.entry;
      for (const tool of session.tools) {
        out.push({
          name: composedToolName(entry.slug, tool.name),
          description: tool.description || ('MCP tool: ' + entry.name + '/' + tool.name),
          parameters: shrinkMcpSchema(tool.inputSchema) || { type: 'object', properties: {} },
          serverSlug: entry.slug,
          toolName: tool.name
        });
      }
    }
  }
  // 2) Enabled-but-stopped servers fall back to the persisted tool
  //    cache. The model sees the same surface it saw the last time
  //    the server ran; a call will surface EMCP_NOSESSION until the
  //    user starts it again, which is the honest signal.
  try {
    for (const { entry, raw } of resolveMerged(projectDir)) {
      if (!entry || seen.has(entry.id)) continue;
      const cache = loadToolCache(projectDir, raw || entry);
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
  APP_SCOPE,
  PROJECT_SCOPE,
  getMcpPath,
  // helpers (exported for tests)
  slugify,
  composedToolName,
  parseServerSlugAndToolName,
  normalizeHeaders,
  buildChildEnv,
  resolveMcpOutputPaths,
  // CRUD
  listServers,
  getServer,
  addServer,
  updateServer,
  removeServer,
  resolveMerged,
  // lifecycle
  startServer,
  stopServer,
  stopAll,
  installShutdown,
  ensureServersRunning,
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
