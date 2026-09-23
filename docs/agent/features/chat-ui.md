# Chat UI — Preact + Vite mobile shell — implementation notes

> Agent-facing reference for [`docs/features/chat-ui.md`](../../features/chat-ui.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## HTTP (chat-aware)

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ messages: [{ role, content, ts }] }` (422 on corrupt file) |
| POST   | `/api/chats/:id/messages` | `{ projectDir, role, content }` | `{ message }` (201) |
| DELETE | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ ok: true, removed }` |
| POST   | `/api/chats/:id/messages/stream` | `{ projectDir, modelId, providerId?, content }` | **SSE stream** of `message` / `done` / `error` events; `providerId` resolves live-catalog models that are not stored in the optional project `models` array. |
| GET    | `/api/ai/models?projectDir=<abs>` | — | `{ models: [{ id, provider, label, auth }], providers: [..] }` — project-level model list (the `models` array in `.mouaif.json`). |
| GET    | `/api/ai/models/providers` | — | `{ providers: [{ id }] }` — configured app-level provider connections, with no credentials. |
| GET    | `/api/ai/models/live?provider=<id>` | — | `{ models: [{ id, label, contextWindow? }], fetchedAt, cached }` — live catalog from the upstream `/models` endpoint (or curated for Anthropic/Copilot). Cached 1h per `provider:credHash`. 400 on unknown provider; 502 `{ error, code: 'EUPSTREAM' }` on upstream failure; 8 s `AbortController` timeout. |

## Build and Dev

```bash
npm install         # prepare builds frontend/dist/ when it is stale
node bin/mouaif.js serve
```

`npm run build:web` still exists for an explicit rebuild (and is what `prepack`
and `prepublishOnly` call). The install path no longer needs it — see
[docs/agent/features/cli-commands.md](./cli-commands.md).

Dev with HMR:
```bash
npm run dev:web      # vite dev server on :5173 (not used by the Node server)
```

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

Call and result cards are keyed by one shared `data-tool-id`. Because not every
provider echoes a tool-call id — and a few internal call sites pass `id: null` on
purpose (a subagent that failed to start, a tool or MCP error result) — the
call card mints an id and parks it in `refs._anonToolCalls`;
`appendToolResultCard` adopts a parked id when the result carries none of its
own, preferring the entry whose tool name matches, and never reusing an entry
whose card has left the tree. Both sides previously minted an independent random
id in that case, so the result could never find the call card: the transcript
grew a duplicate result card and the call card stayed on “Waiting for
results…” forever. `scripts/test-tool-call-id-matching.js` covers this.

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
[frontend/src/components/chat/stream.js](../../../frontend/src/components/chat/stream.js)
treats that status specially: it drops the optimistic bubble, restores the
composer (text, attachments, and the debounced draft), and shows a busy status
instead of an error card, so the same-disk poll cannot wipe the message.

Image attachments are also persisted as a chat-level draft. `chat_store`
carries a `draft_attachments` column (JSON array), written alongside the text
`draft` field. The composer restores it on reopen and clears it after a send.

- Build: [frontend/vite.config.js](../../../frontend/vite.config.js), `frontend/index.html`, [frontend/src/main.jsx](../../../frontend/src/main.jsx), [frontend/src/style.css](../../../frontend/src/style.css), [frontend/src/virtual-list.js](../../../frontend/src/virtual-list.js). Vite emits hashed assets under `frontend/dist/assets/`.
- Server: [src/index.js](../../../src/index.js) → `handleChats()` handles `/api/chats/:id/messages[/:action]` and delegates streaming to `handleChatStream()`. The static `/` route prefers `frontend/dist/`, falls back to `frontend/` for dev.
- Messages: per-chat storage in SQLite database `~/.mouaif/store.sqlite`.
- Trace: [src/trace.js](../../../src/trace.js) — per-chat NDJSON writer (`<projectDir>/.mouaif/traces/<chatId>.ndjson`), no-op when `chat.trace` is false.
- Bottom nav: Projects / Inspector / Settings.

