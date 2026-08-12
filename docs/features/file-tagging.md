# File tagging — annotate project files and inject them into a chat

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

A user can attach **tags** to files inside a project. When a chat is sent, every tagged file is included in the upstream request as a synthetic message carrying the file's content (or a path/line-range excerpt) and the tags that pulled it in. Tags live in `<projectDir>/.mouaif.json` so the user can commit them with the project and edit them by hand. The picker is mobile-first: a list of files, a per-file tag chip strip, and an "Include in chat" toggle.

## Usage

### Tagging a file

From the project card's options menu or **Settings → This project → File tags**, the user opens **File tags** and sees every scanned project file. Each row shows the file name prominently and its project-relative folder underneath; root files show **Project root**. Binary files are labeled and cannot be newly tagged.

- **Tags** — a free-form chip list. New tags are created by typing and pressing `,` or `Enter`. Removing a chip is a tap on the chip's `×`.
- **Excerpt** — the user can pin a specific line range (start/end inclusive) instead of including the whole file. Empty excerpt means "whole file."
- **Include in chat** — a single switch, on by default. Off means the file stays tagged but is not auto-injected into new messages; it can still be referenced explicitly with `@path/to/file` in the composer.

Tags are project-scoped. A tag named `api` on `src/api/users.js` is a different annotation from a tag named `api` on `frontend/api.js`; the chat injects both, each with its own context.

### In a chat

When the user sends a message, the server pre-appends the tagged files to the upstream `messages` array, before the user's history. The shape of each injected message is:

```js
{
  role: 'system',                     // or 'user' if the user explicitly @-referenced the file
  content:
    '# File: src/api/users.js\n' +
    '# Tags: api, auth\n' +
    '# Excerpt: 1-120\n' +
    '\n' +
    '<file contents or excerpt>'
}
```

The leading header block lets the model reason about provenance. The role is `system` by default (the tagged files are project context); when the user types `@src/api/users.js` in the composer, the role is `user` so the model treats it as a direct reference.

