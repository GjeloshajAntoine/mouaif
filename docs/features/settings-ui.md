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

The home screen groups cards by scope so app-level and project-level settings never sit in the same list. Rather than repeat "overrides / wins / shadows" on every row, the layering is stated plainly and once: the **App defaults** group title notes it applies to every project, the **This project** footer says a project can change any default for its own folder, and the project page has a "Inherit app default" option where it matters. The mental model is two layers — *app defaults apply everywhere; a project can change them for its own folder* — not a chain of winners and losers.

- **Providers** — `Providers` (account-level connections you sign into / add keys for; not part of the app/project layering).
- **App defaults** (title note: *Apply to every project*) — cards: `Chat defaults` (`prompt style`), `MCP servers` (`servers & default permission`), `Model pricing` (`cost table`), `About & reset` (`storage · danger zone`). (The GitHub Copilot OAuth-app `client_id` is **not** a separate card here — it lives inside the Copilot provider form, next to that provider's sign-in, so all Copilot auth is in one place.)
- **This project** — only rendered when a project is active (set by opening a chat, the project picker, or loading a project here). The group title shows the active project's name/path so the scope is concrete, not abstract. Cards: `Project settings` (`prompt style, tools, agents`), `MCP servers` (`app servers + this project's own`), `Custom prompts`, `File tags`, each linking with `?projectDir=<active>` so the destination view auto-loads without a manual paste. When no project is active the group shows a one-line hint pointing the user at a chat / the picker instead of dead links. **File tags** resolves the registered project id from the path on arrival — the route only needs to carry `projectDir`.

Each card's summary line reflects live state (e.g. `1 connected`, `3 models priced`) with a static fallback so the list never flashes a bare `—` before load resolves.

| Hash route | View | Purpose |
|------------|------|---------|
| `#/settings` | `SettingsHomeView` | Scope-grouped card list (see above). |
| `#/settings/providers` | `SettingsProvidersView` | List of configured providers + an `+ Add provider` entry. |
| `#/settings/providers/new` | `SettingsProviderEditView` | New provider form. |
| `#/settings/providers/<id>` | `SettingsProviderEditView` | Edit / delete an existing provider. |
| `#/settings/defaults` | `SettingsDefaultsView` | `Default prompt style` (select). Save writes to `PUT /api/settings/app`. |
| `#/settings/project[?projectDir=<abs path>]` | `SettingsProjectView` | Per-project overrides (prompt style, tool authorization, agent files, agents) + a "This chat" group for the chat the user came from (`?chatId=…`). Raw `<projectDir>/.mouaif.json` editor and resolved view live in a collapsed Advanced section. Seeds the directory from `?projectDir=` or the active project and auto-loads. |
| `#/settings/copilot` | — (legacy alias) | Old GitHub Copilot OAuth screen. The `client_id` field now lives in the Copilot provider form; this hash redirects to `#/settings/providers/github-copilot`. |
| `#/settings/tags[?projectDir=<abs path>]` | `SettingsTagsView` | Per-project file tagging (decisions §15). Resolves the registered project id from `projectDir` when no `projectId` is passed. |
| `#/settings/about` | `SettingsAboutView` | Storage location, in-code defaults, and the destructive "Reset all app settings" action. |

The provider form has all fields on one screen: provider id (locked after creation), API base URL, authentication mode, an API key (when the auth is `apikey`) or an OAuth-account <select> with an inline sign-in helper (when the auth is `oauth`). On the **new**-provider screen the provider `<select>` defaults to `openai-compatible` (the first, API-key-only entry). The active option is marked with the `selected` attribute rather than a controlled `value` prop on the `<select>`; a controlled `value` set before the `<option>` children are attached is silently dropped by the DOM, which made the picker fall through to the *last* entry (`github-copilot`) and open the new-provider form on the OAuth-only screen for no reason. The reserved `github-copilot` provider hides the API base URL row (the base URL is hard-coded) and replaces the auth `<select>` with a static "OAuth (required)" badge. The provider's `hint` is also promoted to a colored notice so the OAuth requirement is unmistakable on a phone. The same reserved-rail hides the `apikey` row and forces `auth: oauth` at save time, so a user cannot submit a model the server would later reject with `ENOAUTH`.

**GitHub Copilot OAuth-app `client_id`.** GitHub will not let a third-party app use the public Copilot `client_id` with a loopback callback, so the Copilot sign-in needs a per-install OAuth-app `client_id` (stored in app settings under `githubCopilot.clientId`; blank = shipped default). That field is rendered **inside the Copilot provider form** — only when the provider is `github-copilot` and the auth is OAuth — right above the Sign in button, with its own "Save client ID" action (decoupled from the provider Save so you can set the id, sign in, then save the record). It used to be a standalone `Application` card (`#/settings/copilot`); that screen was removed and the route is now a redirect. This keeps everything Copilot-auth (client id → sign in → account) on one screen instead of split across two settings sections.

**OAuth is only offered for providers the server can actually sign into.** Each entry in `SETTINGS_PROVIDERS` carries an `oauth: true` flag when the server has an OAuth flow registered for it (`src/index.js → oauthAnthropic.register()` / `oauthCopilot.register()`); `reserved` implies OAuth-only. Currently that is **Anthropic** (key *or* OAuth) and **GitHub Copilot** (OAuth-only). For every other provider (OpenAI-compatible, Gemini, Ollama) the authentication `<select>` is hidden entirely — there is a single mode (API key), so a one-option picker would be noise — and the "Sign in" button is never shown. This closes a real bug: the form used to offer OAuth for every provider, and picking it then tapping "Sign in" hit `POST /api/auth/sign-in/<id>`, which returns **404** for providers with no OAuth flow. `startSignIn()` also guards against this directly, showing "does not support OAuth sign-in; use an API key." instead of the raw 404.

The project view loads both the raw project file and the resolved view in parallel. Saving the project refreshes the resolved view in the same tap.

The project view's groups are scoped on purpose: a **Chat defaults** group holds settings that live in `.mouaif.json` and apply to chats in this project (prompt style today; anything left on its default follows the app-level value), and a separate **This chat** group holds actions that apply to the chat the user came from (trace toggle, export trace, delete chat). The two scopes are never mixed in one group — a per-chat action next to a project setting reads as "this writes `.mouaif.json`", which it does not. The "This chat" group is hidden when the route carries no `?chatId=…`.

The UI is mobile-first: stacked rows, minimum 44 px touch targets, system colors, and safe-area awareness. It is part of the Preact + Vite bundle built with `npm run build:web` and served from `src/web/dist/`.

## Behavior

- **Provider connections are upserted by id.** Saving `openai-compatible` again updates that provider's global connection without creating a duplicate.
- **Models remain project-defined.** `GET /api/ai/models?projectDir=...` reads the project's resolved `models` array. When a chat starts, the server combines the selected model with the matching app-level provider connection.
- **`POST /api/settings/app/reset` is destructive on purpose.** The body lists the keys to remove; the rest of the app object is preserved. This is a `REPLACE` of the app object with the listed keys omitted, not a deep merge. A bad key in the list returns 400. Resettable keys are the `DEFAULTS` keys plus the additive app keys that have no in-code default — `modelPricing` and `githubCopilot` — so the pricing table and the custom Copilot OAuth client can actually be cleared (`RESETTABLE_APP_KEYS` in [src/index.js](../../src/index.js)).
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

- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. Provider endpoints are `POST /api/settings/app/providers` and `DELETE /api/settings/app/providers/:id`; legacy app-model endpoints remain readable for backward compatibility but are not used by the current UI.
- Store support: [src/settings.js](../../src/settings.js) adds `setAppReplace(next)` for the reset path. The default `setApp(patch)` is shallow-merge; reset needs replace semantics to drop keys rather than re-set them.
- Mobile UI: [src/web/index.html](../../src/web/index.html), [src/web/src/style.css](../../src/web/src/style.css), [src/web/src/main.jsx](../../src/web/src/main.jsx). The settings screen is a stack of focused sub-views routed by the hash (`#/settings`, `#/settings/providers/<id>`, …); the bottom tab bar is hidden on sub-views so the content owns the full viewport height. `/api/settings` is fetched on demand and cached briefly in module scope; cache-busting `force: true` happens on save, delete, and the about-reset path.
- **Settings shared bits** (declared at the top of [main.jsx](../../src/web/src/main.jsx)) — `loadApp`, `saveApp`, `resetAppKeys`, `loadAccounts`, `appProviders`, `providerDef`, `authNsForProvider`, `setStatus`, and the `SETTINGS_PROVIDERS` constant. The provider list is the single source of truth for the `<select>` and matches `src/ai.js → ENDPOINTS`.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Chat proxy that consumes the models list: [docs/features/ai-client.md](./ai-client.md).
- The model record shape (the one this UI edits) is defined in [docs/features/ai-client.md](./ai-client.md) § "Model record".
