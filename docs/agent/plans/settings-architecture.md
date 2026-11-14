# Settings and content architecture, and code structure

Plan for one registry of everything the user configures (single settings and lists such as agents, prompts, hooks, themes and MCP servers), one write path, backend search, a chat card that shows what any change did, and a domain-based folder layout. Date: 2026-11-14.

**Status: steps 1–7 of the order of work are implemented; 8–12 are not.**

## Decisions taken (2026-11-14)

| Question | Decision |
| --- | --- |
| Where the schema and search live | On the backend. The browser asks for both; nothing about settings is bundled into the frontend. |
| A hand-edited file holds an invalid value | Validate on write only. On read, keep the stored value and return a warning that the page shows on that row. |
| MCP, hooks and themes | Brought into the same registry, write path and storage adapters as plain settings, and the design is generalised to any configured content. |

## How it was checked

- Read `src/settings.js`, `src/server-shared.js`, `src/server-handlers-settings.js`, `src/tools/mouaif.js`, `src/share-gate.js`, the `mouaif-config` skill, `frontend/src/api.js`, `frontend/src/routes.js`, `SettingsHome.jsx`, `SettingsDefaults.jsx` and `chat/tools.js`.
- For the content modules, read the header comment and the storage calls of `hooks.js`, `projectHooks.js`, `themes.js`, `extensions.js`, `prompts.js`, `agents.js`, `tags.js`, `custom-actions.js`, `mcp.js`, `tools/authorization.js` and `artifactStores.js`. Their validation and runtime logic was not read in full.
- File and line counts come from `git ls-files` and `wc -l`.
- Timings were measured against the current `src/settings.js` in a temporary store, 2,000 reads and 200 writes per row, on the dev host. The cached-read rows simulate the read path (a file stat plus a copy of an in-memory object); they are not a built design.

## Problems today

| # | Problem | Evidence |
| --- | --- | --- |
| 1 | One setting is declared in up to six places. | `DEFAULTS` (`src/settings.js:106`), `CLIENT_SETTINGS_KEYS` (`src/server-shared.js:162`), `RESETTABLE_APP_KEYS` (same file), `PERMISSION_KEYS` (`src/tools/mouaif.js:59`), the table in `src/skills/mouaif-config/SKILL.md`, and the page component. The allowlist comments describe two bugs from forgetting one place. |
| 2 | Two write paths apply different rules. | `PUT /api/settings/app` and `/project` and the tool's `runSettings` (`src/tools/mouaif.js:751`) each repeat the hooks refusal and `sanitizeClientEntries`. Only the tool checks the app allowlist, refuses `apiKey`, and drops a key when `baseUrl` changes. |
| 3 | The storage mode is checked inside every accessor. | `getProject`, `setProject` and `unsetProjectKeys` each branch on `isDbBacked`; `dbBacked` appears in 30 lines outside `settings.js`. |
| 4 | Every list re-implements the same read–modify–write. | `prompts.js`, `agents.js`, `tags.js`, `themes.js`, `hooks.js`, `projectHooks.js`, `custom-actions.js` and `mcp.js` each have their own list, get, update and remove over "read the whole array, change it, write the whole array". |
| 5 | MCP ignores the project's storage mode. | `src/mcp.js` and `src/tools/authorization.js` each read and write `<project>/.mcp.json` directly, with a plain `writeFileSync`. A project set to "Store settings in app DB" still gets `.mcp.json` written into its tree, and the write is not atomic. Neither file checks `isDbBacked`. |
| 6 | Remote rules are a third copy of the conditions. | `src/share-gate.js` blocks app settings once by route and again by tool name and `scope` argument. |
| 7 | Nothing is cached. | Every read re-queries the DB or re-reads the file and re-parses JSON. Tool authorization and hooks do this on every tool call; `projectHooks.js` built its own cache keyed on file mtime. |
| 8 | The chat card shows key names only. | `update_settings` renders as `project: promptSize, tools` (`frontend/src/components/chat/tools.js:250`). `hook_create` has its own hand-written card (`chat/cards.js:747`). |
| 9 | Settings pages hold one state variable per setting. | `SettingsDefaults.jsx`: 7 values and 7 status messages. `SettingsProject.jsx`: 45 `useState` calls in 1,642 lines. |
| 10 | Nothing can be searched. | `SettingsHome.jsx` is a hand-written list of links. |
| 11 | The source layout is flat. | `src/` has 107 files at one level (`server-handlers-*` ×20, `oauth-*`, `share-*`). `frontend/src/components/` has 20 `Settings*.jsx` files beside a `settings/` folder; about 35 CSS files sit in `frontend/src/`. `scripts/` holds 372 test files among 406. |

