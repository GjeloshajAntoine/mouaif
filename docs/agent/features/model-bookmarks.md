# Model bookmarks (pinned & recently used) — implementation notes

> Agent-facing reference for [`docs/features/model-bookmarks.md`](../../features/model-bookmarks.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Storage

- **Pinned models**: stored in `localStorage` under the single key `mouaif_models_pinned`, as a JSON array of `"providerId\0modelId"` strings. App-wide, not per project.
- **Recent models**: stored server-side in the app SQLite DB (`~/.mouaif/store.sqlite`, `model_recent` table). Each row is `(provider, model_id, ts)` with a composite primary key on `(provider, model_id)`. App-wide, capped at 20 entries.

Both lists are app-wide on purpose: a model is an app-level resource (its provider connection lives in app settings, and a slug means the same thing everywhere), so one bookmark list follows the user across every project. Older builds partitioned both by project directory; see the migration section below.

## Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/settings/models/recent` | Fetch the app-wide recent models (newest first, capped at 20) |
| POST   | `/api/settings/models/recent` | Record a model as used (`{ provider, modelId }`) |
| DELETE | `/api/settings/models/recent` | Clear the app-wide recent models list |

The endpoint takes no `projectDir`. It is accepted and ignored on the way in, so an older client keeps working rather than 400ing.

## Implementation notes

- The pin button is a 28×28 px `<button>` inside the picker row, with `aria-pressed` reflecting the pin state. The row itself is a `<div role="button">` (not a `<button>`) because HTML forbids nested buttons — the pin button is a child event target.
- `touchRecent(state, provider, id)` is called from `onPickerPick` and from the bound callback in `useChatState.js` so every model selection records its position in the recent list. It updates the local cache synchronously (optimistic UI) and fires a POST to the server fire-and-forget.
- The Pinned section is always shown first (above Recent and the per-provider sections) when it has entries.
- The Recent section shows up to 5 unpinned models. A row whose catalog entry has not arrived yet is rendered anyway from the stored `(provider, id)`, with the provider id in place of a label — the picker's first paint can precede the live catalogs, and dropping the row there left the user's just-used model missing. See `rowFromKey`/`pinnedRows`/`renderRecentSection` in `ModelPickerField.jsx`.
- A sheet that shows bookmarked rows does not render the empty-state card, and its title is `No other models` rather than `No models yet`.
- Pinning and unpinning re-render the entire picker so newly pinned models appear in the Pinned section immediately.
- Recent models are fetched from the server on every chat picker open request and cached on `state.recentModels`. `useChatState.js` keeps the declarative sheet closed until that fetch settles, then applies the fresh recent rows and `open: true` atomically. Request counters in `useChatState.js` and `modelPicker.js` prevent superseded, cancelled, or previous-project fetches from reopening the sheet or overwriting newer data.

The chat picker keeps its sheet closed while `GET /api/settings/models/recent` is in flight. Once the request settles, the refreshed recent rows and open state are applied together. Closing or superseding an open request invalidates the pending result.

The **dictation page** ([dictation.md](../../features/dictation.md)) shows the same Pinned and Recent sections: it calls `loadPinned`, `loadRecent`, `loadRecentFromServer` and `togglePin` from `frontend/src/components/chat/modelPicker.js` with a state object holding just the field those helpers read (`recentModels`). Both lists are app-wide, so a pin or a recent made on either surface is offered on the other, in every project. Rows that cannot transcribe are filtered out of the list the sections resolve against, so a chat model never shows up in the dictation picker. The chat head additionally records a pick with `touchRecent`; dictation does not, because a speech-only model should not fill the chat picker's recent list.

## Sharing across projects (migration)

- Server: the `2026-10-07-share-model-bookmarks` migration in `src/settings.js` rebuilds `model_recent` without `project_dir`, keeping the newest `ts` per `(provider, model_id)`, then re-applies the 20-entry cap. It rebuilds (drop + recreate) rather than dropping the column so the composite primary key becomes `(provider, model_id)` on every store. Idempotent: `PRAGMA table_info` decides, and a table already in the app-wide shape is left alone.
- Browser: `migrateProjectScopedBookmarks()` in `modelPicker.js` unions every legacy `mouaif_models_*_pinned` key into `mouaif_models_pinned`, removes the old keys, and sets `mouaif_models_pinned_migrated`. It is called on chat mount (`useChatState.js`) and on the dictation page's bookmark effect. The union is intentional — a pin is a rare, deliberate action, and dropping one because it was set in another project would lose user intent.
- `canonicalizeProjectKeys()` no longer touches `model_recent`; the table carries no directory key. `scripts/test-project-canonical-dirs.js` asserts both halves.
