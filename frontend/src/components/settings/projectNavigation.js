// mouaif web — project-scoped settings links.
//
// One link builder + one target resolver for the whole project drill-down
// (Settings → [This project] → Project settings → File tool options / Web
// preview / Hide file content / MCP servers / Custom prompts / Custom
// actions / Agents, plus the App-defaults siblings MCP servers and Custom
// prompts).
//
// Why it exists: every page used to compose `projectDir` + `from` by hand
// with `projectQS(dir) + '&from=…'`. Two things went wrong with that.
//
//   1. `&from=…` was appended after `projectQS()`, which returns '' when
//      there is no project — so the App-scoped pages (MCP servers, Custom
//      prompts, Custom actions opened from Settings → App defaults) built
//      `#/settings/mcp&from=…`. That is not a known route, so the router
//      fell back to the chat list and Back landed on the Chats tab.
//   2. The chat a project page was opened from (`&chatId=…`, added by the
//      chat header and by every project sub-page link) was dropped at the
//      first sub-page, so pressing Back twice ended on the Settings root
//      even though the user had come from a chat.
//
// `settingsLink` fixes the first by delegating to URLSearchParams (it
// always places the `?`), and `backTarget` fixes the second by putting the
// chat first in the Back chain. Pure and DOM-free, like the routes table it
// feeds: `scripts/test-settings-back.mjs` drives the real pages through
// `preact-render-to-string` and asserts on the hrefs.

// scopedParams(context, options) — the query params every project
// drill-down link shares: the project, the chat it came from, and which
// project list the project settings page itself was entered from. A
// missing/blank value is omitted entirely (URLSearchParams would otherwise
// emit `projectDir=`). `options.from === false` skips `from`, which
// `settingsLink` appends last instead.
export function scopedParams(context = {}, options = {}) {
  const params = new URLSearchParams();
  if (context.projectDir) params.set('projectDir', context.projectDir);
  if (context.chatId) params.set('chatId', context.chatId);
  if (context.from && options.from !== false) params.set('from', context.from);
  return params;
}

// settingsLink(path, context, extra) — a `#/…` href for a settings route.
//
//   settingsLink('settings/project')                 → '#/settings/project'
//   settingsLink('settings/mcp', { projectDir: '/p' }) → '#/settings/mcp?projectDir=%2Fp'
//
// Query order is projectDir, chatId, the per-page params (`extra`: `scope`,
// `file`, `returnTo`, …), then `from` last — the order the pages have always
// emitted, so the hrefs stay stable and readable.
export function settingsLink(path, context = {}, extra = {}) {
  const params = scopedParams(context, { from: false });
  for (const [key, value] of Object.entries(extra)) {
    // `null`/`undefined` means "not this page" (e.g. an app-scoped MCP
    // add); an empty string is a real value for `scope` and stays.
    if (value == null) continue;
    params.set(key, String(value));
  }
  if (context.from) params.set('from', context.from);
  const query = params.toString();
  // URLSearchParams serializes a space as '+'; the app's links document and
  // test with %20 (and a literal '+' in a value is already %2B here), so
  // normalize for readable, stable hrefs.
  return '#/' + path + (query ? '?' + query.replace(/\+/g, '%20') : '');
}

// navTarget(path, context, extra) — the same link without the `#/` prefix,
// for `nav()` (which adds it).
export function navTarget(path, context = {}, extra = {}) {
  return settingsLink(path, context, extra).slice(2);
}

// mcpListScope(serverScope) — the `scope` param the MCP list re-emits.
// Normalizes the server's own scope ('app' | 'project') to the two values
// the route understands; anything else (a missing server, an older API
// shape) answers 'project'.
export function mcpListScope(serverScope) {
  return serverScope === 'app' ? 'app' : 'project';
}

// backTarget(context) — where a page's Back arrow (and the redirect that
// follows a save/delete) points: `{ path, label }`.
//
// The chain, most specific first:
//   1. the chat the page was opened from (it carried `&chatId=…`);
//   2. the project settings page (`returnTo: 'project'`, or `projectDir`);
//   3. the named project list the project page was entered from;
//   4. the Settings root.
//
// `context.returnTo === 'project'` forces step 2: the agent editor is
// reached straight from the project page's Agents row, so its immediate
// caller is project settings even when the project has no dir yet.
export function backTarget(context = {}) {
  const { projectDir = '', chatId = '', from = '', returnTo = '' } = context;
  if (chatId && projectDir) {
    return {
      path: 'chat/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir),
      label: 'Back to chat'
    };
  }
  if (projectDir || returnTo === 'project') {
    return { path: navTarget('settings/project', { projectDir, chatId, from }), label: 'Back to project settings' };
  }
  if (from === 'projects') return { path: 'projects', label: 'Back to projects' };
  if (from === 'settings/projects') return { path: 'settings/projects', label: 'Back to project list' };
  return { path: 'settings', label: 'Back to settings' };
}

// backHref(context) — `backTarget().path` as a `#/…` href.
export function backHref(context = {}) {
  return '#/' + backTarget(context).path;
}
