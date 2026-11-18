// Pure helpers for parsing and exporting standard MCP server JSON blocks
// (`mcpServers` from Claude Desktop / Cursor / Windsurf, `servers` from VS Code
// and mouaif `.mcp.json`, or a single server object) and filtering servers/tools
// in the MCP management UI.

function normalizeEnvMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

function normalizeHeaderMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

function detectTransport(raw, url) {
  const t = typeof raw.transport === 'string'
    ? raw.transport.trim().toLowerCase()
    : (typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '');
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamable_http' || t === 'streamablehttp') return 'http';
  if (t === 'stdio' || t === 'local') return 'stdio';
  if (url) {
    return /\/sse(?:[/?#]|$)/i.test(url) ? 'sse' : 'http';
  }
  return 'stdio';
}

// Coerce one raw server entry into a clean POST /api/mcp/servers body
// (without scope/projectDir, which the caller attaches) or return an error.
export function coerceImportedServer(raw, fallbackName = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: (fallbackName ? fallbackName + ': ' : '') + 'entry must be a JSON object.' };
  }
  const name = (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : String(fallbackName || '').trim();
  if (!name) return { ok: false, error: 'Each server needs a name.' };

  const url = typeof raw.url === 'string' ? raw.url.trim()
    : (typeof raw.serverUrl === 'string' ? raw.serverUrl.trim() : '');
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const transport = detectTransport(raw, !command ? url : '');

  if (transport === 'stdio') {
    if (!command) {
      return { ok: false, error: name + ': missing "command" (or "url" for a remote server).' };
    }
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a) => a != null).map((a) => String(a))
      : [];
    const env = normalizeEnvMap(raw.env);
    const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
    const spec = { name, transport: 'stdio', command, args };
    if (Object.keys(env).length) spec.env = env;
    if (cwd) spec.cwd = cwd;
    return { ok: true, server: spec };
  }

  if (!url) {
    return { ok: false, error: name + ': missing "url" for remote server.' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: name + ': URL must start with http:// or https://.' };
    }
  } catch {
    return { ok: false, error: name + ': invalid URL "' + url + '".' };
  }
  const headers = normalizeHeaderMap(raw.headers);
  const spec = { name, transport, url };
  if (Object.keys(headers).length) spec.headers = headers;
  if (raw.oauth && typeof raw.oauth === 'object' && raw.oauth.enabled) {
    spec.oauth = {
      enabled: true,
      clientId: typeof raw.oauth.clientId === 'string' ? raw.oauth.clientId.trim() : '',
      scope: typeof raw.oauth.scope === 'string' ? raw.oauth.scope.trim() : ''
    };
    if (raw.oauth.grant === 'client_credentials') spec.oauth.grant = 'client_credentials';
  }
  return { ok: true, server: spec };
}

function looksLikeSingleServer(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return typeof obj.command === 'string' || typeof obj.url === 'string' || typeof obj.serverUrl === 'string';
}

// Parse pasted MCP JSON into `{ ok, servers, errors }`.
// Accepts:
//   1. Full `{ "mcpServers": { "name": { ... } } }` (Claude / Cursor / Windsurf)
//   2. Full `{ "servers": { "name": { ... } } }` or `{ "servers": [ ... ] }` (VS Code / mouaif `.mcp.json`)
//   3. A key-value map `{ "github": { "command": "npx", ... } }`
//   4. A single server object `{ "name": "fs", "command": "npx", ... }`
//   5. A bare `"name": { "command": ... }` snippet copied from inside `mcpServers`
export function parseMcpJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, servers: [], errors: ['Paste a JSON configuration first.'] };

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstErr) {
    // Support snippets like `"github": { "command": "npx", "args": [...] }`
    const unwrapped = trimmed.replace(/,\s*$/, '');
    if (/^["'][^"']+["']\s*:/.test(unwrapped)) {
      try { parsed = JSON.parse('{' + unwrapped + '}'); } catch { /* fall through */ }
    }
    if (!parsed) {
      return { ok: false, servers: [], errors: ['Invalid JSON: ' + (firstErr && firstErr.message ? firstErr.message : 'syntax error')] };
    }
  }

  if (Array.isArray(parsed)) {
    const servers = [];
    const errors = [];
    parsed.forEach((item, index) => {
      const res = coerceImportedServer(item, item && item.name ? item.name : 'server-' + (index + 1));
      if (res.ok) servers.push(res.server);
      else errors.push(res.error);
    });
    return { ok: servers.length > 0 && errors.length === 0, servers, errors };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, servers: [], errors: ['Expected a JSON object or array of servers.'] };
  }

  if (looksLikeSingleServer(parsed)) {
    const res = coerceImportedServer(parsed, parsed.name || 'mcp-server');
    return res.ok
      ? { ok: true, servers: [res.server], errors: [] }
      : { ok: false, servers: [], errors: [res.error] };
  }

  // Unwrap `{ mcp: { servers: ... } }`, `{ mcpServers: ... }`, or `{ servers: ... }`
  let container = parsed;
  if (container.mcp && typeof container.mcp === 'object' && !Array.isArray(container.mcp)) {
    container = container.mcp;
  }
  if (container.mcpServers && typeof container.mcpServers === 'object') {
    container = container.mcpServers;
  } else if (container.servers && typeof container.servers === 'object') {
    container = container.servers;
  }

  if (Array.isArray(container)) {
    const servers = [];
    const errors = [];
    container.forEach((item, index) => {
      const res = coerceImportedServer(item, item && item.name ? item.name : 'server-' + (index + 1));
      if (res.ok) servers.push(res.server);
      else errors.push(res.error);
    });
    if (!servers.length && !errors.length) errors.push('No servers found in the array.');
    return { ok: servers.length > 0 && errors.length === 0, servers, errors };
  }

  const entries = Object.entries(container).filter(([key]) => key !== '$schema' && key !== 'authorization' && key !== 'inputs');
  if (!entries.length) {
    return { ok: false, servers: [], errors: ['No server definitions found in JSON.'] };
  }

  const servers = [];
  const errors = [];
  for (const [key, val] of entries) {
    const res = coerceImportedServer(val, key);
    if (res.ok) servers.push(res.server);
    else errors.push(res.error);
  }
  return { ok: servers.length > 0 && errors.length === 0, servers, errors };
}

