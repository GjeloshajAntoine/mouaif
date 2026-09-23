# Usage metrics — cost and live token speed in the chat — implementation notes

> Agent-facing reference for [`docs/features/usage-metrics.md`](../../features/usage-metrics.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### Programmatic (Node)

```js
const { computeCost, formatCost } = require('mouaif/src/usage.js');

const cost = computeCost({
  model: { id: 'gpt-4o-mini', pricing: { inputPer1K: 0.00015, outputPer1K: 0.00060 } },
  usage: { promptTokens: 243, completionTokens: 118 }
});
// -> { input: 0.00003645, output: 0.0000708, total: 0.00010725, currency: 'USD' }

formatCost(cost.total); // -> "$0.00011"  (2–5 fractional digits, locale-aware)
```

## Implementation notes

- Source: `src/usage.js` (new module) — `computeCost(model, usage)`, `formatCost(amount)`, `tokPerSecond(samples)`.
- The AI client already emits `usage_input`, `usage_output`, and `done({ usage })` (see [docs/features/ai-client.md](./ai-client.md)). The new module is purely a derivation layer; it adds no events to the SSE stream.
- `src/ai.js` keeps parent prompt tokens as last-round-wins for normal tool loops, but tracks delegated subagent usage separately and adds it to the final `done({ usage, providerCost })` payload because subagents are separate upstream requests. Anthropic's prompt-cache read/write token counts are summed across tool rounds and ride the same final `usage` block.
- The chat UI hooks the existing `onEvent('message')` and `onEvent('done')` callbacks from `/api/chats/:id/messages/stream`; no protocol change is needed.
- The pricing resolution order is **model.pricing → app.modelPricing[<id>] → built-in defaults → none**. The built-in table lives in `src/usage.js` and is keyed on `model.id`.
- **Dictation is priced here but written by a second cost path.** `POST /api/ai/transcribe` prices the provider's report with the same `computeCost` and resolution order. When the request carries the `chatId` it dictated in (the composer microphone does; the dictation page does not), the handler calls `messages.addChatCost(projectDir, chatId, cost.total)` — `src/chatdb.js#addChatCost`, the only writer of the persisted `total_cost` / `cost_known_count` counters that writes no message row. It moves the chat row and the registered project total in one transaction, and is best-effort: an unknown cost, a zero cost or a chat that no longer exists attributes nothing rather than failing a paid-for run. The chat view mirrors the run in a session-only `state.attributedCost` so the header Total moves before the next `GET /api/chats/:id/messages` snapshot. `costSummary.attributedCostAfter(held, snapshot, amount)` owns that accumulator and keys it on the snapshot *object*: a rebase installs a fresh snapshot that already covers every attributed run, so the running total restarts from zero instead of adding the earlier runs a second time. `summarizeChatUsage(messages, snapshot, liveInfo, attributedCost)` takes the delta as its fourth argument.
- Mobile-first layout: the cost / token-s line renders as a single row of compact tokens (•-separated) under each user turn, sized for a 360 px viewport with no horizontal scroll. The line collapses to a single dot-summary (`gpt-4o-mini • •`) on very narrow screens if needed; the full row is the default.

## Decisions

- [docs/decisions.md](../../decisions.md): §14 (usage metrics), §10 (AI client usage events).
