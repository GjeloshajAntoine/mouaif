# MCP Apps foundation

## Overview

mouaif recognizes MCP Apps tool metadata and can read referenced HTML resources internally. Interactive frames are **not enabled**: tool results continue to use the existing text/image renderer. This is the backend foundation, not a complete MCP Apps host.

## Usage

MCP servers can declare `_meta.ui.resourceUri` with a `ui://` URI and optional `visibility: ["model", "app"]`. App-only tools are excluded from model discovery, including persisted tool caches. The deprecated `_meta["ui/resourceUri"]` is accepted when the new field is absent.

```json
{
  "name": "dashboard",
  "inputSchema": { "type": "object" },
  "_meta": { "ui": { "resourceUri": "ui://example/dashboard" } }
}
```

No dependency install, project opt-in setting, sandbox listener, or app-call REST endpoint is introduced by this foundation. No configuration change is needed; unrenderable apps retain ordinary tool results. A separate sandbox deployment decision is required before rendering can ship.

## Protocol and security contract

### Reviewed protocol

Reviewed official [`ext-apps` v2.0.3](https://github.com/modelcontextprotocol/ext-apps/tree/82221c0c8ce7661efa6771c9d461511b1650495f), pinned to commit `82221c0c8ce7661efa6771c9d461511b1650495f`; the extension protocol version is `2026-01-26`. The tag was resolved with Git and the GitHub ref API. This validates the cited source, not browser interoperability or support for future revisions.

Primary evidence:

- [Specification](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx).
- [Generated wire schema](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/src/generated/schema.json).
- [Host bridge](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/src/app-bridge.ts).
- [Reference sandbox proxy](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/examples/basic-host/src/sandbox.ts) and [HTTP CSP server](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/examples/basic-host/serve.ts).

### Resource lifecycle

Resources are read only from the exact project/server live session and must be referenced by one of that server's discovered tools. Reads require one matching text resource with MIME type `text/html;profile=mcp-app`; ordinary HTML, duplicate/mismatched contents, and HTML larger than 1 MiB are rejected. The cache holds at most 16 resources per session and returns copies, never shared mutable cache objects.

Resource update/list-change notifications invalidate cached resources. Updates racing a read produce `EMCP_APP_STALE` rather than caching stale HTML. Stop, disconnect, and restart discard cache state. Explicit refresh and AbortSignal cancellation are supported. Reading resources does not subscribe to updates automatically; a future frame host must arrange refresh/subscriptions or re-read on mount.

### Required web-host contract (deferred)

- **Origin isolation:** the official spec requires an intermediate sandbox proxy on a different origin from the host, with `allow-scripts allow-same-origin`. Same-origin `srcdoc` with those flags is unsafe and noncompliant. A different port alone does not isolate cookies; the sandbox must serve no app API or credentials. Mobile, HTTPS, proxy and certificate reachability must be chosen before enabling this surface. Server-declared `ui.domain` is not an arbitrary navigation target.
- **CSP:** construct HTTP-header CSP using validated declared `connectDomains`, `resourceDomains`, `frameDomains`, and `baseUriDomains`. Reject directive injection and app/API origins. Do not rely on removable meta tags, broaden the host's script policy, or permit undeclared origins. Permissions requests are advisory; camera/microphone/geolocation/clipboard require explicit host policy. No app HTML may enter PWA caches or offline shell fallbacks.
- **Initialization:** validate message origin **and** exact window source; wait for `sandbox-proxy-ready`, send `sandbox-resource-ready`, answer `ui/initialize`, then wait for `ui/notifications/initialized` before sending complete tool input followed by result/cancellation. Unknown requests receive JSON-RPC `-32601`; unsupported capabilities are not advertised. No tool execution during initialization.
- **Lifecycle:** send `ui/resource-teardown` as a request before frame removal, wait with a bounded timeout, cancel pending calls and remove listeners on teardown. Resource updates must replace/reinitialize the frame rather than injecting HTML into an initialized view. Cancel notifications cannot be treated as approval.
- **Authorization:** bind the frame server/project/chat/resource identity server-side. Resolve raw tools only on that server and require `app` visibility before applying the existing off/ask/allow gate, per-tool overrides, approval and cancellation path. Name the serving server and app on approval cards; never trust frame-supplied server IDs, approval IDs or raw HTML as authority. App-only visibility is not permission to bypass authorization.
- **Mobile/fallback:** inline cards first, width 100%, bounded viewport-relative height and clamped finite size notifications; fullscreen as a safe-area sheet with 44 px controls. Coordinate transcript height changes without forced layout on scroll. Keep ordinary text/image results visible through loading, initialization timeout, permission denial, resource errors, unsupported modes and teardown. Review at 360 px before declaring the host complete.

These are contracts for the follow-up, not implemented UI features or verified browser behavior.
