# MCP Apps

## Overview

MCP Apps are interactive HTML tool views inside the conversation, as described by the [official MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview). mouaif uses the official AppBridge SDK to connect these views to their serving MCP server, with sandbox isolation and the existing tool authorization gate.

## Usage

1. Enable **Settings → This project → General → MCP Apps**. It is off by default.
2. Restart the relevant MCP server using its Settings lifecycle control so it receives the Apps capability at initialization.
3. Call a tool declaring `_meta.ui.resourceUri`. Expand its completed tool card to load the app beside the ordinary text/image result.
4. Interact with the view. App tool calls use the server's Off/Ask/Allow policy; Ask displays the app/server identity and arguments on a normal approval card.
5. Use **Fullscreen** / **Inline** for the mobile sheet, or **Retry** after an app resource changes or fails to initialize.

The initial deployment supports **direct HTTP** clients using an app-managed second listener on an ephemeral port. That port must be reachable from the client. HTTPS, reverse proxies which do not expose that port, unsupported app policies, stopped servers and initialization failures keep the ordinary tool result instead. The main app's port remains 5732 by default.

Camera, microphone, geolocation, clipboard, external links, downloads, app messages and model-context writes are not granted. Apps requiring those capabilities may not work in this release. No app action starts an AI turn automatically.

## Official reference

The [official overview](https://modelcontextprotocol.io/extensions/apps/overview) is the entry point and source for the feature: tool metadata, UI resources, sandbox rendering, bidirectional JSON-RPC, consent and framework-independent apps. Its linked [AppBridge API](https://apps.extensions.modelcontextprotocol.io/api/modules/app-bridge.html) and [official specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) supply the wire details that the overview does not define.

The installed official SDK is pinned to `@modelcontextprotocol/ext-apps@2.0.3`, reviewed at `82221c0c8ce7661efa6771c9d461511b1650495f`, with extension protocol `2026-01-26`. The SDK version is not the protocol date. No third-party protocol summary is used.

## Security and supported behavior

- The outer proxy has a different origin from the app. Its inner app frame has an opaque origin and cannot read host DOM, cookies or storage, navigate the parent, or remove the outer sandbox.
- HTTP-header CSP defaults deny network connections. Validated public HTTPS resources and HTTPS/WSS connections can be allowed only when declared by the app. Host/private origins, wildcard rules, CSP fragments, nested frames, dedicated app domains and external base URIs are rejected in this initial host.
- The isolated listener serves only short-lived proxy tickets, no app API, cookies, service worker or HTML resources. App HTML arrives over a source-and-origin-checked message channel; proxy responses are `no-store`.
- AppBridge performs initialization. Tool input is delivered before the original result. Unknown/unimplemented requests are rejected; capabilities are not advertised merely because the overview lists them.
- Mount identities come from persisted tool call/result rows. The app cannot select another project, chat or server, or nominate its approval call ID. Only raw tools with app visibility on its own server are callable, through existing per-chat/per-tool authorization.
- Resource reads are session-scoped and bounded to 16 cached HTML resources of at most 1 MiB each. Updates invalidate the cache and mounted views detect resource/session changes; they fall back and offer Retry rather than injecting replacement HTML into an initialized app.
- Initialization has a 10-second timeout. Teardown requests wait at most 500 ms on explicit closure; navigation or recycled transcript rows use best-effort teardown because the browser may already remove the frame. Pending calls are cancelled and listeners/timers are removed when the view closes; the server revokes its mount capability. Mounts expire after 30 minutes and limits prevent unbounded frame/call growth.
- Inline views are width-constrained with bounded heights; fullscreen uses a safe-area sheet and controls at least 44 px tall. Text/image results remain independent of app success.

## HTTP interface

All routes use the main app's normal access and same-origin authorization. Frame requests are proxied by the host; sandbox frames cannot call these APIs directly.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/mcp/apps/mount` | Bind `{ projectDir, chatId, callId }` to a completed MCP tool result; return an isolated view mount, or disabled/fallback. |
| POST | `/api/mcp/apps/:mountId/call` | Call a bound server tool with `{ requestId, name, arguments }`; `409 EAUTH_REQUIRED` returns a server-generated approval request for the existing decision endpoint. |
| POST | `/api/mcp/apps/:mountId/status` | Detect resource/session changes, expiry or revoked project opt-in. |
| POST | `/api/mcp/apps/:mountId/cancel` | Cancel a host request ID and its outstanding approval. |
| DELETE | `/api/mcp/apps/:mountId` | Revoke the mount and cancel outstanding calls. |

## Verification

Regression tests use a real stdio MCP fixture, actual HTTP mount/authorization routes, and the official App SDK inside Chrome at 360 px. They cover initialization, source/origin isolation, host-API CSP blocking, app tool approval/denial, unsupported context mutation, fullscreen, touch targets and cleanup. An isolated Docker test image runs the same checks without restarting the running host app.

```bash
docker build -f scripts/Dockerfile.mcp-apps -t mouaif-track-b-mcp-apps:test .
docker run --rm --shm-size=256m mouaif-track-b-mcp-apps:test
```

This test image uses the locally built `mouaif-app:latest` as its Chrome-equipped base; it does not modify that image or run its default server command.
