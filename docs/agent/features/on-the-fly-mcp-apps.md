# On-the-fly MCP Apps — implementation notes

## Overview

An isolated follow-up to the existing MCP Apps branch: import one HTML/browser-JS file, or prepare a request in a separate resumable development chat. The public guide is [On-the-fly MCP Apps](../../features/on-the-fly-mcp-apps.md).

## Usage

The project MCP server list contains the form; app-wide settings do not. Request creation writes only a chat draft and allocates a unique output path. The user chooses a model, sends the draft and imports its output afterward. Parallel drafts use separate filenames and chats but share the checkout; no hidden worktrees, automatic AI execution or settings changes occur.

## Implementation notes

- `src/instant-mcp-apps.js`: source/type/byte validation, canonical in-project paths, storage symlink guard, unique source paths, single-file generation draft. Injects the installed official SDK's self-contained `app-with-deps` module without a CDN or build dependency. Extracts the exported App binding and fails if that pinned bundle layout changes. SDK and author JS have separate module scopes; script-end sequences are escaped.
- `src/instant-mcp-app-server.js`: trusted stdio adapter, only a `view` tool plus the declared `ui://mouaif/instant-app` resource. Reads app source as data, never Node-imports or evaluates it. No additional tools, credentials or external CSP origins. Existing paths are reread on resource requests; users close/retry to refresh. No watcher/subscription or live replacement of initialized HTML.
- `src/server-handlers-instant-mcp-apps.js`: host-origin/access-gated request/import APIs, stopped project server registration, unsent development drafts, 512 KiB source/1 MiB HTML bounds, 100-character names, 16000-character requests. Exact one-of path/source selection. Import does not enable Apps, start the server or alter tool permission policy.
- `src/http-server.js`: dispatch the two exact creation routes before the mount-capability routes; existing access/session and the sandbox host remain unchanged.
- `frontend/src/components/settings/InstantMcpApp.jsx`: local form state, JSON API calls, bounded uploads, unmount guard, new chat navigation; `SettingsMcp.jsx` shows it only for a selected project. CSS and browser tests cover 360/390/430 px, no overflow, 44 px controls.

The adapter reuses MCP Apps' current HTTP/ephemeral-second-port limitation and all messaging/approval policies. Generated registry arguments contain the absolute runtime/adapter/project paths; re-import is required after relocation. Symlink checks are not a boundary against an adversarial local process racing filesystem changes, consistent with existing project file and shell access. Uploaded originals remain as source files when registry entries are removed; .mouaif may be Git-ignored.

## Verification

```bash
npm run test:instant-mcp-apps
npm run test:mcp-apps
npm run lint
npm run build:web
node scripts/test-docs-links.js
```

The new server test uses temporary MOUAIF_HOME, a real createServer instance and stdio adapters. It validates source imports, draft creation, source refresh, Node execution sentinel, resource metadata, size/type/traversal/symlink/origin/method guards and frontend serving. The new Chrome test uses actual form/frame components and SDK injection with fake API fixtures, an opaque sandbox, normal site isolation, initialization/user messaging and width/touch checks. Existing MCP Apps real-host regressions independently cover authorization, persistence and AI/SSE flow. No running host app restart is needed for verification; deployment requires landing the prerequisite branch and this commit plus reloading server code through the managed app workflow.
