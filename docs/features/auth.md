# Auth — keyring, loopback callback, account index

## Overview

OAuth tokens live in the OS keychain via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring). The mouaif server exposes a loopback callback on its own port so the user can sign in with their system browser. The app SQLite store keeps a non-secret index of `{ provider: [account, ...] }` so the UI can show "signed in as ..." without touching the keychain. Per-provider OAuth flows (authorization endpoints, code exchange, refresh) are pluggable via `auth.registerExchange(provider, fn)` and land in their own commits, one provider at a time.

Implements [docs/decisions.md §11](../decisions.md). The next four commits in the series add OpenAI, Anthropic, Google, and GitHub Copilot OAuth on top of this skeleton.

## Usage

### Token storage (Node)

```js
const auth = require('mouaif/src/auth.js');

// Store a token blob (any string). Conventionally JSON: { accessToken, refreshToken, expiresAt, scope }.
await auth.setToken('openai', 'me@example.com', JSON.stringify({
  accessToken: '...', refreshToken: '...', expiresAt: 1730000000, scope: 'openid profile'
}));

// Read it back. null if no such account.
const blob = auth.getToken('openai', 'me@example.com');

// Delete. Idempotent.
auth.deleteToken('openai', 'me@example.com');

// The non-secret account index. The UI lists this; the keychain is never read directly.
auth.listAccounts();
// -> { openai: ['me@example.com'], anthropic: [], google: [], 'github-copilot': [] }
```

### Model integration

A model with `auth: 'oauth'` is resolved to a token via `auth.tokenForModel(model)`. The AI client (`src/ai.js`) calls this on every chat. The lookup falls back through:

1. `model.oauthAccount` — explicit per-model account.
2. If the user has exactly one signed-in account on the auth provider that the model maps to (see below), that account is used.
3. Otherwise, the chat returns a typed `ENOAUTH` error and the UI prompts the user to sign in.

The model record stores the **AI client** provider verbatim (e.g. `openai-compatible`); the keyring is keyed by the **auth** provider (e.g. `openai`). The mapping is a single frozen object in [src/auth.js](../../src/auth.js): `AI_TO_AUTH_PROVIDER`. Today the only non-identity pair is `openai-compatible → openai`; the others are 1:1. Both the AI client and the settings UI's OAuth account picker go through `auth.authProviderFor(model)` so adding a new AI client (or changing the mapping) is one edit.

```js
// The AI client uses the OAuth access token exactly the same way it uses
// an apiKey, so per-provider builders don't have to know about OAuth.
const ai = require('mouaif/src/ai.js');

await ai.streamChat({
  model: {
    id: 'gpt-4o-mini',
    provider: 'openai-compatible',   // AI client provider (request shape)
    baseUrl: 'https://api.openai.com',
    auth: 'oauth',
    oauthAccount: 'me@example.com'   // optional; auto-resolved if exactly one is signed in
  },
  messages: [{ role: 'user', content: 'hi' }],
  onEvent: (name, data) => { /* ... */ }
});
```

### Per-provider exchange registration

Each per-provider OAuth commit calls `auth.registerExchange(provider, fn)` once at startup. The `fn` is invoked by the loopback callback with the pending record and the authorization code, and must return `{ accessToken, refreshToken?, expiresAt?, scope?, account? }` or `{ error: '...' }`.

```js
auth.registerExchange('openai', async ({ pending, code }) => {
  // 1) POST to the provider's token endpoint with code + code_verifier.
  // 2) Return the access token + (optional) refresh token.
  // 3) The callback will store it in the keychain and update the index.
  return { accessToken: '...', refreshToken: '...', account: 'me@example.com' };
});
```

### Loopback callback

The provider redirects the user's browser to:

```
GET /oauth/callback?provider=<name>&state=<opaque>&code=<authcode>
```

`mouaif` looks up the pending record, calls the registered exchange, stores the token in the keychain, updates the account index, and replies with a small HTML page. The UI polls `GET /api/auth/status?provider=<name>` to learn when the flow has finished.

