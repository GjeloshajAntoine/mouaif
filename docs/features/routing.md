# Routing

## Overview

The web UI is a single page with a hash router: no history API, no server-side rewrite. `window.location.hash` decides which view renders, so a deep link, a bookmark and an installed PWA all land in the same place. The whole hash → route mapping is one ordered table in `frontend/src/routes.js`; `frontend/src/router.js` is only the browser wiring (the `hashchange` listener and `nav()`).

## Usage

Every view has a hash. Deep links are stable and old names keep working.

| Hash | View |
|------|------|
| `#/chats` (default, and any unknown hash) | Chat list, grouped by project |
| `#/chat/<chatId>?projectDir=…` | Chat transcript |
| `#/projects/new?dir=…` | Project folder picker |
| `#/inspector` | Inspector |
| `#/settings` | Settings root |
| `#/settings/access` | Access / authentication |
| `#/settings/providers`, `#/settings/providers/new`, `#/settings/providers/<id>` | AI providers |
| `#/settings/projects` | Registered projects |
| `#/settings/defaults` | App defaults |
| `#/settings/notifications` | Push notifications |
| `#/settings/pricing` | Pricing |
| `#/settings/about` | About |
| `#/settings/project?projectDir=…&chatId=…` | Project settings |
| `#/settings/project/technical` | Project settings → Technical details |
| `#/settings/project/output` | Project settings → File tool options |
| `#/settings/project/preview` | Project settings → Web preview |
| `#/settings/project/hide?file=…` | Project settings → Hide file content |
| `#/settings/agents?projectDir=…` | Agents list |
| `#/settings/agents/<name>?…` | Agent editor (`new` is a draft unless `?edit=1`) |
| `#/settings/actions?projectDir=…`, `#/settings/actions/<id>` | Custom actions |
| `#/settings/prompts?projectDir=…&scope=app\|project` | Custom prompts (both scopes) |
| `#/settings/mcp`, `#/settings/mcp/registry`, `#/settings/mcp/new?scope=…`, `#/settings/mcp/<id>` | MCP servers |
| `#/settings/tags?projectId=…` | File tagging |

### Query parameters

- `projectDir` — which project a project-scoped page is editing. It defaults to the active project; the hash value only overrides it for deep links and tests.
- `from=projects|settings/projects` — where the user entered project settings from, so **Back** returns there. Any other value is dropped.
- `chatId` — carries the chat context into project settings and the agent editor.
- `scope=app|project` — pre-selects the scope for an MCP add, and tells an edit which list it came from. Any other value is dropped.
- `file` — the file to open in **Hide file content**.
- `dir` — the folder to start the project picker in.

### Legacy names

| Old hash | Now |
|----------|-----|
| `#/projects` | `#/chats` |
| `#/auth` | `#/settings` |
| `#/settings/copilot` | `#/settings/providers/github-copilot` |
| `#/settings/project/agents/<name>?…` | `#/settings/agents/<name>?…` (with `returnTo=project`) |

## Implementation notes

- `frontend/src/routes.js` holds the table. Entries are `exact(path)`, `exactOrQuery(path)` or `prefix(head)`, each with a `build(match)` that returns a route object or `null` to fall through. Matching is **in order**, which is what keeps `settings/mcp/registry` and `settings/mcp/new` from being read as `settings/mcp/<id>`, and the legacy `settings/project/agents/<name>` from being read as project settings. Adding a route is one entry; adding a sub-page under an existing prefix means putting the exact entry above the prefix entry.
- `frontend/src/router.js` writes the shared `route` signal on load and on `hashchange`, and exports `nav(hash)` (used by every component that navigates). It contains no route knowledge.
- `parseHash()` is pure and never touches `window`, so `scripts/test-routes.js` covers the whole table (legacy aliases, query plumbing, order-sensitive routes, fall-throughs) without a DOM.
- Path segments are decoded with a non-throwing `decodeURIComponent`: a malformed escape (`%zz`, a truncated `%e0`) keeps the segment as written instead of throwing a `URIError` out of the `hashchange` handler, which used to leave the app on a dead hash. `src/util.js` has the same guard server-side (`safeDecode`).
- The previous inline router compared the whole hash remainder for `settings/providers/<id>`, so `#/settings/providers/openai?from=projects` looked up a provider literally named `openai?from=projects`. The table takes the segment before the query.
