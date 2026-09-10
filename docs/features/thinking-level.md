# Thinking Level

## Overview

The thinking level is a lightweight parameter stored on the chat record (`thinkingLevel`). The dropdown options **come from the provider when available**: each model record may carry a `thinking` capability descriptor attached by the server, and the chat view builds its option list from it. When the provider reports nothing (unknown model, no live data yet), the dropdown falls back to the generic Low/Medium/High presets plus a custom input.

The selected value is sent to the AI provider's API as the appropriate native field:

- **OpenAI-compatible** (including OpenRouter, GitHub Copilot): maps to `reasoning_effort` — any provider-reported level is passed through verbatim (`"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, …)
- **Anthropic**: maps to `thinking.budget_tokens` (low=2048, medium=8192, high=16384, or a custom number). A custom number is capped at **100 000** tokens, and `max_tokens` is raised to `min(budget, 100000) + 256` when it would otherwise be smaller — Anthropic rejects a request whose `max_tokens` does not clear its thinking budget, so both values come from the same capped number.
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
- **Anthropic** — the curated catalog marks every current Claude model as `budget`.
- **Gemini** — `gemini-2.5` and newer ids are marked `budget`.
- **GitHub Copilot** — the curated catalog infers per family: OpenAI reasoning models → `levels`, Claude / Gemini 2.5+ → `budget`.
- **Ollama** — provider-level `toggle` descriptor (`think` boolean), applied to every project model on that provider via `/api/ai/models`.

## Usage

1. Open a chat.
2. Tap the **thinking level** dropdown next to the model picker.
3. Select one of the provider-reported options (or a preset when no provider info is available).
4. The value is persisted immediately on the chat record and takes effect on the next message sent.

### Fallback presets

| Label | Value | OpenAI | Anthropic | Gemini |
|-------|-------|--------|-----------|--------|
| No thinking | `""` (empty) | not sent | not sent | not sent |
| Low | `"low"` | `reasoning_effort: "low"` | `thinking.budget_tokens: 2048` | `thinkingConfig.thinkingBudget: 2048` |
| Medium | `"medium"` | `reasoning_effort: "medium"` | `thinking.budget_tokens: 8192` | `thinkingConfig.thinkingBudget: 8192` |
| High | `"high"` | `reasoning_effort: "high"` | `thinking.budget_tokens: 16384` | `thinkingConfig.thinkingBudget: 16384` |

When the provider reports a `levels` descriptor, its level list replaces the Low/Medium/High rows. A `budget` descriptor keeps the presets (mapped to token counts server-side) and adds the custom input. A `toggle` descriptor shows just "No thinking" / "Thinking".

### Custom values

For `levels` and `budget` models, select "Custom…" from the dropdown to reveal a text input. Type any value and press Enter or blur the field. The value is saved immediately.

- For Anthropic and Gemini, a numeric string is parsed as the token budget. Anthropic caps at 100000 and raises `max_tokens` to at least `budget_tokens + 256`.
- For OpenAI-compatible providers, the value is passed as-is as `reasoning_effort`.
