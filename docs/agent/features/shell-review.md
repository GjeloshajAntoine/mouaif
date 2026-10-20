# Shell review — a second model reads a command before it runs — implementation notes

> Agent-facing reference for [`docs/features/shell-review.md`](../../features/shell-review.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### Sources

| Path | Role |
| --- | --- |
| `src/shellReview.js` | Everything server-side: normalization, request shape, the one-shot review, the dedupe/automatic path, pricing. |
| `src/settings.js` | `DEFAULTS.shellReview = { mode: 'off' }` — the resolved floor. |
| `src/ai-stream.js` | Starts the automatic review before the authorization gate for a `shell` call. |
| `src/tools/authorization.js` | `attachReview` / `listPending` carry the verdict on the parked approval request. |
| `src/live-chat.js` | Buffers the `shell_review` frame with the approval prompt it belongs to. |
| `src/server-handlers-chat.js` | Fans `shell_review` into `liveChat.pushLive`. |
| `src/server-handlers-tools.js` | `POST /api/tools/shell/review`. |
| `frontend/src/components/chat/shellReview.js` | `shellReviewFromResolved`, `verdictMeta`, `buildReviewBlock`, `applyReviewToCard`. |
| `frontend/src/components/chat/ShellReviewSheet.jsx` | The on-demand sheet (lazy chunk). |
| `frontend/src/components/chat/ToolPopup.jsx` | The **Review a command** action row. |
| `frontend/src/components/ShellReviewPage.jsx` | The Shell review page (`settingsProjectShellReview`): mode, catalog picker, provider select, model-id field with catalog suggestions, prompt, and a Check model action. |
| `frontend/src/components/chat/cards.js` | Renders `request.review` in the approval card. |
| `frontend/src/components/chat/transcript.js` | `handleShellReviewEvent` folds a frame into the card by call id. |

### Module surface

```js
// src/shellReview.js
normalize(raw)                     // -> { mode, providerId, modelId, prompt }
configured(raw)                    // -> boolean (mode !== off && providerId && modelId)
buildMessages({ prompt, cmd, cwd }) // -> [system, user]
clampCommand(cmd)                  // caps at MAX_COMMAND_CHARS, announces the cut
parseReview(text)                  // -> { text, verdict } (last SAFE|CAUTION|DANGER word)
resolveReviewModel(projectDir, cfg) // -> hydrated model record (throws EBADINPUT)
reviewCommand(opts)                // -> Promise<review>; NEVER throws
shouldAutoReview(projectDir)       // -> boolean (mode === 'always' && configured)
attachReviewToPending(...)         // best-effort bridge to the authorization module
startReview(opts)                  // -> null | Promise<review>; dedupes by call id
REVIEW_MODES, DEFAULT_PROMPT, REVIEW_TIMEOUT_MS, REVIEW_DEDUPE_MS
```

`reviewCommand` resolves `{ ok: false, code, error }` for every failure (`EBADINPUT`, `EREVIEW_OFF`, `EREVIEW_MODEL`, `EABORTED`, `ETIMEOUT`, `EEMPTY_REVIEW`, upstream codes). Nothing in the approval path awaits it, so a slow reviewer cannot delay the prompt; the card opens first and the verdict fills in.

### Why the review is started before the gate

The approval card is what the user reads before deciding. Starting the request *before* `authorize()` means the reviewer runs while the prompt is being rendered and answered, so a verdict that takes a second or two is usually already there when the user looks. The request is fired and not awaited; `authorize()` blocks on the user, not on the reviewer.

The alternative — review after approval — would produce a verdict about a command that has already run, which is the wrong question.

### Why `noTools`

`streamChat` advertises the whole native + MCP tool surface by default. `opts.noTools` empties it (after the `off` gates, before the per-chat filter), so the request carries no `tools` field at all. Without it the reviewer could call `shell` — acting on the command it was only asked to read.

### Dedupe

`startReview` keys on the tool call id. The gate and the dispatcher would otherwise both ask for the same call's review, doubling the bill and racing two frames with the same id. `REVIEW_DEDUPE_MS` (5 min) keeps a settled entry long enough for the dispatcher's follow-up to reuse it; the map is swept on the next start rather than on a timer.

### Delivery

1. `onEvent('shell_review', { id, cmd, ...review })` on the chat stream.
2. `liveChat.pushLive` buffers it (see `eventToolId` — keyed by `data.id`) so a late subscriber and the reconnect poll replay it; `pruneLive` drops it with the call's other transient frames once the result is persisted.
3. `attachReview` stores it on the pending entry, so `GET /api/tools/pending` (via `listPending`) re-delivers it after a reload; `pending.publicResult` and `pending.request` are kept in sync so both reads agree.
4. The client applies it in place: `applyReviewToCard` replaces an existing `.tool-card__review` or inserts one above the card body's first child. `data-awaiting-review` on a shell approval card records that the card is waiting; `handleShellReviewEvent` clears it.

### Cost

Priced through `src/usage.js` `computeCost` with the reviewer's own model record. `POST /api/tools/shell/review` attributes a known cost to `chatId` through `messages.addChatCost` — the same "priced run that is not a chat turn" rule dictation follows. The automatic path does not attribute: the parent turn's own `done` already bills the chat, and the reviewer's usage is not part of the chat model's usage block. (Adding it would double-count on any future per-turn reconciliation.)

### The page, not a section

The feature first shipped as a section of Project settings with only the
catalog picker. That left two inputs missing: there was no way to name a
**provider** and a **model id** explicitly, so a model the picker did not list
(a live slug after a catalog failure, a local alias, an Azure deployment) could
not be configured at all. It is now its own route,
`settingsProjectShellReview` (`#/settings/project/shell-review`), rendered by
`frontend/src/components/ShellReviewPage.jsx` and lazy-loaded like its
siblings.

Save policy:

| Control | Commit |
| --- | --- |
| Mode | Immediately on change (a closed choice; leaving it unsaved misreports whether reviews happen). |
| Catalog picker | Immediately, filling provider + model id. |
| Provider, model id | Locally, committed by **Save model** or on the id field's blur. |
| Prompt | Locally, committed by **Save prompt**. |

Every write sends the complete `{ mode, providerId, modelId, prompt }` object.
The server stores `shellReview` as one value, so a partial write would be a
client-side read-modify-write with no guarantee both halves came from the same
snapshot. The project page no longer edits any of it — its link row reads
`shellReviewFromResolved()` from the resolved settings and prints the
consequence (`off`, `no model yet`, or `<mode> · <model id>`).

A provider whose connection was removed stays in the select, labelled
*(not configured)*, and the page shows a warning rather than silently rewriting
the stored id: the value is still valid config, and it starts working the moment
the connection is added back.

**Check model** calls `POST /api/ai/test` with the named pair. The route
resolves a live-catalog model too (it takes `providerId`), so checking does not
require the model to be saved in the project's `models` list.

### Tests

- `scripts/test-shell-review.js` — normalization, request shape, verdict parsing, the CLI-shaped failures, dedupe, pending attachment, and the REST route.
- `scripts/test-shell-review-ui.mjs` — the shared choice model, the settings section's complete-block writes, the verdict block, and the popup/sheet wiring.
- `scripts/test-routes.js` pins `#/settings/project/shell-review` as a real route with the same `projectDir`/`chatId`/`from` context as its siblings.
- `scripts/test-project-settings-render.mjs` / `scripts/test-settings-back.mjs` assert the project page's link row points at that route.
