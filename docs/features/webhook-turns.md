# Webhook turns — start a chat turn when a link is called

## Overview

`webhook_create`, `webhook_status` and `webhook_delete` give a chat a secret link. Each time something calls the link (a CI build, a form, a monitoring alert, another script), mouaif starts a new turn **in that chat**. The turn's message is the webhook's prompt with the data the call carried below it.

It works like a [recurring task](scheduled-wakes.md), but an outside call starts each run instead of the clock. Each run starts with a fresh context at its own prompt. The model does not see earlier runs, but their messages stay in the chat, and the files they wrote stay in the project.

The link is `/hook/<uuid>` on the address mouaif is reached at, for example:

```
https://mouaif.example/hook/fa4e902f-df10-44fe-9dd7-741808463a32
```

## Usage

Ask the assistant for a webhook: "give this chat a webhook. When CI calls it, summarise the build and tell me if anything failed." It calls:

```json
{ "prompt": "A CI build finished. Summarise the result in two lines and say whether anything needs my attention.", "method": "POST" }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `webhook_create` | `prompt` (required, up to 4000 characters), `method`: `POST` (default), `GET` or `ANY` | `id`, `token`, `path`, `url` (when mouaif knows its public origin), `method`, `status`, `created` |
| `webhook_status` | none | The chat's webhook (or `null`) and its 10 latest calls |
| `webhook_delete` | none | `deleted: true` |

A chat has one webhook. Calling `webhook_create` again changes the prompt and method but keeps the link, so callers that already use it keep working.

Then call the link:

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"build":1289,"status":"failed"}' \
  'https://mouaif.example/hook/fa4e902f-df10-44fe-9dd7-741808463a32?branch=main'
# 202 {"ok":true,"id":"whe-…","status":"queued"}
```

With `GET`, the data goes in the query string: `curl 'https://…/hook/<uuid>?event=deploy&env=prod'`.

### The webhook bar

While the chat has a webhook, a bar above the composer shows the method, how many calls came in and when the last one arrived. **Copy** copies the link. **Calls** opens a panel with:

- **Link**: the full link, **Copy link** and **Copy curl** (a ready-to-paste test call for the method).
- **Method**: POST, GET or Both. The change applies to the next call.
- **Pause / Resume**: while paused, calls get `409` and nothing runs. Calls that were already waiting run when you resume.
- **Prompt**: see the prompt in full or edit it. The change applies from the next call.
- **New link**: makes a new UUID. The old link stops working at once. Tap twice to confirm.
- **Delete**: removes the webhook and its call history. Turns it already started stay in the chat. Tap twice to confirm.
- **Calls**: newest first, each with its run number, method, time and status (`waiting`, `started` or `failed`). Tap a call to see its query, body and headers. **Open turn** scrolls the chat to the turn it started, and **Copy data** copies the data.

### In the chat

The prompt a call started is marked `Webhook · run N` next to its time. Under the prompt, a collapsed **Received data · POST · time** block holds the query, body and headers that were sent to the model.

### In the chat list

A chat with a webhook shows a link icon in its row. The card's filter has a **Webhooks** entry that lists only those chats.

## Behavior

- **What the model receives.** The webhook's prompt, a line with the run number, method and time, then the data in `<query>`, `<body content-type="…">` and `<headers>` tags. The message tells the model to treat the tagged content as data, not instructions. A closing tag inside the data is escaped, so a caller can't end the block early.
- **Bodies.** JSON is pretty-printed, a form (`application/x-www-form-urlencoded`) becomes JSON, other text is kept as it is, and binary content is described (`[binary body, N bytes, type]`) rather than included. Up to 64 KB is kept for the panel and 20000 characters go to the model, with the received size noted when it is cut. A body over 256 KB is refused with `413`.
- **Headers.** `Authorization`, `Cookie`, `X-Api-Key` and similar headers are recorded as `[redacted]` and never stored. Transport headers (`Host`, `Content-Length`, `Connection`…) are dropped.
- **Runs never overlap.** Calls queue. If one arrives while the chat is streaming, it waits until the chat is free, then they run one at a time, oldest first. Waiting calls survive a restart.
- **Failures retry.** A call whose turn cannot start (for example, the provider is down) is retried and marked `failed` after three attempts, with the last error kept. A chat with no model selected fails its calls at once.
- **Limits.** At most 30 calls a minute and 20 waiting calls per webhook. Beyond either limit the link answers `429` with `Retry-After: 60`. The 100 latest calls are kept per webhook.
- **Notifications.** No browser started the run, so its completion and errors go to every subscribed device, with the reply as the notification text, as for a recurring task.
- **Permissions.** The three tools are in the **mouaif** family in **Settings → Project** (Off / Ask / Allow). A webhook's run uses the chat's normal tool permissions, so anything that needs approval waits for you.
- **Chats own their webhook.** Deleting a chat deletes its webhook, and the link answers `404`.

### Responses

| Status | When |
| --- | --- |
| `202` `{ ok, id, status: "queued" }` | The call was recorded and will run. |
| `404` | Unknown link, a link replaced by **New link**, or a deleted chat. |
| `405` + `Allow` | The method is not accepted. |
| `409` `EPAUSED` | The webhook is paused. |
| `413` | The body is over 256 KB. |
| `429` `ERATE` / `EQUEUE` | Too many calls in the last minute, or too many waiting. |

## Security

The link is public on purpose: an outside service has no mouaif session. The random UUID in the path is the credential, so treat the link like a password. Share it only with the service that calls it, and use **New link** if it leaks. The endpoint sits outside `/api/`, so the session and access gates don't apply to it. It can only queue a turn in the chat that owns the token. It cannot read anything back: the response says only that the call was queued.

mouaif listens on loopback unless you configure a remote host. To receive calls from the internet, mouaif must be reachable there (for example through the same reverse proxy or tunnel you use for the app). Set `MOUAIF_PUBLIC_ORIGIN` so the tools can return the full link. Otherwise the bar builds it from the address your browser uses.

## Implementation notes

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

## Related

- [Scheduled wake-ups and recurring tasks](scheduled-wakes.md): the same kind of run, started by the clock.
- [Chat model tools](chat-model-tools.md): `start_chat`, the same background-turn path.
