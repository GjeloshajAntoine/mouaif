# AI client — server-side proxy with SSE streaming

## Overview

`mouaif` is the only thing that holds provider API keys. Provider connections are app-level; model IDs are project-level and reference a provider. The mobile UI POSTs to `/api/ai/chat`, the server combines the selected project model with its provider connection, calls upstream, and forwards events as SSE.

## Usage

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/ai/models` | `?projectDir=<abs>` (optional) | `{ models: [{id,provider,label,auth}], providers: [...] }` |
| POST   | `/api/ai/test` | `{ modelId, projectDir? }` | `{ ok: true }` or `{ ok: false, error, code? }` |
| POST   | `/api/ai/chat`  | `{ modelId, messages, projectDir? }` | `text/event-stream` — see below |

`POST /api/ai/test` makes a real provider request with a single `Hi`
message and discards the generated content. It aborts after ten seconds and
returns `ETIMEDOUT`; provider, credential, and network failures are returned as
`ok: false` without exposing stored credentials.

The stream emits events with the same names as the upstream:

- `event: message` `data: { "delta": "Hello" }` — text deltas.
- `event: done` `data: { "usage": { "promptTokens": 11, "completionTokens": 22 } }` — end of stream, with token usage.
- `event: error` `data: { "code": "EUPSTREAM", "message": "..." }` — typed error, stream is closed after.
- `event: passthrough` `data: { "raw": "..." }` — unparsed upstream payload, useful for debugging.
- `event: finish` `data: { "reason": "stop" }` — upstream's finish reason.

Example:

````bash
curl -N -X POST http://localhost:5732/api/ai/chat \
  -H 'Content-Type: application/json' \
  -d '{"modelId":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
````

### Model record

The project owns model identity:

```js
{
  id:            'gpt-4o-mini',     // slug, also the upstream model id
  provider:      'openai-compatible', // 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama' | 'github-copilot'
  label:         'GPT-4o mini',     // optional UI label
  contextWindow: 128000             // informational; not yet enforced
}
```

The app store owns the provider connection:

```js
{
  id:            'openai-compatible',
  baseUrl:       'https://api.openai.com/v1',
  apiKey:        'sk-...',
  auth:          'apikey',
  oauthAccount:  undefined
}
```

The chat proxy picks a project model by `id`, then hydrates it with the provider connection referenced by `provider`.

### Programmatic (Node)

```js
const ai = require('mouaif/src/ai.js');

const events = [];
const result = await ai.streamChat({
  model: { id: 'gpt-4o-mini', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...' },
  messages: [{ role: 'user', content: 'hi' }],
  onEvent: (name, data) => events.push({ name, data })
});
// result: { ok: true, usage: { promptTokens, completionTokens } } | { ok: false, error: { code, message } }
```

## Behavior

- **SSE in, SSE out.** The proxy reads the upstream's SSE (or Ollama's NDJSON) and re-emits the same event names with normalized shapes. The browser does not need to know what provider is behind the URL.
- **Apikey only in this commit.** Models with `auth: 'oauth'` produce a typed `ENOAUTH` error. The OAuth commits add the flow; nothing in this commit stores tokens.
- **Reserved provider: `github-copilot`.** Listed in `ENDPOINTS` and `providers`, gated by `reserved: true`, so any attempt to call it returns `ENOAUTH`. The provider's auth flow ships separately.
- **Errors are typed.** The proxy maps upstream HTTP errors to `EUPSTREAM`, network failures to `ENETWORK`, aborts to `EABORTED`, unknown providers to `EUNKNOWN_PROVIDER`, missing keys to `ENOAPIKEY`, OAuth-marked models to `ENOAUTH`, and bad input to `EBADINPUT` / `EMODEL_NOT_FOUND`. The UI branches on `code`, not on `message`.
- **Connectivity tests time out.** `/api/ai/test` converts its own ten-second abort into `ETIMEDOUT`; unrelated aborted chat requests remain `EABORTED`.
- **No tool calls yet.** This commit transports text + usage. Tool-call events (`tool_call`, `tool_result`) are reserved names and will land in a later commit.
- **`[DONE]` sentinel is suppressed.** OpenAI uses the literal `[DONE]` to end a stream; the parser drops it so it does not show up as `passthrough` in the UI.

## Implementation notes

- Source: [src/ai.js](../../src/ai.js). Public surface: `streamChat`, `chat`, `ENDPOINTS`, plus the `BUILDERS` and `PARSERS` maps for extensibility.
- Server wiring: [src/index.js](../../src/index.js) → `handleAI()`. Model resolution is `settings.getResolved(projectDir).models` (decision §2).
- `AbortController`: the request's `close` event aborts the upstream fetch, so closing the tab or navigating away cancels the model call.
- AI provider → keyring namespace mapping lives in [src/auth.js](../../src/auth.js) (`AI_TO_AUTH_PROVIDER` / `authProviderFor`). Today the only non-identity pair is `openai-compatible` → `openai`; the AI client and the settings UI both go through this mapping so an OpenAI-signed-in account can serve an `openai-compatible` model without copying credentials.
- UI integration: the chat composer posts to `/api/chats/:id/messages/stream`, which delegates to this AI client and renders the normalized SSE stream. The former standalone AI-test panel has been removed.

## Related

- Decision: [docs/decisions.md §10](../decisions.md) (this commit) and §11 (auth — next commit).
- Settings storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
