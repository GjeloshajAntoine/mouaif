# Files modal — edit any text file, preview images

## Overview

- **Text files** (`.js`, `.ts`, `.json`, `.md`, `.py`, `.yml`, `.sh`, …) open in the existing CodeMirror editor with syntax highlighting, save/revert, and Ctrl/Cmd+S.
- **Unknown extensions** with text content (e.g. `LICENSE`, `.gitattributes`, dotfiles) are detected by an 8 KiB NUL-byte sniff and open in the editor too.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`) open in a preview pane that renders the bytes through a single `<img>`; an SVG is a script-disabled image document there, exactly like a raster bitmap.
- **SVG** is both text and image; the preview is the default, and the preview header has an **Edit** button to switch the same file into the CodeMirror editor.
- **Other binaries** stay disabled in the file list, same as before.
- **Layout toggle** — the modal opens in split view by default (file list on the left, editor/preview on the right) and has a toolbar button to switch to **full-editor mode** (the file list is hidden so the editor/preview takes the whole pane). Tapping the same button restores the split view.

## Usage
Tap the **Files** item in the file toolbar dropdown (next to the composer). The modal opens with the project root listed on the left and an empty state on the right.

The browser is **not capped at the project root**: you can navigate up (via the **Up** button, the breadcrumb, or by typing an absolute path in the path input) to browse and edit files anywhere under the user's home directory. With `MOUAIF_ALLOW_ANY_ROOT=1` set on the server, the whole filesystem is reachable. The Up button and breadcrumb stop at the natural boundary (home, or `/` when allow-any-root is on) rather than at the project root, so the list never asks the server for a directory the home guard would reject.

| Tap on a list row | Result |
|-------------------|--------|
| Folder (`…`) | Recurse into that folder |
| Text file (`.js`, `.json`, …) | Editor opens with the file content |
| Text file with no extension (`LICENSE`) | Editor opens (sniffed as text) |
| Image (`.png`, `.jpg`, …) | Preview opens in the right pane |
| SVG (`.svg`) | Preview opens by default; **Edit** in the header swaps to the editor |
| Other binary | Row is greyed out and not tappable |

### Right-hand pane modes

- **Editor** — header shows the relative path with a `•` when dirty, **Revert** + **Save** buttons, the CodeMirror host, and a status row. Syntax highlighting uses the One Dark palette (readable on the dark editor surface), not the light `defaultHighlightStyle`.
- **Preview** — header shows the relative path, **Edit** (only for SVG) + **Close**, the centered image, and a status row with the file size and MIME type. Every previewable image, SVG included, is painted by one `<img>` whose `src` is the `data:` URL the server returned. An SVG loaded that way is a separate document with scripting disabled: `<script>`, `on*` handlers, `<foreignObject>` HTML content and external fetches do not run. See **Why the SVG preview is an image, not markup** below.
- **Empty state** — "Pick a file from the list to start editing, or tap an image to preview it."

The two panes never appear together. Opening a text file clears the preview, opening an image clears the editor and destroys the CodeMirror view to free memory.

### Layout toggle — split vs full-editor
The modal opens in **split view** by default. On tablet/desktop the file list sits on the left (38% width) and the editor/preview on the right. On phones the list is stacked above the editor. While no file is open, the list and the empty state share the body. Once a file or image is open, the list shrinks to fit its rows, up to 40% of the body, and scrolls past that. The editor gets the rest of the space.

A **layout toggle** in the header switches to **full-editor mode**, which hides the file list (and the breadcrumb + list-status rows that go with it) so the editor/preview takes the whole pane. The header is also reduced: the path input, Up / Go / Refresh buttons, and breadcrumb all disappear in full-editor mode, leaving only the toggle and **Close**.

The toggle is a single on/off switch for the file list. It is the same button in both headers:

- Its icon is a panel outline that matches the current layout: a top pane on phones, a left pane on wider screens. The list pane is **filled** while the list is shown and empty while it is hidden.
- It carries the `is-active` accent and `aria-pressed="true"` while the list is shown (split view), and neither while it is hidden (full editor). Its accessible name stays "Show file list" in both states. The tooltip names the action a tap takes.

Tapping the toggle switches layouts without reloading or closing the currently open file, so flipping it mid-edit preserves the buffer, dirty flag, and save state.