// Build a clean, secret-redacted JSON snippet for copying/sharing a server or list.
// Write-only env / header keys are emitted as `<YOUR_KEY>` placeholders so the
// exported snippet is immediately usable as a template without leaking secrets.
export function serializeMcpServersJson(servers) {
  const list = Array.isArray(servers) ? servers : (servers ? [servers] : []);
  const mcpServers = {};
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const key = (s.slug || s.name || s.id || 'server').trim();
    const transport = s.transport === 'http' || s.transport === 'sse' ? s.transport : 'stdio';
    if (transport === 'stdio') {
      const item = { command: s.command || '' };
      if (Array.isArray(s.args) && s.args.length) item.args = [...s.args];
      const envKeys = Object.keys(s.env || {}).filter((k) => s.env[k] && (s.env[k].configured || typeof s.env[k] === 'string'));
      if (envKeys.length) {
        item.env = {};
        for (const k of envKeys) item.env[k] = typeof s.env[k] === 'string' ? s.env[k] : '<' + k + '>';
      }
      if (s.cwd) item.cwd = s.cwd;
      mcpServers[key] = item;
    } else {
      const item = { url: s.url || '' };
      if (transport === 'sse') item.transport = 'sse';
      const headerKeys = Object.keys(s.headers || {}).filter((k) => s.headers[k] && (s.headers[k].configured || typeof s.headers[k] === 'string'));
      if (headerKeys.length) {
        item.headers = {};
        for (const k of headerKeys) item.headers[k] = typeof s.headers[k] === 'string' ? s.headers[k] : '<' + k + '>';
      }
      if (s.oauth && s.oauth.enabled) {
        item.oauth = { enabled: true };
        if (s.oauth.clientId) item.oauth.clientId = s.oauth.clientId;
        if (s.oauth.scope) item.oauth.scope = s.oauth.scope;
        if (s.oauth.grant === 'client_credentials') item.oauth.grant = 'client_credentials';
      }
      mcpServers[key] = item;
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

// Human-readable one-line summary of how a server connects (command + args or URL).
export function serverTargetSummary(server) {
  if (!server || typeof server !== 'object') return '';
  const transport = server.transport === 'http' || server.transport === 'sse' ? server.transport : 'stdio';
  if (transport !== 'stdio') return server.url || '';
  const parts = [server.command || ''].concat(Array.isArray(server.args) ? server.args : []).filter(Boolean);
  return parts.join(' ');
}

// Summary counts across a server list for the overview strip.
export function summarizeMcpServers(servers, mcpAuth) {
  const list = Array.isArray(servers) ? servers : [];
  let ready = 0, starting = 0, errored = 0, stopped = 0, off = 0, tools = 0, appCount = 0, projectCount = 0;
  const serverMap = (mcpAuth && mcpAuth.servers) || {};
  const sharedMode = (mcpAuth && mcpAuth.mode) || 'ask';
  for (const s of list) {
    if (!s) continue;
    if (s.scope === 'app') appCount++; else projectCount++;
    tools += Array.isArray(s.tools) ? s.tools.length : 0;
    const slug = s.slug || s.id || '';
    const ov = slug && serverMap[slug] && serverMap[slug].mode;
    const effMode = ov || sharedMode;
    const isOff = s.enabled === false || effMode === 'off';
    if (isOff) off++;
    const st = s.status || 'stopped';
    if (st === 'ready') ready++;
    else if (st === 'starting') starting++;
    else if (st === 'errored') errored++;
    else stopped++;
  }
  return { total: list.length, ready, starting, errored, stopped, off, tools, appCount, projectCount };
}

// Filter a server list by search query, scope/status filter, and discovered tool names.
export function filterMcpServers(servers, { search = '', filter = 'all', mcpAuth = null } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const q = String(search || '').trim().toLowerCase();
  const serverMap = (mcpAuth && mcpAuth.servers) || {};
  const sharedMode = (mcpAuth && mcpAuth.mode) || 'ask';

  return list.filter((s) => {
    if (!s) return false;
    const slug = s.slug || s.id || '';
    const effMode = (slug && serverMap[slug] && serverMap[slug].mode) || sharedMode;
    const isOff = s.enabled === false || effMode === 'off';
    const st = s.status || 'stopped';

    if (filter === 'ready' && st !== 'ready') return false;
    if (filter === 'errored' && st !== 'errored') return false;
    if (filter === 'stopped' && (st !== 'stopped' || isOff)) return false;
    if (filter === 'off' && !isOff) return false;
    if (filter === 'app' && s.scope !== 'app') return false;
    if (filter === 'project' && s.scope === 'app') return false;

    if (!q) return true;
    const hay = [
      s.name || '',
      s.slug || '',
      s.command || '',
      ...(Array.isArray(s.args) ? s.args : []),
      s.url || '',
      ...(Array.isArray(s.tools) ? s.tools.flatMap((t) => [t.name || '', t.composedName || '', t.description || '']) : [])
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}
