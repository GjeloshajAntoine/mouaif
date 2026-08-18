# Files modal — edit any text file, preview images

## Overview

- **Text files** (`.js`, `.ts`, `.json`, `.md`, `.py`, `.yml`, `.sh`, …) open in the existing CodeMirror editor with syntax highlighting, save/revert, and Ctrl/Cmd+S.
- **Unknown extensions** with text content (e.g. `LICENSE`, `.gitattributes`, dotfiles) are detected by an 8 KiB NUL-byte sniff and open in the editor too.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`) open in a preview pane that renders the bytes inline (raster bitmaps as `<img>`, SVG inline at native resolution).
- **SVG** is both text and image; the preview is the default, and the preview header has an **Edit** button to switch the same file into the CodeMirror editor.
- **Other binaries** stay disabled in the file list, same as before.
- **Layout toggle** — the modal opens in split view by default (file list on the left, editor/preview on the right) and has a toolbar button to switch to **full-editor mode** (the file list is hidden so the editor/preview takes the whole pane). Tapping the same button restores the split view.

## Usage

Tap the **Files** item in the file toolbar dropdown (next to the composer). The modal opens with the project root listed on the left and an empty state on the right.

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
- **Preview** — header shows the relative path, **Edit** (only for SVG) + **Close**, the centered image, and a status row with the file size and MIME type.
- **Empty state** — "Pick a file from the list to start editing, or tap an image to preview it."

The two panes never appear together. Opening a text file clears the preview, opening an image clears the editor and destroys the CodeMirror view to free memory.

### Layout toggle — split vs full-editor
The modal opens in **split view** by default: the file list sits on the left (38% width on tablet/desktop, full-width and stacked above the editor on phones) and the editor/preview sits on the right. A single-rectangle icon in the header toolbar switches to **full-editor mode**, which hides the file list (and the breadcrumb + list-status rows that go with it) so the editor/preview takes the whole pane. The header is also reduced: the path input, Up / Go / Refresh buttons, and breadcrumb all disappear in full-editor mode, leaving only the toggle and **Close**.

The toggle icon always shows the **next** state, not the current one:

- In split view: a single wide rectangle (the action is "hide the file list").
- In full-editor mode: two equal vertical bars (the action is "restore the split view"). The icon gets the `is-active` accent so the current layout is obvious at a glance. The icon renders at 18px in this state so the two-bar shape stays legible at the 36px mobile touch target.

Tapping the toggle switches layouts without reloading or closing the currently open file, so flipping it mid-edit preserves the buffer, dirty flag, and save state.
