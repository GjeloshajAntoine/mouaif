# File tagging — annotate project files and inject them into a chat — implementation notes

> Agent-facing reference for [`docs/features/file-tagging.md`](../../features/file-tagging.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`    | `/api/projects/<id>/tags` | — | `{ tags: { "<relPath>": { tags: [...], excerpt: {start,end} | null, includeInChat: true } } }` |
| `PUT`    | `/api/projects/<id>/tags` | `{ tags: { ... } }` | `{ tags: { ... } }` (echo of the new map) |
| `POST`   | `/api/projects/<id>/tags/scan` | `{ dir?: "<abs>", exts?: [".js",".md",...] }` | `{ files: [{ path, size, ext }] }` (read-only scan; no writes) |
| `DELETE` | `/api/projects/<id>/tags/files/*` | — | `{ ok: true, removed: "<relPath>" }` |

The `scan` endpoint is the directory walk the UI uses to populate the file list. It honors the same home-allowlist rules as the folder picker ([docs/features/folder-picker.md](./folder-picker.md)).

## Implementation notes

- Source: `src/tags.js` (new module) — `getTags(projectDir)`, `setTags(projectDir, map)`, `scanFiles(projectDir, exts)`, `resolveForInjection(projectDir, message)`, `parseReferences(projectDir, text)`. `parseReferences` short-circuits when the message has no `@` tokens (it runs on every chat send) and only touches the disk for bare basename mentions; exact `@path` tokens are resolved without scanning. A bare basename (`@users.js`) resolves against the on-disk scan plus the tagged map (a mention can target any file in the project, tagged or not); the scan results are mapped to `path` strings before the basename match.
- The injection happens in `src/index.js` → `handleChatStream`, immediately before the existing `promptId` block. Tagged files go first (deepest context), then the prompt, then the transcript.
- A `tags` section is appended to the per-chat trace file (decision §5) as a single `system event` line so a trace replay shows what was injected without re-reading the file from disk.
- The `scan` endpoint is a one-pass walk; large projects (>50k files) are paged by directory depth. The UI can stop at any time and the server is not blocked.
- Mobile-first layout: the bounded file list uses the existing virtual-list primitive ([docs/features/virtual-list.md](./virtual-list.md)) with recycled fixed-height editor rows and overscan, so only the visible files own DOM controls and listeners.

## Decisions

- [docs/decisions.md](../../decisions.md): §15 (file tagging), §2 (project overrides app).
