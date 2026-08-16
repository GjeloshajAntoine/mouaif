# Anthropic prompt caching — implementation notes

> Agent-facing reference for [`docs/features/prompt-caching.md`](../../features/prompt-caching.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Source: `src/ai-endpoints.js` — `ENDPOINTS.anthropic.authHeader` (authentication headers), `buildAnthropicRequest` (system array + `cache_control`, native `tools` conversion + `cache_control` on the last tool, `markPenultimateMessage` for the guaranteed breakpoint, `tool_use`/`tool_result` message conversion), `parseAnthropicSSE` (cache fields on `usage_input`, `tool_use` accumulation → `tool_call_delta`). `src/ai-stream.js` — `runUpstreamTurn` passes the tool specs into the builder and shares one per-turn `tool_use` accumulator with the parser; `streamChat`/`commitRoundUsage` keep the per-round trackers and fold them into the turn aggregate → `done` usage. `src/server-handlers-chats.js` — historical tool pairs are reconstructed for Anthropic models.
- Cost: `src/usage.js → computeCost` — default `CACHE_READ_FACTOR`/`CACHE_WRITE_FACTOR` (0.10 / 1.25), overridable per model via `pricing.cacheReadFactor` / `pricing.cacheWriteFactor`.
- Server wiring: `src/index.js` — the segment cost at `assistant_turn_end` and the final `done` cost both go through `usage.computeCost`, so intermediate tool-round segments and the final message each price their cached tokens correctly.
- Chat UI: `frontend/src/components/chat/stream.js` merges the cache fields from `usage_input`/`done`; `frontend/src/components/chat/usage.js` renders the `cache … read · … written` meta token.
- Tests: `scripts/test-anthropic-tools.js` covers the request shapes (tools + cache markers, penultimate-message breakpoint with and without tools, OAuth exclusion, message conversion), the streaming parser (accumulated `input_json_delta` → `tool_call_delta`), and the full multi-turn loop against a mocked Anthropic SSE stream (tool round → final answer, cache counts folded into `done`). `scripts/test-provider-cache-usage.js` covers OpenAI-shaped and Gemini cached-token normalization.
- Docs: [docs/decisions.md §14](../decisions.md) documents the cost line; [usage-metrics.md](./usage-metrics.md) documents the meta line and pricing.
