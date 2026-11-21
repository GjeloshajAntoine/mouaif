'use strict';

// What a forwarded request may do on the sharing machine
// (docs/features/share-project.md → "Rules").
//
// A request forwarded by the adding mouaif enters the normal route table as a
// "share caller", not as a browser session. Before any handler runs it must
// pass, in order:
//
//   1. the route allowlist below (project-scoped routes only: no access,
//      provider, credential, restart, app-settings, inspector or folder
//      browsing endpoints);
//   2. the share's access level ("files" shares refuse shell, terminal,
//      command and git-write routes);
//   3. the project filter: the request names the shared project (projectDir in
//      the query or the JSON body) and every path it names stays inside it.
//
// The caller is also kept in an AsyncLocalStorage context for the life of the
// request and everything it starts (the agent loop, subagents, tools), which
// is how the tool gate and the borrowed-provider model resolution know who is
// asking without threading a parameter through every module.

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const callerStore = new AsyncLocalStorage();

// The share caller for the current async context, or null for local requests.
function currentCaller() {
  return callerStore.getStore() || null;
}

function runAsCaller(caller, fn) {
  return callerStore.run(caller, fn);
}

// ---- Route allowlist ------------------------------------------------------------
// Each row: [methods ('*' = any), path test, minimum access, options]
//   access 'files' — allowed for every share; 'full' — files-and-shell only
//   noProject      — the route carries no projectDir (checked another way)
//   paths          — query/body keys that name a file or folder path
const R = (methods, test, access, opts = {}) => ({ methods, test, access, ...opts });
const exact = (p) => (u) => u === p;
const under = (p) => (u) => u === p || u.startsWith(p + '/');
const re = (rx) => (u) => rx.test(u);

const ROUTES = [
  // Chats, their transcript, streaming, live re-entry, drafts, images.
  R('*', re(/^\/api\/chats\/[^/]+\/hooks(\/.*)?$/), 'full'),
  R('*', under('/api/chats'), 'files'),
  // Project settings (never app settings).
  R('*', under('/api/settings/project'), 'files'),
  R(['GET'], exact('/api/settings/resolved'), 'files'),
  R('*', exact('/api/settings/hide-file-content'), 'files'),
  // The in-app file editor and image preview, confined to the project.
  R(['GET'], exact('/api/files'), 'files', { paths: ['dir'] }),
  R(['GET', 'PUT'], exact('/api/file'), 'files', { paths: ['path'] }),
  R(['GET'], exact('/api/file-media'), 'files', { paths: ['path'] }),
  // Project prompts, agents, features and the tool surface.
  R('*', under('/api/prompts'), 'files'),
  R('*', under('/api/agents'), 'files'),
  R(['GET'], exact('/api/features'), 'files'),
  R(['GET'], exact('/api/tools/list'), 'files'),
  R('*', under('/api/tools/authorization'), 'files'),
  R(['POST'], exact('/api/tools/subagent'), 'files'),
  // Git: reading is file access; running git commands is not.
  R(['GET'], exact('/api/git/info'), 'files'),
  R(['GET'], exact('/api/git/commits'), 'files'),
  R(['GET'], exact('/api/git/commit-files'), 'files'),
  R(['POST'], exact('/api/git'), 'full'),
  // MCP: listing is fine, starting servers and calling tools runs commands.
  R(['GET'], exact('/api/mcp/servers'), 'files'),
  R('*', under('/api/mcp/servers'), 'full'),
  R(['POST'], exact('/api/mcp/call'), 'full'),
  // Shell, terminal, custom actions, project hooks, the web preview tool.
  R(['POST'], exact('/api/tools/shell'), 'full'),
  R(['POST'], exact('/api/tools/shell/review'), 'full'),
  R(['GET'], exact('/api/tools/cli/session'), 'full'),
  R(['GET'], exact('/api/tools/cli/sessions'), 'full'),
  R(['GET'], exact('/api/tools/cli/output'), 'full', { noProject: 'cliSession' }),
  R(['POST'], exact('/api/tools/cli/command'), 'full'),
  R(['POST'], exact('/api/tools/cli/close'), 'full'),
  R(['POST'], exact('/api/tools/webpreview'), 'full'),
  R('*', under('/api/actions'), 'full'),
  R('*', under('/api/hooks/project'), 'full'),
  // The app event stream: notices about the shared project, and with full
  // access its terminal's output (filtered in src/http-server.js).
  R(['GET'], exact('/events'), 'files', { noProject: 'events' })
];

const ACCESS_RANK = { files: 1, full: 2 };

