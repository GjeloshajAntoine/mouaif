// frontend/src/routes.js — the hash → route mapping, as data.
//
// router.js owns the browser wiring (the `hashchange` listener and `nav()`);
// everything decidable from the hash text alone lives here, so the whole
// route surface is one table and can be tested without a DOM
// (scripts/test-routes.js).
//
// Adding a route is one entry. Adding a *sub-page* under an existing prefix
// means putting the exact entry above the prefix entry, because the table is
// matched in order. Three places depend on that order:
//   1. `settings/mcp/registry` and `settings/mcp/new` before `settings/mcp/<id>`;
//   2. `settings/providers/new` before `settings/providers/<id>`;
//   3. the legacy `settings/project/agents/<name>` alias before any
//      `settings/project` entry.
//
// An entry's `build` may return `null` to fall through to the next entry
// (used by the provider id prefix, which ignores an empty or reserved id).
// Nothing matched means `{ name: 'chats' }`, the app's default view.

const FROM_VALUES = ['projects', 'settings/projects'];

// fromParam(params) — the `from` query param shared by the project-scoped
// settings views. It records where the user entered project settings from
// (the Projects tab, or Settings → Projects) so the back button can return
// to that exact place even after a round-trip through a sub-page. Anything
// else is ignored so the back button falls through to the default target.
export function fromParam(params) {
  const from = params.get('from') || '';
  return FROM_VALUES.includes(from) ? from : '';
}

// paramsAfterQuery(hash) — the query string, as a URLSearchParams. The hash
// holds at most one `?`, so the first one starts the query.
function paramsAfterQuery(hash) {
  const at = hash.indexOf('?');
  return new URLSearchParams(at >= 0 ? hash.slice(at + 1) : '');
}

// decodeId(value) — decode one path segment. `decodeURIComponent` throws a
// URIError on malformed input (`%zz`, a truncated `%e0`), which would take
// the whole router down on a hand-edited or truncated URL, so a failure
// returns the segment as written. The server has the same guard in
// `src/util.js` (`safeDecode`).
function decodeId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// ---- Matchers ---------------------------------------------------------
// Each returns `null` (no match) or a match object handed to `build`:
//   `{ id?: string, params: URLSearchParams }`

// exact(path) — the hash is exactly this path, with no query.
function exact(path, build) {
  return { match: (hash) => (hash === path ? { params: new URLSearchParams() } : null), build };
}

// exactOrQuery(path) — this path, with or without a query string. Used by
// every page that accepts `?projectDir=…`, `?from=…` and friends.
function exactOrQuery(path, build) {
  return {
    match: (hash) => (hash === path || hash.startsWith(path + '?') ? { params: paramsAfterQuery(hash) } : null),
    build
  };
}

// prefix(head) — this path prefix; the segment up to the query is the id.
function prefix(head, build) {
  return {
    match: (hash) => {
      if (!hash.startsWith(head)) return null;
      const rest = hash.slice(head.length);
      const at = rest.indexOf('?');
      return {
        id: at >= 0 ? rest.slice(0, at) : rest,
        params: paramsAfterQuery(hash)
      };
    },
    build
  };
}

// ---- The table --------------------------------------------------------

