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
- Mobile-first layout: the cost / token-s line renders as a single row of compact tokens (•-separated) under each user turn, sized for a 360 px viewport with no horizontal scroll. The line collapses to a single dot-summary (`gpt-4o-mini • •`) on very narrow screens if needed; the full row is the default.
