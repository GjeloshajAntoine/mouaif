# Extensions — implementation notes

> Agent-facing reference for [`docs/features/extensions.md`](../../features/extensions.md). Design: [the extensions spec](../specs/extensions.md).

- `src/extensions.js`: `validate(raw, { scope })` returns the normalized view (`id`, `name`, `version`, `description`, `server`, `permissions`, `hooks` via `hooks.normalizeHook(…, { inExtension: true })`, `ui`). The raw object is what is stored and exported. A project scope refuses an inline server.
- App store: table `extension (id, manifest, enabled, imported_at, server_id, position)`. `importApp` upserts it off (and unregisters a previously registered inline server); `setAppEnabled(true)` registers an inline server with `mcp.addServer(null, { scope: 'app' })` and keeps its id; off/delete call `mcp.removeServer`. `exportApp` is the stored JSON plus `exportedAt`.
- Per-project switch: project setting `extensions: { "<id>": { "enabled": false } }` (`setProjectOff`).
- Project files: `.mouaif/extensions/<id>.mouaif-extension.json` (file name must match the id, ≤ 1 MiB). Hash = canonical JSON + the project files its command hooks run (`projectHooks.referencedFiles`); trust in `hook_trust` under key `ext:<id>`.
- `active(projectDir)`: enabled app extensions not off here and not shadowed by a project file, then trusted project extensions not off here. `runtimeHooks(projectDir)` (2 s cache, cleared on every write) gives `{ app, project }` hook lists with ids `<ext>/<hook>`, `extension` set, `scope: 'project'` for project ones, and mcp handlers bound to the server slug. `src/hooks.js` merges them: app → app extensions → project hooks → project extensions → chat.
- `mcp` hook kind (`src/hooks.js runMcp`): `mcp.callTool(projectDir, slug, tool, input, { timeoutMs, signal })`; `structuredContent` (JSON) or the text blocks become stdout; `isError` is a hook error. Bare hooks must name `handler.server`.
- Surfaces: `surface(projectDir, extensionId, surfaceId)` resolves an active extension's UI entry; `surfaces(projectDir, slot)` lists them for the UI (`GET /api/extensions/surfaces`, no HTML). `surfaces` is a reserved id.
- Mounting (`src/server-handlers-mcp-apps.js mountSurface`): `POST /api/mcp/apps/mount { projectDir, chatId?, extensionId, surfaceId }` creates a mount of kind `surface` through the same sandbox, tickets, lease and 30-minute expiry as tool-result apps. Inline `html` goes through `instant-mcp-apps.renderHtml` (bundled SDK, `window.mouaifApp`) with a no-network CSP; a `ui://` resource starts the extension's server if needed and reads it with `readAppResource(…, { declaredByExtension: true })` (no tool has to declare it). Chat slots (`CHAT_SLOTS`) need a chat. `validateSurface` revokes the mount when the extension is off, untrusted or changed, the chat is gone, or the server session/resource epoch changed. `/message` needs `chat.message` and a chat; `/call` needs a chat.
- Client: `McpAppFrame` takes `surface` (`{ extensionId, surfaceId, slot, projectName }`), `onClosed` (only the user's Close) and `onBridge`; `appHostContext.js` builds the theme host context (standard MCP Apps variables mapped from mouaif tokens, light/dark from `--bg`) and the live budget (`MAX_LIVE = 2`, `claimSurface` / `releaseSurface`); `theme/runtime.js paintStyles` fires `mouaif:theme-painted`, which pushes `host-context-changed`. `ExtensionDocks.jsx` (chat.dock), `ExtensionSheet.jsx` (chat.sheet, opened from `FileToolbar` or `extensionEvents.openExtensionSheet`), `extensionEvents.js` (registry of live views for badges, sheets and host events).
- REST (`src/server-handlers-extensions.js`):

```
GET    /api/extensions?projectDir=                    -> { app: [view], project: [view], permissions }
POST   /api/extensions { manifest }                   -> { extension, summary, replaced }   (imported off)
PUT    /api/extensions/:id { enabled }                -> { extension }
PUT    /api/extensions/:id { projectDir, offInProject } -> { ok }
DELETE /api/extensions/:id                            -> { ok }
GET    /api/extensions/:id/export                     -> the file (attachment)
POST   /api/extensions/:id/trust { projectDir, hash } -> { extension }   (409 when changed)
DELETE /api/extensions/:id/trust?projectDir=          -> { ok }
```

- Frontend: `frontend/src/components/SettingsExtensions.jsx` (`#/settings/extensions`), `components/settings/ExtensionSummary.jsx` (permission screen), and the project banner `components/chat/ProjectHooksBar.jsx`, which also lists untrusted project extensions.
- Tests: `node scripts/test-extensions.js` (uses the stub MCP server `scripts/test-extension-server.js`).
