# Model bookmarks (pinned & recently used) — implementation notes

> Agent-facing reference for [`docs/features/model-bookmarks.md`](../../features/model-bookmarks.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Storage

- **Pinned models**: stored in `localStorage` under key `mouaif_models_<projectDirHash>_pinned` as a JSON array of `"providerId::modelId"` strings.
- **Recent models**: stored server-side in the app SQLite DB (`~/.mouaif/store.sqlite`, `model_recent` table). Each row is `(project_dir, provider, model_id, ts)` with a composite primary key. Capped at 20 entries per project.

## Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/settings/models/recent?projectDir=<abs>` | Fetch recent models (newest first, capped at 20) |
| POST   | `/api/settings/models/recent` | Record a model as used (`{ projectDir, provider, modelId }`) |
| DELETE | `/api/settings/models/recent?projectDir=<abs>` | Clear all recent models for a project |

## Implementation notes

- The pin button is a 28×28 px `<button>` inside the picker row, with `aria-pressed` reflecting the pin state. The row itself is a `<div role="button">` (not a `<button>`) because HTML forbids nested buttons — the pin button is a child event target.
- `touchRecent(state, provider, id)` is called from `onPickerPick` and from the bound callback in `useChatState.js` so every model selection records its position in the recent list. It updates the local cache synchronously (optimistic UI) and fires a POST to the server fire-and-forget.
- The Pinned section is always shown first (above Recent and the per-provider sections) when it has entries.
- The Recent section shows up to 5 unpinned models, skipping any that are no longer in the live catalog (stale entries are silently dropped).
- Pinning and unpinning re-render the entire picker so newly pinned models appear in the Pinned section immediately.
- Recent models are fetched from the server on every `openModelPicker()` call and cached on `state.recentModels` for the lifetime of the picker.
