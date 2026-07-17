# AI client — server-side proxy with SSE streaming

## Overview

`mouaif` is the only thing that holds provider API keys. Provider connections are app-level; model IDs are project-level and reference a provider. The mobile UI POSTs to `/api/ai/chat`, the server combines the selected project model with its provider connection, calls upstream, and forwards events as SSE.

Six providers ship today:

- **OpenAI compatible** — any OpenAI-shaped endpoint (OpenAI, Together, Groq, LM Studio, Ollama's `/v1`, etc.). API key.
- **Anthropic** — Claude Messages API. API key, or OAuth for Claude Pro/Max accounts.
- **Google Gemini** — Google AI Studio. API key.
- **Ollama** — local server. No key.
- **OpenRouter** — one API key, many models (Anthropic, OpenAI, Google, Meta, Mistral, etc.) over an OpenAI-shaped endpoint. API key.
- **GitHub Copilot** — reserved; OAuth-only, requires an active Copilot subscription.

## Usage

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/ai/models` | `?projectDir=<abs>` (optional) | `{ models: [{id,provider,label,auth}], providers: [...] }` |
| GET    | `/api/ai/models/providers` | — | `{ providers: [{id}] }` — configured provider connections, credentials omitted |
| GET    | `/api/ai/models/live` | `?provider=<id>` | `{ models: [...], fetchedAt, cached }` — see [Live model list](#live-model-list) for the error contract |
| GET    | `/api/ai/models-all` | — | `{ ids: [...] }` — union of every model id across all projects + app-level models |
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
  provider:      'openai-compatible', // 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama' | 'openrouter' | 'github-copilot'
  label:         'GPT-4o mini',     // optional UI label
  contextWindow: 128000             // informational; not yet enforced
}
```

For OpenRouter, `id` is the model slug as listed on openrouter.ai, e.g. `'anthropic/claude-3.5-sonnet'`, `'google/gemini-2.0-flash'`, `'meta-llama/llama-3.1-405b-instruct'`. The full upstream id is sent verbatim in the `model` field of the chat-completions body.

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

The chat proxy picks a project model by `id`, then hydrates it with the provider connection referenced by `provider`. For a model selected directly from a live catalog, the client also submits `providerId`; the server builds a minimal `{ id, provider }` model and hydrates it from that connection. This keeps the project `models` array optional while preserving an unambiguous provider choice.

### Programmatic (Node)

```js
const ai = require('mouaif/src/ai.js');

const events = [];
const result = await ai.streamChat({
  model: { id: 'gpt-4o-mini', provider: 'openai-compatible' },
  messages: [{ role: 'user', content: 'hi' }],
  onEvent: (name, data) => events.push({ name, data })
});
// result: { ok: true, usage: { promptTokens, completionTokens } } | { ok: false, error: { code, message } }
```

### Live model list

`GET /api/ai/models/live?provider=<id>` fetches the provider's live catalog and merges it into the chat <select>. Results are cached per provider in memory for one hour; the chat UI's refresh button bypasses the cache via a `_` query string. The handler returns typed errors with HTTP statuses that match the failure mode, not a generic 502:

| Code | Status | When | Chat UI message |
|------|--------|------|-----------------|
| `ENO_LIST` | 400 | Provider has no `listModels` adapter | `<provider> has no model list endpoint` |
| `ENO_APIKEY` | 400 | Provider requires a key but none is configured | `add API key in Settings → Providers` |
| `EUNREACHABLE` | 503 | Network failure (Ollama not running, DNS error, `fetch failed`) | `ollama not running on 127.0.0.1:11434` / `<provider> unreachable` |
| `EABORTED` | 504 | Hit the 8 s per-call timeout | `timeout — <provider> did not respond in 8s` |
| `EUPSTREAM` | `<err.status>` | Upstream returned a non-2xx (e.g. 401, 403, 500) | `<provider> returned <status>` |
| other | 502 | Unexpected adapter failure | `model list failed (<status>)` |

The response body is always `{ error, code, provider, upstreamStatus? }`. The `upstreamStatus` field is present only on `EUPSTREAM` and carries the raw upstream HTTP status for debugging.

When more than one provider is configured, the chat shows an explicit provider picker. A chat without a saved choice starts on a `(provider)` placeholder; it never guesses by taking the first app connection. The chosen provider/model pair is persisted on the chat. This matters when the project has no saved models: choosing OpenRouter must query `/api/ai/models/live?provider=openrouter`, not a previously configured OpenAI-compatible connection.

## Behavior

- **SSE in, SSE out.** The proxy reads the upstream's SSE (or Ollama's NDJSON) and re-emits the same event names with normalized shapes. The browser does not need to know what provider is behind the URL.
- **Apikey only in this commit.** Models with `auth: 'oauth'` produce a typed `ENOAUTH` error. The OAuth commits add the flow; nothing in this commit stores tokens.
- **Reserved provider: `github-copilot`.** Listed in `ENDPOINTS` and `providers`, gated by `reserved: true`, so any attempt to call it returns `ENOAUTH`. The provider's auth flow ships separately.
- **Live model catalog.** Each `ENDPOINTS` entry carries a `listModels(cred)` that returns a normalized `[{ id, label, contextWindow? }]`. The chat <select> is populated from this list (see [docs/decisions.md §20](../decisions.md) and [docs/features/chat-ui.md](./chat-ui.md#per-chat-controls)). Throws `ENO_LIST` for providers without an adapter, `ENO_APIKEY` when a provider requires a credential and none is configured, `EUNREACHABLE` for network failures (Ollama not running, DNS error), `EABORTED` for the per-call timeout, and `EUPSTREAM` (with `err.status` forwarded) for upstream HTTP errors. The HTTP layer maps these to the right status code so the chat UI can show an actionable message — see [Live model list](#live-model-list).
- **Errors are typed.** The proxy maps upstream HTTP errors to `EUPSTREAM`, network failures to `ENETWORK`, aborts to `EABORTED`, unknown providers to `EUNKNOWN_PROVIDER`, missing keys to `ENOAPIKEY`, OAuth-marked models to `ENOAUTH`, and bad input to `EBADINPUT` / `EMODEL_NOT_FOUND`. The UI branches on `code`, not on `message`.
- **Connectivity tests time out.** `/api/ai/test` converts its own ten-second abort into `ETIMEDOUT`; unrelated aborted chat requests remain `EABORTED`.
- **Tool calls use a bounded multi-turn loop.** Native and MCP calls emit `tool_call` / `tool_result`, append the result to the upstream conversation, and request a user-facing answer. After `maxToolTurns` (12 by default), tool declarations are removed and the model receives an explicit completion instruction. Two answer-only retries are reserved so repeated tool use cannot consume the turn needed for the final response.
- **`[DONE]` sentinel is suppressed.** OpenAI uses the literal `[DONE]` to end a stream; the parser drops it so it does not show up as `passthrough` in the UI.

## Implementation notes

- Source: [src/ai.js](../../src/ai.js). Public surface: `streamChat`, `chat`, `ENDPOINTS`, `listModels`, plus the `BUILDERS` and `PARSERS` maps for extensibility.
- Server wiring: [src/index.js](../../src/index.js) → `handleAI()`. Model resolution is `settings.getResolved(projectDir).models` (decision §2).
- `AbortController`: the request's `close` event aborts the upstream fetch, so closing the tab or navigating away cancels the model call.
- AI provider → keyring namespace mapping lives in [src/auth.js](../../src/auth.js) (`AI_TO_AUTH_PROVIDER` / `authProviderFor`). Today the non-identity pairs are `openai-compatible` → `openai` and `openrouter` → `openai`; both put their API key in the same `openai` keyring namespace so users do not have to juggle a second credential store. The AI client and the settings UI both go through this mapping.
- OpenRouter: reuses the `openai-compatible` builder and the OpenAI SSE parser. Per OpenRouter's docs, every request carries `HTTP-Referer: https://mouaif.local` and `X-Title: mouaif` static headers so the app shows up correctly on the public leaderboard. The base URL defaults to `https://openrouter.ai/api/v1`. There is no OAuth flow; the user pastes an OpenRouter API key (issued at openrouter.ai) into the provider form. The model id is the OpenRouter slug (e.g. `anthropic/claude-3.5-sonnet`), sent verbatim.
- MiniMax models routed through OpenRouter sometimes serialize a tool call inside streamed text using `]<]minimax[>[` sentinels instead of returning OpenAI `delta.tool_calls`. The client buffers each OpenRouter assistant turn, recognizes this narrow compatibility format, converts its `<invoke>` name and XML arguments into a normal tool call, hides the private markers, and continues the same bounded multi-turn loop. Native OpenAI tool calls always take precedence.
- If an OpenAI-compatible model returns an empty `stop` response immediately after a tool result, the client treats the exchange as incomplete and retries up to twice with a short instruction to answer from the result. These retries remain available after the tool-call cap. If the provider still returns no text, the stream emits a visible fallback instead of ending with tool cards and no message.
- UI integration: the chat composer posts to `/api/chats/:id/messages/stream`, which delegates to this AI client and renders the normalized SSE stream. The former standalone AI-test panel has been removed.

## Related

- Decision: [docs/decisions.md §10](../decisions.md) (this commit) and §11 (auth — next commit).
- Settings storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
