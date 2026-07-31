# OpenRouter provider

## Overview

OpenRouter is a single API key that fronts many upstream models (Anthropic, OpenAI, Google, Meta, Mistral, and others) over one OpenAI-shaped endpoint. `mouaif` treats it as a first-class provider: same UI flow as any other provider, same SSE streaming, same usage accounting — but the user only has to manage one key to access models from many vendors.

The provider supports **two ways to authenticate**:

1. **Paste an OpenRouter API key** (issued at [openrouter.ai](https://openrouter.ai/keys)). The key is stored in the app SQLite provider record and never returned to the browser after save.
2. **Sign in with OpenRouter (PKCE).** The Settings → Providers form now offers a `Sign in with OpenRouter` button. The browser is sent to `https://openrouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256`, the user authorises the app, OpenRouter redirects back to the loopback, the server exchanges the `code` for a user-controlled OpenRouter API key at `https://openrouter.ai/api/v1/auth/keys`, and the key is stored in the OS keyring under the `openrouter` namespace. Subsequent chats use that key as a plain Bearer credential.

The PKCE flow is the only sign-in option OpenRouter exposes to third-party clients; there is no client_id, no client_secret, no per-app dashboard, and no refresh-token grant. The flow's "OAuth" surface is therefore narrower than Anthropic's or GitHub Copilot's, but it still ships a sign-in button on the provider form so the user can authorise the app in one tap rather than round-tripping through the OpenRouter keys page.

## Usage

### Add the provider

1. **Settings → Providers → + Add provider.**
2. Pick **OpenRouter** from the provider dropdown. The default API base URL is `https://openrouter.ai/api/v1` (overridable for self-hosted/proxy setups).
3. Pick an authentication mode:
   - **API key** — paste your OpenRouter key. The key lives in the app store (encrypted at rest by the host OS, see [`app-and-project-settings`](./app-and-project-settings.md)). The apikey path does not touch the keyring.
   - **OAuth (PKCE)** — tap **Sign in with OpenRouter** in the provider form. The browser opens `https://openrouter.ai/auth`, the user signs in and grants the request, OpenRouter redirects back to the loopback, and the resulting OpenRouter API key is stored in the OS keyring under the `openrouter` namespace. The account picker shows a short label derived from the key (e.g. `sk-or-v1-mock-12`) so the user can tell two sign-ins apart without exposing the full secret.
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

No special path. The chat composer posts to `/api/chats/:id/messages/stream`, which hydrates the project's model with the OpenRouter provider connection, calls `https://openrouter.ai/api/v1/chat/completions`, and forwards events as SSE. The model picker shows the friendly label; the chat transcript and usage display are identical to every other provider. The key path is transparent: a key obtained via PKCE is used exactly the same way a manually pasted key is.

## Behavior

- **OpenAI-shaped wire protocol.** OpenRouter accepts and returns the standard OpenAI chat-completions format, so `mouaif` reuses the openai-compatible builder and parser. The body shape is `{ model, messages, stream, ... }`; the response is `text/event-stream` ending with the literal `[DONE]` sentinel.
- **Attribution headers.** Every request carries `HTTP-Referer: <url>` and `X-OpenRouter-Title: <app name>` (plus the deprecated alias `X-Title: <app name>`), per [OpenRouter's docs](https://openrouter.ai/docs/api-reference/overview). `X-OpenRouter-Title` is the canonical attribution header on current OpenRouter releases (the older `X-Title` is silently dropped on the SSO/leaderboard path, so we send both). The shipped defaults are `mouaif` for the title and `https://mouaif.local` for the referer URL. Both headers do not send PII. They can be overridden per-request by `model.headers` for testing.
- **OAuth via PKCE.** The flow follows [OpenRouter's documented PKCE guide](https://openrouter.ai/docs/guides/overview/auth/oauth):
  - Authorize: `https://openrouter.ai/auth?callback_url=<loopback>&code_challenge=<sha256(verifier)>&code_challenge_method=S256&state=<state>`.
  - Token: `POST https://openrouter.ai/api/v1/auth/keys` with JSON body `{ code, code_verifier, code_challenge_method: 'S256' }`.
  - Response: `{ key }` — a user-controlled OpenRouter API key.
  The key is stored as the `accessToken` field of a standard OAuth blob, with `refreshToken: null` and `expiresAt: null` (OpenRouter keys do not expire unless revoked).
- **No refresh-token grant.** OpenRouter's PKCE flow does not issue a refresh token. A leaked or revoked key is irrecoverable through the OAuth path; the user re-runs Sign in to receive a new key. The `auth.registerRefresher('openrouter', ...)` call in `src/oauth-openrouter.js` therefore registers a no-op refresher — `expiresAt` is always `null` so the AI client's proactive-refresh code path never fires.
- **Account naming.** Each sign-in produces a separate row in the OAuth account picker. The label is the first 16 characters of the issued key (e.g. `sk-or-v1-mock-12`); that is unique enough to be useful in a phone-sized picker without leaking the full secret.
- **Separate keyring namespace.** OpenRouter has its own keyring namespace (`openrouter`), added to `SUPPORTED_PROVIDERS` in [src/auth.js](../../src/auth.js). The AI client maps `provider: 'openrouter'` to the auth namespace `openrouter` in `AI_TO_AUTH_PROVIDER`; the prior `openai` mapping was removed. An OpenAI key in the `openai` keyring is NOT a valid OpenRouter credential — the two services have different billing — so the namespaces stay isolated.
- **Loopback callback is shared.** The existing `/oauth/callback` handler in [src/index.js](../../src/index.js) already routes by `?provider=...`. The OpenRouter flow is invoked with `?provider=openrouter`; the registered exchange (`auth.getExchange('openrouter')`) maps the response `{ key }` to the standard OAuth blob and `auth.setToken` writes the keyring entry.
- **Model id is the OpenRouter slug.** OpenRouter catalogs models with a `<vendor>/<name>` prefix; pass it through unchanged. The chat-completions body is built from `model.id` with no transformation.
- **Provider balance.** The chat head asks `GET /api/ai/provider-credit?provider=openrouter`, which calls OpenRouter's `/credits` endpoint with the active API key or PKCE-issued key. When OpenRouter returns totals, the head shows `Balance $…`; unsupported providers hide the pill.
- **Per-model pricing from the live catalog.** OpenRouter's `GET /api/v1/models` advertises real per-model prices (`pricing.prompt` / `pricing.completion`, $ per token) plus prompt-cache rates (`pricing.input_cache_read` / `pricing.input_cache_write`, $ per token; some models ship the equivalent `prompt_cache_read_breakpoints` / `prompt_cache_write_breakpoints` arrays). The live-model parser folds these into each model record as a `pricing` block (`inputPer1K` / `outputPer1K` / `cacheReadFactor` / `cacheWriteFactor`), and `resolveModel` picks that block up from the in-memory live cache so the chat cost line uses the provider's actual numbers. Hand-written `pricing` on a project model record still wins; the app-wide default table is the fallback for models the live API didn't price. See [prompt-caching.md](./prompt-caching.md).
- **Errors are typed.** The same `EUPSTREAM` / `EUNKNOWN_PROVIDER` / `ENOAPIKEY` / `ENOAUTH` mapping as every other provider applies. A bad model slug returns 400 from OpenRouter and the proxy surfaces the message as `EUPSTREAM`. A bad `code` on the exchange returns 400 from OpenRouter with `{ error: { message, code } }`; the server maps it to a typed `EOAUTH` with `oauthError` set to the message string.

- **Implementation notes**

- **Source: [src/ai.js](../../src/ai.js).** The provider is registered as a single entry in `ENDPOINTS` (with `baseUrl`, `chatPath`, `authHeader`, and `staticHeaders`) and reuses the existing `buildOpenAIRequest` and `parseOpenAISSE`. No new builder or parser was needed. The live-model parser (`parseOpenAIShapedModels`) additionally reads the per-model `pricing` and the prompt-cache rates from the `/models` response.
- **PKCE module: [src/oauth-openrouter.js](../../src/oauth-openrouter.js).** The per-provider sign-in flow. Public surface: `register()`, `buildAuthorizeUrl({ callbackUrl, state, verifier })`, `exchangeAuthorizationCode({ code, verifier })`, `accountForKey(key)`. `register()` is called once at server startup from [src/index.js](../../src/index.js); it wires `auth.registerExchange('openrouter', exchange)` and `auth.registerRefresher('openrouter', refresh)`. The refresher is a no-op (returns the existing blob with `expiresAt: null`) because OpenRouter keys cannot be refreshed.
- **Auth mapping: [src/auth.js](../../src/auth.js) → `AI_TO_AUTH_PROVIDER`.** `'openrouter' → 'openrouter'`. The keyring entry is keyed `mouaif/openrouter/<account>`. The `account` slot is the first 16 chars of the OpenRouter key (e.g. `sk-or-v1-mock-12`) so the OAuth account picker can show one row per signed-in key without exposing the full secret.
- **REST: `POST /api/auth/sign-in/openrouter`** in [src/index.js](../../src/index.js). Returns `{ authorizeUrl, redirectUri, state, expiresAt, apiBase }`. The `redirectUri` is the loopback callback (`http://127.0.0.1:5732/oauth/callback?provider=openrouter`) so the shared `finishOAuth` handler routes the redirect to the right exchange. Returns 501 when the build does not register the exchange (e.g. when `oauthOpenRouter.register()` was never called).
- **UI: [src/web/src/api.js](../../src/web/src/api.js) → `SETTINGS_PROVIDERS`.** The OpenRouter row carries `oauth: true`, which makes the SettingsProviders form render the auth `<select>` (with both `API key` and `OAuth` options) and the Sign in button. Reserved providers (GitHub Copilot) skip the auth select entirely; OpenRouter now shows it because both modes are valid.
- **No new AI client code.** The AI client treats the OAuth blob the same way the apikey path does: `requireApiKey` reads `model.__accessToken` after the OAuth path resolves the key from the keyring, and the OpenRouter `ENDPOINTS` entry's `authHeader(cred)` emits `Authorization: Bearer <cred>` for either origin. No new `if (provider === 'openrouter')` branches in [src/ai.js](../../src/ai.js).
- **Latent bug fixed.** `buildOpenAIRequest` used to call `joinUrl(model.baseUrl, ...)` without a fallback, so an empty saved `baseUrl` would collapse the URL to the relative path `/chat/completions`. The builder now falls back to the per-provider `defaultBaseUrl` when the record's `baseUrl` is empty. The Settings UI snaps to `defaultBaseUrl` on save, but hand-edited `.mouaif.json` files or future providers that forget to set one are now safe.
- **Tests: [scripts/test-openrouter.js](../../scripts/test-openrouter.js).** 50 assertions: `authProviderFor` mapping, request URL, Authorization header, HTTP-Referer + X-OpenRouter-Title + X-Title static headers, no Copilot Editor-Version leakage, body shape, end-to-end `streamChat` round-trip with a mocked fetch (parses the SSE, emits a `message` event, emits a `done` event with usage), `SUPPORTED_PROVIDERS` membership, `buildAuthorizeUrl` URL shape, `code_challenge = base64url(sha256(verifier))` invariant, `accountForKey` short-label helper, `exchangeAuthorizationCode` request body, the registered `exchange` / `refresh` shape.
- **New keyring namespace.** `SUPPORTED_PROVIDERS` in [src/auth.js](../../src/auth.js) gains `'openrouter'`. The OAuth account picker (which is the only place that iterates `SUPPORTED_PROVIDERS`) therefore lists OpenRouter as a separate column; the `authNsForProvider` helper in [src/web/src/api.js](../../src/web/src/api.js) returns `'openrouter'` for the OpenRouter model, so the picker queries the right keyring row.

## Related

- [AI client](./ai-client.md) — the parent feature, including the wire-protocol details and the model record shape.
- [App and project settings](./app-and-project-settings.md) — where provider connections live.
- [Settings UI](./settings-ui.md) — the mobile Providers screen where OpenRouter is configured.
- [Anthropic OAuth](./oauth-anthropic.md) — the per-provider OAuth flow for Anthropic, which the OpenRouter flow parallels in shape (PKCE → token exchange → keyring).
- [decisions.md §10](../decisions.md) — the original AI client core spec.
