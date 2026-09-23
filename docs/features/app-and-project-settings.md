# App and project settings

## Overview

`mouaif` manages settings through a three-layer hierarchy: **built-in defaults → global app settings → project-level settings**. Project values override app-level defaults when they conflict, giving you shared defaults across your environment while allowing fine-grained customization per codebase.

## API shapes (`GET /api/settings/project`, `GET /api/settings/resolved`)

The app-level and project-level payloads are projected differently, because the two stores hold different kinds of data:

- `GET /api/settings` (app + defaults) is **allowlisted**: only the keys the web UI consumes are sent, so server-only bookkeeping such as in-flight OAuth state (`authPending`) or the CDP debugger URL can never leak into the browser.
- The project-scoped endpoints send the **whole project object**, minus secrets and the internal storage marker. `.mouaif.json` is hand-editable and every feature that lands there adds a key (`name`, `agents`, `skills`, `agentFiles`, `hideFileContent`, `tags`, `customActions`, `totalCost`, `models`, ...), so an allowlist would silently hide user data and freeze project-scoped UI at its default.

```json
// GET /api/settings/project?projectDir=/abs/path
{
  "project": { "name": "app", "skills": true, "agentFiles": false, "tags": ["web"] },
  "path": "/abs/path/.mouaif.json",
  "dbBacked": false
}
```

Two fields are always removed: `__dbBacked` (internal storage bookkeeping, never part of the user's settings) and `apiKey` on any `providers` / `models` entry, which is replaced by a response-only `hasApiKey` boolean. Credentials belong in the app store only.

## Where the app store lives

App-level settings are stored as one JSON object in the `app_kv` row of `~/.mouaif/store.sqlite` (key `settings`), next to the purpose-built tables for project settings, the MCP tool cache and recent models.

Because every route reads that row, an unreadable value must not take the server down — but it must not destroy the user's data either. If the stored blob does not parse (or is not a JSON object), the server:

1. moves the stored text to a quarantine row keyed `settings.corrupt-<timestamp>-<random>`;
2. deletes the unreadable live row, so the app starts from the built-in defaults;
3. logs the quarantine key on stderr.

The result is the same empty-but-working store the old silent `{}` fallback produced, except the original bytes are still in the database:

```bash
sqlite3 ~/.mouaif/store.sqlite \
  "SELECT key, value FROM app_kv WHERE key LIKE 'settings.corrupt-%'"
```

`settings.listQuarantinedAppSettings()` returns the same rows from Node. Restore an entry by copying its value back into the `settings` row once you have repaired the JSON.

## How settings work

- **Global app settings** — configured once in the **Settings** tab. These include connected AI provider credentials, global model pricing, default prompt styles, and default tool permissions.
- **Project settings** — configured per project in **Settings → Projects → [Project Name]** (or via the project card menu). These include project custom prompts, prompt size preferences, agent personas, and specific tool permissions. They are written **atomically** (stage + fsync + rename), so an interrupted save can never leave a half-written `.mouaif.json` that would break every settings and chat route for that project.
- **Merge order** — defaults apply first, global settings override defaults, and project settings override global settings. The merged object is a **fresh copy**: nested objects merge key by key (an `app` value of `toolOutput.size` keeps the built-in `toolOutput.structure`), arrays are replaced rather than concatenated, and nothing in the result aliases the built-in defaults, the stored app object, or the project file — so a caller may edit the resolved object freely.

## Managing settings in the UI

1. **AI Providers & Keys** — open **Settings → Providers** to add or edit API keys and OAuth connections. Provider credentials are global and never committed to individual project folders.
2. **Access & Security** — configure optional password protection, passkeys, and manage sessions from **Settings → Access & passkeys** (see [Authentication](./authentication.md#app-access-control-who-can-open-mouaif)).
3. **Project Customizations** — open project settings to configure rules, instruction files (such as `AGENTS.md` or `CLAUDE.md`), and tool permissions for that project.
4. **Database-backed settings (Clean tree)** — by default, project settings are stored next to your code in `.mouaif.json`. If you prefer to keep your working directory untouched by tooling files, enable **Store settings in app DB** in project settings.
5. **Chat defaults** — open **Settings → App defaults → Chat defaults** to set the default prompt style and two composer toggles (Enter inserts a newline; Auto-retry failed sends). All three save automatically as soon as you change them; there is no Save button. Each setting is a row card with a per-row status line that confirms the change.
6. **Dictation** — open **Settings → App defaults → Dictation** to pick the speech-to-text model. The choice is stored under the app-level `dictation` key (`{ modelId, providerId }`) and is read by the Dictation page and the chat composer's microphone alike, so both agree on which model a recording is sent to (see [Dictation](./dictation.md)).

## Related

- [Authentication](./authentication.md#app-access-control-who-can-open-mouaif) — user login, passwords, and passkeys.
- [Project settings storage](./project-settings-storage.md) — storing project settings without writing files to your git repo.
- [Custom prompts](./custom-prompts.md) — creating and managing prompt presets.
- [Tool authorization](./tool-authorization.md) — configuring tool execution permissions.
