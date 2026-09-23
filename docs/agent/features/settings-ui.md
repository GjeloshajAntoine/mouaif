# Settings — REST surface and mobile UI — implementation notes

> Agent-facing reference for [`docs/features/settings-ui.md`](../../features/settings-ui.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/settings` | — | `{ home, defaults, app }` (redacted: allowlisted keys only, provider/model `apiKey` dropped) |
| GET    | `/api/settings/project?projectDir=<abs path>` | — | `{ project, path }` (raw project file, `{}` if it doesn't exist; redacted for the client) |
| GET    | `/api/settings/resolved?projectDir=<abs path>` | — | `{ resolved }` (defaults + app + project, project wins; redacted for the client) |
| PUT    | `/api/settings/app` | `{ ...patch }` | `{ app }` (shallow-merged) |
| PUT    | `/api/settings/project` | `{ projectDir, ...patch }` | `{ project, path }` |
| POST   | `/api/settings/app/providers` | `{ id, baseUrl?, apiKey?, auth?, oauthAccount? }` | `{ provider, providers }` |
| DELETE | `/api/settings/app/providers/:id` | — | `{ ok, removed, providers }` (404 if unknown) |
| POST   | `/api/settings/app/reset` | `{ keys: [...] }` | `{ app, reset }` (replaces the app object with the listed keys removed) |

Examples:

````bash
curl -X POST http://localhost:5732/api/settings/app/providers \
  -H 'Content-Type: application/json' \
  -d '{"id":"openai-compatible","baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","auth":"apikey"}'

curl -X DELETE http://localhost:5732/api/settings/app/providers/openai-compatible

curl -X POST http://localhost:5732/api/settings/app/reset \
  -H 'Content-Type: application/json' \
  -d '{"keys":["models","promptSize","authAccounts","projects","flags"]}'

curl 'http://localhost:5732/api/settings/project?projectDir=/path/to/project'
````

## Implementation notes

- **Secret redaction** — API keys are accepted on provider writes but are never
  serialized back to the browser. Settings responses replace the key with
  `hasApiKey: true`; the UI uses that boolean to render `key: •••`. This
  applies to app, project, resolved, provider-create, and provider-delete
  responses.

- **Allowlisted client fields** — `settingsForClient()` does **not** spread the
  whole app-level store. It copies only the keys the web UI actually reads
  (`CLIENT_SETTINGS_KEYS`: `providers`, `models`, `projects`, `promptSize`,
  `githubCopilot`, `modelPricing`, `authAccounts`, `flags`) and drops everything
  else. Server-only bookkeeping — in-flight OAuth flows (`authPending`, which
  carry a PKCE `codeVerifier` and CSRF `state`) and the CDP `inspectorDebuggerUrl`
  — therefore never reaches the browser, and a future key stashed in the app
  store cannot leak by accident.

- **Abandoned OAuth flows are pruned** — an `authPending` record is only removed
  on a successful exchange or an explicit cancel. If the user closes the sign-in
  tab, the record (with its PKCE verifier) would leak forever. `auth.prunePending()`
  drops records older than 1h and runs once at server start (`createServer()`),
  best-effort.

- Server wiring: [src/index.js](../../../src/index.js) → `handleSettings()`. Provider endpoints are `POST /api/settings/app/providers` and `DELETE /api/settings/app/providers/:id`; legacy app-model endpoints remain readable for backward compatibility but are not used by the current UI.
- Store support: [src/settings.js](../../../src/settings.js) adds `setAppReplace(next)` for the reset path. The default `setApp(patch)` is shallow-merge; reset needs replace semantics to drop keys rather than re-set them.
- Mobile UI: [frontend/index.html](../../../frontend/index.html), [frontend/src/style.css](../../../frontend/src/style.css), [frontend/src/main.jsx](../../../frontend/src/main.jsx). The settings screen is a stack of focused sub-views routed by the hash (`#/settings`, `#/settings/providers/<id>`, …); the bottom tab bar is hidden on sub-views so the content owns the full viewport height. `/api/settings` is fetched on demand and cached briefly in module scope; cache-busting `force: true` happens on save, delete, and the about-reset path.
- **Settings shared bits** (declared at the top of [main.jsx](../../../frontend/src/main.jsx)) — `loadApp`, `saveApp`, `resetAppKeys`, `loadAccounts`, `appProviders`, `providerDef`, `authNsForProvider`, `setStatus`, and the `SETTINGS_PROVIDERS` constant. The provider list is the single source of truth for the `<select>` and matches `src/ai.js → ENDPOINTS`.

## Decisions

- [docs/decisions.md](../../decisions.md): §1–§3 (settings storage, scope, providers and models), §15 (file tagging).
