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

The mobile UI exposes a **Settings** destination in the bottom tab bar at `/web/`. It has four subsections:

- **App** — `Default prompt size` (select). Save writes to `PUT /api/settings/app`. Reset clears every app-level key and reloads. Trace has no app-wide default: each chat starts off and exposes its own opt-in toggle.
- **Providers** — app-level provider connections with provider id, API base URL, authentication method, and either an API key or OAuth account. Saving the same provider updates its connection. API-key authentication requires a key except for Ollama. No model ID or model label appears here because this section configures providers, not models.
- **Project overrides** — paste a project directory and click Load. The raw `<projectDir>/.mouaif.json` is loaded into a JSON editor (textarea); this is where project model records are defined, for example `{ "models": [{ "id": "gpt-4o", "provider": "openai-compatible" }] }`. **Save** PUTs the parsed JSON through `/api/settings/project`, and **Revert** restores the loaded text.
- **Resolved (effective for project)** — read-only. The `defaults → app → project` merge result for the loaded project directory. The `apiKey` of any model is redacted to `•••` so a resolved view never echoes a secret back into the DOM. This is the view the chat layer actually reads (decision §2); what it shows is what the user gets at chat time.

The UI is mobile-first: stacked rows, 44 px touch targets, system colors, and safe-area awareness. It is part of the Preact + Vite bundle built with `npm run build:web` and served from `src/web/dist/`.

## Behavior

- **Provider connections are upserted by id.** Saving `openai-compatible` again updates that provider's global connection without creating a duplicate.
- **Models remain project-defined.** `GET /api/ai/models?projectDir=...` reads the project's resolved `models` array. When a chat starts, the server combines the selected model with the matching app-level provider connection.
- **`POST /api/settings/app/reset` is destructive on purpose.** The body lists the keys to remove; the rest of the app object is preserved. This is a `REPLACE` of the app object with the listed keys omitted, not a deep merge. A bad key in the list returns 400.
- **`DELETE /api/settings/app/providers/:id` returns 404 when unknown.** The UI confirms with the user before deleting a provider connection.
- **API keys are stored in plaintext in the SQLite store.** The keyring is for OAuth tokens only (decision §11). The doc is honest about this; the project-level encryption-when-resting decision is open and out of scope for this commit.
- **OAuth provider connections carry `auth: 'oauth'` and an optional `oauthAccount`.** An OAuth connection has any stale API key removed. The AI client resolves the keyring entry through `src/auth.js → authProviderFor(model)` after hydrating the project model with its provider connection.
- **`github-copilot` is reserved.** The UI lists it in the provider dropdown (per decision §10) but forces the auth select to `oauth` and disables the `apikey` option, so a user cannot submit a model the server would later reject with `ENOAUTH`. The reserved list is the same one in `src/ai.js → ENDPOINTS` (decision §10, "the last is reserved; its auth flow ships in a later commit").

## Implementation notes

- **Secret redaction** — API keys are accepted on model writes but are never
  serialized back to the browser. Settings responses replace the key with
  `hasApiKey: true`; the UI uses that boolean to render `key: •••`. This
  applies to app, project, resolved, model-create, model-delete, and reset
  responses.

- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. Provider endpoints are `POST /api/settings/app/providers` and `DELETE /api/settings/app/providers/:id`; legacy app-model endpoints remain readable for backward compatibility but are not used by the current UI.
- Store support: [src/settings.js](../../src/settings.js) adds `setAppReplace(next)` for the reset path. The default `setApp(patch)` is shallow-merge; reset needs replace semantics to drop keys rather than re-set them.
- Mobile UI: [src/web/index.html](../../src/web/index.html), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/main.jsx](../../src/web/src/main.jsx). Polls `GET /api/settings` every 30 s so the page is truthful even if another client changes settings.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Chat proxy that consumes the models list: [docs/features/ai-client.md](./ai-client.md).
- The model record shape (the one this UI edits) is defined in [docs/features/ai-client.md](./ai-client.md) § "Model record".
