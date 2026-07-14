# Settings — REST surface and mobile UI

## Overview

Two surfaces in this commit. The REST surface is the new endpoints the mobile UI calls; the mobile UI is the panel at `/web/` that lets a user edit app-level settings and the models list without `curl`.

The endpoints build on [docs/features/app-and-project-settings.md](./app-and-project-settings.md) and [docs/decisions.md §1–§2](../decisions.md). Nothing in the storage layer changed; this commit only adds the missing GET for project-level settings, the models-CRUD endpoints, the reset endpoint, and the UI on top of all of that.

## Usage

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/settings` | — | `{ home, defaults, app }` (app is the raw app-level object) |
| GET    | `/api/settings/project?projectDir=<abs path>` | — | `{ project, path }` (raw project file, `{}` if it doesn't exist) |
| GET    | `/api/settings/resolved?projectDir=<abs path>` | — | `{ resolved }` (defaults + app + project, project wins) |
| PUT    | `/api/settings/app` | `{ ...patch }` | `{ app }` (shallow-merged) |
| PUT    | `/api/settings/project` | `{ projectDir, ...patch }` | `{ project, path }` |
| POST   | `/api/settings/app/models` | `{ id, provider, label?, baseUrl?, apiKey?, auth?, oauthAccount?, contextWindow? }` | `{ model, models }` |
| DELETE | `/api/settings/app/models/:id` | — | `{ ok, removed, models }` (404 if unknown) |
| POST   | `/api/settings/app/reset` | `{ keys: [...] }` | `{ app, reset }` (replaces the app object with the listed keys removed) |

Examples:

````bash
# Add a model.
curl -X POST http://localhost:5732/api/settings/app/models \
  -H 'Content-Type: application/json' \
  -d '{"id":"gpt-4o-mini","provider":"openai-compatible","label":"GPT-4o mini","baseUrl":"https://api.openai.com","apiKey":"sk-..."}'

# Rename a model.
curl -X POST http://localhost:5732/api/settings/app/models \
  -H 'Content-Type: application/json' \
  -d '{"id":"gpt-4o-mini","label":"GPT-4o (renamed)"}'

# Delete a model.
curl -X DELETE http://localhost:5732/api/settings/app/models/gpt-4o-mini

# Reset all app-level keys to defaults.
curl -X POST http://localhost:5732/api/settings/app/reset \
  -H 'Content-Type: application/json' \
  -d '{"keys":["models","promptSize","authAccounts","projects","flags"]}'

# Read project-level settings (raw, no merge).
curl 'http://localhost:5732/api/settings/project?projectDir=/path/to/project'
````

### Mobile UI

The mobile UI exposes a **Settings** destination in the bottom tab bar at `/web/`. It has three subsections:

- **App** — `Default prompt size` (select). Save writes to `PUT /api/settings/app`. Reset clears every app-level key and reloads. Trace has no app-wide default: each chat starts off and exposes its own opt-in toggle.
- **Models** — a list of configured models with a Delete button each, and an "Add a model" disclosure that captures `id`, `provider`, `label`, `base URL`, `auth` (apikey/oauth), and **either** an `API key` field (for apikey) **or** an `OAuth account` picker (for oauth) — the two are toggled by the auth select. The OAuth picker lists the signed-in accounts from `/api/auth/accounts` for the chosen provider; the default `(auto)` is the single-account fallback in `auth.resolveAccount` and falls through to the stored token. With multiple signed-in accounts, the user must pick one explicitly.
- **Project** — paste a project directory, click Load, and the raw `<projectDir>/.mouaif.json` is shown. No edit UI yet (that's part of the project card commit per the build order).

The UI is mobile-first: stacked rows, 44 px touch targets, system colors, and safe-area awareness. It is part of the Preact + Vite bundle built with `npm run build:web` and served from `src/web/dist/`.

## Behavior

- **Models added through `POST /api/settings/app/models` appear in `GET /api/ai/models` on the next call.** No restart, no cache invalidation. The chat picker reads `settings.getResolved(projectDir).models` on every request.
- **`POST /api/settings/app/models` is upsert by `id`.** A new id adds; an existing id merges the body into the existing record (so a partial update — e.g. only the label — only needs the changed fields). `provider` is required on the first add, optional on subsequent re-adds.
- **`POST /api/settings/app/reset` is destructive on purpose.** The body lists the keys to remove; the rest of the app object is preserved. This is a `REPLACE` of the app object with the listed keys omitted, not a deep merge. A bad key in the list returns 400.
- **`DELETE /api/settings/app/models/:id` is idempotent at the API level** (404 if not found, 200 with the new models list otherwise). The UI confirms with the user before issuing the call.
- **API keys are stored in plaintext in the SQLite store.** The keyring is for OAuth tokens only (decision §11). The doc is honest about this; the project-level encryption-when-resting decision is open and out of scope for this commit.
- **OAuth model records carry `auth: 'oauth'` and an optional `oauthAccount`.** The server's `POST /api/settings/app/models` accepts both. Light validation on the server: `auth` must be `'apikey'` or `'oauth'`; `oauthAccount` is a string; an OAuth model that arrives with a leftover `apiKey` has it stripped on merge (so a user toggling a model from apikey to oauth does not leak a stale key). The AI client (`src/ai.js → requireApiKey`) reads `oauthAccount` from the model to pick the right keyring entry.

## Implementation notes

- **Secret redaction** — API keys are accepted on model writes but are never
  serialized back to the browser. Settings responses replace the key with
  `hasApiKey: true`; the UI uses that boolean to render `key: •••`. This
  applies to app, project, resolved, model-create, model-delete, and reset
  responses.

- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. New endpoints are `GET /api/settings/project`, `POST /api/settings/app/models`, `DELETE /api/settings/app/models/:id`, `POST /api/settings/app/reset`. The `GET /` self-description lists all of them.
- Store support: [src/settings.js](../../src/settings.js) adds `setAppReplace(next)` for the reset path. The default `setApp(patch)` is shallow-merge; reset needs replace semantics to drop keys rather than re-set them.
- Mobile UI: [src/web/index.html](../../src/web/index.html), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/main.jsx](../../src/web/src/main.jsx). Polls `GET /api/settings` every 30 s so the page is truthful even if another client changes settings.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Chat proxy that consumes the models list: [docs/features/ai-client.md](./ai-client.md).
- The model record shape (the one this UI edits) is defined in [docs/features/ai-client.md](./ai-client.md) § "Model record".
