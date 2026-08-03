# Anthropic prompt caching

## Overview

Anthropic's Messages API supports **prompt caching**: a stable prefix of the prompt (system block, tools, earlier messages) can be marked with `cache_control` so the provider stores it once and serves subsequent requests from cache. Cached reads are billed at **10%** of the input rate and cache writes at **125%**, so multi-turn and tool-heavy Claude chats become markedly cheaper once the cache is warm.

`mouaif` enables this for every **API-key** Anthropic model. The cached prefix is the **system block plus the native tool definitions, with the breakpoint extended to the penultimate message**: the combined system block (prompt profile + agent files + skills + feature summary + tagged files + custom prompt) is the most stable part of the prompt across turns, the last tool definition is marked with `cache_control` per Anthropic's own recommendation, and the second-to-last message carries a breakpoint too. The message breakpoint is what makes caching actually engage: Anthropic silently ignores a `cache_control` breakpoint whose prefix is below the per-model minimum cacheable length (1024 tokens for Sonnet 3.5/3.7, 4096 for the current generation — Sonnet 4 / Opus 4 / Haiku 4.5), and a system block alone — or even a small tool set — is usually below that. The penultimate message guarantees the cached prefix (system + tools + history) clears the minimum whenever there is any history to replay, so caching works from the second request of a conversation **even with every tool switched off**. The cache read/write token counts are surfaced in the chat usage line and priced at the discounted tiers.

Claude tool calls ride the same multi-turn loop as the OpenAI-shaped providers: the request carries native `tools` (converted from the OpenAI-shaped specs), `tool_use` blocks from the stream are parsed back into the loop, and tool results are sent back as `tool_result` blocks.

## Usage

No user action is required. Every chat turn against an Anthropic API-key model sends:

```jsonc
// Request body, system field (single combined block, marked cacheable):
{
  "system": [
    {
      "type": "text",
      "text": "<profile + agent files + skills + feature summary + tagged files + custom prompt>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "tools": [
    { "name": "shell", "description": "Run a shell command", "input_schema": { "type": "object", "properties": { "cmd": { "type": "string" } } } },
    // … every other enabled tool …
    {
      "name": "report_progress",
      "description": "Report progress",
      "input_schema": { /* … */ },
      "cache_control": { "type": "ephemeral" }   // LAST tool only
    }
  ]
}
```

…with the `anthropic-beta: prompt-caching-2024-07-31` header on the API-key auth path. The system block is sent as an **array** because a plain string silently drops `cache_control`.

Every request also marks the **penultimate message** (the second-to-last, i.e. the deepest point of the stable, replayed prefix) with `cache_control`. The final message — the current turn — is never marked: a breakpoint there is ignored by the API, and the current turn is not part of the stable prefix anyway. On the first request of a conversation there is no penultimate message, so the breakpoint appears from the second request onward — which is also the first time there is any history to read back from cache.

### Cache metrics

Anthropic reports cache usage on the `message_start` frame:

```jsonc
{ "message": { "usage": {
  "input_tokens": 1200,
  "cache_read_input_tokens": 900,
  "cache_creation_input_tokens": 300
} } }
```

Anthropic's three input fields are disjoint buckets: `input_tokens` is uncached input, while the two cache fields are read and newly-created input. The AI client normalizes them into the provider-neutral contract by setting `promptTokens` to their sum, then folds the result into per-round usage snapshots and the final `done` usage block:

```jsonc
{ "usage": { "promptTokens": 2400, "completionTokens": 400,
             "cacheReadTokens": 900, "cacheCreationTokens": 300 } }
```

The chat UI shows a `cache 900 read · 300 written` token in the per-turn meta line (only when the provider reported any cache activity), and the cost line prices the cached tokens at the discounted rates.

## Behavior

