# Usage metrics — cost and live token speed in the chat

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

Every chat turn reports a `usage` block (`{ promptTokens, completionTokens }`) when the upstream finishes streaming. The chat UI turns that block into a per-message **cost** (in USD) and a **live tokens/s** counter that ticks under each user turn as the assistant's tokens stream in. Pricing comes from a per-model `pricing` map so the user can override defaults for any model they configure; sensible defaults are bundled for the providers the AI client ships with.

## Usage

### What the user sees

For every assistant message in the chat, the UI renders a small status line directly below the reply:

```text
gpt-4o-mini  •  context 243  •  output 118  •  cost $0.00012  •  37 tok/s
```

- `gpt-4o-mini` — the model the user picked for the turn.
- `context` / `output` — the prompt and completion token counts (the same numbers the upstream reported).
- `cache 1.2K read · 800 written` — *Anthropic only, shown only when present:* the prompt-cache tokens served from cache and written into cache for the turn.
- `cost $0.00012` — the cost for this turn, formatted with 2–5 fractional digits and the user's locale decimal separator.
- `37 tok/s` — completion tokens per second, averaged over the streaming window for that turn.

The `tok/s` line updates **live** as the assistant's deltas arrive: it climbs from `0` while the upstream warms up, follows the throughput as tokens flow, and freezes on the final value when `done` is received. If the stream ends in `error` (e.g. `EUPSTREAM`, `EABORTED`, `EENETWORK`), the counter freezes at the last value and the cost line shows `--`.

### Per-model pricing

Pricing is an opt-in addition to the existing model record, so existing projects keep working without any change:

```jsonc
// <projectDir>/.mouaif.json
{
  "models": [
    {
      "id": "gpt-4o-mini",
      "provider": "openai-compatible",
      "label": "GPT-4o mini",
      "contextWindow": 128000,
      "pricing": {               // NEW (all fields optional)
        "inputPer1K":  0.00015,   // USD per 1 000 prompt tokens
        "outputPer1K": 0.00060,   // USD per 1 000 completion tokens
        "cacheReadFactor": 0.10,  // optional: prompt-cache read multiplier (default 0.10)
        "cacheWriteFactor": 1.25  // optional: prompt-cache write multiplier (default 1.25)
      }
    }
  ]
}
```

A chat with no `pricing` block falls back to the **app-level default** (`settings.app.modelPricing[<modelId>]`), which in turn falls back to a small built-in table for well-known model ids. The built-in table is best-effort and intentionally not exhaustive — the moment a model id is unknown, the cost line renders `--` and the token/s line keeps working.

The app-level table is editable through the existing Settings UI so a user can lock in a price without editing JSON:

```jsonc
// ~/.mouaif/store.sqlite  (settings.app.modelPricing)
{
  "gpt-4o-mini":        { "inputPer1K": 0.00015, "outputPer1K": 0.00060 },
  "claude-3-5-sonnet":  { "inputPer1K": 0.00300, "outputPer1K": 0.01500 }
}
```

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

## Behavior

- **Live counter, single turn.** The token/s counter only ticks for the turn that is currently streaming. When a new turn starts, it resets to `0` and follows the new assistant deltas.
- **Counter formula.** `tok/s = completionTokensDelivered / streamingMs`. The window starts on the first `message` delta of the turn and stops on `done` (or on the last delta before `error` / `EABORTED`). Sub-second windows are allowed.
- **No token guessing.** If the upstream did not report any `usage` event by the time the stream ends, both the cost and the token/s line show `--`. The chat does not estimate from characters.
- **Currency is USD only.** The model pricing block is denominated in USD. The format layer respects the user's locale decimal separator; the currency symbol stays `$`. A future `currency` field on the model record could add multi-currency support without breaking the existing shape.
- **Persisted with the message.** The full `usage` object returned by the AI client is stored on the assistant message record (decision §10) and is also written to the trace file as a `done` event (decision §5). Re-opening a chat shows the same numbers that were visible at the time the message was produced.
- **Subagents are included.** When the model delegates work to the native `subagent` tool, the nested model call's token usage is added to the parent chat turn's final `usage` block. Provider-reported costs are added too when the parent turn has an authoritative provider cost; otherwise the UI computes cost from the aggregated token usage.
- **Anthropic prompt-cache tokens are priced at the discounted tiers.** When the `usage` block carries `cacheReadTokens` / `cacheCreationTokens` (Anthropic only), `computeCost` charges the cached reads at the model's `cacheReadFactor` (default 10%) of the input rate, the cache writes at `cacheWriteFactor` (default 125%), and the remaining uncached prompt tokens at the full input rate — all multiplied by the model's own `inputPer1K`. The factors live on the pricing record so a model (or app-level override) can differ from the standard tiers. The `input` bucket stays the uncached portion so a `usage` block with no cache fields prices identically to before the feature. See [prompt-caching.md](./prompt-caching.md).
- **Pricing is informational.** A wrong `pricing` entry causes a wrong number on the cost line; it does not affect what the upstream charges. The Settings UI surfaces a "verify with your provider's pricing page" hint on the pricing fields.

## Implementation notes

- Source: `src/usage.js` (new module) — `computeCost(model, usage)`, `formatCost(amount)`, `tokPerSecond(samples)`.
- The AI client already emits `usage_input`, `usage_output`, and `done({ usage })` (see [docs/features/ai-client.md](./ai-client.md)). The new module is purely a derivation layer; it adds no events to the SSE stream.
- `src/ai.js` keeps parent prompt tokens as last-round-wins for normal tool loops, but tracks delegated subagent usage separately and adds it to the final `done({ usage, providerCost })` payload because subagents are separate upstream requests. Anthropic's prompt-cache read/write token counts are summed across tool rounds and ride the same final `usage` block.
- The chat UI hooks the existing `onEvent('message')` and `onEvent('done')` callbacks from `/api/chats/:id/messages/stream`; no protocol change is needed.
- The pricing resolution order is **model.pricing → app.modelPricing[<id>] → built-in defaults → none**. The built-in table lives in `src/usage.js` and is keyed on `model.id`.
- Mobile-first layout: the cost / token-s line renders as a single row of compact tokens (•-separated) under each user turn, sized for a 360 px viewport with no horizontal scroll. The line collapses to a single dot-summary (`gpt-4o-mini • •`) on very narrow screens if needed; the full row is the default.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `usage` events on `done`.
- [docs/features/chat-ui.md](./chat-ui.md) — chat composer, message rendering, and SSE hook points.
- [docs/features/app-and-project-settings.md](./app-and-project-settings.md) — `app.modelPricing` lives in the same SQLite store.
- Decision: [docs/decisions.md §14](../decisions.md) (this feature) and §10 (AI client usage events).
