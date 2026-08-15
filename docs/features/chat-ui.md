# Chat UI — Preact + Vite mobile shell

## Overview

The mobile UI at `/` is a **Preact + Vite** app, served from `frontend/dist/`. The Node server ([src/index.js](../../src/index.js)) serves the Vite build at `/` and falls back to the source tree at `frontend/` when the build hasn't run yet, so the dev cycle works either way.

The chat UI consumes the **per-chat message store** ([src/messages.js](../../src/messages.js)) and the **per-chat trace writer** ([src/trace.js](../../src/trace.js)).

## Visual design

A polished, dark, mobile-first design system lives in [frontend/src/style.css](../../frontend/src/style.css). It is intentionally a single stylesheet — small surface area, easy to scan.

- **Surfaces**: three levels of dark elevation (`--bg`, `--surface`, `--surface-2`, `--surface-3`) with a soft accent-tinted radial glow at the top of the page and a fainter one at the bottom, so the app never reads as a black void. Cards sit on `--surface` and use a soft 1 px border plus `--shadow-sm` for lift.
- **Color tokens**: `--accent` (signature blue) with `--accent-press`, `--accent-soft` (tinted surface), `--on-accent` (text on accent). Semantic colors: `--success`, `--warning`, `--danger` + `--danger-soft`. The status line drives its color from a `data-state` attribute on the `.status` element (`busy` → accent, `error` → danger, `success` → success, default → muted) so the same line reads correctly in every context.
- **Typography**: a single system-font stack at 15 px / 1.35–1.45 line-height. Section headings are small-caps uppercase (`.07em` letter-spacing) in `--muted` for navigation and `--accent` for subsections. The H1 title uses a white-to-blue gradient for the brand mark. The meta tier (per-turn usage line, the head's "Context / Total / Balance" summary, the bottom tab-bar labels) is kept as small as possible (0.6–0.66 rem) so every spare pixel goes to the bubble on a phone. The tier gets its richness from *shape*, not size: the head summary renders each value as a soft accent-tinted pill (label dim, value bold), the per-turn line underlines the model id in a hairline, tints the cost number, and softly gradients the live tok/s while the bubble is streaming (see "Usage summary at the top" below).
- **Spacing & radii**: a 6 px scale (`--pad-x: 10`, `--pad-y: 6`, `--gap: 6`) and a 5/8/12 px radius scale (`--r-sm`, `--r-md`, `--r-lg`). Interactive controls use a minimum 44 × 44 px target (`--tap`) throughout the bottom tab bar, project card menu, picker, and icon buttons.
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
npm run build:web   # writes frontend/dist/
node bin/mouaif.js serve
# open http://127.0.0.1:5732/
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
- **The `done` event carries a precomputed cost block.** For providers that report an authoritative request cost (currently OpenRouter's `usage.cost`), the server uses that value, including the sum across tool-loop requests. Otherwise it resolves pricing through the order documented in [docs/decisions.md §14](../decisions.md) (`model.pricing → app.modelPricing[id] → built-in → none`). It ships `{ cost: { known, input, output, total, currency }, streamingMs, modelId }` on `done`. The same `cost` + `usage` block is persisted so reopened chats show the same numbers.
- **System prompt is the first message.** The resolved prompt-size profile (plus any custom prompt) is rendered as a normal `.chat-msg--system` card at the top of the transcript (role `system`, muted), fed by `GET /api/chats/:id/system-prompt`. It is a real message in the conversation — not a widget — so the user can read exactly what the model was told. It refreshes in place when the prompt size, custom prompt, or per-chat agent-files toggle changes. The card spans the full transcript width (`.chat-msg--system` uses `align-self: stretch` and cancels the bubble caps — the base `.chat-msg` `max-width: 92%`, the `@media (max-width: 360px)` `max-width: 78%` squeeze, and its own old `max-width: 96%` — so it stays flush edge-to-edge with the sibling full-width transcript children (setup select, tools card, agent-files card, empty state), not a floating chip in an otherwise full-width column. **The body is collapsed by default** behind a one-tap `<details>` disclosure (`› System prompt · N lines`), matching the chevron pattern used by `.models__add` / `.settings__advanced` / `.picker__create`. Tapping the summary expands the body, rendered as a `<pre>` with `white-space: pre-wrap` so the prompt's own line breaks survive unchanged. Without this default, the agent's thousand-line system prompt would push the first real turn off-screen on a phone.
- **Prompt-size control lives in the message area, only at creation time.** The prompt-size choice is a creation-time concern, so it is part of the transcript (the message area) instead of the head (the top bar). On a brand-new chat the transcript's first child is a single full-width `<select class="input chat-view__setup">` with three options: `Very small — tool names only, no parameter schemas, smallest prompt`, `Average — full tools, recommended`, and `Extensive — full tools + best-practice guidance`. The currently resolved profile is marked with the `selected` attribute on its `<option>` so the dropdown reflects state on every re-render (Preact can drop a `<select value=…>` on first mount; toggling `selected` is reliable). A `change` PATCHes `{ promptSize }` and updates the System bubble. As soon as the first message is sent, `updateSetupVisibility()` removes the control from the DOM for the life of the chat — the prompt size is fixed from that point, and the top bar stays clean (no permanent prompt-size widget). There is no prompt-size control in the ⚙ popover anymore.
- **Tool calls render inline, between the turns.** When the model calls a tool (native `shell` or an MCP tool), the `tool_call` SSE event renders a `.tool-card` directly in the transcript, above the streaming assistant reply. The card is a compact, borderless one-line row: a chevron (the tap target's affordance, rotates 90° when expanded), a verb-style label (`Read src/index.js`, `Ran npm test`, `Edited …` — built-in tools map to verbs via `TOOL_VERBS` in `transcript.js`, MCP tools show only the leaf tool name instead of the full `mcp__server__tool` id), a one-line argument summary, and a small status dot on the right (pulsing accent while running, green on ok, red on error; the dot keeps the legacy `.tool-card__pill--*` classes so the streaming code that swaps them is unchanged). Long names and arguments always ellipsize in the header so the row stays inline on mobile. The matching `tool_result` event flips only the dot while the collapsed row stays one line. Tapping the header reveals the full structured result preview (diff, file content, terminal output, …) underneath without adding an extra outer preview panel; preview metadata that duplicates the header is hidden, and the result is scroll-capped to 75% of the viewport. Errors auto-expand. Both records are persisted, rendered again after reopening, and reconstructed into provider-compatible assistant/tool history on the next send.
- **Usage summary at the top, breakdown below each assistant message.** The chat head shows `Context <tokens>` using the latest prompt-token count (the current context size, deliberately not a sum) and `Total <cost>` using the sum of known assistant-turn costs, rendered in `.chat-view__usage-summary` as small as possible (0.6 rem). Each value is a soft accent-tinted pill (label dim / value bold, `1px 7px` padding, `999px` radius, `inset 0 1px 0` highlight on top) so the head reads as a row of status chips. When the provider exposes a remaining credit, a third pill is appended in the success palette so it doesn't read as a third budget number. Each assistant bubble keeps a compact breakdown underneath: `modelId · context <prompt> · output <completion> · cost $0.00012 · 37 tok/s`, rendered in `.chat-msg__meta` at 0.62 rem / 1.3 / `--muted` with tabular numerals so the columns line up. The line is split into a row of individually-classed spans (set in `renderUsageMeta` via `data-token` attributes: `model`, `context`, `output`, `cost`, `rate`): the model id gets a 1 px hairline underline, the cost picks up a soft accent tint at 500 weight, and the live rate (only present while the row carries `data-live="1"`) gets a soft accent→white gradient on the text itself so the value reads as "active" without animating. The `tok/s` value is rendered live: a per-turn counter accumulates a heuristic token estimate from each `message` and `reasoning` delta and is replaced by the upstream's authoritative `completionTokens` on `done`. The summary and current breakdown update during streaming and are reconciled from persisted messages afterward. Older turns without usage remain excluded.
- **Trace follows the chat's `trace` flag.** The chat record in [src/chats.js](../../src/chats.js) already has the field per [docs/decisions.md §5](../decisions.md). When it's on, every event sent to the browser is also written to the trace file. The writer is a no-op when the project is on a read-only filesystem (the directory creation is best-effort) or when the chat has `trace: false`.
- **Long transcripts render progressively, not in one blocking pass.** `renderTranscript` builds every chat bubble and tool card plus a full markdown parse per assistant message. For a long agentic transcript done synchronously that's one long blocking pass that keeps the chat blank and the UI frozen while it runs. Transcripts with ≥ 120 persisted messages now render in chunks: the system prompt, tools card, and first 40 messages paint immediately, then the remaining rows are appended 40 per animation frame until the transcript is complete (see `TRANSCRIPT_CHUNK_ROWS` / `TRANSCRIPT_CHUNK_THRESHOLD` in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js)). The messages are still fetched in a single request — this is purely a rendering concern, so it adds no network latency and needs nothing from the API. While a chunked pass is filling in, `afterTranscriptAppend` suppresses its per-append auto-scroll (see the `refs._suspendScrollPin` guard in [frontend/src/components/chat/scroll.js](../../frontend/src/components/chat/scroll.js)) so the scrollbar isn't yanked down dozens of times; the pass re-pins to the bottom and restores the user's expanded cards once, when it finishes. A rebuild (e.g. the stream-reconcile re-render) cancels any in-flight chunked pass via a module render token, so two overlapping renders never append the same rows twice, and the chat's unmount cleanup cancels a pending chunk so a navigate-away can't write into a detached transcript.
- **The hash router is simple.** Top-level views are `projects`, `inspector`, and `settings`; `chat/<id>` and the project picker are drill-ins. The retired `#/auth` route resolves to Settings for backward compatibility.
- **Models are per-project; providers are app-level.** The chat view reads `/api/ai/models?projectDir=…` for project model IDs. The server resolves credentials from the matching global provider connection only when sending a request.
- **Auto-scroll.** The transcript auto-scrolls to the bottom on new content while the user is pinned to the bottom; scrolling up past a 48 px threshold unpins and a floating `↓ N` button appears instead of yanking the view down. Tapping it (or scrolling back to the very bottom) re-pins. Pinning is per-chat: `useChatState` resets `pinnedToBottom` / `pendingCount` on every `[chatId, projectDir]` change, so navigating from a chat the user had scrolled up in still opens the next chat pinned to its latest messages. A single `scrollTop = scrollHeight` pins against the pre-layout height, so content that reflows a frame or two later (markdown code blocks, tool cards, image decode) could leave the newest row a few pixels below the fold; `pinTranscriptAfterSettle` in [frontend/src/components/chat/scroll.js](../../frontend/src/components/chat/scroll.js) schedules a short, bounded run of rAF checkpoints that re-pin while the content keeps growing and stop once the layout is stable (cancelled on user scroll-up or while a chunked render is in flight).
- **No optimistic re-render on errors.** A 4xx/5xx on the stream endpoint shows in the status line; the live assistant message is replaced with `[error: HTTP <code>]`.
- **Sending while a run is in progress never loses the message.** The server rejects a second concurrent stream on the same chat with `409 EALREADY_RUNNING` *before* persisting the user message. The client handles this in two layers: `send()` bails out early (before clearing the composer) when this tab is already streaming — which also covers the `Enter` key, since it bypasses the disabled send button — and on a `409` (another tab/device owns the run) the optimistic bubble is removed and the text plus image attachments are restored into the composer, with the draft re-persisted. Without the restore, the once-per-second transcript poll would rebuild from disk and the message would silently disappear.

## Per-chat controls

The chat head is intentionally minimal so the message area gets every spare pixel on a phone. Row one is the compact chrome row: back / title+meta / settings / rename / delete. Row two is the **model picker trigger** (`.chat-view__model-trigger`), a single full-width button that shows the active model id on top and the provider id underneath. It opens the **model picker popover** (see "Model picker" below). A small ↻ refresh button sits flush right of the trigger so the head stays on two lines and the transcript is never pushed off-screen on a 360 px viewport. The Trace + Prompt controls live in a small popover anchored to the ⚙ button; tapping the button toggles the popover, tapping outside or pressing Escape closes it. Keeping these in a popover (instead of a fixed row under the head) reclaims vertical space for the transcript. The prompt-size choice is not in the head at all — it lives in the message area as a full-width `<select>` shown only on a brand-new chat (see "Behavior" above).

- **Model picker** — the head's second row opens a popover anchored to the trigger button. On narrow phones the popover takes the full viewport width with a top margin (a near-full-screen sheet) so a long OpenRouter list is usable; on wider screens it falls back to a floating popover anchored to the model row. Contents, top to bottom:
  1. **Header row** — a search input (`<input type="search">`, auto-focused on open), a ↻ refresh button (fans the live catalog out to every configured provider in parallel), and a `×` close button.
  2. **Filter chips** — one chip per provider plus an `All` chip. Each chip shows a live count of how many models the picker knows about for that provider, so the user can see at a glance that OpenRouter has 342 entries and OpenAI-compatible has 0 without opening them. Default is `All`; tapping a chip filters the list to that provider and persists the filter for the next open.
  3. **Model list** — sections, one per provider, with a sticky uppercase header showing the provider id and a section count. Rows are the model id, the upstream label (if it differs from the id), and a small provider tag on the right. The active selection is highlighted with the accent background. If the chat references a model that's no longer available in the live catalog and is hidden by the current filter, the picker adds a virtual "ghost" row at the top of the active-provider section so the user can see what's still saved and either re-pick or close the picker without losing context.
  4. **Empty states** — `no matches` (search returned nothing), `no <provider> models — tap ↻` (filter is too narrow), or `no models — tap ↻` (catalog is empty). Tapping the head's ↻ button (or the picker's) fires `GET /api/ai/models/live?provider=<id>` in parallel for every configured provider and re-renders the list as each call resolves. The status line shows `refreshing models…` while the call is in flight, then `models: N` (or `models: N (M failed)` if any provider returned an error) on success. Typed error codes (`ENO_APIKEY`, `EUNREACHABLE`, `EABORTED`, `EUPSTREAM`, `ENO_LIST`) are mapped to a one-line actionable pill the same way the old refresh button did.
  The trigger label is the chat's `modelId` (with `providerId` as a sub-line); selecting a row calls `PATCH /api/chats/:id` with `{ providerId, modelId }` and the trigger label updates in place. Closing the popover (outside-click, Escape, or `×`) preserves the search query and the active filter chip across re-opens.

  The data feeding the picker is the union of the per-provider live catalog (`GET /api/ai/models/live`) and the project-level models array (the legacy `models` field in `.mouaif.json`), deduped by `(provider, id)` with project entries winning. A live selection is sent as `{ modelId, providerId }`; the server hydrates it from the matching app-level connection without persisting hundreds of catalog entries into `.mouaif.json`.

  See [docs/features/model-picker.md](./model-picker.md) for the picker's empty-state card, keyboard navigation, and the active-row accent rail.
- **⚙ Settings** — opens the settings popover. Inside:
  - **Prompt** — optional custom prompt for this chat, populated from `GET /api/prompts`. `PATCH` with `{ promptId }`. Layered on top of the profile; the system-prompt card refreshes to show it appended.
  - **Trace to file** — checkbox. `PATCH` with `{ trace: bool }`. The only per-chat control still surfaced on the meta line (`trace on`, or nothing when off), because it has no other on-screen indicator. The trace writer in [src/trace.js](../../src/trace.js) is already gated on `chat.trace`, so flipping this on mid-conversation starts writing `<projectDir>/.mouaif/traces/<chatId>.ndjson` from the next event.
  - **Export trace** — one-shot `POST /api/chats/:id/trace/export`. It exports the stored transcript immediately without changing the toggle.
- **Tools card** — a collapsible card below the system-prompt message groups every available tool (Shell, Subagent, Ask user, File tools, and one row per MCP server). Each group row carries a visibility checkbox (on the left) and a **Off / Ask / Allow authorization segment** (on the right), matching the same control pattern as the project settings page. The segment writes through `PUT /api/tools/authorization` immediately on tap; the card re-renders in place to reflect the new mode. MCP rows write the layered `.mcp.json` authorization: each server row is that server's override (`mcp.servers.<slug>`) showing the effective mode, with a ↺ reset when overridden. The per-chat visibility filter (which tools are exposed to the model for this chat) is separate from the project-level authorization mode (who decides whether a call is approved). Both controls live side by side on the same row, with the authorization segment pushed to the right edge via `tool-tree__control`.
- **Tool turns** — shell, file, and subagent calls all render with the same compact collapsed row: chevron, verb-style label, optional summary, and status dot. A running subagent stays collapsed by default like the other tools; tapping the header expands the standard body and shows live nested progress. Every other tool call (`read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `task`, MCP tools) carries a placeholder body while it runs — a "Running…" hint plus the full argument payload (the header only shows a 220-char truncation) — so expanding a card mid-call never shows a blank area. The `tool_result` renderer clears the placeholder in place when the result lands.
- **✎ Rename** — `prompt()` for a new title, `PATCH /api/chats/:id` with `{ title }`. The visible title updates immediately on success; the chat list in the project card refreshes on next render.
- **× Delete** — `confirm()` then `DELETE /api/chats/:id?projectDir=…`. Bumps `projectsReload` so the project card refetches, and navigates back to `#/projects`. The on-disk transcript is removed and the project's `.mouaif.json` loses the chat entry. The trace file is deliberately kept because it is an independent, user-owned export per [docs/decisions.md §5](../decisions.md).

All `PATCH`-style controls share a single `updateChat(patch)` helper. On success it overwrites the local `chat` record with the server's response, which is the single source of truth for the head's title, the (trace-only) meta line, and the popover's controls. The prompt-size switch and the custom-prompt handler additionally re-fetch `GET /api/chats/:id/system-prompt` and re-render the system-prompt card (the switch also re-fetches the tool preview). On failure the status line shows the HTTP code and nothing on the page changes.

## Composer

The chat view is a full-height flex column: the head and composer are fixed-height (`flex: 0 0 auto`) and the transcript in between flexes (`flex: 1 1 auto; min-height: 0`) and scrolls internally. This keeps the composer pinned to the bottom and stops the last message from being hidden behind it — the transcript scrolls, not the page. The shell (`.app__shell`) is bounded to `100dvh` and the drill-in main region (`.app__main--flush`) is a bounded flex column so the internal scroll works.

**On-screen keyboard.** The shell (`.app__shell`) is bounded to the dynamic viewport (`height: 100vh; height: 100dvh;` in [frontend/src/layout.css](../../frontend/src/layout.css)) and the safe-area insets live on the shell, not on `<html>`/`<body>` — html/body are locked to the viewport (`height: 100%; overflow: hidden` in [frontend/src/base.css](../../frontend/src/base.css)) so the document can never itself become a scroll container that competes with the transcript. The composer sits in the shell's flex column, so when a browser shrinks the layout viewport for the keyboard (`interactive-widget=resizes-content` on Chromium) `100dvh` already reflects the visible height and the composer rides up with it. No `--kb-inset` JS measurement is needed at the shell level. The model picker, by contrast, is a fixed-position sheet that must hug the *visual* viewport, so it measures `window.visualViewport` and publishes `--model-picker-viewport-height` / `--model-picker-viewport-top` on its own element (see [`model-picker.md`](./model-picker.md)).

The composer is a floating rounded rectangle (`1.25rem` radius, `--surface-2` background, `margin: 6px 10px 0`) holding a single horizontal row: a files button, an image button, an auto-growing `<textarea>`, and a 32 × 32 px round send button. Its rounded corners visually follow the send button without becoming a full pill as the textarea grows across multiple lines, while asymmetric inset padding keeps the send button close to, but fully inside, the right border. The file editor is lazy-loaded only after tapping the files button, and its browser treats common text formats including PowerShell scripts (`.ps1`, `.psm1`, `.psd1`) as editable text instead of disabled binary rows. The status line lives **below** the pill, outside it. `Enter` sends; `Shift+Enter` inserts a newline. The textarea's height is reset to `auto` on every `input` event, then set to `Math.min(120, Math.max(32, scrollHeight))`. After a send it collapses back to its 32 px single-line height. The textarea's font size is `1rem` (16 px) so iOS Safari does not auto-zoom on focus. The send button is `disabled` while the composer is empty (no text and no attached images); typing, restoring a draft, or attaching an image enables it, and clearing the composer disables it again.

The status line carries the bottom safe-area inset via **padding** (`padding: 2px 0 calc(var(--safe-bottom) + 6px)`), not margin, so the space is reserved even when the status is empty — keeping the composer flush with the bottom of the view instead of floating above the home-indicator area with a gap. When the status is empty the text collapses (`font-size: 0`) but the safe-area padding remains.

On narrow phones the composer keeps its 10 px side margin and the textarea has a little more internal side padding (4 px) so typed text does not press against the rounded pill edge.

## Implementation notes

When a chat page is reloaded while an agent run is still active on the
server, the replacement page polls the persisted transcript once per second.
New assistant segments, tool calls, and tool results therefore appear as they
are saved, without requiring another manual reload. A tab that owns the live
SSE stream does not poll over its in-progress rendering. The server-side run is
not cancelled just because the browser's SSE connection closes; stream writes
are best-effort and the persisted transcript remains authoritative.

Each model tool round-trip has an explicit `assistant_turn_end` SSE boundary.
Text emitted before a tool call is finalized in its own assistant bubble, the
tool call and result follow it, and subsequent model text starts a new bubble.
Blank assistant boundaries are skipped, so a tool-only round does not create an
empty chat bubble. This preserves the real assistant → tool → assistant order
both live and after reopening the chat.

Tool-card rendering is isolated from the network reader. A malformed or
unsupported tool payload can fail to render without aborting the remaining SSE
stream or suppressing the assistant response that follows the tool result.

When authorization is required, the authorization card is emitted before the
tool-call card. The call appears as “running” only after approval; denial or a
disabled tool still produces an adjacent call/result pair. This avoids leaving
a misleading permanent “running” card while execution is waiting for input.

After a streamed exchange completes, the browser reconciles the rendered turn
with the server transcript. The persisted transcript is authoritative, so a
missed or failed live DOM update cannot leave the screen ending on a tool card
when the post-tool assistant message was successfully stored.

A message sent while the chat is already running is never persisted by the
server (`409 EALREADY_RUNNING`). The send path in
[frontend/src/components/chat/stream.js](../../frontend/src/components/chat/stream.js)
treats that status specially: it drops the optimistic bubble, restores the
composer (text, attachments, and the debounced draft), and shows a busy status
instead of an error card, so the same-disk poll cannot wipe the message.

- Build: [frontend/vite.config.js](../../frontend/vite.config.js), `frontend/index.html`, [frontend/src/main.jsx](../../frontend/src/main.jsx), [frontend/src/style.css](../../frontend/src/style.css), [frontend/src/virtual-list.js](../../frontend/src/virtual-list.js). Vite emits hashed assets under `frontend/dist/assets/`. Current production output is about 69 KB JS + 26 KB CSS, about 22 KB + 5 KB gzipped.
- Server: [src/index.js](../../src/index.js) → `handleChats()` now also handles `/api/chats/:id/messages[/:action]` and delegates the stream to `handleChatStream()`. The static `/` route prefers `frontend/dist/`, falls back to `frontend/` for dev.
- Messages: [src/messages.js](../../src/messages.js) — per-chat file `<projectDir>/.mouaif.messages.<chatId>.json`. Robust read (drops malformed entries), throws `MOUAIF_PROJECT_PARSE_ERROR` (422) only if the file itself is corrupt.
- Trace: [src/trace.js](../../src/trace.js) — per-chat NDJSON writer, no-op when `chat.trace` is false or the directory can't be created.
- Bottom nav: Projects / Inspector / Settings. Settings contains provider connections, provider authentication, and the raw project-settings editor.
- Dropped (intentionally): the previous `AI test` panel and the `Virtual list demo`. They were dev-time affordances; the chat view replaces the AI test, while the Inspector now consumes the virtual-list primitive.

## Related

- Per-chat trace concept: [docs/decisions.md §5](../decisions.md).
- AI proxy that powers the stream: [docs/features/ai-client.md](./ai-client.md).
- Per-project chat bookkeeping: [docs/features/project-card.md](./project-card.md).
- Provider authentication: [docs/features/auth.md](./auth.md).
- The virtual-list primitive: [docs/features/virtual-list.md](./virtual-list.md). It lives at `frontend/src/virtual-list.js` and powers the Inspector Console and Network panels.
