# MCP Apps

## Overview

MCP Apps are interactive HTML tool views inside the conversation, as described by the [official MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview). mouaif uses the official AppBridge SDK to connect these views to their serving MCP server, with sandbox isolation and the existing tool authorization gate.

## Usage

1. MCP Apps are always available for compatible project MCP tools; there is no project enable/disable switch. Legacy `mcpApps.enabled` values are ignored.
2. Start the relevant MCP server using its Settings lifecycle control. Restart servers connected before this update so they receive the Apps capability at initialization.
3. Call a tool declaring `_meta.ui.resourceUri`. Expand its completed tool card to load the app beside the ordinary text/image result.
4. Interact with the view. App tool calls use the server's Off/Ask/Allow policy; Ask displays the app/server identity and arguments on a normal approval card.
5. Use **Fullscreen** / **Inline** for the mobile sheet, **Close** to revoke a view, or **Retry** after closure, tab hiding, a resource change or initialization failure.

App frames and sandbox wrappers have transparent backgrounds: unpainted app areas show the chat backdrop in inline mode. An app's own background is preserved; fullscreen retains its normal sheet backdrop. Transparency does not change sandbox isolation or permissions.

The host supports both **direct HTTP** (using an app-managed second listener on an ephemeral port) and **HTTPS / reverse-proxy** deployments (serving the single-use outer sandbox proxy at `/api/mcp/apps/sandbox/:token` with `Content-Security-Policy: sandbox allow-scripts` so it runs in an opaque `null` origin without needing an extra browser-facing port). Unsupported app policies, stopped servers and initialization failures keep the ordinary tool result instead. The main app's port remains 5732 by default.

**App text messages are automatic:** a view can send `ui/message` with user text to its bound chat, starting a normal AI turn without another confirmation. The transcript labels the message with its app/server. This can consume provider credits; use interactive views only from servers you trust to initiate prompts. Disable their source tools through the existing tool permissions when needed. Existing tool approvals still apply to the AI's actions.

Only user-role text is accepted (up to 16 blocks and 16 KiB). Messages cannot select another chat/model or insert assistant/system authority. They are rejected while the chat is running and limited to one attempt per chat per 5 seconds, including across remounts. The app receives only an acknowledgement, never conversation history or the AI response. Once accepted, the turn continues if the view closes; use the normal chat Stop control to cancel it.

Camera, microphone, geolocation, clipboard, external links, downloads and model-context writes are not granted. Image/audio/resource messages remain unsupported.

For local single-file apps or a request-to-development-chat workflow, see [On-the-fly MCP Apps](./on-the-fly-mcp-apps.md). Imports reuse this host and its sandbox/tool-permission restrictions.

## Official reference

