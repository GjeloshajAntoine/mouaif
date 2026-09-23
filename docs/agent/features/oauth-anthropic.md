# Anthropic OAuth — implementation notes

> Agent-facing reference for [`docs/features/oauth-anthropic.md`](../../features/oauth-anthropic.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| POST   | `/api/auth/sign-in/anthropic` | `{}` (or `{ redirectUri?, scope?, accountHint? }`) | `{ authorizeUrl, state, expiresAt, apiBase }` |
| GET    | `/oauth/callback?provider=anthropic&state=...&code=...` | (browser redirect) | HTML page |
| POST   | `/oauth/callback` | `{ provider, state, code }` | `{ ok: true, provider, account }` or `{ ok: false, error, code }` (no-browser fallback) |

The UI flow is two explicit taps so popup blockers cannot intercept it: **Sign in** calls `POST /api/auth/sign-in/anthropic` and reveals a real **Continue with Anthropic** link; tapping that link opens `authorizeUrl` in a new tab. On success the browser comes back to `GET /oauth/callback`, which finishes the flow and writes the token to the keychain. The UI polls `GET /api/auth/accounts` until the new email appears.

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

## Implementation notes

- The loopback redirect URI includes `?provider=anthropic`. The callback is
  shared by providers, so this query parameter binds the returned code and
  state to the Anthropic exchange handler. The sign-in response also returns
  the exact `redirectUri` shown by the no-browser fallback UI.
- The pending state and authorization URL live in Preact refs. Periodic auth
  status refreshes can re-render the panel without losing the state required
  by the manual code-paste fallback.

- Source: [src/oauth-anthropic.js](../../../src/oauth-anthropic.js). Public surface: `register`, `exchange` (registered with `auth.registerExchange`), `refresh` (registered with `auth.registerRefresher`), `buildAuthorizeUrl`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, plus `newState`, `newVerifier`, `challengeFor` for tests. Introspection: `CLIENT_ID`, `DEFAULT_CONSOLE_URL`, `DEFAULT_API_BASE`, `DEFAULT_SCOPE`, `BETA_HEADER`.
- Server wiring: [src/server-handlers-auth.js](../../../src/server-handlers-auth.js). The `POST /api/auth/sign-in/anthropic` handler is in `handleAuth`. The loopback callback is `handleOAuthCallback` (GET, browser) and `handleOAuthCallbackPost` (POST, no-browser fallback); both share `finishOAuth()`. The exchange is registered at module load via `oauthAnthropic.register()` from [src/server-shared.js](../../../src/server-shared.js).
- The AI client is updated to send `Authorization: Bearer ...` and the OAuth beta for `auth: 'oauth'` Anthropic models ([src/ai.js](../../../src/ai.js) → `ENDPOINTS.anthropic.authHeader`).
- `MOUAIF_ANTHROPIC_API_BASE` env var overrides the default `https://api.anthropic.com` for tests. **Do not set this in production** — it would point your sign-in at an untrusted server.
- Mobile UI: **Settings → Providers → Provider accounts** has a **Sign in** setup button followed by a **Continue with Anthropic** authorization link. This avoids asynchronous `window.open()` calls, which browsers commonly block. A no-browser fallback accepts the `code` (or full redirect URL) and POSTs it to the callback.

## Decisions

- [docs/decisions.md](../../decisions.md): §12 (per-provider OAuth).
