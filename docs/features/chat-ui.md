# Chat UI — Preact + Vite mobile shell

## Overview

The mobile UI at `/web/` is a **Preact + Vite** app, served from `src/web/dist/`. The Node server ([src/index.js](../../src/index.js)) serves the Vite build at `/web/` and falls back to the source tree at `src/web/` when the build hasn't run yet, so the dev cycle works either way.

The chat UI consumes the **per-chat message store** ([src/messages.js](../../src/messages.js)) and the **per-chat trace writer** ([src/trace.js](../../src/trace.js)).

## Visual design

A polished, dark, mobile-first design system lives in [src/web/src/style.css](../../src/web/src/style.css). It is intentionally a single stylesheet — small surface area, easy to scan.

- **Surfaces**: three levels of dark elevation (`--bg`, `--surface`, `--surface-2`, `--surface-3`) with a soft accent-tinted radial glow at the top of the page and a fainter one at the bottom, so the app never reads as a black void. Cards sit on `--surface` and use a soft 1 px border plus `--shadow-sm` for lift.
- **Color tokens**: `--accent` (signature blue) with `--accent-press`, `--accent-soft` (tinted surface), `--on-accent` (text on accent). Semantic colors: `--success`, `--warning`, `--danger` + `--danger-soft`. The status line drives its color from a `data-state` attribute on the `.status` element (`busy` → accent, `error` → danger, `success` → success, default → muted) so the same line reads correctly in every context.
- **Typography**: a single system-font stack at 15 px / 1.35–1.45 line-height. Section headings are small-caps uppercase (`.07em` letter-spacing) in `--muted` for navigation and `--accent` for subsections. The H1 title uses a white-to-blue gradient for the brand mark.
- **Spacing & radii**: a 6 px scale (`--pad-x: 10`, `--pad-y: 6`, `--gap: 6`) and a 5/8/12 px radius scale (`--r-sm`, `--r-md`, `--r-lg`). Interactive controls use a minimum 32 × 32 px target (`--tap`) throughout the bottom tab bar, project card menu, picker, and icon buttons. The whole UI is tuned to be as small as possible on a phone: 32px is intentionally below the iOS 44px / Material 48px minimums and trades some tap accuracy for information density.
- **Components**: primary buttons (`.btn--primary`) get a subtle inset highlight + glow; cards (`.project-card`, `.chat-view__composer`) get rounded corners and a soft shadow; popovers (`.project-card__menu-pop`) get a stronger shadow and the third surface level; chat bubbles use asymmetric corner radii to point at the speaker. Empty states (`.projects__empty`, `.chat-view__empty`) have a centered icon tile in `--accent-soft`, a bold title, and a short body line so the page is never just a bare "nothing here" message.
- **Motion**: a small set of transform/opacity-only animations on the shell, all driven by `--dur` / `--ease` tokens. The view inside `.app__main` fades + lifts in on every route change (`mouaif-view-in`, 180 ms). Each `.chat-msg` slides + scales in on append, with a tiny stagger so a streaming reply feels conversational rather than dumpy (`mouaif-bubble-in`, 180 ms, up to 8 staggered rows). The project list and per-project chat rows get the same entrance. The live assistant bubble (`.chat-msg[data-live="1"]`) shows a blinking accent caret while the stream is open (`mouaif-cursor`, 900 ms). Press feedback on tabs (`.94`) and chat rows (`.985`) is a one-frame scale. `prefers-reduced-motion: reduce` zeroes every transition / animation / stagger and removes the caret, so the UI is fully static for users who opt out.
- **Focus**: keyboard-only focus ring via `:focus-visible`; touch devices never see it.