One part already has the target shape: `src/artifactStores.js` has a file store and a DB store behind one interface, chosen by a single `storeFor(projectDir)`. The plan extends that pattern.

## Goals

- Each kind of configured content is declared once. Defaults, allowlists, validation, the skill's table, search and display are generated from the declaration.
- The UI, the model's tools and a remote caller change content through one function, with their differences in one policy table.
- Storage modes stay (app DB, project file, project DB) and are chosen in one place, for every kind of content.
- Any change returns a change list that the chat renders the way the settings page renders the same content.
- Anything configured can be found by typing part of its name.

Not goals: changing stored formats or the existing REST routes, or making `.mouaif.json` less hand-editable.

## The model: two shapes cover everything

| Shape | What it is | Examples |
| --- | --- | --- |
| **value** | One setting at a key. | `promptSize`, `autoRetry`, `toolOutput.size`, `shellReview.mode`, `themes.active` |
| **collection** | Items with an id and fields. | agents, prompts, hooks, themes, MCP servers, providers, models, custom actions, tags, hide-file rules, tool wording sets, extensions |

A collection item's fields are themselves typed values, so one field description serves both shapes.

Where the content lives today:

| Content | Shape | Scopes | Stored in |
| --- | --- | --- | --- |
| Chat defaults, notifications, tool output, shell review | value | app, project | settings document |
| Tool permissions (`tools`) | value (object) | app, project | settings document; MCP per-server rules in `.mcp.json` `authorization` |
| Providers | collection | app | settings document `providers`; secrets in the credential store |
| Models | collection | app, project | settings document `models` |
| Prompts | collection | app, project | settings document `prompts` |
| Agents | collection | project | settings document `agents` |
| Custom actions | collection | project | settings document `customActions` |
| Tags, hide-file rules | collection keyed by path | project | settings document `tags`, `hideFileContent` |
| Tool wording sets | collection | app, project | settings document `toolWording.sets` |
| Themes | collection + active value | app | settings document `themes` |
| Hooks | collection | app, project | settings document `hooks`; project trust hash in its own table |
| MCP servers | collection | app, project | app: settings document `mcp`; project: `.mcp.json`, legacy `.mouaif.json` |
| Extensions | collection | app, project | table `extension`; project on/off map in the settings document |

Out of scope, because it is runtime data and not configuration: chats and messages, the MCP tool cache, recent models, hook runs, usage, webhooks and scheduled wake-ups, share peers, and credentials (which stay in the credential store and are only referenced).

## Design

### 1. Registry

`src/content/registry.js` holds one declaration per content type. It is plain data plus small pure functions.

```js
// a value
{ id: 'toolOutput.size', shape: 'value', scopes: ['app', 'project'],
  doc: 'settings', path: 'toolOutput.size',
  field: { type: 'enum', options: ['very-small', 'average', 'full', 'extensive'], default: 'average' },
  label: 'Tool output size', description: 'Byte cap on text sent back to the model.',
  keywords: ['context', 'bytes'], group: 'Tools', page: 'settings/project/output',
  clientVisible: true, resettable: true,
  writers: { ui: true, tool: 'update_settings', share: true }, approval: false }

// a collection
{ id: 'agents', shape: 'collection', scopes: ['project'],
  doc: 'settings', path: 'agents', container: 'array', itemId: 'name', itemLabel: 'name',
  fields: {
    content:  { type: 'text', label: 'Instructions', large: true },
    tools:    { type: 'list', label: 'Allowed tools' },
    modelId:  { type: 'string', label: 'Model' } },
  label: 'Agents', page: 'settings/agents', itemPage: 'settings/agents/:id',
  searchFields: ['name', 'content'],
  writers: { ui: true, tool: 'update_settings', share: true }, approval: false,
  normalize: require('../agents.js').normalizeAgent }
```

