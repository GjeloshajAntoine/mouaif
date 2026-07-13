# mouaif — Architectural decisions

Resolved by `Ask questions for what's missin` on 2026-07-13. These choices are now binding for every subsequent `feat:` commit. Any change requires a new ADR-style note in this file and, if a commit has already shipped, a `refactor!:` or `fix:` commit that updates the relevant code and doc.

## 1. Settings storage — SQLite via `better-sqlite3`

- App-level settings live in `~/.mouaif/store.sqlite` (managed by `better-sqlite3`).
- Project-level settings still live in `<projectDir>/.mouaif.json` so they can be committed to a repo and edited by hand.
- New runtime dependency: `better-sqlite3` (^11). Add it in the settings commit.

## 2. Settings scope — project overrides app

- Resolution order: defaults → app → project. Project wins on conflict.
- Documented in `docs/features/app-and-project-settings.md`.

## 3. Models — slug key, no pre-made list

- A model is `{ id: slug, provider, label, baseUrl, apiKey, contextWindow, ... }`.
- Persisted in the app settings store. No built-in list, ever.

## 4. Projects — full filesystem browse

- Picker shows any directory the user has permission to read.
- Mobile UI must implement its own directory browser from day one (no native FS picker).

## 5. Trace-to-file — per-chat export to a project-relative file

The "trace to file" feature is a **user export**, not a background stream and not a chat-storage mechanism. It exists so a user can commit a chat's transcript next to the rest of the project source and treat it like any other file in the repo.

- **Scope: the chat the toggle is on.** Nothing is traced unless the user opts this chat in.
- **Trigger: per-chat toggle**, off by default. There is no app-wide or project-wide default; every chat starts untraced.
- **Path: `<projectDir>/.mouaif/traces/<chatId>.ndjson`.** Lives next to the project so it can be `git add`-ed with the rest of the source. If the chat has no project, the user is prompted to pick one before tracing starts (no surprise writes outside the project).
- **Format: NDJSON, one event per line, append-only.** Each line is one of `user message | assistant message | tool call | tool result | system event | error`, with `{ ts, type, ...payload }`. The filename identifies the chat, so the `chatId` is not duplicated on every line.
- **Lifecycle: while the toggle is on, every new event for the chat is appended.** Toggling off closes the file handle; the file is kept. Toggling on again opens it in append mode and continues. No rotation, no TTL, no auto-cleanup — the file is the user's source file.
- **Relationship to chat storage: independent.** The transcript of the chat is stored wherever the chat store decides (per decision 1, that will be the app SQLite store). The trace file is a *view* of that store, written out as a plain file. Deleting the trace file does not delete the chat; deleting the chat does not delete the trace file.
- **Export is also available without toggling.** The chat UI exposes a one-shot "Export trace" action that writes the same NDJSON shape to a path the user picks, without leaving the toggle on.

## 6. Inspector — Chrome DevTools Protocol (CDP) over WebSocket

- `mouaif` connects to a Chrome instance started with `--remote-debugging-port`.
- New runtime dependency: a CDP client (decided per implementation commit; the lightweight choice is `chrome-remote-interface`).
- The mobile UI is still from-scratch — it consumes CDP events but never embeds the Chrome panel.

## 7. UI scaffold — Preact + Vite

- Build tool: Vite.
- Framework: Preact (`~3 KB`), with `@preact/signals` for the virtual list and the inspector tree.
- Mobile-first via CSS + `env(safe-area-inset-*)`.

## 8. Web serving — served by `mouaif serve` at `/web/`

- The existing Node server on port `5732` gains a `GET /web/...` route that serves the built mobile UI bundle.
- One process, one port. CORS stays permissive.
- Vite builds into `src/web/dist/`. The dev flow is `npm run build:web` then `mouaif serve`.

## 9. Build order — settings first

- The next `feat:` commit implements app + project settings (decisions 1 + 2) and ships with `docs/features/app-and-project-settings.md`.
- After that: virtual list primitive → models → folder picker → trace → project card → custom prompts → grouped chat list → prompt-size profiles → tabbed mobile UI shell → custom DevTools-style inspector.