The build target is 360–430 px wide; the app is a 480 px-max-width column centered in the viewport, so desktop is "the mobile UI with extra room" (per [docs/decisions.md §4](../decisions.md) and [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §2).

## App shell

The shell is a full-viewport flex column (`min-height: 100dvh`). Three regions stack top → bottom, and the whole UI is tuned to be as small as possible on a phone:

1. **Header** — single-line brand block: a 24 × 24 px blue logo tile with the letter "m" and the title "mouaif". No subtitle, no second row, no right-side spacer. A future header action (search, profile) can sit in the same row next to the brand.
2. **Main** — the scrollable content. Reserves `padding-bottom: var(--tabbar-h) + var(--safe-bottom)` so the last row never sits under the tab bar. Drill-in screens (chat, picker) use `.app__main--flush` and own the safe area themselves.
3. **Bottom tab bar** — sticky child of the shell, 52 px tall (incl. safe area). Hidden on drill-in screens.

## Bottom tab bar

The three top-level destinations — **Projects / Inspector / Settings** — are reached from a sticky bottom tab bar (`.app__tabbar`) instead of the top header. Provider authentication lives inside Settings because it is part of configuring a provider, not a standalone destination. Each tab is a small inline-SVG icon above a small-caps label.

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
| POST   | `/api/chats/:id/messages/stream` | `{ projectDir, modelId, providerId?, content }` | **SSE stream** of `message` / `done` / `error` events; `providerId` resolves live-catalog models that are not stored in the optional project `models` array. |
| GET    | `/api/ai/models?projectDir=<abs>` | — | `{ models: [{ id, provider, label, auth }], providers: [..] }` — project-level model list (the `models` array in `.mouaif.json`). |
| GET    | `/api/ai/models/providers` | — | `{ providers: [{ id }] }` — configured app-level provider connections, with no credentials. |
| GET    | `/api/ai/models/live?provider=<id>` | — | `{ models: [{ id, label, contextWindow? }], fetchedAt, cached }` — live catalog from the upstream `/models` endpoint (or curated for Anthropic/Copilot). Cached 1h per `provider:credHash`. 400 on unknown provider; 502 `{ error, code: 'EUPSTREAM' }` on upstream failure; 8 s `AbortController` timeout. |

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

A chat with `trace: true` also writes a per-chat NDJSON stream to `<projectDir>/.mouaif/traces/<chatId>.ndjson` (per [docs/decisions.md §5](../decisions.md)). One event per line: `{ ts, type, ...payload }`. User and assistant turns are complete `user_message` / `assistant_message` records; tool calls/results, system events, and errors have their own records. Append mode has no rotation or auto-cleanup. **Export trace** rewrites the same path once from the persisted transcript without enabling background tracing.

## Behavior

- **One SSE round-trip per user turn.** `POST /api/chats/:id/messages/stream` accepts the user message, resolves the model from the project settings, calls `ai.streamChat`, and streams the response back. The browser reads the SSE the same way the old `AI test` panel did. The user message is appended before streaming; the assistant message is appended on `done`.
- **The `done` event carries a precomputed cost block.** The server resolves pricing through the order documented in [docs/decisions.md §14](../decisions.md) (`model.pricing → app.modelPricing[id] → built-in → none`) and ships the result on `done` as `{ cost: { known, input, output, total, currency }, streamingMs, modelId }`. The chat UI consumes that block and renders the per-turn meta line under the assistant bubble; the chat UI never has to know about pricing resolution. The same `cost` + `usage` block is also persisted on the assistant message record so a chat that is re-opened later shows the same numbers.
- **System prompt is the first message.** The resolved prompt-size profile (plus any custom prompt) is rendered as a normal `.chat-msg--system` bubble at the top of the transcript (role `system`, centered, muted), fed by `GET /api/chats/:id/system-prompt`. It is a real message in the conversation — not a widget — so the user can read exactly what the model was told. It refreshes in place when the prompt size or custom prompt changes.
- **Prompt-size control lives in the message area, only at creation time.** The prompt-size choice is a creation-time concern, so it is part of the transcript (the message area) instead of the head (the top bar). On a brand-new chat the transcript's first child is a single full-width `<select class="input chat-view__setup">` with three options: `Very small — tool names only, no parameter schemas, smallest prompt`, `Average — full tools, recommended`, and `Extensive — full tools + best-practice guidance`. The currently resolved profile is marked with the `selected` attribute on its `<option>` so the dropdown reflects state on every re-render (Preact can drop a `<select value=…>` on first mount; toggling `selected` is reliable). A `change` PATCHes `{ promptSize }` and updates the System bubble. As soon as the first message is sent, `updateSetupVisibility()` removes the control from the DOM for the life of the chat — the prompt size is fixed from that point, and the top bar stays clean (no permanent prompt-size widget). There is no prompt-size control in the ⚙ popover anymore.
- **Tool calls render inline, between the turns.** When the model calls a tool (native `shell` or an MCP tool), the `tool_call` SSE event renders a `.tool-card` (`TOOL CALL · <name>` + argument JSON + a `RUNNING…` pill) directly in the transcript, above the streaming assistant reply. The matching `tool_result` event turns it into a collapsible result card with an `ok` / `error` pill. Both records are persisted, rendered again after reopening, and reconstructed into provider-compatible assistant/tool history on the next send.
- **Per-turn meta line under each assistant message.** A small row of compact tokens (`.chat-msg__meta`): `modelId · <prompt> in · <completion> out · $0.00012 · 37 tok/s`. The `tok/s` value is rendered live: a per-turn counter (one per `send()`) accumulates a heuristic token estimate from each `message` delta and is replaced by the upstream's authoritative `completionTokens` on `done`. The repaint is throttled to ~8 Hz so a long stream doesn't strobe on a phone. The line is hidden when the assistant message has no `usage` block (e.g. older transcripts from before this commit shipped).
- **Trace follows the chat's `trace` flag.** The chat record in [src/chats.js](../../src/chats.js) already has the field per [docs/decisions.md §5](../decisions.md). When it's on, every event sent to the browser is also written to the trace file. The writer is a no-op when the project is on a read-only filesystem (the directory creation is best-effort) or when the chat has `trace: false`.
- **The hash router is simple.** Top-level views are `projects`, `inspector`, and `settings`; `chat/<id>` and the project picker are drill-ins. The retired `#/auth` route resolves to Settings for backward compatibility.
- **Models are per-project; providers are app-level.** The chat view reads `/api/ai/models?projectDir=…` for project model IDs. The server resolves credentials from the matching global provider connection only when sending a request.
- **Auto-scroll.** The transcript auto-scrolls to the bottom on new content. Manual scrolling is not preserved across sends — out of scope.
- **No optimistic re-render on errors.** A 4xx/5xx on the stream endpoint shows in the status line; the live assistant message is replaced with `[error: HTTP <code>]`.

## Per-chat controls

The chat head is intentionally minimal so the message area gets every spare pixel on a phone. Row one is the compact chrome row: back / title+meta / settings / rename / delete. Row two is the model `<select>`, which wraps to its own full-width line (`flex: 1 0 100%`) so it never competes with the title for horizontal space and the header can never overflow vertically on a 360 px viewport. The Trace + Prompt controls live in a small popover anchored to the ⚙ button; tapping the button toggles the popover, tapping outside or pressing Escape closes it. Keeping these in a popover (instead of a fixed row under the head) reclaims vertical space for the transcript. The prompt-size choice is not in the head at all — it lives in the message area as a full-width `<select>` shown only on a brand-new chat (see "Behavior" above).

- **Provider + Model** — the head's second row contains an explicit provider picker, the model picker, and a refresh button (↻). The provider list comes from `GET /api/ai/models/providers`; changing it fetches only that provider's catalog. When multiple providers exist and a chat has no saved choice, the picker starts at `(provider)` instead of silently using the first connection (for example OpenAI-compatible instead of OpenRouter). The selected `providerId` + `modelId` pair is saved on the chat and restored on reopen. The model picker is populated from the union of that provider's project entries and `GET /api/ai/models/live?provider=<id>`, deduped by id with project entries winning. A live selection is sent as `{ modelId, providerId }`; the server hydrates it from the matching app-level connection without persisting hundreds of catalog entries into `.mouaif.json`.
- **⚙ Settings** — opens the settings popover. Inside:
  - **Prompt** — optional custom prompt for this chat, populated from `GET /api/prompts`. `PATCH` with `{ promptId }`. Layered on top of the profile; the system-prompt card refreshes to show it appended.
  - **Trace to file** — checkbox. `PATCH` with `{ trace: bool }`. The only per-chat control still surfaced on the meta line (`trace on`, or nothing when off), because it has no other on-screen indicator. The trace writer in [src/trace.js](../../src/trace.js) is already gated on `chat.trace`, so flipping this on mid-conversation starts writing `<projectDir>/.mouaif/traces/<chatId>.ndjson` from the next event.
  - **Export trace** — one-shot `POST /api/chats/:id/trace/export`. It exports the stored transcript immediately without changing the toggle.
- **✎ Rename** — `prompt()` for a new title, `PATCH /api/chats/:id` with `{ title }`. The visible title updates immediately on success; the chat list in the project card refreshes on next render.
- **× Delete** — `confirm()` then `DELETE /api/chats/:id?projectDir=…`. Bumps `projectsReload` so the project card refetches, and navigates back to `#/projects`. The on-disk transcript is removed and the project's `.mouaif.json` loses the chat entry. The trace file is deliberately kept because it is an independent, user-owned export per [docs/decisions.md §5](../decisions.md).

All `PATCH`-style controls share a single `updateChat(patch)` helper. On success it overwrites the local `chat` record with the server's response, which is the single source of truth for the head's title, the (trace-only) meta line, and the popover's controls. The prompt-size switch and the custom-prompt handler additionally re-fetch `GET /api/chats/:id/system-prompt` and re-render the system-prompt card (the switch also re-fetches the tool preview). On failure the status line shows the HTTP code and nothing on the page changes.

## Composer

The chat view is a full-height flex column: the head and composer are fixed-height (`flex: 0 0 auto`) and the transcript in between flexes (`flex: 1 1 auto; min-height: 0`) and scrolls internally. This keeps the composer pinned to the bottom and stops the last message from being hidden behind it — the transcript scrolls, not the page. The shell (`.app__shell`) is bounded to `100dvh` and the drill-in main region (`.app__main--flush`) is a bounded flex column so the internal scroll works.

The composer is a single horizontal row: an auto-growing `<textarea>` + a 32 × 32 px square send button + a status line below. `Enter` sends; `Shift+Enter` inserts a newline. The textarea's height is reset to `auto` on every `input` event, then set to `Math.min(120, Math.max(32, scrollHeight))` so it grows with the content (capped at 120 px so a very long paste doesn't push the transcript off-screen). After a send the textarea is cleared and re-measured, so the composer collapses back to its 32 px single-line height, which lines up with the send button.

