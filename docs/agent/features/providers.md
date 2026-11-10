# AI providers — implementation notes

> Agent-facing reference for [`docs/features/providers.md`](../../features/providers.md). The provider-credentials half of the former `authentication.md` page lives here; the app-access half stays in [authentication.md](./authentication.md).

## Connections and types

A connection has an `id` and a `type`. The `id` is what project models, chats, agents, recents and pins store as `provider` / `providerId`. The `type` is the `ENDPOINTS` key that sets the wire shape, the sign-in flow and the token namespace. [src/providerConnections.js](../../../src/providerConnections.js) holds the helpers.

- **No migration.** A record with no `type` has `type === id`. The first connection of a type takes the type name as its id, so existing records and project files keep working. Later ones get `<type>-2`, `<type>-3` and so on, from `nextConnectionId`.
- **What `provider` means.** On a hydrated model (from `resolveModel` or the subagent dispatcher, both through `hydrateModel`), `provider` is the type and `providerId` is the connection. On an unhydrated project record or live catalog row, `provider` is the connection id. Anything that stores, compares, displays or re-resolves a hydrated model's identity must use `connectionIdOf(model)`; builders, parsers and capability checks use `model.provider`.
- **Per connection.** Credential (`credentialForProvider`), base URL (`baseUrlForProvider`), model-list cache entry and balance lookup all take a connection id. `liveModelsFor` resolves the type itself to pick the adapter.
- **Per type.** OAuth accounts are indexed by type's auth namespace, so every connection of a type sees the same signed-in accounts and picks one with `oauthAccount`. `app.githubCopilot.clientId` is also shared.
- **Display.** `name` is display-only and stays off hydrated models. The web UI shows it through `providerLabel(id)`, which falls back to the id. Keys, filters and saved selections always use the id.

`POST /api/settings/app/providers`:

| Body | Effect |
|------|--------|
| `{ type, name?, ... }` | Adds a connection. The server picks the id. |
| `{ id, name?, ... }` with an existing id | Updates that connection. An empty `name` clears it. A different `type` is a 400. |
| `{ id, ... }` with no such connection | Adds it if `id` is a type name, otherwise 400. This is the form clients used before `type` existed. |

`GET /api/ai/models/providers` returns `{ id, type, name? }` rows. `GET /api/ai/models/live` and `GET /api/ai/provider-credit` take a connection id in `provider`.

The route `#/settings/providers/new` opens the picker (`SettingsProviderPicker`). `#/settings/providers/new/<choice>` opens the add form for a choice from `PROVIDER_CHOICE_GROUPS` in `frontend/src/providerChoices.js`. A choice is a way to connect, not a type: `claude-plan` and `anthropic` are both type `anthropic`, and `openai`, `lm-studio` and `llama-cpp` are presets of `openai-compatible`. An unknown choice falls back to the picker. A redirect sign-in returns to its choice when the connection doesn't exist yet (`oauthPending.choice`).

Adding a provider always tests it: `checkConnection` calls `GET /api/ai/models/live?provider=<id>&_bust=1`, and `connectionHealth` reads the answer. `healthWithoutAsking` answers without a request when a request can't tell anything: a missing required key, or a type in `LIST_IGNORES_THE_KEY`. Anthropic's list is a built-in catalog, OpenRouter's is public (`requireCred: false`), and Copilot's falls back to a curated catalog when its token fails, so a 200 from those proves nothing about the credential. A new type whose `listModels` doesn't use its credential must join that set, or a bad key reads as connected. The provider list checks each row without `_bust`, so a good answer comes from the one-hour model-list cache. Failures aren't cached, so a failing row asks upstream on each visit.

## Provider credentials — keyring, loopback callback, account index

### Programmatic (Node)

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

```js
auth.registerExchange('openai', async ({ pending, code }) => {
  // 1) POST to the provider's token endpoint with code + code_verifier.
  // 2) Return the access token + (optional) refresh token.
  // 3) The callback will store it in the keychain and update the index.
  return { accessToken: '...', refreshToken: '...', account: 'me@example.com' };
});
```

### HTTP surface

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/auth/accounts` | — | `{ accounts: { openai: [...], ... } }` |
| GET    | `/api/auth/status?provider=<name>` | — | `{ provider, accounts: [...], hasExchange: bool }` |
| DELETE | `/api/auth/accounts/:provider/:account` | — | `{ ok: true, provider, account, deleted: bool }` |
| GET    | `/oauth/callback` | `?provider=&state=&code=&error?` | HTML page (200 / 4xx / 501) |

The OAuth flow itself is started by the UI: it generates a `state`, calls `auth.recordPending(provider, { state, codeVerifier?, redirectUri, scopes, accountHint? })`, then redirects the user to the provider's authorization endpoint. The provider redirects back to `/oauth/callback`, which finishes the flow.

### Implementation notes

- Source: [src/auth.js](../../../src/auth.js). Public surface: `setToken`, `getToken`, `deleteToken`, `listAccounts`, `resolveAccount`, `tokenForModel`, `recordPending`, `consumePending`, `clearPending`, `registerExchange`, `getExchange`, plus `SUPPORTED_PROVIDERS` and `SERVICE_PREFIX`.
- Server wiring: [src/server-handlers-auth.js](../../../src/server-handlers-auth.js) → `handleAuth()` and `handleOAuthCallback()`. The callback renders a tiny inline-styled HTML page so the user can close the tab. The page's redirect JS is generated by `redirectMeta()` in [src/server-shared.js](../../../src/server-shared.js). The per-provider exchange registrations (`oauth*.register()`) run from [src/server-shared.js](../../../src/server-shared.js) at module load.
- Route gating: [src/http-server.js](../../../src/http-server.js) lists `/oauth/callback` in neither the browser-session gate (`browserProtected`) nor the access gate (`accessProtected`), so the IdP's cross-site redirect-back is admitted while every `/api/*` route stays protected.
- AI client bridge: [src/ai.js](../../../src/ai.js) → `requireApiKey` resolves the OAuth access token via `auth.tokenForModel` and stashes it on the model object as `__accessToken`. The request builders read it through `credential(model)`.
- Settings default: `authAccounts: {}` was added to [src/settings.js](../../../src/settings.js) so the non-secret index is always present and valid.
- Mobile UI: **Settings → Providers** shows a live read-only view of `/api/auth/accounts` and the relevant provider sign-in actions. Authentication is not a separate destination; it is part of configuring a provider connection.
