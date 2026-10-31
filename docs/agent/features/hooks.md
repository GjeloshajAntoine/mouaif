# Hooks — implementation notes

> Agent-facing reference for [`docs/features/hooks.md`](../../features/hooks.md).

- `src/hooks.js` validates hooks, stores them app-level under the `hooks` key (`{ enabled, list }`), matches them (tool globs, tool family via `authorization.configToolName` plus `mcp`, the argument regex in a worker thread, origin) and runs commands: `spawn` with an allowlisted environment, stdin JSON, 64 KB stdout / 16 KB stderr caps, a process-group kill on timeout or abort, priority lowered with `os.setPriority`. `runHooks(event, payload, ctx)` returns `{ decision, reason, by, args?, context?, followUps[], suppress?, notes[] }`. Per event it keeps only what that event may do (`BLOCKING_EVENTS`, `CONTEXT_EVENTS`, `followUp` on `turn.end`, `suppress` on `attention`) and sends only that event's `EVENT_FIELDS`. Node scripts are written as `hook.js` in a fresh temp folder so Node detects CommonJS or ESM.
- A note for a hook that changed arguments carries `changedArgs: true` and `changes: [{ key, before?, after? }]` (top-level keys, values as text clipped to 2000 chars); rows saved before that keep a whole `before` object, which the card still shows.
- `src/ai-stream.js` `runSingleToolCall` runs `tool.before` after the forged-call and tool-surface checks and before the circuit breaker and `authorize`; `ask` sets `forcePrompt`, so session grants and Allow do not skip the card. Rewritten arguments of a parent-only orchestration tool are checked again with `validateControl`. `tool.after` runs before `tool_result` is emitted; background subagent results, which land later, run no `tool.after`.
- `src/hookTurns.js`: `fireTurnStart`, `fireTurnError`, `fireTurnEnd(t, { startTurn, isRunning })`. `runChatStream` calls them without awaiting: `turn.start` after the run marker is set, `turn.error` on each failure and Stop path, `turn.end` after the run marker is cleared on success, with `text` read from the assistant rows saved after the turn's user row (`assistantContent` only holds the last segment), tail-kept at 16 KB. A follow-up goes through `startChatTurn(body, lifecycle, sessionToken)` with `origin: { kind: 'hook', hookId, depth, run }`; depth ≥ 3 → not started (`limit`), chat running or `EALREADY_RUNNING` → dropped (`busy`). Outcomes go to the run log. `messages.normalizeOrigin` keeps the `hook` origin; it does not reset upstream context the way schedule/webhook origins do.
- `attention`: `attention-push.notifyAttention` (approval, ask_user) and `sendChatPush('completion')` in `runChatStream` run the hooks first when `hooks.hasHooks('attention')`, and send unless one returns `suppress`. With no attention hook the push stays synchronous.
- Per-chat hooks: `src/chatHooks.js`, table `chat_hook (project_dir, chat_id, hook_id, entry, created_by, created_at, status, position)`, max 20 per chat. `runHooks` appends `chatHooks.active(projectDir, chatId)` (marked `scope: 'chat'`) after the app list; the app master switch and `MOUAIF_NO_HOOKS` cover them. New ids avoid app hook ids. `promote` appends to the app list, then removes the chat row. The chat DELETE route calls `removeChat`.
- Model tools: `src/tools/hooks.js` (`hook_create`, `hook_list`, `hook_delete`; mouaif family). `runSingleToolCall` sets `forcePrompt` for `hook_create` and builds the card's summary with `describe(args)`. A request that fails `draft()` is answered with `EBADINPUT` before any card. The card's decision payload carries `hookScope`, and the runner takes the lower of the request and the pick; no payload = `chat`. Specs are not pushed for nested subagents, and the runner refuses them with `EPARENT_ONLY`. `hooks.HOOK_TOOLS` are skipped by tool events in `runHooks`.
- Run log: `hook_run` table in the app DB (`logRun`, `listRuns`), one row per executed hook plus one per follow-up outcome, pruned to the last 200.
- `src/server-handlers-chats.js` `runChatStream` runs `prompt.submit` after the running-chat check and before the user row is saved, then checks again that no other run started. A block returns `409 { code: "EHOOK_BLOCKED", error, hook }`. MCP App messages pass `hookOrigin: 'app'` through `startChatTurn`.
- Rows keep `hooks: { notes, context? }` in the `hooks` column of `message_store` (user rows and tool result rows). `messages.withHookContext` appends `context` when history is rebuilt upstream. The stream sends `prompt_hooks { clientId, seq, hooks }` so the open page shows a prompt's context block at once.
- `hooks` is not in `CLIENT_SETTINGS_KEYS`: `update_settings` cannot write it, and `PUT /api/settings/app` refuses it. The routes below are the only way in, behind the normal session and access gates:

```
GET  /api/hooks                              -> { enabled, list, events, origins, families, shells, disabledByEnv }
GET    /api/chats/:id/hooks?projectDir=                 -> { hooks: [{ hook, createdBy, createdAt, status }], runs, max, hooksOn }
POST   /api/chats/:id/hooks { projectDir, entry }       -> { hook }   (added by the user)
PUT    /api/chats/:id/hooks/:hookId { projectDir, entry?, status? } -> { hook }
DELETE /api/chats/:id/hooks/:hookId?projectDir=         -> { ok }
POST   /api/chats/:id/hooks/:hookId/promote { projectDir, scope: "app" } -> { ok, hook }
GET  /api/hooks/runs?projectDir=&chatId=&limit=
                                             -> { runs: [{ id, at, hook, name?, event, decision, ms?, detail?, error?, projectDir?, chatId? }] }
PUT  /api/hooks  { enabled, list }           -> the same shape, after validation (400 with the first problem)
POST /api/hooks/test { hook, payload?, projectDir? }
                                             -> { parsed, code, ms, timedOut, stdout, stderr }
```

- Frontend: `frontend/src/components/SettingsHooks.jsx` (page, recent runs, exported `HookEditor`), `components/settings/hookText.js` (labels and summaries), `components/chat/HooksDock.jsx` (the chat's hooks bar and panel; `stream.js` fires `CHAT_HOOKS_CHANGED` from `hookEvents.js` after hook tools), the `hook_create` scope picker in `components/chat/cards.js`, `components/chat/hookNotes.js` (tool-card line, approval card list, prompt block), the follow-up badge in `components/chat/transcript.js`.
- Tests: `node scripts/test-hooks.js` (includes a full turn against a mock provider: the follow-up chain to its cap, and `turn.error`).
- The wider design (project hooks with trust, per-chat and model-made hooks, `turn.end`, UI extensions) is in [the extensions spec](../specs/extensions.md); this is its phases 1 to 3.