- **API-key models only.** OAuth Anthropic models keep the `anthropic-beta: oauth-2025-04-20` header and their requests carry **no** `cache_control` markers — the OAuth flow's beta gate takes precedence. The header and system/tool shape are decided at request time from `model.auth` (enforced in `buildAnthropicRequest`).
- **One combined cacheable system block.** All `system` messages are concatenated into a single text block marked with `cache_control`. The block is stable across every turn of a conversation (profile, agent files, skills, feature summary, tagged files, and the custom prompt are all resolved from persistent state), so the second and subsequent turns read it from cache.
- **The last tool definition is cacheable too.** Every enabled native/MCP tool is converted to Anthropic's `{ name, description, input_schema }` form and the **last** entry carries `cache_control` — the documented best practice. Tool schemas are several thousand tokens, so the cached prefix (system + tools) clears the per-model minimum cacheable length on its own for typical tool sets.
- **The penultimate message carries the guaranteed breakpoint.** The second-to-last message is always marked with `cache_control`. Its prefix — system + tools + every message before the current turn — is re-sent byte-identically on every request (each tool round and every follow-up turn replays the full history), so the next request reads it from cache. This is what makes caching engage when the system + tools prefix is short: no tools enabled, a small tool set, or a terse system block all still cache, because the history itself clears the minimum. Plain-text messages are wrapped into a `text` block so the marker is honored; tool results and tool_use blocks are marked on their last block.
- **Multi-turn tool loop works for Claude.** The conversation is converted per request: assistant `tool_calls` become `tool_use` blocks, `role: "tool"` messages become `tool_result` blocks in a user message, and streamed `input_json_delta` frames are accumulated into tool calls by the parser. Historical tool pairs are reconstructed the same way when a chat resumes.
- **The cache prefix is kept byte-stable.** The post-tool empty-response retry reminder rides as a `user` message instead of `system` for Anthropic, because the builder folds every `system`-role message into the cached system block — a mid-conversation system message would change the prefix and invalidate the warm cache for the rest of the chat.
- **Minimum cacheable length still applies.** If a conversation is so short that even the full replayed prefix (system + tools + history) is below the per-model minimum, the markers are harmless but inactive — there is simply nothing worth caching yet. The cache engages from the second request of any real conversation, tools on or off.
- **Cost is cache-aware and per-model.** `src/usage.js → computeCost` charges cached reads at 10% of the input rate and cache writes at 125%, with the remaining uncached prompt tokens at the full input rate — **multiplied by the model's own input price**. The 10% / 125% factors are the standard Anthropic tiers and are uniform across Claude models today, but a pricing record can override them per model (`pricing.cacheReadFactor` / `pricing.cacheWriteFactor`); see [usage-metrics.md](./usage-metrics.md#per-model-pricing). OpenRouter's live model catalog supplies both the per-model base prices and the cache factors from its `/models` API (`pricing.prompt` / `pricing.completion` in $ per token, cache rates in `pricing.input_cache_read` / `pricing.input_cache_write`), so Claude models used through OpenRouter are priced from the provider's real numbers — including non-standard cache tiers (e.g. Gemini 2.5 Pro writes at 0.3×, DeepSeek reads at 0.5×). A `usage` block without cache fields prices identically to before the feature. The per-segment cost attached at `assistant_turn_end` uses the same math via the round snapshot.
- **Other providers' cache reads are normalized too.** OpenAI-shaped providers (including OpenAI-compatible endpoints, OpenRouter, Azure, GitHub Copilot, Mistral, Groq, and DeepSeek) expose cache hits through `prompt_tokens_details.cached_tokens`; Gemini exposes `usageMetadata.cachedContentTokenCount`. Both are subsets of the provider's total prompt count and map to `cacheReadTokens`, enabling the same cache-aware usage and pricing path. Ollama does not currently report a cached-token usage bucket.
- **Cache fields travel with the transcript.** The `usage` block — including `cacheReadTokens` / `cacheCreationTokens` — is persisted on the assistant message, so a chat re-opened later shows the same numbers that were on screen.

## Implementation notes

- Source: `src/ai-endpoints.js` — `ENDPOINTS.anthropic.authHeader` (API-key beta header), `buildAnthropicRequest` (system array + `cache_control`, native `tools` conversion + `cache_control` on the last tool, `markPenultimateMessage` for the guaranteed breakpoint, `tool_use`/`tool_result` message conversion), `parseAnthropicSSE` (cache fields on `usage_input`, `tool_use` accumulation → `tool_call_delta`). `src/ai-stream.js` — `runUpstreamTurn` passes the tool specs into the builder and shares one per-turn `tool_use` accumulator with the parser; `streamChat`/`commitRoundUsage` keep the per-round trackers and fold them into the turn aggregate → `done` usage. `src/server-handlers-chats.js` — historical tool pairs are reconstructed for Anthropic models.
- Cost: `src/usage.js → computeCost` — default `CACHE_READ_FACTOR`/`CACHE_WRITE_FACTOR` (0.10 / 1.25), overridable per model via `pricing.cacheReadFactor` / `pricing.cacheWriteFactor`.
- Server wiring: `src/index.js` — the segment cost at `assistant_turn_end` and the final `done` cost both go through `usage.computeCost`, so intermediate tool-round segments and the final message each price their cached tokens correctly.
- Chat UI: `src/web/src/components/chat/stream.js` merges the cache fields from `usage_input`/`done`; `src/web/src/components/chat/usage.js` renders the `cache … read · … written` meta token.
- Tests: `scripts/test-anthropic-tools.js` covers the request shapes (tools + cache markers, penultimate-message breakpoint with and without tools, OAuth exclusion, message conversion), the streaming parser (accumulated `input_json_delta` → `tool_call_delta`), and the full multi-turn loop against a mocked Anthropic SSE stream (tool round → final answer, cache counts folded into `done`). `scripts/test-provider-cache-usage.js` covers OpenAI-shaped and Gemini cached-token normalization.
- Docs: [docs/decisions.md §14](../decisions.md) documents the cost line; [usage-metrics.md](./usage-metrics.md) documents the meta line and pricing.

## Related

- [docs/features/ai-client.md](./ai-client.md) — request builders and SSE events.
- [docs/features/oauth-anthropic.md](./oauth-anthropic.md) — the API-key vs OAuth header split.
- [docs/features/usage-metrics.md](./usage-metrics.md) — cost and token/s rendering.