### Spacing in the chat head and composer
- The head's vertical rhythm is even, measured at 360 px: title text → usage chips **9 px**, chips → model selects **10 px**, selects → divider **7 px**. It used to read 15 / 4 / 4, which is why the chips looked glued to the model row.
  - `.chat-view__head` owns it: `gap: 2px 4px`, `padding: 0 8px 6px`. The model row used to carry `margin: -6px 0 6px` to tuck it under the chips; because the title/icon row is taller than the chips line, that negative margin made the two rows **overlap** (the model row started 5 px inside the icon column and 3 px inside the title stack).
  - `.chat-view__chat-switcher-trigger` is `--tap-sm` (32 px), not `--tap`. The title is 16 px of text, so a 44 px box carried 14 px of invisible padding: the text stayed put (the stack is centred in the 66 px icon row either way) but the chips were pushed 12 px down into the model row. Same size as the gear and globe beside it; the box is 260 px wide.
- `.chat-view__composer-row` uses `align-items: center`. The file-toolbar trigger is a 44 px target whose painted circle is 40 px (2 px `::before` inset), and the composer pill is 40 px: bottom-aligning them left the circle 2 px above the pill on both edges. Centering puts the painted circle exactly on the pill's centre line (verified: both at y 724–764 on a 360 px viewport) and keeps it centred while a multi-line draft grows the pill.
- Chrome reports `.webpreview-dock` at 94 × 176 for a 375 × 812 capture with the height cap on `.webpreview-dock__image` (`max-height: min(24dvh, 11rem)`, `object-fit: cover`, `object-position: top`). The cap must be on the image: a `max-height` on the flex item clamps the card's box while the percentage-height image keeps its intrinsic height and overflows.

### Transcript

Detaching a turn is detected from the abort signal itself, not only from a thrown `AbortError`. The read loop also re-checks the mounted `projectDir`/`chatId` before every read, so a switch that lands between two reads unwinds the loop without throwing; both paths converge on the same silent detach and skip the finalize step that would otherwise append the abandoned chat's partial assistant turn to `state.messages` and reconcile the new chat against the old chat's cursor.

Per-chat state that is normally seeded by the chat load — the backward-pagination cursor, the transcript append cursor, and the live replay cursor — is reset by a dedicated effect on every `projectDir`/`chatId` change, so a failed or superseded load cannot leave the previous chat's cursor driving the next chat's fetches. The chat load re-checks its `cancelled` flag after its last `await` (the tool-authorization fetch), so a load that is still in flight when the user switches away cannot overwrite the incoming chat's composer, thinking level, meta line, provider credit, or model picker.

The composer is also reset per chat. `ChatView` is reused across navigation rather than remounted, so the outgoing chat's text and image attachments are flushed to that chat (an explicit chat-scoped `PATCH`, because `state.props` already points at the new chat by then) and the field is cleared before the incoming chat's saved draft is applied. This keeps a typed message from being saved as another chat's draft, and lets the new chat show its own draft.

The chat switcher preloads its first page per `projectDir`/`chatId` and resets its pager only when that identity changes. A `runningVisible` flip — which happens at both ends of every turn — re-fetches the newest page and merges it over the rows already on screen, instead of replacing the list, so pages the user scrolled in are never discarded. A page callback that finds its pager has been replaced still clears the loading flag, so "Loading more…" cannot stay on screen after a project switch.

Composer autosaves remain debounced. Draft-only PATCH responses update only saved text/attachment metadata: they do not rebuild the model picker, repaint the header, or fetch provider credit. A late draft acknowledgement cannot replace an in-progress model selection with an older server snapshot. Mixed metadata updates and explicit model changes retain their normal refresh behavior.

The transcript observes DOM mutations and geometry changes for both its viewport and direct message rows. Geometry changes re-pin only when the reader is already at the bottom; scrolling up disables automatic movement so reading history is not interrupted.

The chat listens for `visibilitychange`, `pageshow`, and window `focus`. Resume signals are coalesced into one incremental revision sync, covering ordinary tabs, page-cache restores, and standalone mobile PWA foregrounding without reloading the full page.

### Regression checks

Run the focused reliability/performance checks with:

```bash
npm run test:chat-view
```

This suite covers send preparation failures, cursor-aligned total costs, batched transcript scrolling, and draft-only saves. It also runs as part of `npm test`.
