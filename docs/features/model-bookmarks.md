# Model bookmarks (pinned & recently used)

## Overview

The model picker saves the user time by showing **pinned** and **recently used** models at the top of the list, so the most frequently accessed models are reachable in one tap without scrolling or searching. Pins persist across page reloads via `localStorage`; the recent list is capped at 20 entries per project.

## Usage

1. Open the model picker (tap the model trigger in the chat head).
2. **Pin a model**: tap the star icon (☆) next to a model's name. The star fills (★) and the model appears in the **Pinned** section at the top of the unfiltered picker.
3. **Unpin**: tap the filled star again. The model disappears from the Pinned section.
4. **Recently used**: Every model you select is automatically added to the **Recent** section (up to 5 shown, newest first). Models you have pinned are excluded from the recent list to avoid duplication.
5. Both sections only appear when the provider filter is set to **All** and the search box is empty — they hide when you browse a specific provider or type a query.
6. The last 20 selections are tracked per project; older entries are dropped when the list overflows.

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

## Related

- [docs/features/model-picker.md](./model-picker.md) — the model picker popover