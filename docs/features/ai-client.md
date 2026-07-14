# AI client — server-side proxy with SSE streaming

## Overview

`mouaif` is the only thing that holds provider API keys. The mobile UI POSTs to `/api/ai/chat` and reads the response as a Server-Sent Events stream; the server picks the model from the app + project settings, calls the upstream provider, and forwards each event to the browser. Five providers are wired in this commit: `openai-compatible`, `anthropic`, `gemini`, `ollama`, and `github-copilot` (the last one is reserved; its auth flow ships in a later commit). Implements [docs/decisions.md §10](../decisions.md).

## Usage

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/ai/models` | `?projectDir=<abs>` (optional) | `{ models: [{id,provider,label,auth}], providers: [...] }` |
| POST   | `/api/ai/chat`  | `{ modelId, messages, projectDir? }` | `text/event-stream` — see below |

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

The model record is read from the resolved settings (defaults → app → project). The shape extends decision §3 with `auth`:

```js
{
  id:            'gpt-4o-mini',     // slug, also the upstream model id
  provider:      'openai-compatible', // 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama' | 'github-copilot'
  label:         'GPT-4o mini',     // UI label
  baseUrl:       'https://api.openai.com', // optional; per-provider defaults applied
  apiKey:        'sk-...',          // ignored when auth === 'oauth'
  auth:          'apikey',          // 'apikey' | 'oauth' (default: 'apikey')
  oauthAccount:  undefined,         // populated by the OAuth commits
  contextWindow: 128000             // informational; not yet enforced
}
```

Adding a model from the mobile UI is `PUT /api/settings/app` with `{ models: [ ... ] }`. The chat proxy picks a model by `id`.

### Programmatic (Node)

```js
const ai = require('mouaif/src/ai.js');

const events = [];
const result = await ai.streamChat({
  model: { id: 'gpt-4o-mini', provider: 'openai-compatible', baseUrl: 'https://api.openai.com', apiKey: 'sk-...' },
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
