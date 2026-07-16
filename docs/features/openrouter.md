# OpenRouter provider

## Overview

OpenRouter is a single API key that fronts many upstream models (Anthropic, OpenAI, Google, Meta, Mistral, and others) over one OpenAI-shaped endpoint. `mouaif` treats it as a first-class provider: same UI flow as any other provider, same SSE streaming, same usage accounting — but the user only has to manage one key to access models from many vendors.

The provider is **API-key only**. OpenRouter does not expose an OAuth flow for third-party clients, so `mouaif` does not ship a sign-in screen for it; the user pastes the key issued at [openrouter.ai](https://openrouter.ai) into the provider form, same as the OpenAI-compatible path.

## Usage

### Add the provider

1. **Settings → Providers → + Add provider.**
2. Pick **OpenRouter** from the provider dropdown. The default API base URL is `https://openrouter.ai/api/v1` (overridable for self-hosted/proxy setups).
3. Paste your OpenRouter API key. The key is stored in the OS keychain (the same `openai` namespace the OpenAI-compatible provider uses) and never returned to the browser after save.
4. **Save provider.** You can now pick OpenRouter when creating a model on a project.

### Add a model

1. In a project, open the project's **Models** editor.
2. Set `provider: 'openrouter'` and `id` to the OpenRouter model slug as listed on [openrouter.ai/models](https://openrouter.ai/models). For example:

   ```json
   {
     "id": "anthropic/claude-3.5-sonnet",
     "provider": "openrouter",
     "label": "Claude 3.5 Sonnet (via OpenRouter)"
   }
   ```

   The full upstream `id` (including the vendor prefix) is sent verbatim in the chat-completions `model` field.

3. The model now appears in the chat head's model picker for any chat in this project.

### Chat

No special path. The chat composer posts to `/api/chats/:id/messages/stream`, which hydrates the project's model with the OpenRouter provider connection, calls `https://openrouter.ai/api/v1/chat/completions`, and forwards events as SSE. The model picker shows the friendly label; the chat transcript and usage display are identical to every other provider.

## Behavior

- **OpenAI-shaped wire protocol.** OpenRouter accepts and returns the standard OpenAI chat-completions format, so `mouaif` reuses the openai-compatible builder and parser. The body shape is `{ model, messages, stream, ... }`; the response is `text/event-stream` ending with the literal `[DONE]` sentinel.
- **Attribution headers.** Every request carries `HTTP-Referer: https://mouaif.local` and `X-Title: mouaif` static headers, per [OpenRouter's docs](https://openrouter.ai/docs/api-reference/overview). These identify the app on the public leaderboard; they do not send PII. They can be overridden per-request by `model.headers` for testing.
- **No OAuth.** Choosing OAuth in the provider form is not offered — there is no server-side flow registered, and offering it would 404. The form auto-hides the auth select for OpenRouter (singleAuth = true) and only shows the API-key field.
- **Single credential store.** The OpenRouter key is stored under the `openai` keyring namespace. The mapping from AI client provider (`openrouter`) to keyring namespace (`openai`) lives in [src/auth.js](../../src/auth.js) `AI_TO_AUTH_PROVIDER`. This means an OpenAI API key already in the keychain does NOT double as an OpenRouter key — the two are different services with different billing.
- **Model id is the OpenRouter slug.** OpenRouter catalogs models with a `<vendor>/<name>` prefix; pass it through unchanged. The chat-completions body is built from `model.id` with no transformation.
- **No per-model pricing yet.** OpenRouter's pricing is per-model and changes; the project's model record carries a `pricing` block you can set by hand, otherwise the chat uses the app-wide default pricing.
- **Errors are typed.** The same `EUPSTREAM` / `EUNKNOWN_PROVIDER` / `ENOAPIKEY` mapping as every other provider applies. A bad model slug returns 400 from OpenRouter and the proxy surfaces the message as `EUPSTREAM`.

## Implementation notes

- **Source: [src/ai.js](../../src/ai.js).** The provider is registered as a single entry in `ENDPOINTS` (with `baseUrl`, `chatPath`, `authHeader`, and `staticHeaders`) and reuses the existing `buildOpenAIRequest` and `parseOpenAISSE`. No new builder or parser was needed.
- **Auth mapping: [src/auth.js](../../src/auth.js) → `AI_TO_AUTH_PROVIDER`.** `'openrouter' → 'openai'`. The keyring entry is keyed `mouaif/openai/<account>`. The `account` slot is the OpenAI-style account string (the user can leave it blank to use the `default` slot).
- **UI: [src/web/src/api.js](../../src/web/src/api.js) → `SETTINGS_PROVIDERS`.** One row in the list. No `oauth: true` and no `reserved: true`, so the SettingsProviders form auto-hides the OAuth select and Sign in button — the form just shows the base URL + API key fields.
- **No new endpoint.** The existing `/api/ai/chat`, `/api/ai/test`, and `/api/ai/models` routes pick up the new provider for free; model resolution already filters by the project's model list, and providers are looked up by id.
- **Latent bug fixed.** `buildOpenAIRequest` used to call `joinUrl(model.baseUrl, ...)` without a fallback, so an empty saved `baseUrl` would collapse the URL to the relative path `/chat/completions`. The builder now falls back to the per-provider `defaultBaseUrl` when the record's `baseUrl` is empty. The Settings UI snaps to `defaultBaseUrl` on save, but hand-edited `.mouaif.json` files or future providers that forget to set one are now safe.
- **Tests: [scripts/test-openrouter.js](../../scripts/test-openrouter.js).** 21 assertions: `authProviderFor` mapping, request URL, Authorization header, HTTP-Referer + X-Title static headers, no Copilot Editor-Version leakage, body shape, and end-to-end `streamChat` round-trip with a mocked fetch (parses the SSE, emits a `message` event, emits a `done` event with usage).
- **No new keyring namespace.** `SUPPORTED_PROVIDERS` in [src/auth.js](../../src/auth.js) is unchanged; OpenRouter borrows the existing `openai` namespace rather than introducing a parallel one. This keeps the OAuth account picker (which is the only thing that iterates `SUPPORTED_PROVIDERS`) stable.

## Related

- [AI client](./ai-client.md) — the parent feature, including the wire-protocol details and the model record shape.
- [App and project settings](./app-and-project-settings.md) — where provider connections live.
- [Settings UI](./settings-ui.md) — the mobile Providers screen where OpenRouter is configured.
- [decisions.md §10](../decisions.md) — the original AI client core spec.
