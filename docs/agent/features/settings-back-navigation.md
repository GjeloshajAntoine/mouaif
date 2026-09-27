# Settings back navigation — implementation notes

> Agent-facing reference for [`docs/features/settings-back-navigation.md`](../../features/settings-back-navigation.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The hash router is described in [Routing](routing.md); this page covers the link plumbing that sits on top of it.

### One builder, one Back chain

`frontend/src/components/settings/projectNavigation.js` is a small pure module (no DOM, no Preact) with four exports:

- `settingsLink(path, context, extra)` — a `#/…` href. `context` is `{ projectDir, chatId, from }`; `extra` holds per-page params (`scope`, `file`, `returnTo`, …). It delegates to `URLSearchParams`, so the `?` is always placed correctly, and `from` is emitted last to keep the query order stable.
- `navTarget(...)` — the same link without the `#/` prefix, for `nav()`.
- `backTarget(context)` / `backHref(context)` — the Back chain above, as `{ path, label }` and as an href.
- `scopedParams(context)` — the shared params alone, for the two legacy helpers below.

`backTarget` returns both the destination and the label, so a page sets `href` and `aria-label` from one source of truth:

```js
h('a', { href: backHref(context), class: 'view-back', 'aria-label': backTarget(context).label }, '←')
```

### What went wrong before

Two hand-rolled patterns were replaced across every settings page:

```js
// Before: '&from=' appended after a helper that returns '' with no project —
// an app-scoped page built '#/settings/mcp&from=…', which is not a route, so
// the router fell back to the chat list and Back landed on the Chats tab.
'#/settings/mcp' + projectQS(projectDir) + (from ? '&from=' + encodeURIComponent(from) : '')

// After
settingsLink('settings/mcp', ctx, { scope: listScope })
```

```js
// Before: a sub-page rebuilt the project link by hand, so `chatId` was
// dropped at the first hop and Back twice ended on the Settings root.
'#/settings/project?projectDir=' + encodeURIComponent(dir) + (from ? '&from=' + from : '')

// After
settingsLink('settings/project', navContext())
```

The routes had to carry the context too: `settings/project/output`, `.../preview`, `.../hide`, `settings/agents` (list and editor), `settings/actions` (list and editor), `settings/prompts`, `settings/mcp` (list, registry and editor) and `settings/tags` all gained `chatId` (and the actions routes gained `scope`), and `frontend/src/components/App.jsx` passes them to the views.

### Deliberate Back targets

Two pages go **up** rather than back to their immediate caller:

- **Technical details** returns to project settings, keeping `chatId`, instead of jumping straight to the chat. A sub-page whose only way out skipped the page you were just on made the layout feel like it lost a step.
- **The agent editor** returns to project settings when it was opened from the project page's Agents row (`returnTo=project`), because the Agents list was not visited. Opened from the Agents list, it returns to that list.

The chat stays *one more tap away* in both cases, because the project page's own Back arrow reads the `chatId` it was handed.

### MCP scope, and old links

An MCP editor is reachable from the app-wide list (`#/settings/mcp`, no `projectDir`) and from a project's list (`?projectDir=…`). The editor now answers which list it came from the same way its rows do: an edit keeps the list it was opened from, and an add follows the scope being created (`scope=app` returns to the app list even when a project is active). Custom actions work the same way via `scope`, which is also re-emitted by the list's own links.

Older links that predate `scope` still resolve: an empty scope is inferred from `projectDir`, and an empty `projectDir` is no longer emitted as `?projectDir=` by `agentQuery` (which also fixes the `#/settings/agents/new?&edit=1` href).

### Tests

`scripts/test-settings-back.mjs` renders the real pages with their imports stripped (the same VM harness as `scripts/test-project-settings-render.mjs`), asserts the Back href and label each one emits, and checks that every link the builder can produce parses to a real route rather than the chat-list fallback.

```bash
node scripts/test-settings-back.mjs
node scripts/test-routes.js
node scripts/test-project-settings-render.mjs
```
