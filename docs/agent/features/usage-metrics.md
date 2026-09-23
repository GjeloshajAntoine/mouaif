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

The header Total uses an authoritative cost snapshot paired with the exclusive `nextSeq` cursor from `GET /api/chats/:id/messages`. Window, tail, and full-list responses include an additive `totalCost` field (`{ total, known, currency, knownCount }`) covering all persisted messages, not just the returned page.

The client adds only newer rows and optimistic/live costs not covered by that snapshot. Tail reconciliation replaces optimistic segments before advancing the cost baseline, including when no extra DOM rows are appended. Loading older history and saving metadata never advance the baseline, preventing double counting during an active turn. Older servers without this field retain the loaded-message sum fallback.

**Dictation reuses the same pricing, and a run taken in a chat joins the sums.** `POST /api/ai/transcribe` prices the provider's token report with this same `computeCost` and resolution order, and returns `{ usage, cost }` so the dictation page and the composer microphone can show what a run cost. The composer microphone also sends the `chatId` it dictated in, and the server adds a known, positive cost to that chat's persisted `total_cost` / `cost_known_count` and to the registered project total (`messages.addChatCost`) — the same counters an assistant turn maintains, written without a message row because a transcription produces a draft, not a turn. The chat view keeps the run in a session-only `attributedCost` delta so the header Total moves immediately; the delta is keyed on the cost snapshot object, so the next authoritative snapshot (tail sync or reload) — which by then covers the same number — starts the accumulator over instead of double-counting it. A run taken on the **Dictation page** sends no `chatId` and stays point-of-use only, and a run whose cost is unknown adds nothing anywhere. The built-in table still gets no transcription ids: speech-to-text is normally billed per minute of audio, which the per-1K-token shape cannot express, so those runs render `--` and stay out of the totals. See [dictation.md](../../features/dictation.md).

## Decisions

- [docs/decisions.md](../../decisions.md): §14 (usage metrics), §10 (AI client usage events).
