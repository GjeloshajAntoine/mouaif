# Chat UI — Preact + Vite mobile shell

## Overview

The mobile UI at `/web/` is now a **Preact + Vite** app, served from `src/web/dist/`. The Node server ([src/index.js](../../src/index.js)) serves the Vite build at `/web/` and falls back to the source tree at `src/web/` when the build hasn't run yet, so the dev cycle works either way.

This commit landed two features in one (your explicit override of the "one feature = one commit" rule):

1. **The chat UI itself** — a hash-routed two-view SPA: `#/projects` (the per-project chat list) and `#/chat/<id>?projectDir=…` (the chat view with transcript + composer). Plus `#/settings` and `#/auth` for the existing model editor and OAuth panel, reachable from the top nav.
2. **The Preact + Vite framework** — adds `preact`, `@preact/signals`, `vite`, `@preact/preset-vite` as deps. `npm run build:web` writes `src/web/dist/` (a 34 KB JS + 8 KB CSS bundle, gzipped 12 + 2 KB).

The chat UI consumes the **per-chat message store** ([src/messages.js](../../src/messages.js)) and the **per-chat trace writer** ([src/trace.js](../../src/trace.js)), both of which this commit also adds.

## Usage

### Build

````bash
npm install
npm run build:web   # writes src/web/dist/
node bin/mouaif.js serve
# open http://127.0.0.1:5732/web/
````

### Dev (optional, with HMR)

````bash
npm run dev:web      # vite dev server on :5173 (not used by the Node server)
npm run build:web   # ship the bundle, then `mouaif serve`
````

### HTTP (chat-aware)

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ messages: [{ role, content, ts }] }` (422 on corrupt file) |
| POST   | `/api/chats/:id/messages` | `{ projectDir, role, content }` | `{ message }` (201) |
| DELETE | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ ok: true, removed }` |
| POST   | `/api/chats/:id/messages/stream` | `{ projectDir, modelId, content }` | **SSE stream** of `message` / `done` / `error` events; the server appends the user message, calls `ai.streamChat`, streams the response, appends the assistant message on `done`, and writes each event to the trace file (if the chat's `trace` flag is on). |

### On-disk shape

A chat's transcript is stored in `<projectDir>/.mouaif.messages.<chatId>.json`:

```json
{
  "messages": [
    { "role": "user",      "content": "Hello, Claude", "ts": "2026-07-14T12:34:00.000Z" },
    { "role": "assistant", "content": "Hi! How can I help?", "ts": "2026-07-14T12:34:03.000Z" }
  ]
}
```

A chat with `trace: true` also writes a per-chat NDJSON stream to `<projectDir>/.mouaif/traces/<chatId>.ndjson` (per [docs/decisions.md §5](../decisions.md)). One event per line: `{ ts, type, ...payload }`. Types mirror the SSE events: `message`, `done`, `error`, plus `passthrough` for unknown events. Append-only, no rotation, no auto-cleanup.

## Behavior

- **One SSE round-trip per user turn.** `POST /api/chats/:id/messages/stream` accepts the user message, resolves the model from the project settings, calls `ai.streamChat`, and streams the response back. The browser reads the SSE the same way the old `AI test` panel did. The user message is appended before streaming; the assistant message is appended on `done`.
- **Trace follows the chat's `trace` flag.** The chat record in [src/chats.js](../../src/chats.js) already has the field per [docs/decisions.md §5](../decisions.md). When it's on, every event sent to the browser is also written to the trace file. The writer is a no-op when the project is on a read-only filesystem (the directory creation is best-effort) or when the chat has `trace: false`.
- **The hash router is simple.** No history API, no client-side router — the Node server doesn't rewrite unknown paths to `index.html`, so deep links would 404 anyway. Three views: `projects`, `chat/<id>?projectDir=…`, `settings`, `auth`. The `AppNav` component highlights the active route.
- **Models are still per-project.** The chat view reads `/api/ai/models?projectDir=…` so the model picker is filtered to models visible in the chat's project.
- **Auto-scroll.** The transcript auto-scrolls to the bottom on new content. Manual scrolling is not preserved across sends — out of scope.
- **No optimistic re-render on errors.** A 4xx/5xx on the stream endpoint shows in the status line; the live assistant message is replaced with `[error: HTTP <code>]`.

## Implementation notes

- Build: [src/web/vite.config.js](../../src/web/vite.config.js), `src/web/index.html`, [src/web/src/main.jsx](../../src/web/src/main.jsx), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/virtual-list.js](../../src/web/src/virtual-list.js). Vite emits hashed assets under `src/web/dist/assets/`. Total bundle is ~35 KB JS + ~9 KB CSS, ~14 KB + ~2 KB gzipped.
- Server: [src/index.js](../../src/index.js) → `handleChats()` now also handles `/api/chats/:id/messages[/:action]` and delegates the stream to `handleChatStream()`. The static `/web/` route prefers `src/web/dist/`, falls back to `src/web/` for dev.
- Messages: [src/messages.js](../../src/messages.js) — per-chat file `<projectDir>/.mouaif.messages.<chatId>.json`. Robust read (drops malformed entries), throws `MOUAIF_PROJECT_PARSE_ERROR` (422) only if the file itself is corrupt.
- Trace: [src/trace.js](../../src/trace.js) — per-chat NDJSON writer, no-op when `chat.trace` is false or the directory can't be created.
- Top nav: Projects / Settings / Auth. Settings is where the model editor lives; Auth is where the Anthropic sign-in button lives. Each has a back link to `#/projects`.
- Dropped (intentionally): the previous `AI test` panel and the `Virtual list demo`. They were dev-time affordances; the chat view replaces the AI test, and the virtual list primitive is now bundled into the chat transcript if needed. The dead code is gone from `main.jsx` (no `useMemo` or `createVirtualList` imports left).

## Related

- Per-chat trace concept: [docs/decisions.md §5](../decisions.md).
- AI proxy that powers the stream: [docs/features/ai-client.md](./ai-client.md).
- Per-project chat bookkeeping: [docs/features/project-card.md](./project-card.md).
- Auth panel: [docs/features/auth.md](./auth.md).
- The original virtual-list primitive: [docs/features/virtual-list.md](./virtual-list.md). The primitive still lives at `src/web/src/virtual-list.js` for the chat transcript (used in `ChatView`'s per-message rendering) but the demo at the top of the old page is gone.