The [official overview](https://modelcontextprotocol.io/extensions/apps/overview) is the entry point and source for the feature: tool metadata, UI resources, sandbox rendering, bidirectional JSON-RPC, consent and framework-independent apps. Its linked [AppBridge API](https://apps.extensions.modelcontextprotocol.io/api/modules/app-bridge.html) and [official specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) supply the wire details that the overview does not define.

The installed official SDK is pinned to `@modelcontextprotocol/ext-apps@2.0.3`, reviewed at `82221c0c8ce7661efa6771c9d461511b1650495f`, with extension protocol `2026-01-26`. The SDK version is not the protocol date. No third-party protocol summary is used.

## Security and supported behavior

- The outer proxy has a different origin from the app. Its inner app frame has an opaque origin and cannot read host DOM, cookies or storage, navigate the parent, or remove the outer sandbox.
- HTTP-header CSP defaults deny network connections. Validated public HTTPS resources and HTTPS/WSS connections can be allowed only when declared by the app. Host/private origins, wildcard rules, CSP fragments, nested frames, dedicated app domains and external base URIs are rejected in this initial host.
- The isolated listener serves only single-use, host-bound proxy tickets, no app API, session-cookie setting, service worker or HTML resource routes. App HTML arrives over a source-and-origin-checked message channel; proxy responses are `no-store`. Reload requires a fresh mount.
- **Different ports do not isolate cookies.** `HttpOnly` prevents JavaScript reads, not browser transmission: same-host sandbox requests can carry main-app cookies. The trusted listener ignores cookie/auth headers and does not reflect them into HTML, responses or bridge messages. Separate-hostname HTTPS hosting with a reviewed cookie policy remains required before production rollout; prefer a separate registrable domain.
- Every operation rechecks the live server generation, registered server, source-tool visibility/resource URI, tool Off settings and chat existence. Invalid mounts revoke their ticket and pending approvals; late tool results are not returned to a revoked app. APIs pin the mount's exact host origin, reject null/cross-site browser requests, and accept only the documented HTTP methods. No-Origin non-browser CLI access retains the ordinary access policy.
- AppBridge performs initialization. Tool input is delivered before the original result. Unknown/unimplemented requests are rejected; capabilities are not advertised merely because the overview lists them.
- Mount identities come from persisted tool call/result rows. The app cannot select another project, chat or server, or nominate its approval call ID. Only raw tools with app visibility on its own server are callable, through existing per-chat/per-tool authorization.
- Resource reads are session-scoped and bounded to 16 cached HTML resources of at most 1 MiB each. Updates invalidate the cache and mounted views detect resource/session changes; they fall back and offer Retry rather than injecting replacement HTML into an initialized app.
- Initialization has a 10-second timeout. Teardown requests wait at most 500 ms on explicit closure; navigation or recycled transcript rows use best-effort teardown because the browser may already remove the frame. Close/tab hide removes app approval UI and sends independent keepalive revocation; restore requires Retry. A 20-second server lease renewed by 5-second host polling bounds abandoned capabilities/approvals, with a 5-second sweep even if browser teardown fails. Absolute expiry is 30 minutes; limits prevent unbounded mount/call growth. Accepted automatic AI turns remain independent of app teardown.
- Inline views are width-constrained with bounded heights; fullscreen uses a safe-area sheet and controls at least 44 px tall. Text/image results remain independent of app success.

## HTTP interface

All routes use the main app's normal access and same-origin authorization. Frame requests are proxied by the host; sandbox frames cannot call these APIs directly.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/mcp/apps/mount` | Bind `{ projectDir, chatId, callId }` to a completed MCP tool result; return an isolated view mount, or disabled/fallback. |
| POST | `/api/mcp/apps/:mountId/call` | Call a bound server tool with `{ requestId, name, arguments }`; `409 EAUTH_REQUIRED` returns a server-generated approval request for the existing decision endpoint. |
| POST | `/api/mcp/apps/:mountId/message` | Accept `{ role: "user", content: [{ type: "text", text }] }` and automatically start the bound chat's normal AI turn; returns `{}` only. |
| POST | `/api/mcp/apps/:mountId/status` | Detect resource/session changes, expiry or revoked tool permissions. |
| POST | `/api/mcp/apps/:mountId/cancel` | Cancel a host request ID and its outstanding approval. |
| DELETE | `/api/mcp/apps/:mountId` | Revoke the mount and cancel outstanding calls. |

## Remaining capabilities

- Configured HTTPS sandbox hosting on a separate hostname without an extra browser-facing port.
- `ui/updateModelContext` and image/audio/resource-bearing messages.
- Host-controlled links, downloads and optional device permissions.
- App preloading/streaming tool inputs and resource subscriptions.
- Broader external-content policies (nested frames, dedicated domains and wildcard origins).

These are not enabled by automatic text messages; each needs its own implementation and security checks.

## Verification

Regression tests use a real stdio MCP fixture, actual HTTP mount/authorization routes, and the official App SDK inside Chrome with normal site isolation. The combined real-host test covers automatic message → attributed persisted prompt → normally approved MCP tool → actual SSE reply, Close/Retry and abandoned approval cleanup, normal Stop, draft preservation and 360/390/430 px. Cookie/auth sentinels, ticket replay, wrong host/origin/method, source/requested-tool Off, resource/visibility changes, server restart, chat deletion and abandoned leases are also checked. An isolated Docker test image runs the same checks without restarting the running host app.

Passing regressions are not a complete security audit. Remaining review includes real HTTPS/PWA hosting, malicious navigation and reload storms, approval races across multiple followers, and DNS rebinding/private addresses behind declared external hostnames. CSP origin syntax checks alone do not prove that a hostname resolves publicly.

```bash
docker build -f scripts/Dockerfile.mcp-apps -t mouaif-track-b-mcp-apps:test .
docker run --rm --shm-size=256m mouaif-track-b-mcp-apps:test
```

This test image uses the locally built `mouaif-app:latest` as its Chrome-equipped base; it does not modify that image or run its default server command.
