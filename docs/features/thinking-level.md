# Thinking Level

## Overview

The thinking level is a lightweight parameter stored on the chat record (`thinkingLevel`). The dropdown options **come from the provider when available**: each model record may carry a `thinking` capability descriptor attached by the server, and the chat view builds its option list from it. When the provider reports nothing (unknown model, no live data yet), the dropdown falls back to the generic Low/Medium/High presets plus a custom input.

The selected value is sent to the AI provider's API as the appropriate native field:

- **OpenAI-compatible** (including OpenRouter, GitHub Copilot): maps to `reasoning_effort` — any provider-reported level is passed through verbatim (`"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, …)
- **Anthropic**, current models (Opus 4.6 and later, Sonnet 5 and later, every Claude 5 model): maps to adaptive thinking, `thinking: { type: "adaptive", display: "summarized" }` plus `output_config.effort` (`low` … `max`). These models reject a raw `budget_tokens`. A stored token budget is mapped to the nearest effort (≤4096 low, ≤12000 medium, ≤32000 high, above that xhigh), and a level the model lacks steps down to the closest one it has. `display: "summarized"` keeps the Thinking block filling in, since these models omit thinking text by default.
- **Anthropic**, older models (Sonnet 4 / 4.5, Opus 4 / 4.1 / 4.5, Haiku 4.5, Sonnet 3.7): maps to `thinking.budget_tokens` (low=2048, medium=8192, high=16384, or a custom number). The budget is capped at **100 000** tokens and at the model's output ceiling minus 4096, and `max_tokens` is raised to at least `budget + 4096` so the answer and any tool arguments have room after the thinking.
- In a tool round with thinking on, the Anthropic thinking blocks (with their signatures) are sent back unchanged ahead of the tool calls they produced; the API refuses the follow-up request otherwise.
- **Gemini** (2.5+ models): maps to `generationConfig.thinkingConfig.thinkingBudget`
- **Ollama**: maps to the boolean `think` flag on the chat request

## Thinking capability descriptors

Each model record may carry a `thinking` field describing the controls the provider accepts:

```json
{ "kind": "levels", "levels": ["minimal", "low", "medium", "high", "xhigh"] }
```

```json
{ "kind": "budget" }
```

```json
{ "kind": "toggle" }
```

Where the descriptor comes from, per provider:

- **OpenRouter** — parsed from the per-model `supported_parameters` on `GET /api/v1/models`. Models with `reasoning` support get `levels`; Anthropic-family slugs get `budget`.
- **OpenAI-compatible** — inferred statically from the model id (reasoning families: `o*`, `gpt-5*`, plus common third-party reasoning markers). The upstream `/models` endpoint does not report reasoning support, so this is a best-effort signal; unknown ids get no descriptor and the UI falls back to presets.
- **Anthropic** — the curated catalog marks adaptive-thinking models with `levels` (`low`, `medium`, `high`, `xhigh`, `max`; Opus 4.6 has no `xhigh`), older Claude models with `budget`, and Claude 3.5 and older with nothing.
- **Gemini** — `gemini-2.5` and newer ids are marked `budget`.
- **GitHub Copilot** — the curated catalog infers per family: OpenAI reasoning models → `levels`, Claude / Gemini 2.5+ → `budget`.
- **Ollama** — provider-level `toggle` descriptor (`think` boolean), applied to every project model on that provider via `/api/ai/models`.

## Usage

1. Open a chat.
2. Tap the **thinking level** dropdown next to the model picker.
3. Select one of the provider-reported options (or a preset when no provider info is available).
4. The value is persisted immediately on the chat record and takes effect on the next message sent.

When you pick a different model, the level follows it: a level the new model offers is kept, otherwise the closest one it has is saved instead (a toggle model gets "Thinking", a budget model gets Low/Medium/High). "No thinking" and models with no descriptor keep the value as it is.

### Fallback presets

| Label | Value | OpenAI | Anthropic | Gemini |
|-------|-------|--------|-----------|--------|
| No thinking | `""` (empty) | not sent | not sent | not sent |
| Low | `"low"` | `reasoning_effort: "low"` | `thinking.budget_tokens: 2048` | `thinkingConfig.thinkingBudget: 2048` |
| Medium | `"medium"` | `reasoning_effort: "medium"` | `thinking.budget_tokens: 8192` | `thinkingConfig.thinkingBudget: 8192` |
| High | `"high"` | `reasoning_effort: "high"` | `thinking.budget_tokens: 16384` | `thinkingConfig.thinkingBudget: 16384` |

When the provider reports a `levels` descriptor, its level list replaces the Low/Medium/High rows. A `budget` descriptor keeps the presets (mapped to token counts server-side) and adds the custom input. A `toggle` descriptor shows just "No thinking" / "Thinking".

### Custom values

For `levels` and `budget` models, select "Custom…" from the dropdown to reveal a full-width text input below the model controls. The field has a mobile-sized touch target and text that avoids automatic iOS input zoom. Type any value and press Enter or blur the field. The value is saved immediately. You can edit a saved custom value directly; background model-list refreshes preserve your draft instead of restoring the previous value.

- For Gemini and older Anthropic models, a numeric string is parsed as the token budget. Anthropic caps it (see above) and raises `max_tokens` to at least `budget_tokens + 4096`. Adaptive Anthropic models map the number to an effort level.
- For OpenAI-compatible providers, the value is passed as-is as `reasoning_effort`.

While the field is open, the dropdown stays on "Custom…" even if the model's reported level set is refreshed in the background: the catalog fetch that lands a few seconds after the chat opens no longer closes the field or drops the focus, so the keyboard stays up and the value can be typed.

**Leaving the field is not a dismissal.** Tapping the composer, the keyboard opening, and the closing native picker all move focus away, so the field deliberately stays visible on blur — a typed value is committed and the field then follows the stored value: a known level closes it and shows that level's label, a free-form number keeps it open. Press **Enter** to commit explicitly, including an empty field, which resets to "No thinking".
