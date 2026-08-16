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
- **Loopback callback is shared.** The existing `/oauth/callback` handler in [src/server-handlers-auth.js](../../src/server-handlers-auth.js) already routes by `?provider=...`. The OpenRouter flow is invoked with `?provider=openrouter`; the registered exchange (`auth.getExchange('openrouter')`) maps the response `{ key }` to the standard OAuth blob and `auth.setToken` writes the keyring entry. The callback URL is derived from the served origin (public origin or `Host`), so the redirect arrives back at the same origin the user loaded the app from — loopback, LAN IP, or domain name.
- **iOS PWA / popup-blocked sign-in.** The callback route is exempt from the same-origin session gate and the access-auth gate (see [auth.md](./auth.md)), so a top-level redirect-back from `openrouter.ai` — with a cross-site `Origin` and no cookie, as produced by Safari's SVC isolation, a blocked popup, or an iOS PWA web-preview tab — reaches the exchange instead of a 403. The callback page then closes the popup (when one exists) or `location.replace`s back to `/`, so the PWA lands in the app and the Settings → Providers account list refreshes with the new key.
- **Model id is the OpenRouter slug.** OpenRouter catalogs models with a `<vendor>/<name>` prefix; pass it through unchanged. The chat-completions body is built from `model.id` with no transformation.
- **Provider balance.** The chat head asks `GET /api/ai/provider-credit?provider=openrouter`, which calls OpenRouter's `/credits` endpoint with the active API key or PKCE-issued key. When OpenRouter returns totals, the head shows `Balance $…`; unsupported providers hide the pill.
- **Per-model pricing from the live catalog.** OpenRouter's `GET /api/v1/models` advertises real per-model prices (`pricing.prompt` / `pricing.completion`, $ per token) plus prompt-cache rates (`pricing.input_cache_read` / `pricing.input_cache_write`, $ per token; some models ship the equivalent `prompt_cache_read_breakpoints` / `prompt_cache_write_breakpoints` arrays). The live-model parser folds these into each model record as a `pricing` block (`inputPer1K` / `outputPer1K` / `cacheReadFactor` / `cacheWriteFactor`), and `resolveModel` picks that block up from the in-memory live cache so the chat cost line uses the provider's actual numbers. Hand-written `pricing` on a project model record still wins; the app-wide default table is the fallback for models the live API didn't price. See [prompt-caching.md](./prompt-caching.md).
- **Errors are typed.** The same `EUPSTREAM` / `EUNKNOWN_PROVIDER` / `ENOAPIKEY` / `ENOAUTH` mapping as every other provider applies. A bad model slug returns 400 from OpenRouter and the proxy surfaces the message as `EUPSTREAM`. A bad `code` on the exchange returns 400 from OpenRouter with `{ error: { message, code } }`; the server maps it to a typed `EOAUTH` with `oauthError` set to the message string.

## Related

- [AI client](./ai-client.md) — the parent feature, including the wire-protocol details and the model record shape.
- [App and project settings](./app-and-project-settings.md) — where provider connections live.
- [Settings UI](./settings-ui.md) — the mobile Providers screen where OpenRouter is configured.
- [Anthropic OAuth](./oauth-anthropic.md) — the per-provider OAuth flow for Anthropic, which the OpenRouter flow parallels in shape (PKCE → token exchange → keyring).
- [decisions.md §10](../decisions.md) — the original AI client core spec.
