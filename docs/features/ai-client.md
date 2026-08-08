# AI client — server-side proxy with SSE streaming

## Overview

`mouaif` is the only thing that holds provider API keys. Provider connections are app-level; model IDs are project-level and reference a provider. The mobile UI POSTs to `/api/ai/chat`, the server combines the selected project model with its provider connection, calls upstream, and forwards events as SSE.

Ten providers ship today:

- **OpenAI compatible** — any OpenAI-shaped endpoint (OpenAI, Together, Groq, LM Studio, Ollama's `/v1`, etc.). API key.
- **Anthropic** — Claude Messages API. API key, or OAuth for Claude Pro/Max accounts.
- **Google Gemini** — Google AI Studio. API key.
- **Ollama** — local server. No key.
- **OpenRouter** — one API key, many models (Anthropic, OpenAI, Google, Meta, Mistral, etc.) over an OpenAI-shaped endpoint. API key, or PKCE sign-in (the server stores the issued key).
- **GitHub Copilot** — reserved; OAuth-only, requires an active Copilot subscription.
- **Azure OpenAI** — deployment-based OpenAI endpoint. `api-key` header + `api-version` query param. API key.
- **Mistral** — La Plateforme, OpenAI-shaped. API key.
- **Groq** — fast inference for open models, OpenAI-shaped. API key.
- **DeepSeek** — OpenAI-shaped API. API key.

See [docs/features/cloud-providers.md](./cloud-providers.md) for the four OpenAI-shaped providers.

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
- `event: usage_input` `data: { "promptTokens": 11, "cacheReadTokens": 0, "cacheCreationTokens": 0 }` — per-round prompt footprint (fires on each tool round for Anthropic; the final `done` carries the authoritative sum). For Anthropic, `cacheReadTokens` / `cacheCreationTokens` are the prompt-cache read and write counts from `message_start` (see [prompt-caching.md](./prompt-caching.md)).
- `event: usage_output` `data: { "completionTokens": 22 }` — per-round completion footprint.
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
  provider:      'openai-compatible', // 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama' | 'openrouter' | 'github-copilot' | 'azure' | 'mistral' | 'groq' | 'deepseek'
  label:         'GPT-4o mini',     // optional UI label
  contextWindow: 128000             // informational; not yet enforced
}
```

For OpenRouter, `id` is the model slug as listed on openrouter.ai, e.g. `'anthropic/claude-3.5-sonnet'`, `'google/gemini-2.0-flash'`, `'meta-llama/llama-3.1-405b-instruct'`. The full upstream id is sent verbatim in the `model` field of the chat-completions body.

Live-catalog records (OpenRouter) also carry a `pricing` block pulled from the upstream `/models` response — `inputPer1K` / `outputPer1K` (converted from OpenRouter's per-token prices) plus `cacheReadFactor` / `cacheWriteFactor` derived from the `input_cache_read` / `input_cache_write` rates. When the user picks a live model, `resolveModel` reuses this block from the in-memory live-model cache so the cost line reflects the provider's real per-model rates (see [prompt-caching.md](./prompt-caching.md)).

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
- **Tool calls use a multi-turn loop.** Native and MCP calls emit `tool_call` / `tool_result`, append the result to the upstream conversation, and request another model turn. There is no fixed tool-turn limit: the model can continue until it considers the task complete or the user aborts the request. The loop is wired for the OpenAI-shaped providers (openai-compatible, openrouter, github-copilot) and for Anthropic's native tool shape — `buildAnthropicRequest` converts the specs to `tools` and the conversation's `tool_calls`/`tool` messages to `tool_use`/`tool_result` blocks, and the parser reconstructs tool calls from streamed `input_json_delta` frames.
- **Tool feedback is bounded independently from the transcript.** The SSE event, SQLite message, trace, and tool card keep the complete structured result. Only the `role: "tool"` copy sent back upstream is compacted to 64 KiB by default. Oversized text keeps its beginning and end; subagents return only their final text to the parent model; base64 image payloads are omitted from text because they are attached separately as vision input. Historical tool results use the same compaction when a chat is resumed.
- **Interrupted turns do not break continuation.** When a stored transcript is sent again, only adjacent, complete tool call/result pairs are reconstructed. An orphan call left by an aborted request is omitted, and missing, duplicate, or provider-specific call IDs are replaced consistently on both sides of the pair. Empty persisted assistant segments are also omitted because strict providers reject an assistant message with no visible content. Tool records and OpenAI-shaped tool declarations are omitted for providers whose native tool loop is not implemented (all except the OpenAI-shaped providers and Anthropic). This prevents strict endpoints from returning `400 Bad Request` when the user continues the chat or changes models/providers.
- **`[DONE]` sentinel is suppressed.** OpenAI uses the literal `[DONE]` to end a stream; the parser drops it so it does not show up as `passthrough` in the UI.
- **Usage accumulates last-wins within a round, summed across rounds.** Each upstream round-trip's usage is tracked per round and folded into the turn aggregate once, when the stream ends. `promptTokens` is last-report-wins (every round re-sends the full conversation, so the final round's prompt is the real footprint). `completionTokens` and `providerCost` sum across tool rounds (each round's output is genuinely new) but are last-wins *within* one round — so an OpenAI-compatible gateway that stamps a running usage/cost total on every chunk (instead of only the final chunk per `stream_options.include_usage`) is not double-counted. Anthropic's `message_start`/`message_delta` usage frames feed the same per-round trackers; its per-round cost snapshot still rides `usage_output` deltas.
- **Anthropic prompt caching is enabled for API-key and OAuth models.** Every request marks the combined system block, the **last native tool definition**, and the **penultimate message** with `cache_control: { type: 'ephemeral' }` (object blocks only, so plain strings are wrapped) using generally available prompt caching; OAuth retains its own required beta header, while API-key requests need no caching beta header. The message breakpoint matters: Anthropic ignores a `cache_control` breakpoint whose prefix is below the per-model minimum cacheable length (4096 tokens for Sonnet 4 / Opus 4 / Haiku 4.5), and the replayed history is what pushes the prefix over the threshold — so the cache engages from the second request of a conversation even with no tools enabled. Cache read/write token counts from `message_start` are folded into the per-round snapshots and the final `done` usage block as `cacheReadTokens` / `cacheCreationTokens`, and the cost layer prices them at Anthropic's discounted rates. See [prompt-caching.md](./prompt-caching.md).

## Implementation notes

- Source: [src/ai.js](../../src/ai.js) (the stream loop) with provider endpoint definitions (`ENDPOINTS` with `listModels`, `BUILDERS`, `PARSERS`) in [src/ai-endpoints.js](../../src/ai-endpoints.js) and the stream machinery split across `src/ai-stream.js` / `src/ai-chat.js`. Public surface: `streamChat`, `chat`, `ENDPOINTS`, `listModels`, plus the `BUILDERS` / `PARSERS` maps for extensibility.
- Server wiring: [src/http-server.js](../../src/http-server.js) → `handleAI()` in [src/server-handlers-ai.js](../../src/server-handlers-ai.js). Model resolution is `settings.getResolved(projectDir).models` (decision §2).
- `AbortController`: the request's `close` event aborts the upstream fetch, so closing the tab or navigating away cancels the model call.
- AI provider → keyring namespace mapping lives in [src/auth.js](../../src/auth.js) (`AI_TO_AUTH_PROVIDER` / `authProviderFor`). Every provider maps to its own namespace (identity except for `openai-compatible` → `openai`, which shares the `openai` keyring namespace with a user-pasted OpenAI key), so a credential stored under one provider is never treated as a credential for another. OpenRouter has its own `openrouter` namespace; the PKCE sign-in flow stores the issued API key there. The AI client and the settings UI both go through this mapping.
- OpenRouter: reuses the `openai-compatible` builder and the OpenAI SSE parser. Per OpenRouter's docs, every request carries `HTTP-Referer: https://mouaif.local` and `X-Title: mouaif` static headers so the app shows up correctly on the public leaderboard. The base URL defaults to `https://openrouter.ai/api/v1`. The user can paste an OpenRouter API key (issued at openrouter.ai) into the provider form, or use the PKCE sign-in flow ([src/oauth-openrouter.js](../../src/oauth-openrouter.js)) which stores the issued key under the `openrouter` keyring namespace (see [docs/features/openrouter.md](./openrouter.md)). The model id is the OpenRouter slug (e.g. `anthropic/claude-3.5-sonnet`), sent verbatim.
- MiniMax models routed through OpenRouter sometimes serialize a tool call inside streamed text using `]<]minimax[>[` sentinels instead of returning OpenAI `delta.tool_calls`. The client buffers each OpenRouter assistant turn, recognizes this narrow compatibility format, converts its `<invoke>` name and XML arguments into a normal tool call, hides the private markers, and continues the same multi-turn loop. Native OpenAI tool calls always take precedence.
- The SSE reader accepts both LF and CRLF frame terminators. Real upstreams differ: Azure OpenAI, Ollama's OpenAI-compatible mode, and many gateways/proxies emit `\r\n\r\n` blank lines, while the spec form is `\n\n`. Frames are split on `(?:\r?\n){2}` and each frame's line endings are normalized to LF before field parsing, so a CRLF stream never degrades into unparsable `passthrough` chunks.
- If an OpenAI-compatible model returns an empty `stop` response immediately after a tool result, the client treats the exchange as incomplete and retries up to twice with a short instruction to answer from the result. If the provider still returns no text, the stream emits a visible fallback instead of ending with tool cards and no message.
- UI integration: the chat composer posts to `/api/chats/:id/messages/stream`, which delegates to this AI client and renders the normalized SSE stream. The former standalone AI-test panel has been removed.

## Related

- Decision: [docs/decisions.md §10](../decisions.md) (this commit) and §11 (auth — next commit).
- Settings storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