## Implementation notes

- Build: [src/web/vite.config.js](../../src/web/vite.config.js), `src/web/index.html`, [src/web/src/main.jsx](../../src/web/src/main.jsx), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/virtual-list.js](../../src/web/src/virtual-list.js). Vite emits hashed assets under `src/web/dist/assets/`. Current production output is about 69 KB JS + 26 KB CSS, about 22 KB + 5 KB gzipped.
- Server: [src/index.js](../../src/index.js) → `handleChats()` now also handles `/api/chats/:id/messages[/:action]` and delegates the stream to `handleChatStream()`. The static `/web/` route prefers `src/web/dist/`, falls back to `src/web/` for dev.
- Messages: [src/messages.js](../../src/messages.js) — per-chat file `<projectDir>/.mouaif.messages.<chatId>.json`. Robust read (drops malformed entries), throws `MOUAIF_PROJECT_PARSE_ERROR` (422) only if the file itself is corrupt.
- Trace: [src/trace.js](../../src/trace.js) — per-chat NDJSON writer, no-op when `chat.trace` is false or the directory can't be created.
- Bottom nav: Projects / Inspector / Settings. Settings contains provider connections, provider authentication, and the raw project-settings editor.
- Dropped (intentionally): the previous `AI test` panel and the `Virtual list demo`. They were dev-time affordances; the chat view replaces the AI test, while the Inspector now consumes the virtual-list primitive.

## Related

- Per-chat trace concept: [docs/decisions.md §5](../decisions.md).
- AI proxy that powers the stream: [docs/features/ai-client.md](./ai-client.md).
- Per-project chat bookkeeping: [docs/features/project-card.md](./project-card.md).
- Provider authentication: [docs/features/auth.md](./auth.md).
- The virtual-list primitive: [docs/features/virtual-list.md](./virtual-list.md). It lives at `src/web/src/virtual-list.js` and powers the Inspector Console and Network panels.
