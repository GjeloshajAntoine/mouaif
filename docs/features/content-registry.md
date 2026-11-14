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

## Implementation notes

- The registry is plain data with no imports, so `src/settings.js` can require it without a cycle.
- `clientVisible`, `resettable` and `approval` describe a top-level document key. `toolOutput.size` and `toolOutput.structure` both carry them for `toolOutput`.
- Unregistered project keys still pass through: `.mouaif.json` stays open-ended.
- `DEFAULTS` is deep-frozen. `getResolved()` already clones what it merges, so nothing may mutate the floor.
- Plan and later steps (one write path, storage adapters, change cards, search): [docs/agent/plans/settings-architecture.md](../agent/plans/settings-architecture.md).
