# App and project settings

## Overview

`mouaif` resolves every setting through a three-layer merge: **built-in defaults → app-level store → project-level file**. Project values win on conflict. The app store is a single SQLite file in the user's home directory; the project file is a plain `.mouaif.json` next to the project, so it can be committed to source control.

This feature implements [docs/decisions.md §1–§2](../decisions.md).

## Usage

### Resolution

```js
const settings = require('mouaif/src/settings.js');

// Whole resolved view for a project (defaults -> app -> project).
settings.getResolved('/path/to/project');
// -> { providers: [...], models: [...], promptSize: 'average', flags: {}, ... }

// Just the app store (no merge).
settings.getApp();

// Just the project file (no merge).
settings.getProject('/path/to/project');
```

### Writing

```js
// Shallow-merge `patch` into the app store. Returns the new full app object.
settings.setApp({ promptSize: 'extensive' });

// Shallow-merge `patch` into <projectDir>/.mouaif.json. Returns the new file.
settings.setProject('/path/to/project', { promptSize: 'very-small' });
```

## Behavior

- **Defaults** (`src/settings.js` → `DEFAULTS`): `{ providers: [], models: [], projects: [], authAccounts: {}, promptSize: 'average', toolFeedbackMaxBytes: 65536, toolOutput: { size: 'average', structure: 'full' }, notifications: {…}, flags: {} }`. The floor for every resolution. Trace is intentionally absent because it is opt-in per chat. The app store also carries additive keys with no in-code default — their absence is the default: `modelPricing` (per-model USD pricing for the cost line in [Usage metrics](./usage-metrics.md); a small built-in table in [src/usage.js](../../src/usage.js) covers the model ids the providers ship today) and `githubCopilot` (custom OAuth client id).
- **Provider scope**: provider connections and credentials are app-level only. Project files define model IDs and reference a provider by id; they do not contain provider credentials.- **App-level MCP gate**: the app store carries `mcp.authorization` (`{ mode, allowlist }`), the default MCP tool-call permission for every project that has not set its own. Per-server / per-tool MCP rules stay project-scoped in `<projectDir>/.mcp.json`. Written via `authorization.setAppMcpAuthorization()`; see [tool authorization](./tool-authorization.md) and [MCP](./mcp.md).
- **App store**: a single row in `app_kv` (key `settings`) inside `~/.mouaif/store.sqlite`. WAL journal mode. Created on first access.
- **Project file**: `<projectDir>/.mouaif.json`. Created on first write, 2-space indented JSON, LF line endings. Missing file is treated as `{}` (not an error).
- **DB-backed project settings**: a project can opt out of the JSON file entirely. When **Store settings in app DB** is on (Settings → Project → Technical details), the raw project object lives in the `project_settings` table of `~/.mouaif/store.sqlite` and no `.mouaif.json` is written, so the working tree stays clean for git. See [Project settings storage](./project-settings-storage.md).
- **Resolution order**: `defaults → app → project`. Deep-merge for plain objects. Arrays and primitives are replaced, not concatenated — project wins on any conflict.
- **Client redaction allowlist**: `GET`/`PUT /api/settings/*` responses pass through `settingsForClient()` in [src/index.js](../../src/index.js), which copies only an allowlist of non-secret keys (`providers` with `apiKey` redacted, `models`, `projects`, `promptSize`, `githubCopilot`, `modelPricing`, `authAccounts`, `tools`, `toolOutput`, `flags`) and drops server-only bookkeeping (in-flight OAuth PKCE state, the CDP debugger URL, etc.). A new project-level key that the UI must read back — such as `tools.shell.enabled` — has to be added to this allowlist or it round-trips to disk but never reaches the browser.
- **Redaction round-trips**: `PUT /api/settings/app` and `PUT /api/settings/project` both sanitize `providers`/`models` patches before persisting — the response-only `hasApiKey` marker is stripped, and an entry re-submitted without `apiKey` keeps the previously stored key (so saving a redacted snapshot never wipes secrets).
- **Corrupt project file**: the GET returns HTTP 422 with `code: 'MOUAIF_PROJECT_PARSE_ERROR'`. The PUT overwrites the file with the patch merged into the current best-effort state.
- **Concurrency**: `better-sqlite3` is synchronous and single-process. Reads are safe; concurrent writes from the same process are serialized by the event loop. No transactions beyond a single prepared statement.

## Related

- Decisions: [docs/decisions.md §1–§2](../decisions.md).
- Future features may extend `DEFAULTS` with custom prompts or inspector flags. Trace-to-file remains a per-chat opt-in and does not add an app-wide default.
