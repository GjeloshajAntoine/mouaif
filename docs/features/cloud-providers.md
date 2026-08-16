# Cloud model providers

## Overview

`mouaif` ships with four additional first-class API-key providers on top of the original six: **Azure OpenAI**, **Mistral**, **Groq**, and **DeepSeek**. All four are OpenAI-shaped at the wire level — the same `/chat/completions` SSE contract and the same `/models` catalog shape — so they reuse the existing openai-compatible request builder, SSE parser, tool loop, and usage accounting. Adding them was a localized change: one `ENDPOINTS` entry (with a `listModels` adapter) in `src/ai-endpoints.js`, a row in the Settings providers list, and a keyring-namespace mapping in `src/auth.js`.

## Usage

### Add a provider

1. **Settings → Providers → + Add provider.**
2. Pick the provider from the dropdown:
   - **Azure OpenAI** — paste the resource key. The **API base URL** must be the full deployment URL, e.g. `https://<resource>.openai.azure.com/openai/deployments/<deployment>`. The deployment name is the model id on the chat side. The `api-version` query parameter is appended automatically (default `2024-10-21`; override per project model via `model.apiVersion`).
   - **Mistral** — default base URL `https://api.mistral.ai/v1`. Paste a key from [console.mistral.ai](https://console.mistral.ai).
   - **Groq** — default base URL `https://api.groq.com/openai/v1`. Paste a key from [console.groq.com](https://console.groq.com).
   - **DeepSeek** — default base URL `https://api.deepseek.com`. Paste a key from [platform.deepseek.com](https://platform.deepseek.com).
3. **Save provider.** All four are API-key only — the Settings form shows no OAuth option for them.

### Add a model

In the project's **Models** editor set `provider` to `azure` / `mistral` / `groq` / `deepseek` and `id` to the model id (for Azure, the deployment name):

```jsonc
// <projectDir>/.mouaif.json
{
  "models": [
    { "id": "gpt-4o", "provider": "azure", "label": "GPT-4o (my deployment)", "apiVersion": "2024-10-21" },
    { "id": "mistral-large-latest", "provider": "mistral", "label": "Mistral Large" },
    { "id": "llama-3.3-70b-versatile", "provider": "groq", "label": "Llama 3.3 70B" },
    { "id": "deepseek-chat", "provider": "deepseek", "label": "DeepSeek Chat" }
  ]
}
```

The live model catalog (chat head refresh ↻) pulls each provider's real `/models` list, so picking from the picker works without hand-editing JSON.

### Chat

No special path. The chat composer posts to `/api/chats/:id/messages/stream`, which hydrates the project model with the provider connection and streams SSE exactly like the other OpenAI-shaped providers. Tool calls, the multi-turn loop, usage/cost lines, and prompt-size profiles all work unchanged.

## Behavior

- **OpenAI-shaped wire protocol.** All four use the OpenAI chat-completions request/response shape, so they share `buildOpenAIRequest` and `parseOpenAISSE`. Streaming requests set `stream_options.include_usage` so the Context/Cost line has authoritative token counts (Azure needs `api-version` ≥ `2024-10-21` for this).
- **Azure specifics.** Auth is the `api-key` header (the OpenAI `Authorization: Bearer` header is not sent). The base URL is the deployment URL; `api-version` is appended after `/chat/completions`. The default api-version is `2024-10-21`; a project model may set `apiVersion` to pin a different one (e.g. a preview API or an Entra-ID proxy).
- **Mistral / Groq / DeepSeek specifics.** Plain `Authorization: Bearer <key>` against their `/chat/completions`; model catalogs are fetched from their `/models` endpoints. Missing keys surface as `ENO_APIKEY` (the chat UI says "add API key in Settings → Providers") instead of a generic upstream 401.
- **Thinking levels.** Reasoning families on these OpenAI-shaped endpoints (DeepSeek `deepseek-reasoner` / `deepseek-r1`, Qwen `qwq` / `-thinking` variants, Groq's `qwen-qwq-32b`) are inferred by `thinkingForOpenAIModel` and advertised as effort levels, so the chat thinking dropdown works without a client update.
- **Pricing.** Built-in defaults were added for common Mistral, Groq, and DeepSeek model ids in `src/usage.js`; unknown ids fall back to `--` on the cost line (or a per-model `pricing` override).
- **No OAuth.** All four are API-key-only. `AI_TO_AUTH_PROVIDER` maps each to its own keyring namespace (`azure`, `mistral`, `groq`, `deepseek`) so a key stored under one provider is never reused as a credential for another.

## Related

- [docs/features/ai-client.md](./ai-client.md) — the proxy architecture all providers ride on.
- [docs/features/settings-ui.md](./settings-ui.md) — the provider form that renders `SETTINGS_PROVIDERS`.
- [docs/features/usage-metrics.md](./usage-metrics.md) — cost line behavior and pricing resolution.
