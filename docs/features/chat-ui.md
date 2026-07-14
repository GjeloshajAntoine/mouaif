# Chat UI — Preact + Vite mobile shell

## Overview

The mobile UI at `/web/` is a **Preact + Vite** app, served from `src/web/dist/`. The Node server ([src/index.js](../../src/index.js)) serves the Vite build at `/web/` and falls back to the source tree at `src/web/` when the build hasn't run yet, so the dev cycle works either way.

The chat UI consumes the **per-chat message store** ([src/messages.js](../../src/messages.js)) and the **per-chat trace writer** ([src/trace.js](../../src/trace.js)).

## Visual design

A polished, dark, mobile-first design system lives in [src/web/src/style.css](../../src/web/src/style.css). It is intentionally a single stylesheet — small surface area, easy to scan.

- **Surfaces**: three levels of dark elevation (`--bg`, `--surface`, `--surface-2`, `--surface-3`) with a soft accent-tinted radial glow at the top of the page and a fainter one at the bottom, so the app never reads as a black void. Cards sit on `--surface` and use a soft 1 px border plus `--shadow-sm` for lift.
- **Color tokens**: `--accent` (signature blue) with `--accent-press`, `--accent-soft` (tinted surface), `--on-accent` (text on accent). Semantic colors: `--success`, `--warning`, `--danger` + `--danger-soft`. The status line drives its color from a `data-state` attribute on the `.status` element (`busy` → accent, `error` → danger, `success` → success, default → muted) so the same line reads correctly in every context.
- **Typography**: a single system-font stack at 16 px / 1.5 line-height. Section headings are small-caps uppercase (`.08em` letter-spacing) in `--muted` for navigation and `--accent` for subsections. The H1 title uses a white-to-blue gradient for the brand mark.
- **Spacing & radii**: a 4 px scale (`--gap`, `--pad-x`, `--pad-y`) and an 8 px radius scale (`--r-sm`, `--r-md`, `--r-lg`, `--r-pill`). All touch targets are 44 × 44 px (`--tap`).
- **Components**: primary buttons (`.btn--primary`) get a subtle inset highlight + glow; cards (`.project-card`, `.chat-view__composer`) get rounded corners and a soft shadow; popovers (`.project-card__menu-pop`) get a stronger shadow and the third surface level; chat bubbles use asymmetric corner radii to point at the speaker. Empty states (`.projects__empty`, `.chat-view__empty`) have a centered icon tile in `--accent-soft`, a bold title, and a short body line so the page is never just a bare "nothing here" message.
- **Motion**: 120 ms transitions on hover, focus, and press. `prefers-reduced-motion` short-circuits them to 1 ms.
- **Focus**: keyboard-only focus ring via `:focus-visible`; touch devices never see it.

The build target is 360–430 px wide; the app is a 480 px-max-width column centered in the viewport, so desktop is "the mobile UI with extra room" (per [docs/decisions.md §4](../decisions.md) and [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §2).

## App shell

The shell is a full-viewport flex column (`min-height: 100dvh`). Three regions stack top → bottom:

1. **Header** — brand block: a small blue logo tile with the letter "m" and a stacked title (`.app__title` + `.app__sub`). The right side carries a transparent spacer so a future header action can sit there without pushing the brand.
2. **Main** — the scrollable content. Reserves `padding-bottom: var(--tabbar-h) + var(--safe-bottom)` so the last row never sits under the tab bar. Drill-in screens (chat, picker) use `.app__main--flush` and own the safe area themselves.
3. **Bottom tab bar** — sticky child of the shell. Hidden on drill-in screens.

## Bottom tab bar

The three top-level destinations — **Projects / Settings / Auth** — are reached from a sticky bottom tab bar (`.app__tabbar`) instead of the top header. Each tab is a small inline-SVG icon above a small-caps label. The active tab gets the accent color and a soft accent-soft pill behind the icon. The bar respects `env(safe-area-inset-bottom)`, has a top border + gradient background that fades into the content, and sits at `z-index: 30` so popovers and other overlays can stack above it. Hidden on the chat view and the project picker, which are drill-in screens with their own per-screen back button.

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
- **The hash router is simple.** No history API, no client-side router — the Node server doesn't rewrite unknown paths to `index.html`, so deep links would 404 anyway. Four top-level views: `projects`, `settings`, `auth` (reached from the bottom tab bar), and `chat/<id>?projectDir=…` (a drill-in screen with its own back button). The `BottomNav` component highlights the active tab.
- **Models are still per-project.** The chat view reads `/api/ai/models?projectDir=…` so the model picker is filtered to models visible in the chat's project.
- **Auto-scroll.** The transcript auto-scrolls to the bottom on new content. Manual scrolling is not preserved across sends — out of scope.
- **No optimistic re-render on errors.** A 4xx/5xx on the stream endpoint shows in the status line; the live assistant message is replaced with `[error: HTTP <code>]`.

## Per-chat controls

The chat head has a small toolbar of icon buttons (44 × 44 px, mobile-first):

- **✎ Rename** — `prompt()` for a new title, `PATCH /api/chats/:id` with `{ title }`. The visible title updates immediately on success; the chat list in the project card refreshes on next render.
- **× Delete** — `confirm()` then `DELETE /api/chats/:id?projectDir=…`. Bumps `projectsReload` so the project card refetches, and navigates back to `#/projects`. The on-disk transcript and trace file are removed; the project's `.mouaif.json` loses the chat entry.
- **Trace to file** — checkbox below the head. `PATCH` with `{ trace: bool }`. The meta line under the title (`<promptSize> · trace on/off`) updates on success. The trace writer in [src/trace.js](../../src/trace.js) is already gated on `chat.trace`, so flipping this on mid-conversation starts writing `<projectDir>/.mouaif/traces/<chatId>.ndjson` from the next event.
- **Prompt size** — select with `very-small | average | extensive`. `PATCH` with `{ promptSize }`. The same value is read on the server when the chat is opened, so the next message uses the new profile.

All four controls share a single `updateChat(patch)` helper. On success it overwrites the local `chat` signal with the server's response, which is the single source of truth for the head's title, meta line, and the trace / promptSize controls. On failure the status line shows the HTTP code and nothing on the page changes.

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
