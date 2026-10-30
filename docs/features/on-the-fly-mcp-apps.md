# On-the-fly MCP Apps

## Overview

Create an interactive single-file app view inside the current chat from inline HTML/browser-JavaScript source or a project-relative file path, with bidirectional message passing to the agent (`window.mouaifApp.sendMessage`) and without registering an MCP server or MCP tool. Alternatively, prepare a request in a separate resumable development chat.

## Usage

### From a chat tool

Ask the assistant to create or update an interactive app. The native **`create_mcp_app`** tool lives in the **mouaif** tool family and accepts:

- `source` plus `filename` (`.html`, `.htm`, `.js`, or `.mjs`): writes a uniquely named source file and renders the interactive app view directly inside the current chat's tool card (without registering a project MCP server or MCP tool).
- `path`: renders an existing file relative to the original project folder (not the chat's alternate working folder) directly inside the current chat's tool card, or reloads an already-mounted app card for that `path` in place (without registering a project MCP server or MCP tool).
- `path` plus `source`: updates an existing project-relative `.html`, `.htm`, `.js`, or `.mjs` app file in place (such as the `path` returned by an earlier `create_mcp_app` call) and automatically reloads its mounted app card in the current chat without creating a duplicate iframe.
- `message`: pushes a message from the agent to the mounted app view in the current chat using the official `AppBridge` `sendToolInput` / `sendToolResult` notifications (`ui/notifications/tool-input` and `ui/notifications/tool-result`).
- `request`: prepares a separate development chat with an unsent draft. This mode does not generate source, register a server, start an AI response, or spend credits.

`name` is optional. File creation, import, and in-place updates always require an explicit approval, even when the family or tool is **Allow**. **Off** hides and blocks it. Denying approval writes no file. No tool permissions or project MCP servers are changed.

```json
{
  "name": "Checklist",
  "filename": "checklist.html",
  "source": "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>button{min-height:2.75rem}</style></head><body><button onclick=\"this.textContent='Done'\">Mark done</button></body></html>"
}
```

The successful creation tool card automatically expands, opens the app view immediately in the current chat, and stays pinned at the bottom of the transcript as later messages and tool calls arrive. Only the latest app stays there: when a newer app is created (or an older one is updated in place), the previous app card goes back to its chronological place in the chat. Moving a card reloads its app view. Its result includes `name` and `path`. To update an existing app in place, call `create_mcp_app` with `path` (from the earlier creation result) and the updated `source` (or edit the file and call `create_mcp_app` with `path`); the existing mounted app card reloads in place with `updated: true` instead of opening a second iframe. Inside the app:

- **App → Agent (`ui/message`)**: await `window.mouaifAppReady` and call `window.mouaifApp.sendMessage({ role: 'user', content: [{ type: 'text', text: '...' }] })`.
- **Agent → App (`ui/notifications/tool-input` & `ui/notifications/tool-result`)**: register `window.mouaifApp.addEventListener('toolresult', params => ...)` (or `window.addEventListener('mouaif-app-message', e => ...)`), which receives `{ content: [{ type: 'text', text }], structuredContent: { message, name } }` whenever the agent calls `create_mcp_app` with `message`.

All existing single-file limits, transparent backgrounds, SDK injection, sandbox isolation and deployment restrictions below apply equally to the native tool. It accepts no custom command, environment, provider credentials or arbitrary project directory.

### From Settings

Open **Settings → This project → MCP servers → On-the-fly app**. This is project-scoped; it is not shown in the app-wide server list.

### From a request

1. Choose **Request**, name the app, and describe what it should do.
2. Tap **Open development chat**. A new chat opens with a reviewable draft containing the request, a unique output filename, and single-file/mobile/sandbox constraints.
3. Choose a model and send the draft. Normal file/shell/tool approvals still apply. Creating the draft does not run an AI request or spend provider credits.
4. When the HTML file is ready, the agent can call `create_mcp_app` with `path` to open the interactive app view directly in the chat.

This separates app development from your current feature conversation. Multiple requests get separate chats and random output filenames, so they do not target the same app file. These chats share the project checkout; this is not automatic Git worktree isolation. Use the existing authorized shell and working-folder workflow for larger parallel changes.

### From one file

1. Choose **Single HTML / JS file**.
2. Upload one `.html`, `.htm`, `.js`, or `.mjs` file, or enter its existing project-relative path.
3. Tap **Add app**. Uploaded source is validated and saved under `.mouaif/mcp-apps/`; an existing path is validated in place. No MCP server or MCP tool is registered.
4. Ask a chat to call `create_mcp_app` with that `path` to open the interactive app view in the conversation.

HTML must be self-contained, with inline CSS and browser JavaScript. Browser-JS files receive a mobile page shell and a `<main id="app">` mount point. External imports, CDN assets, Node APIs and network requests are not supported by this zero-network view. JavaScript source is never executed on the Node server.

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

App-authored user messages automatically start a normal response in the bound chat and can consume provider credits. All [MCP Apps limitations and trust warnings](./mcp-apps.md) still apply, including the initial direct-HTTP/second-port deployment restriction. Adding a file does not register a server, weaken tool permissions, or grant device/network access.

Edit a referenced file and close/retry its view in the chat card to reload it; there is no file watcher or hot-reload protocol. Uploaded files are copies, not links to the phone's original file. `.mouaif/` may be Git-ignored; keep deliberately versioned apps in a regular project directory and reference their paths.

## HTTP interface

Both endpoints use the main app's existing access gate and reject null/cross-site browser origins. `projectDir` must identify an existing directory. These are host-side APIs, not sandbox APIs.

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/mcp/apps/request` | `{ projectDir, name?, request }` | `201 { chatId, path, url }`; a new chat with an unsent development draft. |
| POST | `/api/mcp/apps/import` | `{ projectDir, name?, path }` or `{ projectDir, name?, filename, source }` or `{ projectDir, name?, path, source }` | `201 { name, path, updated? }`; validates and saves or updates the single-file app without registering an MCP server. |

App names are 1–100 characters; requests are non-empty and at most 16,000 characters. Source files are non-empty and at most 512 KiB; rendered HTML including the SDK must fit the MCP host's 1 MiB resource limit. Provide `path`, `filename` + `source`, or `path` + `source` (to update an existing file in place). Paths must be relative and resolve inside the project, including after symlink resolution. App storage symlinks resolving outside the project are rejected.

## Verification

Run the focused tests:

```bash
npm run test:instant-mcp-apps
npm run test:mouaif-tool
node scripts/test-tool-groups.mjs
```

They cover native tool advertisement/dispatch, explicit creation approval and denial, family/leaf Off, native-card sandbox mounting and permission revocation, real HTTP import/request routes, source edits, no MCP server/tool registration, no Node execution, limits and traversal/origin rejection, plus official SDK initialization and messaging inside Chrome's opaque sandbox, form JSON submission and narrow layouts.
