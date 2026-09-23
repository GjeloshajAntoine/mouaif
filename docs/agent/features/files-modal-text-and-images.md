# Files modal — edit any text file, preview images — implementation notes

> Agent-facing reference for [`docs/features/files-modal-text-and-images.md`](../../features/files-modal-text-and-images.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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

- File: `frontend/src/components/FileEditor.jsx` (component — adds `openMedia` state, `apiReadMedia`, image-row click path, preview pane with a single `<img>` for every previewable image; `editorFull` state + a header `fe__path-row` that renders a minimal toolbar (toggle + Close) in full-editor mode and the full nav toolbar (Up / path / Go / Refresh / toggle / Close) in split mode; breadcrumb + list-status rows are gated on `!editorFull`; sheet gets the `fe__sheet--full` modifier class when the list is hidden)
- File: `frontend/src/file-editor.css` (CSS — `.fe__media-host`, `.fe__media-img`, `.fe__row--image`; `.fe__iconbtn.is-active` for the toggle button, `.fe__sheet--full .fe__list-wrap { display: none }` for the hidden list, `.fe__sheet--full .fe__path-row { justify-content: flex-end }` so the minimal header's two buttons sit on the right of the sheet on narrow phones. The `.fe__overlay` / `.fe__sheet` shell itself comes from the shared modal sheet idiom in `frontend/src/sheets.css`; this file only overrides the desktop card size and keeps `width: 100%; min-width: 0` on the sheet. `.fe__media-svg` remains only as a `display: none` guard against reintroducing a markup container)
- File: `src/files.js` (server — adds `IMAGE_EXTS`, `EXT_TO_MIME`, `isProbablyText`, `isProbablyTextSync`, `readMedia`, `mimeForExt`; expands `TEXT_EXTS`; sniffs in `readFile`/`writeFile`/`listDir`)
- File: `src/server-handlers-projects.js` (server — dispatches `/api/file-media` to `handleFileEditor`; adds the `GET /api/file-media` route inside `handleFileEditor`)
- File: `src/http-server.js` (server — adds `/api/file-media` to the top-level file-editor dispatcher so it wins over `/api/projects/*`)
- File: `src/util.js` (server — adds `ENOTIMAGE → 415` to the typed-error → HTTP-status table)
- File: `scripts/test-file-editor.js`, `scripts/test-file-editor-http.js`, and `scripts/test-file-preview-safety.js` (tests — assert the new `image` flag, the `LICENSE` text sniff, `/api/file-media` happy + error paths, and that no preview path feeds file bytes to `innerHTML`)
The preview pane never opens if the request fails (the modal shows the error in the status row). The SVG render **used to** use `dangerouslySetInnerHTML` after an `atob()` decode, on the reasoning that the file was one the user had explicitly opened. That reasoning was wrong: "inside the project home" is not a trust boundary — a checked-out repo, a downloaded asset, or a file the model just wrote all land there. Injecting markup put the file's markup inside the app origin with the access cookie and `/api/*` reach. The reliable executing vector was the event-handler attribute rather than `<script>` (a `<script>` inserted through `innerHTML` does not run, by the insertion rule): an injected `<svg>` with `<animate onbegin>` and `<foreignObject><img onerror>` both ran their handlers on a policy-free page, confirmed in Chrome before the fix. `.fe__media-img` is now the only preview path — the same bytes through `<img src="data:image/svg+xml;base64,…">` render a 120×60 picture with the handler never firing and no `<svg>` element in the DOM (canvas-sampled at 360 px) — and `scripts/test-file-preview-safety.js` guards it. The `script-src 'self'` policy added in the same pass (see [content-security-policy.md](content-security-policy.md)) independently blocks inline handlers, so a future injection of the same shape is inert as well.

The new endpoint is intentionally separate from `/api/file` (rather than a `?media=1` query flag) so the JSON contract stays unambiguous and the text-path's `EBINARY` rejection stays unchanged for callers that haven't migrated. `GET /api/file` still rejects known image extensions with `EBINARY` so the model-facing `read_file` tool (which uses the same `/api/file` route) continues to refuse to slurp binary bytes into the chat.

The frontend keeps `openFile` and `openMedia` as mutually-exclusive state. Switching from editor → preview runs an extra `useEffect` that calls `viewRef.current.destroy()` so the CodeMirror view is reclaimed before the `<img>` is mounted; switching back runs `mountEditor(file)` from the existing `useLayoutEffect`, the same path the modal already takes on first open.

### Why the SVG preview is an image, not markup
The preview used to render an SVG by base64-decoding the file and assigning the markup to a `<div>` with `dangerouslySetInnerHTML`. That put the file's markup inside the app's origin, with the access cookie and full `/api/*` reach — and a project folder is untrusted input the moment it contains a checked-out repository, a downloaded asset, or a file a model just wrote.

The executing vector is the event-handler attribute, not the `<script>` element: a `<script>` element inserted through `innerHTML` does not run (that is the HTML/SVG insertion rule), but `on*` attributes on injected elements do. Verified in Chrome on a policy-free page — an injected `<svg>` with `<animate onbegin>` and `<foreignObject><img onerror>` ran both handlers in the page's origin. Under the app's Content-Security-Policy those handlers are blocked too, but the preview no longer injects anything at all.

The preview is now a plain `<img src="data:image/svg+xml;base64,…">`. Browsers refuse to run scripts or event handlers in an SVG loaded as an image, so the file renders as a picture and nothing else; nested/external references do not resolve either, which is the same behaviour as the raster previews. Verified end-to-end at 360 px: an SVG containing both a `<script>` and an `onbegin` handler renders (canvas sample equals the file's own fill colour) with the handler never firing and no `<svg>` element in the DOM.

This is covered by `scripts/test-file-preview-safety.js` (source guard plus a real `readMedia` round-trip): it fails if a preview path decodes file bytes for display, or if the `fe__media-svg` markup container comes back.

The list is built server-side by `listDir` in `src/files.js`, which mirrors the `SKIP_DIRS` allowlist that the rest of the app uses (see the file-tagging and file-tools scans). - Hidden **dotfiles** that are text (`.gitignore`, `.env`, `.editorconfig`, `.mouaif.json`, …) are listed and open in the editor; they were previously hidden by a blanket `name.startsWith('.')` skip. - Hidden **dot directories** that are junk (`.git`, `.mouaif`, `.cache`, `.next`, `.turbo`, …) are still skipped via `SKIP_DIRS` so the list stays clean.

### Browse boundary (not the project root)
Every read/write/list path goes through `files.resolveSafe`, which **used to** confine the editor to the project root and throw `EOUTSIDE_PROJECT` for anything above it. The boundary is now the same home / `MOUAIF_ALLOW_ANY_ROOT` guard the project-folder picker uses: `projects.ensureSafeRoot(abs)` is called on the resolved target, so paths escape the project root but must stay under the user's home (or anywhere at all when `MOUAIF_ALLOW_ANY_ROOT=1`). A path outside that boundary still throws `EOUTSIDE_HOME`.

- `resolveSafe(projectDir, incoming)` resolves `incoming` (relative against `projectDir`, absolute as-is), then validates the absolute target with `projects.ensureSafeRoot`. `rel` stays project-relative, so a sibling of the project is reported as `../…`.
- `listDir` now also returns `browseTop`, the top-most directory the browser may reach (the user's home, or `/` when allow-any-root is on). The frontend clamps the Up button and breadcrumb there.
- The frontend `FileEditor` and `AgentFilePicker` read `browseTop` from the `/api/files` response and use it to decide where Up stops, so the UI never requests a directory the server would reject. The path-input placeholder is "Folder path (absolute, or under this project)".
- Error status falls back to `EOUTSIDE_HOME` (403) when a target leaves the home boundary; `EOUTSIDE_PROJECT` is no longer produced by the file editor.
