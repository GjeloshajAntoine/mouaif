# On-the-fly MCP Apps

## Overview

Create a local MCP App from a request or a single HTML/browser-JavaScript file, without creating a server project or installing dependencies. Requests open a separate resumable development chat; file imports register a small trusted stdio adapter that serves the app to the existing sandboxed MCP Apps host.

## Usage

### From a chat tool

Ask the assistant to create an interactive app. The native **`create_mcp_app`** tool lives in the **mouaif** tool family and accepts:

- `source` plus `filename` (`.html`, `.htm`, `.js`, or `.mjs`): writes a uniquely named source file and renders the interactive app directly inside the current chat's tool card (without registering a project-wide MCP server).
- `path`: renders an existing file relative to the original project folder (not the chat's alternate working folder) directly inside the current chat's tool card (without registering a project-wide MCP server).
- `request`: prepares a separate development chat with an unsent draft. This mode does not generate source, register a server, start an AI response, or spend credits.

`name` is optional. File creation/import always requires an explicit approval, even when the family or tool is **Allow**. **Off** hides and blocks it. Denying approval writes no file. No tool permissions or project MCP servers are changed.

```json
{
  "name": "Checklist",
  "filename": "checklist.html",
  "source": "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>button{min-height:2.75rem}</style></head><body><button onclick=\"this.textContent='Done'\">Mark done</button></body></html>"
}
```

The successful creation tool card automatically expands and opens the app view immediately in the current chat. Its result includes `name` and `path`. Inside the app, await `window.mouaifAppReady` and call `window.mouaifApp.sendMessage({ role: 'user', content: [{ type: 'text', text: '...' }] })` to communicate back with the agent in the current chat.

All existing single-file limits, transparent backgrounds, SDK injection, sandbox isolation and deployment restrictions below apply equally to the native tool. It accepts no custom command, environment, provider credentials or arbitrary project directory.

### From Settings

Open **Settings → This project → MCP servers → On-the-fly app**. This is project-scoped; it is not shown in the app-wide server list.

### From a request

1. Choose **Request**, name the app, and describe what it should do.
2. Tap **Open development chat**. A new chat opens with a reviewable draft containing the request, a unique output filename, and single-file/mobile/sandbox constraints.
3. Choose a model and send the draft. Normal file/shell/tool approvals still apply. Creating the draft does not run an AI request or spend provider credits.
4. When the HTML file is ready, return to the project's MCP servers and import the generated project-relative path from the draft.

This separates app development from your current feature conversation. Multiple requests get separate chats and random output filenames, so they do not target the same app file. These chats share the project checkout; this is not automatic Git worktree isolation. Use the existing authorized shell and working-folder workflow for larger parallel changes.

### From one file

1. Choose **Single HTML / JS file**.
2. Upload one `.html`, `.htm`, `.js`, or `.mjs` file, or enter its existing project-relative path.
3. Tap **Add app**. Uploaded source is saved under `.mouaif/mcp-apps/`; an existing path is referenced in place.
4. Start the new MCP server and ask a chat to call its `view` tool. MCP Apps are always available for compatible project tools. Expand the completed tool card to open the app.

HTML must be self-contained, with inline CSS and browser JavaScript. Browser-JS files receive a mobile page shell and a `<main id="app">` mount point. External imports, CDN assets, Node APIs and network requests are not supported by this zero-network adapter. JavaScript source is never executed on the Node server.

The frame and generated browser-JS shell are transparent by default. Request drafts ask for transparent `html`/`body` backgrounds unless the request needs an opaque background. For an imported HTML app, leave its backgrounds unpainted or use `html, body { background: transparent; }` to show the chat backdrop. Author-selected backgrounds are not overridden. Fullscreen keeps its sheet backdrop, and sandbox permissions remain unchanged.

The host injects the official MCP Apps SDK, connects it automatically, and exposes `window.mouaifApp` plus `window.mouaifAppReady`. Author modules can await the ready promise; classic inline scripts can listen for `mouaif-app-ready` before using it. Do not initialize a second bridge.

Example single-file browser app:

```javascript
const root = document.querySelector('#app');
root.innerHTML = '<button id="explain">Explain my checklist</button>';
document.querySelector('#explain').onclick = async () => {
  await window.mouaifAppReady;
  await window.mouaifApp.sendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Help me prioritize this checklist.' }]
  });
};
```

App-authored user messages automatically start a normal response in the bound chat and can consume provider credits. All [MCP Apps limitations and trust warnings](./mcp-apps.md) still apply, including the initial direct-HTTP/second-port deployment restriction. Import does not start the server, weaken tool permissions, or grant device/network access.

Use the existing MCP server controls to start, stop, edit or remove the adapter. Removing its registry entry does not delete the source file. Edit a referenced file and close/retry its view to reload it; there is no file watcher or hot-reload protocol. Uploaded files are copies, not links to the phone's original file. The adapter configuration contains absolute runtime/project paths; re-import after moving a project or the installed runtime. `.mouaif/` may be Git-ignored; keep deliberately versioned apps in a regular project directory and import their paths.

## HTTP interface

Both endpoints use the main app's existing access gate and reject null/cross-site browser origins. `projectDir` must identify an existing directory. These are host-side APIs, not sandbox APIs.

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/mcp/apps/request` | `{ projectDir, name?, request }` | `201 { chatId, path, url }`; a new chat with an unsent development draft. |
| POST | `/api/mcp/apps/import` | `{ projectDir, name?, path }` or `{ projectDir, name?, filename, source }` | `201 { server, path }`; a stopped project-scoped stdio adapter. |

App names are 1–100 characters; requests are non-empty and at most 16,000 characters. Source files are non-empty and at most 512 KiB; rendered HTML including the SDK must fit the MCP host's 1 MiB resource limit. Exactly one `path` or `source` is accepted. Paths must be relative and resolve inside the project, including after symlink resolution. App storage symlinks resolving outside the project are rejected.

## Verification

Run the focused tests:

```bash
npm run test:instant-mcp-apps
npm run test:mouaif-tool
node scripts/test-tool-groups.mjs
```

They cover native tool advertisement/dispatch, explicit registration approval and denial, family/leaf Off, native-card sandbox mounting and permission revocation, real HTTP import/request routes, stdio discovery/resource reads, source edits, no Node execution, limits and traversal/origin rejection, plus official SDK initialization and messaging inside Chrome's opaque sandbox, form JSON submission and narrow layouts.
