# Webhook turns — start a chat turn when a link is called — implementation notes

Public page: [`docs/features/webhook-turns.md`](../../features/webhook-turns.md).

- `src/webhooks.js` holds the store (`chat_webhook` and `webhook_event` tables in the app database), the `/hook/<uuid>` handler and the delivery ticker. The ticker runs every 3 s and is also kicked on each call. It starts turns through `startChatTurn`, the same runner recurring tasks and `start_chat` use.
- `src/tools/webhook.js` holds the model-facing tools.
- A run's user message carries `origin: { kind: 'webhook', hookId, eventId, run }`. `contextFromLastRun` starts the upstream context there, and the transcript uses it for the badge and the collapsed data block.
- REST endpoints for the UI, behind the normal session and access gates:

```
GET    /api/chats/:id/webhook?projectDir=          -> { webhook, events }
PUT    /api/chats/:id/webhook  { projectDir, prompt?, method?, status?: "active"|"paused", rotate?: true } -> { webhook, events }
DELETE /api/chats/:id/webhook?projectDir=          -> { ok, removed }
```

  Each event carries `seq`, the position of the turn it started, for **Open turn**. `GET /api/chats` marks rows with `webhook: true` and accepts `filter=webhook`.
- Tests: `node scripts/test-webhooks.js`.
