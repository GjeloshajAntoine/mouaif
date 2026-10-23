# Shell review — implementation notes

> Agent-facing reference for [`docs/features/shell-review.md`](../../features/shell-review.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### Sources

| Path | Role |
| --- | --- |
| `src/shellReview.js` | Everything server-side: normalization, model resolution (chat/app model by default), request shape, the one-shot review, the dedupe/automatic path, auto-allow on `SAFE`, pricing. |
| `src/settings.js` | `DEFAULTS.shellReview = { mode: 'off' }` — the resolved floor. |
| `src/ai-stream.js` | Starts the automatic review when `authorize()` returns `decision === 'prompt'` for a `shell` or `group_cli` call, passing `fallbackModel: opts.model`. |
| `src/tools/authorization.js` | `attachReview` / `listPending` carry the verdict on the parked approval request; `recordDecision(..., 'allow-once')` resolves the parked wait when `autoAllow` approves a `SAFE` command. |
| `src/live-chat.js` | Buffers the `shell_review` frame with the approval prompt it belongs to. |
| `src/server-handlers-chats.js` | Fans `shell_review` into `liveChat.pushLive`. |
| `src/server-handlers-tools.js` | `POST /api/tools/shell/review` and auto-review on `POST /api/tools/shell`. |
| `frontend/src/components/chat/shellReview.js` | `shellReviewFromResolved`, `verdictMeta`, `buildReviewBlock`, `applyReviewToCard`. |
| `frontend/src/components/chat/ShellReviewSheet.jsx` | The on-demand sheet (lazy chunk). |
| `frontend/src/components/chat/ToolPopup.jsx` | The **Review a command** action row. |
| `frontend/src/components/ShellReviewPage.jsx` | The Shell review page (`settingsProjectShellReview`): mode, auto-allow on Ask toggle, and review prompt. |
| `frontend/src/components/chat/cards.js` | Renders `request.review` in the approval card. |
| `frontend/src/components/chat/transcript.js` | `handleShellReviewEvent` folds a frame into the card by call id. |

### Module surface

```js
// src/shellReview.js
normalize(raw)                     // -> { mode, providerId, modelId, prompt, autoAllow }
configured(raw)                    // -> boolean (mode !== 'off')
buildMessages({ prompt, cmd, cwd }) // -> [system, user]
clampCommand(cmd)                  // caps at MAX_COMMAND_CHARS, announces the cut
parseReview(text)                  // -> { text, verdict } (last SAFE|CAUTION|DANGER word)
resolveReviewModel(projectDir, cfg, opts) // -> hydrated model record (uses chat/app model by default)
reviewCommand(opts)                // -> Promise<review>; NEVER throws
shouldAutoReview(projectDir)       // -> boolean (mode === 'always' && configured)
attachReviewToPending(...)         // best-effort bridge to the authorization module
startReview(opts)                  // -> null | Promise<review>; dedupes by call id and auto-allows SAFE when autoAllow !== false
REVIEW_MODES, DEFAULT_PROMPT, REVIEW_TIMEOUT_MS, REVIEW_DEDUPE_MS
```

`reviewCommand` resolves `{ ok: false, code, error }` for every failure (`EBADINPUT`, `EREVIEW_OFF`, `EREVIEW_MODEL`, `EABORTED`, `ETIMEOUT`, `EEMPTY_REVIEW`, upstream codes). Nothing in the approval path awaits it unless auto-allowing on direct `/api/tools/shell`; in the chat stream the approval card opens immediately and if `autoAllow` is enabled and the verdict is `SAFE`, `recordDecision(projectDir, chatId, callId, 'allow-once')` resolves `authResult.wait` automatically so the command runs right away.

### Model resolution

By default, `resolveReviewModel(projectDir, config, opts)` uses the same model as the rest of the app:
1. Optional `config.providerId` + `config.modelId` pin on `shellReview` (if present).
2. `opts.fallbackModel` (passed from `ai-stream.js` as the active chat turn's model).
3. The chat's stored `modelId` + `providerId` (looked up via `opts.chatId` or the most recent chat in the project).
4. The project's first saved model (`resolved.models[0]`), or the most recently used app model (`settings.getRecentModels()[0]`).

### Auto-allow on Ask

When the shell tool is set to `Ask`, `authorize()` parks a pending entry and returns `{ decision: 'prompt', wait }`. When `shellReview.mode === 'always'`, `startReview` runs the review in parallel. If the review succeeds with `verdict === 'SAFE'` and `config.autoAllow !== false`, `startReview` calls `authz.recordDecision(projectDir, chatId, callId, 'allow-once')`, which settles `authResult.wait` and lets the tool loop execute the command immediately while attaching the review (`autoAllowed: true`, rendered as `Safe · Auto-allowed`) to the shell card. `CAUTION`, `DANGER`, or any failed review leaves the approval card waiting for the user.

### Tests

- `scripts/test-shell-review.js` — normalization, chat/app model fallback, request shape, verdict parsing, auto-allow on `SAFE` when CLI is set to `Ask`, `CAUTION`/`DANGER` staying parked on pending approval, dedupe, and the REST route.
- `scripts/test-shell-review-ui.mjs` — the shared choice model, `ShellReviewPage` (mode, auto-allow toggle, debounced prompt), verdict block, and popup/sheet wiring.
- `scripts/test-routes.js` pins `#/settings/project/shell-review` as a real route with the same `projectDir`/`chatId`/`from` context as its siblings.
- `scripts/test-project-settings-render.mjs` / `scripts/test-settings-back.mjs` assert the project page's link row points at that route.
