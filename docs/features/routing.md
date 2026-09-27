# Routing

## Overview

The web UI is a single page with a hash router: every URL is a `/#/…` hash, never a real path, so the server needs no rewrite. `window.location.hash` decides which view renders, so a deep link, a bookmark and an installed PWA all land in the same place. The whole hash → route mapping is one ordered table in `frontend/src/routes.js`; `frontend/src/router.js` is only the browser wiring (the `hashchange` listener, `nav()`, `back()` and `replace()`). In-app Back never adds a history entry, so the phone's Back gesture can't bounce you into the page you just left (see [Back and history](#back-and-history)).

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
| `#/settings/project/technical?projectDir=…&chatId=…&from=…` | Project settings → Technical details |
| `#/settings/project/output?projectDir=…&chatId=…&from=…` | Project settings → File tool options (Layout: Hierarchical / Full JSON) |
| `#/settings/project/preview?projectDir=…&chatId=…&from=…` | Project settings → Web preview |
| `#/settings/project/hide?projectDir=…&chatId=…&from=…&file=…` | Project settings → Hide file content |
| `#/settings/agents?projectDir=…` | Agents list |
| `#/settings/agents/<name>?…` | Agent editor (`new` is a draft unless `?edit=1`) |
| `#/settings/actions?projectDir=…&scope=project\|app`, `#/settings/actions/<id>?…` | Custom actions (list and editor) |
| `#/settings/prompts?projectDir=…&scope=app\|project` | Custom prompts (both scopes) |
| `#/settings/mcp`, `#/settings/mcp/registry`, `#/settings/mcp/new?scope=…`, `#/settings/mcp/<id>` | MCP servers |
| `#/settings/tags?projectId=…&projectDir=…&from=…` | File tagging |

### Query parameters

- `projectDir` — which project a project-scoped page is editing. It defaults to the active project; the hash value only overrides it for deep links and tests.
- `from=projects|settings/projects` — where the user entered project settings from, so **Back** returns there. Any other value is dropped.
- `chatId` — carries the chat context through the whole project drill-down (project settings, its sub-pages, and the project-scoped views), so **Back** can return to the chat it started in.
- `scope=app\|project` — which list a custom action was opened from, so its Back link returns to that list (inferred from `projectDir` on older links).
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

## Back and history

Every in-app Back control *returns* to the page it names instead of pushing it as a new page. That covers the chat header ←, the ← arrow at the top of every settings page, and the jump back to a list after a save or delete. The browser history therefore stays in step with what you did, and the system Back gesture (Android Back, iOS swipe, the browser button) continues from there:

| You did | In-app ← then system Back |
|---|---|
| Chats → a chat → ← | back on Chats; system Back leaves the app (it used to reopen the chat) |
| Chat → gear → File tool options → ← → ← | back in the chat on its original entry; system Back goes to Chats |
| Tapped a notification (or opened a deep link) straight into a chat → ← | Chats replaces the chat entry, so no loop |
| Settings → MCP servers → Add → Save | the new server's editor *replaces* the blank "new" form; its ← goes to the list |
| Deleted a chat | the list you came from; the deleted chat is not one Back away |

### Using it in code

```js
import { nav, back, replace } from '../router.js';

nav('settings/providers/new');   // go forward: pushes an entry
back('settings/providers');      // return: pops to it, or replaces if it isn't behind us
replace('settings/mcp/fx');      // swap the current entry (a "new" form that was saved)
```

Header arrows need no code: any `<a class="view-back" href="#/…">` tap is routed through `back()` by a document click listener. Modified clicks (open in a new tab) and links whose own `onClick` calls `preventDefault()` are left alone.