Field flags used everywhere below:

| Flag | Effect |
| --- | --- |
| `secret` | Never leaves the server. Shown as `set` or `not set`. |
| `large` | Shown as a size and an expandable text diff, not inline (prompt text, theme CSS and script, hook script). |
| `default` | The built-in value; `DEFAULTS` is generated from these. |

Rules:

- **Generated lists.** `DEFAULTS`, `CLIENT_SETTINGS_KEYS`, `RESETTABLE_APP_KEYS` and `PERMISSION_KEYS` become functions of the registry and stay exported under their current names.
- **`container`** says how items sit in the document: `array` (agents), `map` (tags by path, wording sets by id). The generic collection code handles both.
- **`normalize` and `validate`** stay in the feature module. The registry points at them; it does not absorb domain rules such as theme size caps or hook entry shapes.
- **Unknown project keys pass through.** `.mouaif.json` stays open-ended: an unregistered key is stored and returned as today, without label, validation or search.
- **Skill table.** The "What you can change" table in the `mouaif-config` skill is generated from the registry, with a test that fails when the file is stale.

### 2. Storage: documents and adapters

A **document** is one JSON object per scope. Content declares which document it lives in (`doc`) and where (`path`).

| Document | App scope | Project, file mode | Project, DB mode |
| --- | --- | --- | --- |
| `settings` | `app_kv` row `settings` | `.mouaif.json` or `.mouaif/.mouaif.json` | `project_settings` row |
| `mcp` | inside `settings` at `mcp` (unchanged) | `.mcp.json` | **new:** a `project_documents` row (`doc = 'mcp'`) |

Each adapter in `src/content/stores/` has the same members:

```js
{ kind: 'project-file', location: '/abs/.mouaif.json', read(), write(next), version() }
```

- `storeFor(doc, scope, projectDir)` is the only function that knows the mode.
- Atomic file writes, the corrupt-blob quarantine and the test-process guard move into the adapters unchanged. `.mcp.json` gets the atomic write it lacks today.
- Switching a project's mode copies every document: `to.write(from.read())`, then clear the source.
- **Cache.** An adapter keeps its last parsed object and returns a copy while `version()` is unchanged (file: mtime and size; DB: SQLite `data_version` plus a local counter). Hand edits are picked up by the mtime check. This replaces the private cache in `projectHooks.js`.

