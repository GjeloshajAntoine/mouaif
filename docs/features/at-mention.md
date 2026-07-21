# @-mention autocomplete in the chat composer

## Overview

The chat composer supports `@` autocomplete: typing `@` followed by text shows a popup listing **files**, **tools/actions**, and the **current agent/model**. The user can select an item with the keyboard (Arrow keys + Enter/Tab) or a tap, and the selection is inserted as `@<item>` into the composer text.

## Usage

- Type `@` anywhere in the chat composer. A popup appears above the composer showing:
  - **Files** — tagged project files first (with their tags listed in the search text), then scanned project text files (up to ~200). Selecting a file inserts `@<relPath>`.
  - **Actions** — the project's available tools (shell, read_file, list_files, write_file, etc.).
  - **Agent** — the currently selected model ID.
- Narrow the list by typing more characters (case-insensitive search against label, path, and tags).
- Navigate with **Arrow Down/Up**, select with **Enter** or **Tab**, dismiss with **Escape** or click outside.
- The inserted `@<item>` stays visible in the composer text so the user can edit or remove it.
- The popup refreshes periodically (every 5 s) to pick up newly scanned files or changed tags.

## Popup sections

| Section   | Source                                                  |
|-----------|---------------------------------------------------------|
| Files     | Tagged files from `.mouaif.json` (via `GET /api/projects/:id/tags`), then scanned files from `POST /api/projects/:id/tags/scan` |
| Actions   | Tool catalog from the project settings (`state.tools.catalog`) |
| Agent     | Current chat model (`state.chat.modelId`)              |

## Implementation notes

- Source: `src/web/src/components/chat/atMention.js` — standalone imperative module. Mounted and unmounted via `mountAtMention(textarea, popupEl, preactState)` which returns a cleanup function.
- The popup `<div>` lives inside `.chat-view__composer` as its first child (before the buttons and textarea), positioned above the textarea with `position: absolute; bottom: 100%`.
- State is module-level (one instance). The `uiState` reference points to the Preact mutable state bag so `buildItems` can read project dir, tools catalog, and chat model without passing them on every keystroke.
- Files are fetched on mount and every 5 s via a `setInterval` in the `ChatView` mount effect. The scan endpoint is called once per project-dir change (cached in `scanCache`).
- The `@` detection walks backwards from the cursor to find `@` preceded by whitespace or start-of-string. The query ends at the cursor and cannot contain whitespace.
- Mobile-first: the popup is full-width inside the composer, capped at 240 px height with scroll, uses system font stacks and touch-friendly tap targets (≥ 36 px).

## Related

- [docs/features/file-tagging.md](./file-tagging.md) — the tag system that feeds the Files section.
- [docs/features/chat-ui.md](./chat-ui.md) — composer and message rendering.
- [docs/features/custom-prompts.md](./custom-prompts.md) — @ references are passed as `referencedPaths` to the server, promoting the injected file to `role: 'user'`.