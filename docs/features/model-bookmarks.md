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

## Related

- [docs/features/model-picker.md](./model-picker.md) — the model picker popover
