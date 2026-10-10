# MCP Apps — implementation notes

## Overview

User requested replacing the earlier backend-only feature according to the [official overview](https://modelcontextprotocol.io/extensions/apps/overview), then approved its linked official references, SDK 2.0.3 and a local sandbox listener, with Docker testing. The earlier speculative documentation is replaced; the mandatory feature page remains at [MCP Apps](../../features/mcp-apps.md).

## Usage

Project-only setting: `mcpApps: { enabled: true }`; UI control in SettingsProject General. Servers initialized while enabled advertise `extensions['io.modelcontextprotocol/ui'].mimeTypes`. Reconnect existing MCP sessions after toggling. Direct HTTP only: a lazily started ephemeral listener uses the host hostname with a distinct port. The browser must reach it; HTTPS/proxied clients retain text results.

## Implementation notes

- `src/mcp-apps.js`, `src/mcp.js`: metadata/caller visibility, validated resources, bounded session cache, invalidation and capability advertisement.
- `src/mcp-apps-sandbox.js`: per-app-server listener, validated CSP, restricted permissions, expiring proxy tickets, no API/cookie/resource-serving routes. `src/mcp-apps-sandbox-proxy.js`: source/origin checked relay, outer distinct origin and inner opaque-origin view. Host/sandbox use no credential-bearing CORS.
- `src/server-handlers-mcp-apps.js`: persisted transcript-derived project/chat/server/resource identity, bounded server-generated mount/approval capabilities, off/ask/allow via existing authorization, raw app-visible tools only, replay protection, cancellation and session/epoch checks. REST shapes documented in the feature page.
- `src/http-server.js`: create the host per HTTP server, mount routes after normal access gates, dispose on server close. No running server restart is required or performed by this work.
- `frontend/src/components/chat/mcpAppBridge.js`: official AppBridge with source AND origin checked transport; do not pass a direct MCP client to the bridge (that would proxy tools without the authorization endpoint). Only serverTools capability granted. Unsupported open links/messages/context/downloads/resources remain errors.
- `McpAppFrame.jsx`, `mcp-app.css`: bounded initialization and teardown, polling for server/resource invalidation, host-owned calls and approval rendering, inline/fullscreen, retry/text fallback and hook cleanup.
- `transcript.js`, `useChatState.js`: lazy mount on completed MCP result expansion, original result retained; runtime project/chat context bound before mounting. `cards.js`: show authorization summary so the user sees the serving app identity. `SettingsProject.jsx`: project opt-in.
- Official sources enter through the overview's links. SDK pinned to `2.0.3`, reviewed revision `82221c0c8ce7661efa6771c9d461511b1650495f`; do not confuse package release with extension date `2026-01-26`.

## Testing and landing

New tests: `test-mcp-apps-detection.js`, `test-mcp-apps-host.js`, `test-mcp-apps-ui.mjs`; fixture `test-mcp-apps-server.js`. The UI test bundles the official App and actual host component, runs Chrome at 360 px, checks origin isolation/CSP, approval/denial, fullscreen and teardown. Its fake mount API isolates browser behavior; the host test separately exercises actual REST gates. Docker uses `scripts/Dockerfile.mcp-apps` atop existing `mouaif-app:latest`, installs from the committed lockfile and runs those checks plus MCP and web CSP.

Known baseline: `test-mcp-http.js` has three stale assertions and `test-mcp-ondemand.js` calls `test_server` after registering `echo`; both failures were previously reproduced on untouched d45b1f23. Leave unrelated repairs separate.

Shared surfaces at landing: `src/mcp.js`, `src/http-server.js`, SettingsProject, `cards.js`, `transcript.js`, `useChatState.js`, package/lockfile and documentation indexes. No native tool names added. Track B lands after A/E/C/D; no automatic merge/push. Generated frontend and public docs should be refreshed by the merge-queue caretaker rather than imported from a stale parallel branch.

## Verification evidence

- Passed: `npm run test:mcp-apps`, isolated Docker image/run (official App SDK browser + actual HTTP routes + metadata + MCP smoke + 41 web CSP checks), `npm run build:web`, `npm run lint`, tool groups, test-coverage wiring, subagent prompt suite, tool authorization (77 assertions), docs links/build, project settings UI at 360/390/430 px and built chat element stability.
- `npm run test:project-settings` stops in `test-settings-back.mjs` with `ReferenceError: TOOL_GROUPS is not defined`; reproduced the same failure from untouched `git archive d45b1f23`. New settings UI itself passes. Existing MCP HTTP/ondemand baseline failures remain unrelated.
- Docker initially exposed missing dev dependencies (production base omits esbuild) and Chrome profile cleanup racing process exit; the test Dockerfile explicitly includes dev dependencies and browser cleanup now waits for Chrome exit.
- Generated frontend/public docs are not part of the feature commit: caretaker must refresh at landing after rebasing. No merge, push or running-app restart occurred.

## Limitations

Direct HTTP/extra-port reachability only; configured HTTPS sandbox deployment is not implemented. No app messages/context writes, links, downloads, device permissions, nested frames, wildcard/private resource origins, subscriptions or automatic tool-input preloading. Resource change detection requires receipt of server notifications (no subscription) and polling. Old stopped-server results do not auto-start processes for rendering. Views mount after completed persisted tool results, not during streaming.