function typed(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function routeFor(method, urlPath) {
  for (const row of ROUTES) {
    if (row.methods !== '*' && !row.methods.includes(method)) continue;
    if (row.test(urlPath)) return row;
  }
  return null;
}

function sameDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

// The real path of `p`, or of its deepest existing ancestor joined with the
// rest, so a not-yet-created file is judged by the folder it would land in
// and a symlink inside the project cannot point the check outside it.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function insideDir(root, target) {
  if (typeof target !== 'string' || !target) return true; // the handler reports a missing path
  const base = realish(root);
  const abs = realish(path.isAbsolute(target) ? target : path.join(root, target));
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function firstValue(v) { return Array.isArray(v) ? v[0] : v; }

// checkRequest({ share, method, urlPath, query, body, hooks }) — throws a typed
// error (status, code) when the request is not allowed; returns the route.
// `share` is { projectDir, access }. `body` is the parsed JSON body or null.
// `hooks.cliSessionDir(id)` returns the project folder of a terminal session.
function checkRequest({ share, method, urlPath, query, body, hooks = {} }) {
  const route = routeFor(method, urlPath);
  if (!route) throw typed(403, 'ESHARE_ROUTE', 'This is not available through a shared project');
  if ((ACCESS_RANK[share.access] || 1) < ACCESS_RANK[route.access]) {
    throw typed(403, 'ESHARE_FILES_ONLY', 'This share allows files only: shell and commands are off');
  }
  const q = query || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // App-scoped variants of project routes (`?scope=app`) act on the whole
  // sharing machine, not the project.
  if (firstValue(q.scope) === 'app' || b.scope === 'app') {
    throw typed(403, 'ESHARE_ROUTE', 'App-wide settings are not available through a shared project');
  }
  const named = [firstValue(q.projectDir), b.projectDir].filter((v) => typeof v === 'string' && v);
  for (const dir of named) {
    if (!sameDir(dir, share.projectDir)) throw typed(403, 'ESHARE_PROJECT', 'This request names a project that is not shared');
  }
  // A terminal session is named by id: it must be the shared project's own,
  // whatever else the request names.
  if (route.noProject === 'cliSession') {
    const dir = typeof hooks.cliSessionDir === 'function' ? hooks.cliSessionDir(firstValue(q.id)) : null;
    if (!dir || !sameDir(dir, share.projectDir)) throw typed(403, 'ESHARE_PROJECT', 'This terminal does not belong to the shared project');
  } else if (!named.length && !route.noProject) {
    throw typed(403, 'ESHARE_PROJECT', 'A shared project request must name its project');
  }
  for (const key of route.paths || []) {
    for (const value of [firstValue(q[key]), b[key]]) {
      if (typeof value === 'string' && value && !insideDir(share.projectDir, value)) {
        throw typed(403, 'ESHARE_PATH', 'Only files inside the shared project can be opened');
      }
    }
  }
  return route;
}

// ---- Tool gate ----------------------------------------------------------------
// Tools a share caller may never use, whatever the project's tool settings say:
// they act on the whole machine or on other projects.
const NEVER = new Set(['restart_app', 'list_projects']);
// Tools a files-only share refuses: anything that runs a command now or later
// (scheduled wakes, webhooks and hooks start turns or commands outside this
// request), plus MCP servers and the sharing machine's browser.
const FILES_ONLY_DENIED = new Set([
  'shell', 'group_cli', 'webpreview',
  'schedule_wake', 'schedule_cancel',
  'webhook_create', 'webhook_delete',
  'hook_create', 'hook_delete'
]);

// toolDenied(name, args) -> null, or the reason a share caller may not run it.
function toolDenied(name, args) {
  const caller = currentCaller();
  if (!caller) return null;
  const tool = String(name || '');
  const a = args && typeof args === 'object' ? args : {};
  if (NEVER.has(tool)) return tool + ' is not available through a shared project';
  if ((tool === 'get_settings' || tool === 'update_settings') && a.scope === 'app') {
    return 'App settings are not available through a shared project';
  }
  if (tool === 'change_working_folder' && typeof a.directory === 'string' && a.directory
    && !insideDir(caller.projectDir, a.directory)) {
    return 'A shared project can only work in folders inside it';
  }
  if (caller.access !== 'full' && (FILES_ONLY_DENIED.has(tool) || tool.startsWith('mcp__'))) {
    return tool + ' is off: this project is shared for files only';
  }
  return null;
}

// filterToolList(tools) — a tool catalog ([{ name, kind, ... }]) without the
// tools the current share caller may not use. Unchanged for a local request.
function filterToolList(tools) {
  if (!currentCaller() || !Array.isArray(tools)) return tools;
  return tools.filter((t) => !(t && t.name && toolDenied(t.name, {})));
}

// maskAuthorization(view) — the authorization view (`{ tools: { name: cfg } }`)
// with every tool the current share caller may not use shown as off and
// marked `share: 'denied'`. Unchanged for a local request.
function maskAuthorization(view) {
  if (!currentCaller() || !view || typeof view !== 'object' || !view.tools) return view;
  const tools = Object.assign({}, view.tools);
  for (const name of Object.keys(tools)) {
    if (toolDenied(name, {})) tools[name] = Object.assign({}, tools[name], { mode: 'off', enabled: false, share: 'denied' });
  }
  const out = Object.assign({}, view, { tools });
  // MCP tools as a whole (a files-only share runs no MCP server).
  if (view.mcp && typeof view.mcp === 'object' && toolDenied('mcp__any__tool', {})) {
    out.mcp = Object.assign({}, view.mcp, { mode: 'off', enabled: false, share: 'denied' });
  }
  return out;
}

// mcpHidden() — true for a share caller whose share does not allow MCP tools.
function mcpHidden() {
  const caller = currentCaller();
  return !!caller && caller.access !== 'full';
}

module.exports = {
  mcpHidden,
  filterToolList,
  maskAuthorization,
  ROUTES,
  currentCaller,
  runAsCaller,
  routeFor,
  checkRequest,
  insideDir,
  sameDir,
  toolDenied,
  FILES_ONLY_DENIED
};
