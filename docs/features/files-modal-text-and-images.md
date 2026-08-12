# Files modal — edit any text file, preview images

The **Files** button next to the chat composer opens a full-screen modal with a project file browser and a right-hand pane. This feature makes the right-hand pane accept both text files (CodeMirror editor) and image files (inline preview), so a single tap opens the file the user expects instead of a "binary file" rejection.

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

- **Editor** — header shows the relative path with a `•` when dirty, **Revert** + **Save** buttons, the CodeMirror host, and a status row.
- **Preview** — header shows the relative path, **Edit** (only for SVG) + **Close**, the centered image, and a status row with the file size and MIME type.
- **Empty state** — "Pick a file from the list to start editing, or tap an image to preview it."

The two panes never appear together. Opening a text file clears the preview, opening an image clears the editor and destroys the CodeMirror view to free memory.

### Layout toggle — split vs full-editor
The modal opens in **split view** by default: the file list sits on the left (38% width on tablet/desktop, full-width and stacked above the editor on phones) and the editor/preview sits on the right. A two-bar icon in the header toolbar toggles **full-editor mode**, which hides the file list so the editor/preview takes the whole pane. Tapping the same button (the icon swaps to a one-bar glyph with an `is-active` accent) restores the split view. The toggle is available even before any file is opened, so the user can pick a layout up front, and it does not reload or close the currently open file.

## Backend API

The existing `GET /api/files`, `GET /api/file`, and `PUT /api/file` endpoints stay unchanged. A new `GET /api/file-media` endpoint returns the bytes of a previewable image as a base64 data URL.

### `GET /api/file-media?projectDir=<abs>&path=<abs|rel>`

```json
{
  "projectDir": "/home/me/myproj",
  "path":       "/home/me/myproj/logo.png",
  "relPath":    "logo.png",
  "size":       4096,
  "ext":        ".png",
  "mime":       "image/png",
  "dataUrl":    "data:image/png;base64,iVBORw0KGgo..."
}
```

Errors share the existing typed codes (`EBINARY` → 415 when a known binary isn't text, `ENOENT` → 404, `EOUTSIDE_PROJECT` → 403, `ETOOLARGE` → 413 when the image exceeds the 1 MiB cap, plus the new `ENOTIMAGE` → 415 when the path is a text file).

The same `projectDir` + `path` query shape as `GET /api/file` means the UI reuses its existing resolveSafe path-safety code; nothing changes about the home/`MOUAIF_ALLOW_ANY_ROOT` guard that already protects the file editor.

### List response — `image` flag

`GET /api/files` now adds an `image: boolean` flag to each file entry. Image rows are still clickable and now use a distinct icon + `image` meta pill so the user can spot previewable files at a glance.

### Text allowlist expansion

`src/files.js → TEXT_EXTS` now covers more common text formats so the editor opens them without the small-file sniff even when the path has no extension hint: `.dart`, `.php`, `.graphql`, `.gql`, `.proto`, `.prisma`, `.gradle`, `.kts`, `.rst`, `.tex`, `.diff`, `.patch`, `.log`, `.lock`, `.properties`, `.nim`, `.zig`, `.v`, `.sv`, `.ex`, `.exs`, `.erl`, `.clj`, `.tf`, `.hcl`, `.nix`, `.dhall`, plus more language variants of `.c`/`.cpp`/`.h`.

For files that fall outside the allowlist, `readFile` and `writeFile` now run an 8 KiB NUL-byte sniff on the first read. If the first 8 KiB contains no `0x00` bytes and decodes as UTF-8, the file is treated as text. Known image extensions are never promoted to text, even if the sniff passes (a `.png` whose first 8 KiB happens to contain no NUL is still rejected).

## Implementation notes

- File: `frontend/src/components/FileEditor.jsx` (component — adds `openMedia` state, `apiReadMedia`, image-row click path, preview pane with `<img>` and inline SVG; `editorFull` state + header toggle button for full-editor mode; sheet gets the `fe__sheet--full` modifier class when the list is hidden)
- File: `frontend/src/file-editor.css` (CSS — `.fe__media-host`, `.fe__media-img`, `.fe__media-svg`, `.fe__row--image`; `.fe__iconbtn.is-active` for the toggle button, `.fe__sheet--full .fe__list-wrap { display: none }` for full-editor mode)
- File: `src/files.js` (server — adds `IMAGE_EXTS`, `EXT_TO_MIME`, `isProbablyText`, `isProbablyTextSync`, `readMedia`, `mimeForExt`; expands `TEXT_EXTS`; sniffs in `readFile`/`writeFile`/`listDir`)
- File: `src/server-handlers-projects.js` (server — dispatches `/api/file-media` to `handleFileEditor`; adds the `GET /api/file-media` route inside `handleFileEditor`)
- File: `src/http-server.js` (server — adds `/api/file-media` to the top-level file-editor dispatcher so it wins over `/api/projects/*`)
- File: `src/util.js` (server — adds `ENOTIMAGE → 415` to the typed-error → HTTP-status table)
- File: `scripts/test-file-editor.js` and `scripts/test-file-editor-http.js` (tests — assert the new `image` flag, the `LICENSE` text sniff, and `/api/file-media` happy + error paths)

The preview pane never opens if the request fails (the modal shows the error in the status row). The SVG render uses `dangerouslySetInnerHTML` after a `atob()` decode; this is acceptable because the SVG is read from a project file the user has explicitly opened in the modal, never from an untrusted network source. SVG `<script>` blocks would still execute, but the modal only reads from files inside the user's project home (same `resolveSafe` guard that protects the text editor), so the attack surface matches the existing "open file in editor" feature.

The new endpoint is intentionally separate from `/api/file` (rather than a `?media=1` query flag) so the JSON contract stays unambiguous and the text-path's `EBINARY` rejection stays unchanged for callers that haven't migrated. `GET /api/file` still rejects known image extensions with `EBINARY` so the model-facing `read_file` tool (which uses the same `/api/file` route) continues to refuse to slurp binary bytes into the chat.

The frontend keeps `openFile` and `openMedia` as mutually-exclusive state. Switching from editor → preview runs an extra `useEffect` that calls `viewRef.current.destroy()` so the CodeMirror view is reclaimed before the `<img>` is mounted; switching back runs `mountEditor(file)` from the existing `useLayoutEffect`, the same path the modal already takes on first open.
