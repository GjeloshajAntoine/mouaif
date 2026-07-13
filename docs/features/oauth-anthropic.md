# Anthropic OAuth

## Overview

`mouaif` runs the public Anthropic OAuth browser flow against `https://platform.claude.com`. The user signs in once; the resulting access and refresh tokens are stored in the OS keychain under `mouaif/anthropic`, scoped to the signed-in email. Subsequent calls to the Messages API use `Authorization: Bearer <access_token>` with the `anthropic-beta: oauth-2025-04-20` header required by user_oauth credentials.

Implements [docs/decisions.md §12](../decisions.md) (per-provider OAuth). The flow mirrors the official [`ant` CLI](https://github.com/anthropics/anthropic-cli) `auth login`, including the public `client_id`, the PKCE S256 challenge, the loopback callback, and the `state` validation on the token exchange.

## Usage

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| POST   | `/api/auth/sign-in/anthropic` | `{}` (or `{ redirectUri?, scope?, accountHint? }`) | `{ authorizeUrl, state, expiresAt, apiBase }` |
| GET    | `/oauth/callback?provider=anthropic&state=...&code=...` | (browser redirect) | HTML page |
| POST   | `/oauth/callback` | `{ provider, state, code }` | `{ ok: true, provider, account }` or `{ ok: false, error, code }` (no-browser fallback) |

The UI flow is `POST /api/auth/sign-in/anthropic` → open `authorizeUrl` in a new tab → on success the browser comes back to `GET /oauth/callback`, which finishes the flow and writes the token to the keychain. The UI polls `GET /api/auth/accounts` until the new email appears.

The no-browser fallback (`POST /oauth/callback`) is for SSH, containers, and any environment where the user can't open the loopback URL in a browser that can reach the mouaif server. The user pastes the `code` (or the full redirect URL) into the UI, which POSTs it to the same exchange the browser path uses.

### Model record

```js
{
  id: 'claude-opus-4-8',
  provider: 'anthropic',
  authProvider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',  // optional; default for OAuth too
  auth: 'oauth',
  oauthAccount: 'me@example.com',         // optional; auto-resolved if exactly one
  contextWindow: 200000
}
```

`provider: 'anthropic'` is the AI client namespace (request shape, SSE parser, bearer auth). `authProvider: 'anthropic'` is the keyring namespace. For Anthropic they happen to be the same string; the split is here because `openai-compatible` (the AI client namespace for OpenAI) and `openai` (the keyring namespace for the Codex flow) are different.

### Programmatic (Node)

```js
const oauthAnthropic = require('mouaif/src/oauth-anthropic.js');
const auth = require('mouaif/src/auth.js');

// Register the per-provider exchange function. Idempotent.
oauthAnthropic.register();

// The exchange function expects the pending record created by
// auth.recordPending('anthropic', { state, codeVerifier, redirectUri, scopes, accountHint }).
const fn = auth.getExchange('anthropic');
const out = await fn({ pending, code: 'AUTHCODE99' });
// out: { accessToken, refreshToken, expiresAt, scope, account }
```

## Behavior

- **PKCE S256.** Verifier is 64 random bytes, base64url. `code_challenge_method=S256` on the authorize request; `code_verifier` on the token exchange. The verifier is stored on the pending record by `auth.recordPending` and is never round-tripped through the loopback callback.
- **State, 32 bytes base64url.** Validated on the loopback callback (browser path) **and** on the token exchange (Python oauth_server requires it as a bound CSRF check across both legs). The state is stored on the pending record and consumed atomically by `auth.consumePending` — replay is rejected with `ENOPENDING` (HTTP 400).
- **Default scope is `user:profile user:inference user:developer`.** The UI sends it on the start endpoint; the provider echoes it back in the token response and `mouaif` stores it on the keychain blob for future display.
- **Token endpoint: `POST https://api.anthropic.com/v1/oauth/token`.** The `authorization_code` grant is `application/x-www-form-urlencoded` with **no `anthropic-beta` header** (per the official `ant` CLI source comment: the beta routes the request to api-go's `userauth` handler, which only implements `jwt-bearer`). The `refresh_token` grant is `application/json` **with** `anthropic-beta: oauth-2025-04-20` (Python oauth_server requires it on the refresh grant for user_oauth credentials).
- **Authorization header on Messages API calls:** for `auth: 'oauth'` models the AI client sends `Authorization: Bearer <access_token>` and `anthropic-beta: oauth-2025-04-20`. For `auth: 'apikey'` models it sends `x-api-key` and `anthropic-version: 2023-06-01`. The same provider can serve both flows; the header is decided at request time from `model.auth`.
- **Account resolution.** If the model has no `oauthAccount`, `auth.tokenForModel` looks up the single signed-in account on the keyring namespace. With multiple accounts the user must set `oauthAccount` explicitly.
- **Token lifetime.** The access token's lifetime is determined by the server. `expiresAt` is stored on the keychain blob for future refresh scheduling. The refresh path is `oauthAnthropic.exchangeRefreshToken({ refreshToken })` and writes the new blob back via `auth.setToken`. (Refresh is implemented in the module; the chat proxy does not yet auto-refresh mid-call — that lands with the Google OAuth commit which shares the same shape.)

## Implementation notes

- Source: [src/oauth-anthropic.js](../../src/oauth-anthropic.js). Public surface: `register`, `exchange` (registered with `auth.registerExchange`), `buildAuthorizeUrl`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, plus `newState`, `newVerifier`, `challengeFor` for tests. Introspection: `CLIENT_ID`, `DEFAULT_CONSOLE_URL`, `DEFAULT_API_BASE`, `DEFAULT_SCOPE`, `BETA_HEADER`.
- Server wiring: [src/index.js](../../src/index.js). The `POST /api/auth/sign-in/anthropic` handler is in `handleAuth`. The loopback callback is `handleOAuthCallback` (GET, browser) and `handleOAuthCallbackPost` (POST, no-browser fallback); both share `finishOAuth()`.
- The AI client is updated to send `Authorization: Bearer ...` and the OAuth beta for `auth: 'oauth'` Anthropic models ([src/ai.js](../../src/ai.js) → `ENDPOINTS.anthropic.authHeader`).
- `MOUAIF_ANTHROPIC_API_BASE` env var overrides the default `https://api.anthropic.com` for tests. **Do not set this in production** — it would point your sign-in at an untrusted server.
- Mobile UI: [src/web/index.html](../../src/web/index.html) has a "Sign in with Anthropic" button that opens the authorize URL in a new tab and polls for the new account. A no-browser fallback below it accepts the `code` (or the full redirect URL) and POSTs it to the callback.

## Related

- Decision: [docs/decisions.md §12](../decisions.md) (per-provider OAuth).
- Skeleton: [docs/features/auth.md](./auth.md) (keyring, account index, loopback callback).
- AI client: [docs/features/ai-client.md](./ai-client.md) (request builders, SSE parsers, error codes).
