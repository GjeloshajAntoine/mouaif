# Model bookmarks (pinned & recently used)

## Overview

The model picker saves you time by showing **pinned** and **recently used** models at the top of the list, so the models you actually work with are reachable in one tap without scrolling or searching. Both lists are **app-wide**: the same pins and the same recents follow you across every project on this machine.

## Usage

1. Open the model picker (tap the model trigger in the chat head, the dictation page, or an authorization card).
2. **Pin a model**: tap the star icon (☆) next to a model's name. The star fills (★) and the model appears in the **Pinned** section at the top of the unfiltered picker.
3. **Unpin**: tap the filled star again. The model disappears from the Pinned section.
4. **Recently used**: Every model you select is automatically added to the **Recent** section (up to 5 shown, newest first). Models you have pinned are excluded from the recent list to avoid duplication.
5. Both sections only appear when the provider filter is set to **All** and the search box is empty — they hide when you browse a specific provider or type a query.
6. The last 20 selections are tracked; older entries are dropped when the list overflows.
7. The Recent list is refreshed before the sheet is shown, so stale entries are never briefly displayed.
8. **Bookmarks do not depend on the loaded catalog.** The chat picker opens with whatever the project model list already holds and refreshes the live provider catalogs in the background, so the first paint can have no models at all. Pinned and Recent rows render anyway — they are your own record, kept from the server-backed recent list and the pin list — so the model you just used is still one tap away while the catalogs load. A row whose catalog entry has not arrived yet shows its provider id in place of a label; when the catalog does carry it, the label is used. The sheet only reports **No models yet** when there is genuinely nothing to show, and says **No other models** over a list that holds only bookmarks.

## Where the lists live

Both lists are app-level state, because a model is an app-level resource: its provider connection (and credential) lives in app settings, and a model slug means the same thing in every project.

| List | Storage | Scope |
| --- | --- | --- |
| Pinned | `localStorage` key `mouaif_models_pinned` | app-wide |
| Recent | `model_recent` table in `~/.mouaif/store.sqlite` | app-wide, capped at 20 |

The Recent list is a dedicated table so the web UI can read and update it without touching the whole app settings object. The pinned list is a `localStorage` set of `providerId\0modelId` keys, so it needs no network round-trip and is there on the very first paint.

## Sharing across projects

Sharing is the point of the feature: pinning a model while chatting in one project offers it first when dictating in another, and a model you pick once is offered under **Recent** everywhere from then on.

Both lists used to be partitioned by project directory — pins by a per-project `localStorage` key (`mouaif_models_<dir>_pinned`) and recents by a `project_dir` column in `model_recent`. Every new project therefore started from an empty list, and the model you had just used was missing in the next one. The single list replaces that partitioning.

**Existing data is preserved.** Two one-shot migrations fold what older builds
wrote onto the shared lists:

- Server side, the `2026-10-07-share-model-bookmarks` migration rebuilds
  `model_recent` without the `project_dir` column, keeping the newest timestamp
  per `(provider, model)` and then applying the 20-entry cap.
- Browser side, `migrateProjectScopedBookmarks()` unions every legacy
  `mouaif_models_*_pinned` key into `mouaif_models_pinned` and removes the old
  keys. It runs once, on the first picker mount, and records that it ran so a
  later unpin is not revived from a stale key.

Merging rather than picking one project is deliberate: a pin is a deliberate,
rare action, and silently dropping one because it was set in a different project
would lose the user's intent.

## API

The endpoint is deliberately project-independent; `projectDir` is accepted and ignored so an older client keeps working.

```http
GET    /api/settings/models/recent            -> { recent: [{ provider, id, ts }] }
POST   /api/settings/models/recent            body: { provider, modelId }
DELETE /api/settings/models/recent
```

## Related

- [Model picker](./model-picker.md) — the model picker popover
- [App and project settings](./app-and-project-settings.md) — the app-level store these tables live in
