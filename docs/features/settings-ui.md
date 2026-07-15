# Settings — REST surface and mobile UI

## Overview

Two surfaces in this commit. The REST surface is the endpoints the mobile UI calls; the mobile UI is the panel at `/web/` that lets a user edit app-level settings, provider connections, and raw project settings without `curl`.

The endpoints build on [docs/features/app-and-project-settings.md](./app-and-project-settings.md) and [docs/decisions.md §1–§3](../decisions.md). The current UI manages app-level provider connections and edits project models through the project's raw settings file.

## Usage

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/settings` | — | `{ home, defaults, app }` (app is the raw app-level object) |
| GET    | `/api/settings/project?projectDir=<abs path>` | — | `{ project, path }` (raw project file, `{}` if it doesn't exist) |
| GET    | `/api/settings/resolved?projectDir=<abs path>` | — | `{ resolved }` (defaults + app + project, project wins) |
| PUT    | `/api/settings/app` | `{ ...patch }` | `{ app }` (shallow-merged) |
| PUT    | `/api/settings/project` | `{ projectDir, ...patch }` | `{ project, path }` |
| POST   | `/api/settings/app/providers` | `{ id, baseUrl?, apiKey?, auth?, oauthAccount? }` | `{ provider, providers }` |
| DELETE | `/api/settings/app/providers/:id` | — | `{ ok, removed, providers }` (404 if unknown) |
| POST   | `/api/settings/app/reset` | `{ keys: [...] }` | `{ app, reset }` (replaces the app object with the listed keys removed) |

Examples:

````bash
# Add or update an app-level provider connection.
curl -X POST http://localhost:5732/api/settings/app/providers \
  -H 'Content-Type: application/json' \
  -d '{"id":"openai-compatible","baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","auth":"apikey"}'

# Delete a provider connection.
curl -X DELETE http://localhost:5732/api/settings/app/providers/openai-compatible

# Reset all app-level keys to defaults.
curl -X POST http://localhost:5732/api/settings/app/reset \
  -H 'Content-Type: application/json' \
  -d '{"keys":["models","promptSize","authAccounts","projects","flags"]}'

# Read project-level settings (raw, no merge).
curl 'http://localhost:5732/api/settings/project?projectDir=/path/to/project'
````

### Mobile UI

The mobile UI exposes a **Settings** destination in the bottom tab bar at `/web/`. The screen is a stack of focused sub-views, each with its own back link; the bottom tab bar is hidden on the sub-views so the content owns the full viewport height.

| Hash route | View | Purpose |
|------------|------|---------|
| `#/settings` | `SettingsHomeView` | Card list: providers, project overrides, app defaults, GitHub Copilot OAuth app, about / reset. |
| `#/settings/providers` | `SettingsProvidersView` | List of configured providers + an `+ Add provider` entry. |
| `#/settings/providers/new` | `SettingsProviderEditView` | New provider form. |
| `#/settings/providers/<id>` | `SettingsProviderEditView` | Edit / delete an existing provider. |
| `#/settings/defaults` | `SettingsDefaultsView` | `Default prompt size` (select). Save writes to `PUT /api/settings/app`. |
| `#/settings/project` | `SettingsProjectView` | Directory input + Load; the raw `<projectDir>/.mouaif.json` JSON editor + the resolved view for the same directory. |
| `#/settings/copilot` | `SettingsCopilotView` | The GitHub Copilot OAuth `client_id` used by the loopback flow. |
| `#/settings/about` | `SettingsAboutView` | Storage location, in-code defaults, and the destructive "Reset all app settings" action. |

The provider form has all fields on one screen: provider id (locked after creation), API base URL, authentication mode, an API key (when the auth is `apikey`) or an OAuth-account <select> with an inline sign-in helper (when the auth is `oauth`). The reserved `github-copilot` provider hides the API base URL row (the base URL is hard-coded) and replaces the auth `<select>` with a static "OAuth (required)" badge. The provider's `hint` is also promoted to a colored notice so the OAuth requirement is unmistakable on a phone. The same reserved-rail hides the `apikey` row and forces `auth: oauth` at save time, so a user cannot submit a model the server would later reject with `ENOAUTH`.

The project view loads both the raw project file and the resolved view in parallel. Saving the project refreshes the resolved view in the same tap.

The UI is mobile-first: stacked rows, 32 px touch targets, system colors, and safe-area awareness. It is part of the Preact + Vite bundle built with `npm run build:web` and served from `src/web/dist/`.

## Behavior

- **Provider connections are upserted by id.** Saving `openai-compatible` again updates that provider's global connection without creating a duplicate.
- **Models remain project-defined.** `GET /api/ai/models?projectDir=...` reads the project's resolved `models` array. When a chat starts, the server combines the selected model with the matching app-level provider connection.
- **`POST /api/settings/app/reset` is destructive on purpose.** The body lists the keys to remove; the rest of the app object is preserved. This is a `REPLACE` of the app object with the listed keys omitted, not a deep merge. A bad key in the list returns 400.
- **`DELETE /api/settings/app/providers/:id` returns 404 when unknown.** The UI confirms with the user before deleting a provider connection.
- **API keys are stored in plaintext in the SQLite store.** The keyring is for OAuth tokens only (decision §11). The doc is honest about this; the project-level encryption-when-resting decision is open and out of scope for this commit.
- **OAuth provider connections carry `auth: 'oauth'` and an optional `oauthAccount`.** An OAuth connection has any stale API key removed. The AI client resolves the keyring entry through `src/auth.js → authProviderFor(model)` after hydrating the project model with its provider connection.
- **`github-copilot` is reserved.** The UI lists it in the provider dropdown (per decision §10) but forces the auth select to `oauth` and disables the `apikey` option, so a user cannot submit a model the server would later reject with `ENOAUTH`. The reserved list is the same one in `src/ai.js → ENDPOINTS` (decision §10, "the last is reserved; its auth flow ships in a later commit").

## Implementation notes

- **Secret redaction** — API keys are accepted on provider writes but are never
  serialized back to the browser. Settings responses replace the key with
  `hasApiKey: true`; the UI uses that boolean to render `key: •••`. This
  applies to app, project, resolved, provider-create, and provider-delete
  responses.

- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. Provider endpoints are `POST /api/settings/app/providers` and `DELETE /api/settings/app/providers/:id`; legacy app-model endpoints remain readable for backward compatibility but are not used by the current UI.
- Store support: [src/settings.js](../../src/settings.js) adds `setAppReplace(next)` for the reset path. The default `setApp(patch)` is shallow-merge; reset needs replace semantics to drop keys rather than re-set them.
- Mobile UI: [src/web/index.html](../../src/web/index.html), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/main.jsx](../../src/web/src/main.jsx). The settings screen is a stack of focused sub-views routed by the hash (`#/settings`, `#/settings/providers/<id>`, …); the bottom tab bar is hidden on sub-views so the content owns the full viewport height. `/api/settings` is fetched on demand and cached briefly in module scope; cache-busting `force: true` happens on save, delete, and the about-reset path.
- **Settings shared bits** (declared at the top of [main.jsx](../../src/web/src/main.jsx)) — `loadApp`, `saveApp`, `resetAppKeys`, `loadAccounts`, `appProviders`, `providerDef`, `authNsForProvider`, `setStatus`, and the `SETTINGS_PROVIDERS` constant. The provider list is the single source of truth for the `<select>` and matches `src/ai.js → ENDPOINTS`.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Chat proxy that consumes the models list: [docs/features/ai-client.md](./ai-client.md).
- The model record shape (the one this UI edits) is defined in [docs/features/ai-client.md](./ai-client.md) § "Model record".
