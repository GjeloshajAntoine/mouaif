# Hooks — implementation notes

> Agent-facing reference for [`docs/features/hooks.md`](../../features/hooks.md).

- `src/hooks.js` validates hooks, stores them app-level under the `hooks` key (`{ enabled, list }`), matches them (tool globs, tool family via `authorization.configToolName` plus `mcp`, the argument regex in a worker thread, origin) and runs commands: `spawn` with an allowlisted environment, stdin JSON, 64 KB stdout / 16 KB stderr caps, a process-group kill on timeout or abort, priority lowered with `os.setPriority`. `runHooks(event, payload, ctx)` returns `{ decision, reason, by, args?, context?, notes[] }`.
- A note for a hook that changed arguments carries `changedArgs: true` and `changes: [{ key, before?, after? }]` (top-level keys, values as text clipped to 2000 chars); rows saved before that keep a whole `before` object, which the card still shows.
- `src/ai-stream.js` `runSingleToolCall` runs `tool.before` after the forged-call and tool-surface checks and before the circuit breaker and `authorize`; `ask` sets `forcePrompt`, so session grants and Allow do not skip the card. Rewritten arguments of a parent-only orchestration tool are checked again with `validateControl`. `tool.after` runs before `tool_result` is emitted; background subagent results, which land later, run no `tool.after`.
- `src/server-handlers-chats.js` `runChatStream` runs `prompt.submit` after the running-chat check and before the user row is saved, then checks again that no other run started. A block returns `409 { code: "EHOOK_BLOCKED", error, hook }`. MCP App messages pass `hookOrigin: 'app'` through `startChatTurn`.
- Rows keep `hooks: { notes, context? }` in the `hooks` column of `message_store` (user rows and tool result rows). `messages.withHookContext` appends `context` when history is rebuilt upstream. The stream sends `prompt_hooks { clientId, seq, hooks }` so the open page shows a prompt's context block at once.
- `hooks` is not in `CLIENT_SETTINGS_KEYS`: `update_settings` cannot write it, and `PUT /api/settings/app` refuses it. The routes below are the only way in, behind the normal session and access gates:

```
GET  /api/hooks                              -> { enabled, list, events, origins, families, shells, disabledByEnv }
PUT  /api/hooks  { enabled, list }           -> the same shape, after validation (400 with the first problem)
POST /api/hooks/test { hook, payload?, projectDir? }
                                             -> { parsed, code, ms, timedOut, stdout, stderr }
```

- Frontend: `frontend/src/components/SettingsHooks.jsx` (page), `components/chat/hookNotes.js` (tool-card line, approval card list, prompt block).
- Tests: `node scripts/test-hooks.js`.
- The wider design (project hooks with trust, per-chat and model-made hooks, `turn.end`, UI extensions) is in [the extensions spec](../specs/extensions.md); this is its phase 1.
