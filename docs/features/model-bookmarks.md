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
7. Each time the chat model picker is requested, it refreshes the server-backed recent list before showing the sheet, so stale entries are never briefly displayed.
8. **Bookmarks do not depend on the loaded catalog.** The chat picker opens with whatever the project model list already holds and refreshes the live provider catalogs in the background, so the first paint can have no models at all. Pinned and Recent rows render anyway — they are your own record, kept from the server-backed recent list and per-project pins — so the model you just used is still one tap away while the catalogs load. A row whose catalog entry has not arrived yet shows its provider id in place of a label; when the catalog does carry it, the label is used. The sheet only reports **No models yet** when there is genuinely nothing to show, and says **No other models** over a list that holds only bookmarks.

## Related

- [docs/features/model-picker.md](./model-picker.md) — the model picker popover
