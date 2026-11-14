# Content registry

## Overview

Everything the user configures — single settings such as `promptSize` and lists such as agents, prompts, hooks, themes and MCP servers — is declared once in `src/content/registry.js`. The lists that used to be written by hand in several files are generated from those declarations:

| Generated | Used by | Rule |
| --- | --- | --- |
| `settings.DEFAULTS` | `src/settings.js` (the floor of `getResolved`) | every declared `default`, placed at its path |
| `CLIENT_SETTINGS_KEYS` | `src/server-shared.js` (`settingsForClient`), `update_settings` | app keys whose declaration sets `clientVisible` |
| `RESETTABLE_APP_KEYS` | `POST /api/settings/app/reset` | app keys with a default, or that set `resettable` |
| `PERMISSION_KEYS` | `update_settings` approval (`src/ai-stream.js`) | keys whose declaration sets `approval`, except content written only by its own tool (hooks) |

Before the registry, a new setting had to be added to up to six places, and forgetting the client allowlist made a toggle look as if it would not save.

## Usage

Content comes in two shapes:

| Shape | What it is | Examples |
| --- | --- | --- |
| `value` | one setting at a path in a document | `promptSize`, `toolOutput.size`, `notifications.login` |
| `collection` | items with an id and fields | agents, prompts, models, tags, themes, hooks, MCP servers |

A value declaration:

```js
{ id: 'toolOutput.size', shape: 'value', scopes: ['app', 'project'],
  doc: 'settings', path: 'toolOutput.size',
  field: { type: 'enum', options: ['very-small', 'average', 'full', 'extensive'], default: 'average' },
  label: 'Tool output size', description: 'Byte cap on file and result text sent back to the model.',
  keywords: ['context', 'bytes'], group: 'Tools', page: 'settings/project/output',
  clientVisible: true, resettable: true, writers: { ui: true, tool: 'update_settings', share: true } }
```

A collection declaration adds `container` (`array` or `map`), `itemId`, `itemLabel`, `fields`, `merge` (`override`, `concat` or `replace` across app and project) and `searchFields`.

To add a setting:

1. Add a declaration to `TYPES` in `src/content/registry.js`, next to its group.
2. Give it a `default` if it has one, and set `clientVisible: true` if the browser reads it at app scope.
3. Add its control to the settings page.

`node scripts/test-content-registry.js` checks that the generated lists still match the snapshot of the former constants, that declarations sharing a top-level key agree on `clientVisible` and `approval`, and that enum defaults are valid.

## Storage

Each declaration names a document (`doc`) and a path in it. Where a document lives is decided by `storeFor(doc, scope, projectDir)` in `src/content/stores/index.js`, the only function that knows a project's storage mode:

| Document | App scope | Project, file mode | Project, DB mode |
| --- | --- | --- | --- |
| `settings` | `app_kv` row `settings` | `.mouaif.json` or `.mouaif/.mouaif.json` | `project_settings` row |
| `mcp` | `mcp` inside the app `settings` row | `.mcp.json` | `.mcp.json` when it exists, else a `project_documents` row |

The `mcp` document holds MCP servers and their `authorization` block; `src/mcp.js` and `src/tools/authorization.js` both read and write it through `storeFor('mcp', …)` (`stores/project-mcp.js`). An existing `.mcp.json` is read and written in both modes, since it may be the user's own file shared with other MCP clients; a DB-mode project without one never gets one created. When neither the file nor the row exists, the legacy `mcp` block of the project's settings document is read. `.mcp.json` is written atomically and cached like `.mouaif.json`, and a corrupt one answers `MOUAIF_PROJECT_PARSE_ERROR` (422).

Writes to that document go through the write path like any other content: the server lists as `mcpServers` (app, `mcp.servers` in the app settings) and `projectMcpServers` (project, `servers`), and the authorization block as `mcpAuthorization` (app, `mcp.authorization`) and `projectMcpAuthorization` (project, `authorization`). Each write replaces only its own key, so servers and rules never overwrite each other. A shared project's caller writes no server list and not the app gate (403 `ESHARE_ROUTE`), but may change the project's MCP rules, as the chat's Tools card always allowed. The server types' `afterWrite` (`src/mcp.js`) stops the running session of every server the write changed or removed, in every project for an app server, so the next start reads the new entry.

Every adapter has the same members: `{ kind, scope, location, read(), write(next) }`. Atomic file writes, the corrupt-blob quarantine and the test-process guard live in the adapters (`app-db.js`, `project-file.js`, `project-db.js`, `json-file.js`); the SQLite handle is in `src/content/db.js`. `setProjectMode()` moves a project's documents between file and DB: the settings document is copied, and for `mcp` only a DB row moves (to `.mcp.json`, when switching back to files and no such file exists yet).

### Read cache

A store keeps the last parsed document and hands out a copy while its version stamp is unchanged (`src/content/stores/cache.js`):

