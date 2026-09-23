# Anthropic OAuth

## Overview

`mouaif` runs the public Anthropic OAuth browser flow against `https://platform.claude.com`. The user signs in once; the resulting access and refresh tokens are stored in the OS keychain under `mouaif/anthropic`, scoped to the signed-in email. Subsequent calls to the Messages API use `Authorization: Bearer <access_token>` with the `anthropic-beta: oauth-2025-04-20` header required by user_oauth credentials.

The flow mirrors the official [`ant` CLI](https://github.com/anthropics/anthropic-cli) `auth login`, including the public `client_id`, the PKCE S256 challenge, the loopback callback, and the `state` validation on the token exchange.

## Usage

## Behavior

- **PKCE S256.** Verifier is 64 random bytes, base64url. `code_challenge_method=S256` on the authorize request; `code_verifier` on the token exchange. The verifier is stored on the pending record by `auth.recordPending` and is never round-tripped through the loopback callback.
- **State, 32 bytes base64url.** Validated on the loopback callback (browser path) **and** on the token exchange (Python oauth_server requires it as a bound CSRF check across both legs). The state is stored on the pending record and consumed atomically by `auth.consumePending` — replay is rejected with `ENOPENDING` (HTTP 400).
- **Default scope is `user:profile user:inference user:developer`.** The UI sends it on the start endpoint; the provider echoes it back in the token response and `mouaif` stores it on the keychain blob for future display.
- **Token endpoint: `POST https://api.anthropic.com/v1/oauth/token`.** The `authorization_code` grant is `application/x-www-form-urlencoded` with **no `anthropic-beta` header** (per the official `ant` CLI source comment: the beta routes the request to api-go's `userauth` handler, which only implements `jwt-bearer`). The `refresh_token` grant is `application/json` **with** `anthropic-beta: oauth-2025-04-20` (Python oauth_server requires it on the refresh grant for user_oauth credentials).
- **Authorization header on Messages API calls:** for `auth: 'oauth'` models the AI client sends `Authorization: Bearer <access_token>` and only the OAuth beta header, `anthropic-beta: oauth-2025-04-20`. It does not combine stale prompt-cache beta names with OAuth. For `auth: 'apikey'` models it sends `x-api-key` and `anthropic-version: 2023-06-01`; prompt caching is generally available and needs no beta header (see [prompt-caching.md](./prompt-caching.md)). The same provider can serve both flows; the header is decided at request time from `model.auth`.
- **Account resolution.** If the model has no `oauthAccount`, `auth.tokenForModel` looks up the single signed-in account on the keyring namespace. With multiple accounts the user must set `oauthAccount` explicitly.
- **Token lifetime.** The access token's lifetime is determined by the server. `expiresAt` is stored on the keychain blob. The refresh path is `oauthAnthropic.exchangeRefreshToken({ refreshToken })` and writes the new blob back via `auth.setToken`. **Proactive refresh:** the AI client (`src/ai.js → requireApiKey`) inspects the stored `expiresAt` before every chat. If the token is within `OAUTH_REFRESH_LEAD_MS` (60s) of expiry (or already past) and a `refresh_token` is stored, the registered Anthropic refresher swaps it for a fresh one and persists the new blob. The outbound request uses the new access token, so a long chat never hits a 401 mid-stream. Failures fall through to the stored token; the upstream's clean 401 is the recovery signal. The refresher is registered by `oauthAnthropic.register()` via `auth.registerRefresher('anthropic', refresh)`; other providers can register their own refresher the same way.

## Related

- Skeleton: [docs/features/auth.md](./auth.md) (keyring, account index, loopback callback).
- AI client: [docs/features/ai-client.md](./ai-client.md) (request builders, SSE parsers, error codes).
