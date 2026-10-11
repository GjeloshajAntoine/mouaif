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
- `frontend/src/components/chat/mcpAppBridge.js`: official AppBridge with source AND origin checked transport; do not pass a direct MCP client to the bridge (that would proxy tools without the authorization endpoint). serverTools and text-only message capabilities granted. `ui/message` goes to the mount-bound message endpoint and starts `startChatTurn` using the persisted chat model/options, with app attribution, a 16 KiB/16-block cap, a 5 s per-chat attempt limit and busy rejection. No output/history returns to the view; accepted turns survive view closure. Unsupported links/context/downloads/resources remain errors.
- `McpAppFrame.jsx`, `mcp-app.css`: bounded initialization and teardown, polling for server/resource invalidation, host-owned calls and approval rendering, inline/fullscreen, retry/text fallback and hook cleanup.
- `transcript.js`, `useChatState.js`: lazy mount on completed MCP result expansion, original result retained; runtime project/chat context bound before mounting. `cards.js`: show authorization summary so the user sees the serving app identity. `SettingsProject.jsx`: project opt-in.
- Official sources enter through the overview's links. SDK pinned to `2.0.3`, reviewed revision `82221c0c8ce7661efa6771c9d461511b1650495f`; do not confuse package release with extension date `2026-01-26`.

## Testing and landing

Tests: `test-mcp-apps-detection.js`, `test-mcp-apps-host.js`, `test-mcp-apps-ui.mjs`, `test-mcp-apps-e2e.mjs`; fixture `test-mcp-apps-server.js`. The UI test bundles the official App and actual host component with a fake mount API; the host test exercises actual REST gates and the E2E combines both with the real AI runner. Browser checks retain normal site isolation. Docker uses `scripts/Dockerfile.mcp-apps` atop existing `mouaif-app:latest`; phase 0 can also reuse the already-installed `mouaif-track-b-mcp-apps:test` image, copying current source into its isolated container without dependency installation.

Known baseline: `test-mcp-http.js` has three stale assertions and `test-mcp-ondemand.js` calls `test_server` after registering `echo`; both failures were previously reproduced on untouched 6933d3ba. Leave unrelated repairs separate.

Shared surfaces at landing: `src/mcp.js`, `src/http-server.js`, SettingsProject, `cards.js`, `transcript.js`, `useChatState.js`, package/lockfile and documentation indexes. No native tool names added. Track B lands after A/E/C/D; no automatic merge/push. Generated frontend and public docs should be refreshed by the merge-queue caretaker rather than imported from a stale parallel branch.

## Verification evidence

- Automatic message follow-up: official App SDK `sendMessage` tested through the real bridge; actual HTTP route starts a held mock provider and persists an app-attributed user prompt. Tests reject forged chat targets, non-user roles, non-text/oversized content, busy-chat requests and rate-limit retries; the view receives `{}` only. Docker, lint, frontend build and doc checks rerun successfully.
- Passed: `npm run test:mcp-apps`, isolated Docker image/run (official App SDK browser + actual HTTP routes + metadata + MCP smoke + 41 web CSP checks), `npm run build:web`, `npm run lint`, tool groups, test-coverage wiring, subagent prompt suite, tool authorization (77 assertions), docs links/build, project settings UI at 360/390/430 px and built chat element stability.
- `npm run test:project-settings` stops in `test-settings-back.mjs` with `ReferenceError: TOOL_GROUPS is not defined`; reproduced the same failure from untouched `git archive 6933d3ba`. New settings UI itself passes. Existing MCP HTTP/ondemand baseline failures remain unrelated.
- Docker initially exposed missing dev dependencies (production base omits esbuild) and Chrome profile cleanup racing process exit; the test Dockerfile explicitly includes dev dependencies and browser cleanup now waits for Chrome exit.
- Generated frontend/public docs are not part of the feature commit: caretaker must refresh at landing after rebasing. No merge, push or running-app restart occurred.

## Phase 0 security/lifecycle review

- Fixed source-tool Off/visibility/URI and requested-tool revocation gaps; check registered server + exact live session, project opt-in, chat and epoch on operations, ticket navigation and 5 s sweeps. Post-read mount validation closes async revocation races; post-await ticket/mount bounds close concurrent capacity races; late tool results revalidate before responding.
- Mounts pin host origin. Reject opaque/cross-site and same-site-but-cross-origin browser requests even without Origin; restrict HTTP methods while preserving authorized no-Origin CLI use. Sandbox tickets pin Host/referrer, are single-use, and consult mount validity. Browser ports are NOT cookie boundaries; HttpOnly cookies can be transmitted to the trusted listener, which ignores and never reflects cookie/auth headers.
- A 20 s lease renewed on status (5 s poll/sweep), plus 30 min absolute expiry, cancels abandoned requests/approvals without relying on DELETE. Close/pagehide/visibility hide independently revoke with keepalive; abort signals settle/remove host approval cards. Callback identity changes no longer reconnect an initialized bridge. Accepted AI turns intentionally survive closure.
- `scripts/lib/mcp-apps-cdp.mjs` attaches flattened child-target sessions; browser tests no longer disable site isolation. `test-mcp-apps-e2e.mjs` combines the official App SDK, actual REST gates/stdio MCP, real shared AI runner and local streaming provider. It verifies attributed persistence, model tool approval, SSE replay, Close/Retry/approval UI cleanup, Stop, unchanged drafts and 360/390/430 px. Fixture shell is custom; APIs are not mocked.
- Remaining coverage: deployed HTTPS/PWA, malicious navigation/reload storms, multi-follower approval races, long-session authorization grant/deny bookkeeping, hostile external DNS/private resolution. The synthetic visibility test exercises cleanup, not installed-PWA suspension. This is bounded hardening, not a completed independent security audit; production rollout and new capabilities remain gated by the remaining review and phase 1.
- Verified phase 0 source in the existing installed Docker image (no dependency installation): all four Apps regressions, MCP smoke (42), web CSP (41), frontend build; lint, tool groups (20), coverage wiring (7), tool authorization (77), MCP gate (17), grant cleanup (12), chat authorization (39), subagent prompt suite and public/internal docs build/links pass. Mobile E2E checks 360/390/430 px; built chat reentry, responsive layout, inspector mobile, service-worker reload and install checks pass separately.
- Full `test:browser-build` is not green: chat element assertions pass but Chrome profile cleanup raises `ENOTEMPTY`; reproduced on untouched `git archive 6cabdac0` in the same Docker image. `test-subagent-transcript-ui.mjs` is a manual 5-minute fixture and exceeds the batch timeout (not an assertion failure); it was not interactively verified here. `test-docs-publish.js` fails for missing `mcp-apps.html`/stale `mcp.html`, identically reproduced on untouched 6cabdac0. Preserve existing generated frontend work; published frontend/docs regeneration remains dependent landing work, not deployment-ready in this commit.

## Limitations

Direct HTTP/extra-port reachability only; configured HTTPS sandbox deployment is not implemented. No image/audio/resource app messages, context writes, links, downloads, device permissions, nested frames, wildcard/private resource origins, subscriptions or automatic tool-input preloading. Resource change detection requires receipt of server notifications (no subscription) and polling. Old stopped-server results do not auto-start processes for rendering. Views mount after completed persisted tool results, not during streaming.