| Store | Stamp |
| --- | --- |
| file | inode, size and mtime (ns). A file modified in the last 2 s is re-read and compared with the cached text, because mtimes are coarser than a write. |
| DB row | SQLite `data_version` (moves when another connection commits) and `total_changes()` (moves on any write through this process's connection). |

So a hand edit of `.mouaif.json`, a write from another `mouaif` process and a direct SQL write are all seen on the next read. Measured on the dev host with a 60-key project document:

| Read | Before | Cached |
| --- | --- | --- |
| Project, file mode | 133 µs | 53 µs |
| Project, DB mode | 105 µs | 40 µs |
| Resolved, file mode | 219 µs | 106 µs |
| Resolved, DB mode | 181 µs | 85 µs |

The remaining cost is mostly the copy (about 20 µs) and the merge in `getResolved()`.

## Writing

`applyPatch({ scope, projectDir, patch, unset, actor, remote, dryRun })` in `src/content/service.js` is the one write path for the settings document. `PUT /api/settings/app`, `PUT /api/settings/project` and `update_settings` call it. It returns `{ changes, warnings, approval, document }`.

Who may write what is one table in `src/content/policy.js`:

| Content | `ui` | `tool` | `share` |
| --- | --- | --- | --- |
| App scope, `clientVisible` | write | write | refuse |
| App scope, not `clientVisible` (or unregistered) | refuse | refuse | refuse |
| Project scope, registered or not | write | write | write, unless the type sets `writers.share: false` |
| A `secret` field (`apiKey`) | write | refuse | refuse |
| `approval: true` (`tools`, `mcp`, `authAccounts`) | write | write after the user approves | as its actor |
| Written by its own tool (`hooks` → `hook_create`) | refuse here | refuse here | refuse here |

`share` is a shared project's remote caller using the same routes; a share caller's model is `tool` with `remote: true`. The approval itself is still asked by the chat loop before `update_settings` runs (`PERMISSION_KEYS`); a remote caller's direct UI writes are bounded by the share gate's tool rules, as before.

### Collections

`src/content/collection.js` gives every declared collection the same operations over its document and path, so the feature modules no longer each re-implement "read the array, change it, write it back":

```js
read(type, scope, projectDir)                 list(type, scope, projectDir)
get(type, scope, projectDir, id)              listMerged(type, projectDir)
put(type, scope, projectDir, item, opts)      putAt(type, scope, projectDir, id, item, opts)
remove(type, scope, projectDir, id, opts)     replace(type, scope, projectDir, items, opts)
```

- `put` inserts an array item or replaces the one with the same `itemId` in place; `putAt` sets a map entry (tags by path, wording sets by id).
- `listMerged` follows the type's merge rule: `override` (a project item replaces the app item with the same id: prompts, models), `concat` (both lists, tagged with their scope: hooks, MCP servers) or `replace` (the project list wins when it has items).
- Every write goes through `writeType()` in the service: the policy check, one document write, a change list and `content_changed`. `opts.unset` drops a legacy key in the same write (agents drop `agentPresets`). A write made while serving a shared project's caller is marked `remote` automatically.
- Content written by its own tool (hooks) needs `opts.via` set to that tool or to `route`.

Converted to it: `prompts.js`, `agents.js`, `custom-actions.js`, `tags.js`, `hideFileContent.js` (`setRules`), and the app provider and model routes. The modules keep their normalising, limits and runtime behaviour.

### Several types in one write, and write hooks

`writeMany({ scope, projectDir, entries: [{ type, value }] })` writes several types of one document at once: the theme list with the active theme, the app hook list with its on/off switch.

A type that must react to its own writes registers `service.onWrite(typeId, { beforeWrite, afterWrite })`. Project hooks use it for trust: `beforeWrite` records whether the current list is trusted, and `afterWrite` trusts the new list only if the old one was (or was empty). So no write path can trust a hook list the user has not reviewed.

### Change lists

Every write returns the same structure, whatever the content:

```js
// a value
{ type: 'toolOutput.size', scope: 'project', op: 'set', key: 'toolOutput.size',
  label: 'Tool output size', page: 'settings/project/output', before: 'average', after: 'full' }

// a collection item
{ type: 'agents', scope: 'project', op: 'changed', id: 'reviewer', label: 'Agent "reviewer"',
  page: 'settings/agents/reviewer',
  fields: [
    { key: 'modelId', label: 'Model', before: 'model-a', after: 'model-b' },
    { key: 'content', label: 'Instructions', large: true, beforeSize: 1204, afterSize: 1310 } ] }
```

- A whole-array write (the model replacing `agents`) is diffed by item id into `added`, `changed` and `removed`.
- `secret` fields show `set` or `not set`; `large` fields carry sizes only, so a transcript never stores a prompt body or theme script twice.
- An unregistered project key appears with its key as the label and its raw JSON value (`raw: true`).
- A `dryRun` stops before the write and returns the same list.

## Implementation notes

- The registry is plain data with no imports, so `src/settings.js` can require it without a cycle.
- `clientVisible`, `resettable` and `approval` describe a top-level document key. `toolOutput.size` and `toolOutput.structure` both carry them for `toolOutput`.
- Unregistered project keys still pass through: `.mouaif.json` stays open-ended.
- `DEFAULTS` is deep-frozen. `getResolved()` already clones what it merges, so nothing may mutate the floor.
- Plan and later steps (one write path, storage adapters, change cards, search): [docs/agent/plans/settings-architecture.md](../agent/plans/settings-architecture.md).