A bare basename mention — `@users.js` instead of the full path — is also accepted. `parseReferences` resolves it against the tagged map first and the on-disk scan second, so `@users.js` promotes `src/api/users.js` when that basename is unambiguous (an ambiguous basename resolves to the shortest path rather than being dropped, and a mention with no match at all is silently ignored).

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`    | `/api/projects/<id>/tags` | — | `{ tags: { "<relPath>": { tags: [...], excerpt: {start,end} | null, includeInChat: true } } }` |
| `PUT`    | `/api/projects/<id>/tags` | `{ tags: { ... } }` | `{ tags: { ... } }` (echo of the new map) |
| `POST`   | `/api/projects/<id>/tags/scan` | `{ dir?: "<abs>", exts?: [".js",".md",...] }` | `{ files: [{ path, size, ext }] }` (read-only scan; no writes) |
| `DELETE` | `/api/projects/<id>/tags/files/*` | — | `{ ok: true, removed: "<relPath>" }` |

The `scan` endpoint is the directory walk the UI uses to populate the file list. It honors the same home-allowlist rules as the folder picker ([docs/features/folder-picker.md](./folder-picker.md)).

## Behavior

- **Storage: per-project `.mouaif.json`.** New top-level key `tags`, shaped exactly like the GET response above. The file is rewritten on every PUT; the scan and DELETE endpoints do not touch the map.
- **Path normalization.** Paths are stored as POSIX-style relative paths from the project root (`src/api/users.js`, never `src\\api\\users.js`). The chat loader resolves them with `path.join(projectDir, rel)` and refuses anything that escapes the project root (`..` segments or absolute paths yield `EOUTSIDE_PROJECT`).
- **Excerpt format.** `{ start, end }` are 1-indexed inclusive line numbers. An absent excerpt means the whole file; `{ start: 2, end: 2 }` injects line 2.
- **File size cap.** Files above a soft cap (default 256 KB, configurable via `app.fileTagMaxBytes`) are not auto-injected; the tagged entry stays in the project file with `includeInChat: false` and a `note: "exceeds fileTagMaxBytes"`. The user can pin a smaller excerpt to bypass the cap.
- **Stale path handling.** If a tagged file is moved, renamed, or deleted, the entry is kept (the user may be in the middle of a refactor) but is silently skipped at injection time. The UI shows a `missing` badge on stale entries and offers a "Remove" action.
- **Commit-friendliness.** Because the tag map lives in `.mouaif.json`, the user can `git add` it next to the source. The chat injects the current working-tree version of each file at message-send time, not whatever was committed.
- **No tags on a missing project.** Tag CRUD requires the project to be registered; a PUT against an unregistered project returns `404`.
- **Binary files are out.** The scan filters by extension (configurable; defaults to a text-friendly list: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.json`, `.json5`, `.md`, `.txt`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.c`, `.h`, `.cpp`, `.hpp`, `.css`, `.scss`, `.less`, `.html`, `.vue`, `.svelte`, `.astro`, `.yml`, `.yaml`, `.toml`, `.sh`, `.sql`, `.graphql`, `.gql`, `.proto`, `.ini`, `.conf`, `.cfg`, `.env`, `.lock`, `.map`, `.log`, `.lua`, `.pl`, `.pm`, `.r`, `.jl`, `.dart`, `.zig`, `.ex`, `.exs`, `.erl`, `.hrl`, `.fs`, `.fsx`, `.ml`, `.clj`, `.cljs`, `.scala`, `.groovy`, `.gradle`, `.tf`, `.hcl`, `.pug`, `.jade`, `.ejs`, `.hbs`, `.mustache`, `.tpl`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.eslintrc`, `.prettierrc`, `.babelrc`, `.npmrc`, `.nvmrc`, `.yarnrc`, `.dockerignore`, `.gitmodules`, `.htaccess`, `.dockerfile`, `.makefile`). The check is against the file's **extension**, never the whole name, so dotted base names (`App.vue`, `webpack.config.js`) are never mistaken for extensionless binaries; extensionless build files (`Makefile`) are classified via the allowlist too. Unknown extensions show up in the scan as `binary: true` and cannot be tagged.

## Implementation notes

- Source: `src/tags.js` (new module) — `getTags(projectDir)`, `setTags(projectDir, map)`, `scanFiles(projectDir, exts)`, `resolveForInjection(projectDir, message)`, `parseReferences(projectDir, text)`. `parseReferences` short-circuits when the message has no `@` tokens (it runs on every chat send) and only touches the disk for bare basename mentions; exact `@path` tokens are resolved without scanning. A bare basename (`@users.js`) resolves against the on-disk scan plus the tagged map (a mention can target any file in the project, tagged or not); the scan results are mapped to `path` strings before the basename match.
- The injection happens in `src/index.js` → `handleChatStream`, immediately before the existing `promptId` block. Tagged files go first (deepest context), then the prompt, then the transcript.
- A `tags` section is appended to the per-chat trace file (decision §5) as a single `system event` line so a trace replay shows what was injected without re-reading the file from disk.
- The `scan` endpoint is a one-pass walk; large projects (>50k files) are paged by directory depth. The UI can stop at any time and the server is not blocked.
- Mobile-first layout: the bounded file list uses the existing virtual-list primitive ([docs/features/virtual-list.md](./virtual-list.md)) with recycled fixed-height editor rows and overscan, so only the visible files own DOM controls and listeners.

## Related

- [docs/features/folder-picker.md](./folder-picker.md) — the same home-allowlist rules.
- [docs/features/custom-prompts.md](./custom-prompts.md) — tags and prompts compose: a tagged file can sit under a custom system prompt in the same upstream array.
- [docs/features/chat-ui.md](./chat-ui.md) — composer and message rendering.
- Decision: [docs/decisions.md §15](../decisions.md) (this feature) and §2 (project overrides app).
