# On-the-fly MCP Apps — implementation notes

## Overview

An isolated follow-up to the existing MCP Apps branch: render an interactive single-file HTML/browser-JS app view in the current chat with agent message passing (`window.mouaifApp.sendMessage`), without registering an MCP server or MCP tool, or prepare a request in a separate resumable development chat. The public guide is [On-the-fly MCP Apps](../../features/on-the-fly-mcp-apps.md).

## Usage

The native `create_mcp_app` tool creates or opens an interactive app view directly inside the current chat's tool card (`source` + `filename` or `path`) after explicit approval, or prepares a development draft (`request`). The project MCP settings page also exposes a form for saving a single-file app under `.mouaif/mcp-apps/` or opening a request draft chat, without registering any MCP server or tool.

## Implementation notes

- `src/instant-mcp-apps.js`: source/type/byte validation, canonical in-project paths, storage symlink guard, unique source paths, single-file generation draft. Injects the installed official SDK's self-contained `app-with-deps` module without a CDN or build dependency. Extracts the exported App binding and fails if that pinned bundle layout changes. SDK and author JS have separate module scopes; script-end sequences are escaped. Never registers a project MCP server or MCP tool.
- `src/server-handlers-mcp-apps.js`: mounts `create_mcp_app` results directly from persisted transcript rows (`callId`), reading and rendering the source file into the isolated sandbox with `creationTool: 'create_mcp_app'`, no MCP session (`session === null`), and `POST /message` support for bounded user-text messages back to the bound chat. `POST /call` is rejected (`403 EMCP_VISIBILITY`) since on-the-fly apps do not expose MCP server tools.
- `src/server-handlers-instant-mcp-apps.js`: host-origin/access-gated request/import APIs, single-file validation/storage without MCP server registration, unsent development drafts, 512 KiB source/1 MiB HTML bounds, 100-character names, 16000-character requests. Exact one-of path/source selection.
- `src/http-server.js`: dispatch the two exact creation routes before the mount-capability routes; existing access/session and the sandbox host remain unchanged.
- `frontend/src/components/settings/InstantMcpApp.jsx`: local form state, JSON API calls, bounded uploads, unmount guard, new chat navigation; `SettingsMcp.jsx` shows it only for a selected project. CSS and browser tests cover 360/390/430 px, no overflow, 44 px controls.

On-the-fly views reuse MCP Apps' sandbox isolation and all messaging/approval policies. Symlink checks are not a boundary against an adversarial local process racing filesystem changes, consistent with existing project file and shell access. `.mouaif` may be Git-ignored.

## Verification

```bash
npm run test:instant-mcp-apps
npm run test:mcp-apps
npm run lint
npm run build:web
node scripts/test-docs-links.js
```

The server test uses temporary MOUAIF_HOME and a real createServer instance. It validates `create_mcp_app` and HTTP source imports, direct chat-card mounting, non-registration of MCP servers/tools, rejection of `/call` on card mounts, draft creation, source refresh, Node execution sentinel, size/type/traversal/symlink/origin/method guards and frontend serving. The Chrome test uses actual form/frame components and SDK injection with fake API fixtures, an opaque sandbox, normal site isolation, initialization/user messaging and width/touch checks. Screenshot pixel sampling confirms light/dark host backdrops show through both frame layers at 360/390/430 px, fullscreen retains the sheet backdrop, and app-authored opaque backgrounds remain intact.