**MCP in DB mode.** Today a DB-mode project still gets `.mcp.json` written. Planned behaviour: reads prefer an existing `.mcp.json` (it may be the user's own or shared with other tools) and fall back to the DB row; writes go to the file when it exists and to the DB row when it does not. No file is created in a DB-mode project. The legacy `.mouaif.json → mcp.servers` read stays as a third fallback.

**Table-backed collections.** Extensions live in a table, not a document. They implement the same item interface (below) directly on the table and declare `modes: ['db']`. Nothing else about them changes.

### 3. Collections: one implementation

`src/content/collection.js` gives every collection the same four operations over its document and path:

```js
list(type, scope, projectDir)        get(type, scope, projectDir, id)
put(type, scope, projectDir, item)   remove(type, scope, projectDir, id)
```

- Reads across scopes follow the type's merge rule: `override` (project item replaces the app item with the same id: prompts, models) or `concat` (hooks, MCP servers, each tagged with its scope).
- The hand-written copies in `prompts.js`, `agents.js`, `tags.js`, `themes.js`, `hooks.js`, `custom-actions.js` and `mcp.js` are replaced by calls to these. The modules keep their normalising, limits and runtime behaviour.

### 4. One write pipeline

`src/content/service.js`:

```js
apply({ type, scope, projectDir, op, id, value, actor, tool, dryRun })
  -> { changes: [...], warnings: [...] }
```

`op` is `set` or `unset` for a value, and `put`, `patch` or `remove` for a collection item. `actor` is `ui`, `tool` or `share`. A settings patch with several keys becomes several operations applied as one write per document.

Steps:

1. Look up the type; refuse an unknown type for `tool` and `share`.
2. Check policy (table below). A refusal names the content and where to change it.
3. Normalise and validate with the type's functions.
4. Carry secrets over: an item sent back without its secret keeps the stored one, and loses it when the field the secret is bound to changed (a provider's `baseUrl`, an MCP server's URL).
5. Compute the change list. Stop here when `dryRun` is set.
6. Write through the adapter, run the type's `afterWrite` (hooks: recompute the trust hash; MCP: restart the changed server; themes: nothing), publish `content_changed`.

Policy, in `src/content/policy.js`:

| Content | `ui` | `tool` | `share` |
| --- | --- | --- | --- |
| App scope, `clientVisible` | write | write | refuse |
| App scope, not `clientVisible` | refuse | refuse | refuse |
| Project scope | write | write | write, unless the type sets `share: false` |
| `secret` field | write | refuse | refuse |
| `approval: true` (`tools`, `mcp`, `authAccounts`, hooks) | write | write after the user approves | write after the user approves |
| Type names a specific tool (`writers.tool: 'hook_create'`) | write | only through that tool | as `tool` |

- The existing special cases become rows: "hooks only through `hook_create`", "`apiKey` not writable by the tool", "app settings not available through a shared project".
- `share-gate.js` keeps deciding which routes a remote caller reaches and passes `actor: 'share'`.
- **Behaviour change:** `PUT /api/settings/app` would refuse app keys that are not `clientVisible`, as the tool already does. Audit the keys the frontend sends before this step.

The HTTP handlers and tools (`update_settings`, `hook_create`, the MCP, themes, prompts and agents routes) shrink to: parse, call `apply`, shape the response.

### 5. Change list

Every `apply` returns the same structure, whatever the content:

```js
// value
{ type: 'toolOutput.size', scope: 'project', op: 'set', label: 'Tool output size',
  before: 'average', after: 'full', page: 'settings/project/output' }

// collection item
{ type: 'agents', scope: 'project', op: 'changed', id: 'reviewer', label: 'Agent "reviewer"',
  page: 'settings/agents/reviewer',
  fields: [
    { key: 'modelId', label: 'Model', before: 'model-a', after: 'model-b' },
    { key: 'content', label: 'Instructions', large: true, beforeSize: 1204, afterSize: 1310 } ] }

{ type: 'mcpServers', scope: 'project', op: 'added', id: 'github', label: 'MCP server "github"',
  page: 'settings/mcp/github',
  fields: [ { key: 'url', label: 'URL', after: 'https://…' },
            { key: 'oauth.clientSecret', label: 'Client secret', secret: true, after: 'set' } ] }
```

- `op` for items is `added`, `changed` or `removed`. A whole-array write from `update_settings` is diffed by `itemId` into those three, so "replace the agents array" shows which agents were added, changed and removed.
- `large` fields carry sizes in the change list; the full before and after text is fetched on demand for the expandable diff, so a transcript does not store a theme's script twice.
- An unregistered project key appears with its key as the label and its raw JSON as the value.

### 6. Chat display

One `ChangeCard` renders a change list. It is used for:

- the result of `update_settings`, `hook_create` and any future content tool;
- the approval card, from a `dryRun` call, so the user sees old → new before approving (today `permissionKeysTouched` only names the keys, `src/ai-stream.js:460`);
- the "saved" line on a settings page, since the PUT routes return the same list.

The card and the settings pages share the row components:

| Component | Renders | Modes |
| --- | --- | --- |
| `FieldRow` | one typed field: label, control or value, warning | editable (pages), read-only old → new (chat) |
| `ItemRow` | one collection item: label, changed fields, link to `itemPage` | list row (pages), change row (chat) |

Tool results keep their current fields (`updated`, `removed`, `hook`) and add `changes`, so old transcripts still render.

### 7. Search, on the backend

```
GET /api/content/schema?projectDir=        -> types, fields, labels, pages the caller may see
GET /api/content/search?q=&projectDir=     -> [{ type, id?, label, snippet, scope, page }]
```

- **What is searched.** Type labels, descriptions, keywords and keys, and for collections the `searchFields` of every item: an agent's name and instructions, a prompt's title, an MCP server's name, a hook's name and command, a theme's name, a tag.
- **How.** A linear scan over the cached documents. The measured documents are 2–5 KB, so no index is needed; revisit if a search exceeds a few milliseconds.
- **Never searched or returned:** `secret` fields, and anything the caller's policy cannot read. A remote caller's request is forwarded to the sharing machine like any project route and returns project content only.
- **UI.** A search field at the top of Settings home, debounced, calling the search route. A result opens `#/<page>?focus=<key or id>`; the matching `FieldRow` or `ItemRow` scrolls into view and highlights.
- **Warnings.** The schema route's companion read (`GET /api/settings/project`, `/resolved`) gains a `warnings` array: `{ type, id?, key, message }` for stored values that fail validation. The stored value is still used as it is today; `FieldRow` shows the warning.

### 8. Registry-driven pages

Pages made of simple rows render from the schema: for each value on this page, a `FieldRow`. Order: `SettingsDefaults`, `SettingsNotifications`, the simple sections of `SettingsProject`. List pages (agents, prompts, hooks, themes, MCP) keep their editors and adopt `ItemRow` for the list and the shared save path.

Frontend state moves to one module with signals for schema, app and project content, a `save()` that calls the route and applies the returned `changes`, and a listener on `content_changed` so a change the model makes in chat updates an open settings page.

## How a new kind of content is added

1. Add a declaration to the registry (shape, document and path, fields, page, writers).
2. Write `normalize` and `validate` if the generic field checks are not enough.
3. Add the page.

It then has storage in all three modes, the cache, remote rules, model access through `update_settings` (or a named tool), the chat change card, the approval diff, search and reset, with no further code.

## Storage modes and performance

All three modes stay, and now apply to MCP too. Measured on the current code, per call:

| Operation | File mode | DB mode |
| --- | --- | --- |
| Read project settings | 113 µs | 67 µs |
| Read resolved (defaults, app, project) | 338 µs | 250 µs |
| Write project settings | 1,334 µs | 137 µs |

Sizes were an 8 KB app blob and a 4 KB project blob; the real ones on this host are 2.3 KB and 5 KB. At 60 KB and 20 KB both modes read resolved settings in about 1.06 ms.

- File writes cost about ten times more because of the fsync and rename; one save is still about 1.3 ms.
- With the adapter cache a read is a version check plus a copy: 44 µs at the measured size, instead of 250–340 µs, and both modes end at about the same speed.
- A collection operation is one cached document read and, for writes, one document write: the same cost as today's hand-written versions, minus the repeated parse.
- The registry lookup, policy check and diff add a few key lookups and one comparison per write.

## Code structure

| Folder | Moves in |
| --- | --- |
| `src/server/` | `http-server.js`, `server-shared.js`, `server-web-static.js`, and `routes/` for the 20 `server-handlers-*.js` files |
| `src/content/` | registry, service, policy, collection, stores, db, migrations |
| `src/ai/` | `ai-stream.js`, `ai-endpoints.js`, `ai.js`, `providers/`, pricing and usage |
| `src/auth/` | `auth.js`, `access-auth.js`, `oauth-*.js`, credential storage |
| `src/chat/` | `chats.js`, `chatdb.js`, `messages.js`, `live-chat.js`, artifacts, images |
| `src/share/` | `share.js`, `share-store.js`, `share-mux.js`, `share-gate.js` |
| `src/mcp/` | `mcp.js`, `oauth-mcp.js`, MCP apps |
| `src/inspector/` | `inspector.js`, `inspectorProfiles.js`, `previewProxy.js` |
| `src/tools/` | unchanged |

- `src/settings.js` stays as a thin re-export so its 36 callers keep working; the SQLite handle, migrations, MCP tool cache and recent models move to their own modules.
- **Route table.** The if-chain in `http-server.js` becomes a table of `{ method, path, handler, share }`, merged with the rule table `share-gate.js` already has.
- **Frontend.** `frontend/src/features/{chat,settings,inspector,projects,files}/`, each with its components, helpers and CSS.
- **Tests.** `scripts/test/` for the 372 test files.
- Large files (`ai-stream.js`, `chat/transcript.js`) are not split here.

## Order of work

One commit per step; each leaves the app working.

| # | Step | Behaviour change | Check |
| --- | --- | --- | --- |
| 1 | Registry with the value types; generate `DEFAULTS` and the three key lists. | None | Test: generated values deep-equal the current constants. |
| 2 | Document adapters and `storeFor` for `settings`; `settings.js` delegates. | None | Existing settings and storage tests; mode switch round trip. |
| 3 | Adapter cache. | Reads faster | Test: a hand edit is seen on the next read; a write from a second process is seen; re-run timings. |
| 4 | `service.apply` and the policy table for values; settings routes and `update_settings` call it; `changes` returned. | `PUT /api/settings/app` refuses unregistered app keys; a provider or model entry re-sent from the UI with a changed `baseUrl` and no key loses its stored key (before, only `update_settings` dropped it) | One test per policy cell; `test:mouaif-tool`, `test:share`. |
| 5 | `collection.js`; register and convert agents, prompts, custom actions, tags, hide rules, wording sets, models. | None | Each module's existing tests. |
| 6 | Themes and hooks through the registry and `apply`; hooks trust as `afterWrite`; `hook_create` returns `changes`. | A shared project's caller can no longer write hooks: promoting a chat hook to app or project scope is refused with 403 (kept, see `docs/features/hooks.md`) | `test:themes`, `test:hooks`; project hook stays inert until trusted. |
| 7 | `mcp` document: adapters for `.mcp.json`, DB-mode row, atomic write; `mcp.js` and `tools/authorization.js` share it. | DB-mode projects no longer get a new `.mcp.json` | MCP tests; DB-mode project add-server leaves the tree clean; existing file still read. |
| 8 | `FieldRow`, `ItemRow`, `ChangeCard`; dry-run approval card. | New card content | UI test in the Docker app at 390 px. |
| 9 | Schema and search routes; search field; `focus` highlight; warnings. | New feature | UI test; a shared project returns project content only; no secret in any result. |
| 10 | Convert the simple pages to registry-driven rows. | None intended | Compare each page before and after. |
| 11 | Generate the skill table. | None | Stale-file test. |
| 12 | Folder moves, one domain per commit. | None | `node -c`, full test run, `npm run build:web`. |

Steps 1–4 are the foundation. Steps 5, 6 and 7 are independent of each other and can land in any order. Step 8 can start after step 4 and gains content as 5–7 land. Step 12 is last because it conflicts with every other step.

Docs to update with the code: `app-and-project-settings.md`, `project-settings-storage.md` (MCP in DB mode), `hooks.md`, `themes.md`, the MCP feature doc, a new `settings-search.md`, and an entry in `docs/decisions.md` for the registry as the single declaration.

## Risks

- **Step 4 can reject a write that works today.** Audit which app keys the frontend sends; if unsure, log refused keys for one release before refusing.
- **Step 7 changes where MCP servers are stored for DB-mode projects.** A project that relied on the written `.mcp.json` being read by another tool would lose that. The existing file is never deleted or moved.
- **Hooks run code.** Routing hook writes through a generic path must not create a way around the forced approval or the trust hash. The policy row and a test for "`update_settings` cannot write hooks" guard this.
- **Cache and outside writers.** Covered by `data_version` for the DB and mtime for files; step 3's test writes from a second process.
- **Large fields in transcripts.** Change lists carry sizes only; confirm no theme script or prompt body is copied into a tool result.

## Open questions

1. **Tags and hide-file rules in search.** They are keyed by file path, so a project with many tagged files adds many results. Planned: searchable, capped per type.
2. **Extensions.** Registered as a table-backed collection for search and the change card. Moving them to a document (so file-mode projects could commit them) is possible but not planned.