## HTTP surface

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/auth/accounts` | — | `{ accounts: { openai: [...], ... } }` |
| GET    | `/api/auth/status?provider=<name>` | — | `{ provider, accounts: [...], hasExchange: bool }` |
| DELETE | `/api/auth/accounts/:provider/:account` | — | `{ ok: true, provider, account, deleted: bool }` |
| GET    | `/oauth/callback` | `?provider=&state=&code=&error?` | HTML page (200 / 4xx / 501) |

The OAuth flow itself is started by the UI: it generates a `state`, calls `auth.recordPending(provider, { state, codeVerifier?, redirectUri, scopes, accountHint? })`, then redirects the user to the provider's authorization endpoint. The provider redirects back to `/oauth/callback`, which finishes the flow.

## Behavior

- **OS keychain is the only source of truth for tokens.** Cross-platform: Windows Credential Manager, macOS Keychain, Linux Secret Service / libsecret. The napi-rs binding picks the right backend automatically.
- **App SQLite store is the non-secret index.** It records `{ provider: [account, ...] }` so the UI can list "signed in as ..." without keychain round-trips. Out-of-sync is recoverable: the keychain can be rebuilt from this index by re-authenticating, or vice versa by re-prompting.
- **Loopback callback is provider-neutral.** It routes by `?provider=`. Provider-specific exchange functions are registered via `auth.registerExchange(provider, fn)`; all three shipped providers (Anthropic, OpenRouter, GitHub Copilot) call `register()` from `src/server-shared.js` at module load. If no exchange is registered for a provider, the callback returns 501 with a clear message — that happens only if the startup registration calls are dropped (a regression that shipped once in the http-server split) or a new provider's commit has not landed yet.
- **Callback URL follows the served origin.** The `redirectUri` the provider redirects the browser back to defaults to `<origin>/oauth/callback`, where the origin is `--public-origin` / `MOUAIF_PUBLIC_ORIGIN` when configured, else the request's `Host` header (which a reverse proxy forwards). The client may override it with an explicit `redirectUri` in the sign-in POST body. This keeps sign-in working behind a domain name or on a LAN IP — the old hard-coded `http://127.0.0.1:<port>` only worked when the app ran on the user's own machine.
- **Callback is exempt from the browser-session/access gates.** `/oauth/callback` is a top-level navigation away from the identity provider, so it legitimately carries a cross-site `Origin` (`https://openrouter.ai`, `https://anthropic.com`, ...) and no session or access cookie — Safari's SVC isolation, a blocked popup, or an iOS PWA opening the IdP in a web-preview tab all produce exactly that request. Rejecting it on the same-origin/session check broke iOS PWA sign-in: the IdP completed, but the app never received the token ("shows in provider, error to redirect to the app"). The callback is safe to admit unauthenticated because `finishOAuth` only exchanges a one-time code bound to a `state` the authenticated app generated (`auth.recordPending`), so an attacker cannot mint a session from it. Every `/api/*` route keeps the same-origin + access gate.
- **Callback page returns the user to the app.** On success the reply is a small HTML page that runs JS immediately: in the popup flow it closes the popup (`window.close()`, allowed because the callback page is same-origin with the opener) while the opener app polls the account list; in the full-page flow (iOS PWA redirect-back) it does `location.replace('/web/')` so the PWA lands straight back in the UI. Error pages keep only a 2s meta refresh so the user can read what went wrong before returning to the app. The meta refresh and a manual "Return to the app" link cover no-JS and aggressive script blocking. The mobile UI deliberately opens the popup *without* `noopener` so the callback can close it — the popup's first document is the IdP's own page (a trusted third party the user chose to sign in with), and it ends at our own callback page.
- **PKCE-ready.** `recordPending` accepts a `codeVerifier`; the per-provider exchange uses it. The skeleton does not generate code challenges (that's the provider commit's job).
- **Idempotent delete.** `deleteToken` returns `{ deleted: false }` if the entry didn't exist, never throws.
- **No secrets in the URL.** The callback's `?code=` is the only sensitive piece in the request; the page reply is a static HTML document with no echo of the code.
- **Error codes are typed:** `EKEYRING` (OS keychain unavailable), `ENOENT` (no such account — surfaced as `null`), `EBADINPUT` (validation), `EPROVIDER` (unknown provider), `EOAUTH_BLOB` (stored token is malformed JSON or missing `accessToken`), `ENOAUTH` (OAuth model with no signed-in account).

## Implementation notes

- Source: [src/auth.js](../../src/auth.js). Public surface: `setToken`, `getToken`, `deleteToken`, `listAccounts`, `resolveAccount`, `tokenForModel`, `recordPending`, `consumePending`, `clearPending`, `registerExchange`, `getExchange`, plus `SUPPORTED_PROVIDERS` and `SERVICE_PREFIX`.
- Server wiring: [src/server-handlers-auth.js](../../src/server-handlers-auth.js) → `handleAuth()` and `handleOAuthCallback()`. The callback renders a tiny inline-styled HTML page so the user can close the tab. The page's redirect JS is generated by `redirectMeta()` in [src/server-shared.js](../../src/server-shared.js). The per-provider exchange registrations (`oauth*.register()`) run from [src/server-shared.js](../../src/server-shared.js) at module load.
- Route gating: [src/http-server.js](../../src/http-server.js) lists `/oauth/callback` in neither the browser-session gate (`browserProtected`) nor the access gate (`accessProtected`), so the IdP's cross-site redirect-back is admitted while every `/api/*` route stays protected.
- AI client bridge: [src/ai.js](../../src/ai.js) → `requireApiKey` resolves the OAuth access token via `auth.tokenForModel` and stashes it on the model object as `__accessToken`. The request builders read it through `credential(model)`.
- Settings default: `authAccounts: {}` was added to [src/settings.js](../../src/settings.js) so the non-secret index is always present and valid.
- Mobile UI: **Settings → Providers** shows a live read-only view of `/api/auth/accounts` and the relevant provider sign-in actions. Authentication is not a separate destination; it is part of configuring a provider connection.

## Related

- Decision: [docs/decisions.md §11](../decisions.md) (this commit) and §12 (per-provider OAuth — next four commits).
- AI client: [docs/features/ai-client.md](./ai-client.md).
- Settings storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