const ROUTES = [
  // ---- Legacy aliases ------------------------------------------------
  // Old links, bookmarks and installed PWAs must keep resolving.
  //
  // `#/projects` was the old name of the chat list; `#/auth` was the old
  // name of the settings root (it still lands on Settings, not on the
  // access page); `#/settings/copilot` was the standalone GitHub Copilot
  // OAuth-app config, which now lives inside that provider's form.
  exact('projects', () => ({ name: 'chats' })),
  exact('auth', () => ({ name: 'settings' })),
  exact('settings/copilot', () => ({ name: 'settingsProviderEdit', id: 'github-copilot' })),
  // Agent editing used to live under settings/project.
  prefix('settings/project/agents/', (m) => ({
    name: 'settingsAgentEdit', id: decodeId(m.id),
    projectDir: m.params.get('projectDir') || '', from: fromParam(m.params),
    chatId: m.params.get('chatId') || '', returnTo: 'project',
    isNew: m.id === 'new' && m.params.get('edit') !== '1'
  })),

  // ---- Fixed pages ---------------------------------------------------
  exact('settings', () => ({ name: 'settings' })),
  exact('settings/access', () => ({ name: 'settingsAccess' })),
  exact('inspector', () => ({ name: 'inspector' })),
  // Dictation — the speech-to-text page. App-level, so it lives under
  // Settings (`Settings → App defaults → Dictation`) rather than in the
  // bottom tab bar. A fixed route with no parameters: which model it dictates
  // with is a choice made on the page (and remembered app-wide), not a value
  // that belongs in the URL. `#/dictation` was the page's hash while it had
  // its own tab, so it stays as a legacy alias for bookmarks and installed
  // PWAs (both hashes build the same route).
  exact('settings/dictation', () => ({ name: 'settingsDictation' })),
  exact('dictation', () => ({ name: 'settingsDictation' })),
  exact('settings/projects', () => ({ name: 'settingsProjects' })),
  exact('settings/defaults', () => ({ name: 'settingsDefaults' })),
  exact('settings/notifications', () => ({ name: 'settingsNotifications' })),
  exact('settings/pricing', () => ({ name: 'settingsPricing' })),
  exact('settings/about', () => ({ name: 'settingsAbout' })),

  // ---- Providers -----------------------------------------------------
  // Providers are app-wide: the list, the "new" form, then the editor.
  // A prefix hit whose id is empty or the reserved word `new` falls
  // through, so `#/settings/providers/` cannot open a provider named "".
  exact('settings/providers', () => ({ name: 'settingsProviders' })),
  exact('settings/providers/new', () => ({ name: 'settingsProviderNew' })),
  prefix('settings/providers/', (m) => (
    m.id && m.id !== 'new' ? { name: 'settingsProviderEdit', id: decodeId(m.id) } : null
  )),

  // ---- Project settings ----------------------------------------------
  // Sub-pages first, then the project settings root.
  exactOrQuery('settings/project/technical', (m) => ({
    name: 'settingsProjectTechnical',
    projectDir: m.params.get('projectDir') || '',
    chatId: m.params.get('chatId') || '',
    from: fromParam(m.params)
  })),
  // `File tool options` (size / structure / JSON), a sibling of Technical
  // details under Settings → Project.
  exactOrQuery('settings/project/output', (m) => ({
    name: 'settingsProjectOutput',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),
  // `Web preview`, a sibling of File tool options.
  exactOrQuery('settings/project/preview', (m) => ({
    name: 'settingsProjectPreview',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),
  // `Hide file content`: redaction rules for the agent file tools.
  exactOrQuery('settings/project/hide', (m) => ({
    name: 'settingsProjectHide',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params),
    filePath: m.params.get('file') || ''
  })),
  exactOrQuery('settings/project', (m) => ({
    name: 'settingsProject',
    projectDir: m.params.get('projectDir') || '',
    chatId: m.params.get('chatId') || '',
    from: fromParam(m.params)
  })),

  // ---- Agents --------------------------------------------------------
  // Project-scoped: the active project is the default, `?projectDir=`
  // overrides it (the same resolution the prompts list uses).
  exactOrQuery('settings/agents', (m) => ({
    name: 'settingsAgents',
    projectDir: m.params.get('projectDir') || '',
    chatId: m.params.get('chatId') || '',
    from: fromParam(m.params)
  })),
  prefix('settings/agents/', (m) => ({
    name: 'settingsAgentEdit', id: decodeId(m.id),
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params),
    chatId: m.params.get('chatId') || '',
    returnTo: m.params.get('returnTo') === 'project' ? 'project' : '',
    isNew: m.id === 'new' && m.params.get('edit') !== '1'
  })),

  // ---- Custom actions ------------------------------------------------
  exactOrQuery('settings/actions', (m) => ({
    name: 'settingsActions',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),
  prefix('settings/actions/', (m) => ({
    name: 'settingsActionEdit', id: decodeId(m.id),
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),

  // ---- Custom prompts ------------------------------------------------
  // One route for both scopes: app-wide (Settings → App defaults → Custom
  // prompts, no `projectDir`) and project-scoped (Settings → This project).
  exactOrQuery('settings/prompts', (m) => ({
    name: 'settingsPrompts', id: '',
    projectDir: m.params.get('projectDir') || '',
    scope: m.params.get('scope') || '',
    from: fromParam(m.params)
  })),
  prefix('settings/prompts/', (m) => ({
    // The prompts editor keeps the id as written; the other editors decode
    // it. Left as-is so this refactor stays behaviour-preserving — the
    // editor looks the id up in its own list either way.
    name: 'settingsPrompts', id: m.id,
    projectDir: m.params.get('projectDir') || '',
    scope: m.params.get('scope') || '',
    from: fromParam(m.params)
  })),

  // ---- MCP -----------------------------------------------------------
  // `settings/mcp/registry` routes to the browse view and must be matched
  // before the generic `settings/mcp/<id>`.
  exactOrQuery('settings/mcp/registry', (m) => ({
    name: 'settingsMcpRegistry',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),
  // Settings → MCP lists servers in both scopes (app-wide + per project).
  // The active project is the source of truth for the Project tab; the
  // hash can override it via `?projectDir=…` for deep links and tests.
  exactOrQuery('settings/mcp', (m) => ({
    name: 'settingsMcp',
    projectDir: m.params.get('projectDir') || '',
    from: fromParam(m.params)
  })),
  // "New" is matched before the generic `/:id` entry, so
  // `#/settings/mcp/new?scope=…` cannot look up a server called "new".
  // `?scope=app|project` pre-selects the scope an add creates in, and tells
  // an edit which list it came from.
  exactOrQuery('settings/mcp/new', (m) => ({
    name: 'settingsMcpEdit', id: '',
    projectDir: m.params.get('projectDir') || '',
    scope: m.params.get('scope') === 'app' ? 'app' : (m.params.get('scope') === 'project' ? 'project' : ''),
    from: fromParam(m.params)
  })),
  prefix('settings/mcp/', (m) => ({
    name: 'settingsMcpEdit', id: m.id,
    projectDir: m.params.get('projectDir') || '',
    scope: m.params.get('scope') === 'app' ? 'app' : (m.params.get('scope') === 'project' ? 'project' : ''),
    from: fromParam(m.params)
  })),

  // ---- Tags ----------------------------------------------------------
  exactOrQuery('settings/tags', (m) => ({
    name: 'settingsTags',
    projectId: m.params.get('projectId') || '',
    projectDir: m.params.get('projectDir') || ''
  })),

  // ---- Chat + project picker -----------------------------------------
  // `#/chat/<id>?projectDir=…` is the transcript view; `#/projects/new`
  // opens the folder picker at `?dir=…`.
  prefix('chat/', (m) => ({
    name: 'chat', chatId: m.id,
    projectDir: m.params.get('projectDir') || ''
  })),
  prefix('projects/new', (m) => ({ name: 'picker', dir: m.params.get('dir') || '' }))
];

// parseHash(raw) — the route for a `window.location.hash` value (`'#/a/b'`,
// `'#a/b'`, `'a/b'`). Pure: it never touches `window`.
export function parseHash(raw) {
  const hash = String(raw == null ? '' : raw).replace(/^#\/?/, '');
  if (!hash) return { name: 'chats' };
  for (const entry of ROUTES) {
    const match = entry.match(hash);
    if (!match) continue;
    const route = entry.build(match);
    if (route) return route;
  }
  // Unknown hash, or a prefix hit that declined (an empty provider id):
  // the chat list is the app's default view.
  return { name: 'chats' };
}

// Exported for the route test's "one entry per route" invariant.
export const ROUTE_PATHS = ROUTES.length;
