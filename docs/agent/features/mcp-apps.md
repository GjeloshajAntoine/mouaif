# MCP Apps foundation — agent notes

## Overview

Track B foundation from `d45b1f233558bac1a4d888d36572bec55e196e5d`, developed on isolated branch `feat/track-b-mcp-apps-d45b1f23`. User selected **backend foundation only** at the sandbox-deployment checkpoint; do not interpret this as approval to enable frames. Human documentation and pinned primary references: [MCP Apps foundation](../../features/mcp-apps.md).

## Usage

No new native tool names, npm dependencies, REST endpoints, host capabilities or settings. Existing `GET /api/mcp/servers/:id/tools` and server tool descriptors now preserve normalized `_meta.ui.resourceUri` / `visibility`. Model-facing composed tools omit app-only tools in live and persisted catalogs.

Internal usage (authorization is the caller's responsibility):

```javascript
const resource = await mcp.readAppResource(projectDir, serverId, 'ui://server/view', {
  signal: abortController.signal,
  refresh: true
});
```

Returns `{ uri, mimeType, text, _meta: { ui } }`. Resource metadata is untrusted data, not an approved CSP or Permissions-Policy. Never execute returned HTML at the app origin.

## Implementation notes

- `src/mcp-apps.js`: protocol/revision constants, recognized metadata normalization, visibility, resource validation. Invalid explicit visibility fails closed; absence defaults to both callers. No arbitrary tool `_meta` is forwarded.
- `src/mcp.js`: per-session resource cache (16 × at most 1 MiB), copies on return, resources/read with 10 s timeout, exact project/server lookup, discovered URI binding, generation check for notification/read races, cancellation, stop/disconnect invalidation. Subscription support is not implemented. Cache is not persisted.
- `callTool` defaults to model visibility; internal `callOpts.caller: 'app'` selects app visibility. This is **not** an authorization gate or a public frame-call endpoint. Existing normal callers and REST dispatch stay unchanged; a future app endpoint must bind identity before using this option.
- Errors: `EBADINPUT`, `EMCP_NOSESSION`, `EMCP_NOTFOUND`, `EMCP_RPC`, `EMCP_APP_RESOURCE`, `EMCP_APP_STALE`, `EABORTED`, `EMCP_VISIBILITY`. Raw resource RPC failures are redacted.
- `scripts/test-mcp-apps-detection.js` and `scripts/test-mcp-apps-server.js`: actual SDK/stdio fixture, metadata and deprecated URI, app/model caller restrictions, scoped resource checks, MIME/size/duplicates, mutation-safe cache, notifications, read/update race, pre-abort, bounded cache, restart, text fallback. No browser bridge tests: no bridge has shipped.

## Landing coordination

Do not merge or push automatically. Track B lands after A/E/C/D; rebase only at the merge queue checkpoint with authorization, then re-run MCP suites, tool groups and shared frontend/doc checks. Shared surface touched: `src/mcp.js`; additive entries in `CHANGELOG.md`, `docs/README.md`, `docs/features/mcp.md`, `docs/decisions.md`, and `.github/copilot-instructions.md`. No edits to `cards.js`, `agents.js`, authorization definitions or frontend artifacts in this foundation.

## Verification evidence

- Passed: new MCP Apps SDK/stdio test; `test-mcp.js`, authorization gate, cancellation, crash-midcall, HTTP transport, scope HTTP/scope, stderr, tool names, OAuth/OAuth extras, arguments, registry install/search; `test-web-csp.js` (41 checks), tool groups (20 checks), `npm run lint`, `npm run test:subagent-prompt`, docs links, docs build and syntax checks on all touched JavaScript. HTTP server smoke tests exercise `createServer` without launching or restarting `mouaif serve`.
- Known baseline failures reproduced from an untouched `git archive d45b1f23`: `test-mcp-http.js` (three stale assertions: missing chat/call IDs, stopped catalog retention, auto-start expectation) and `test-mcp-ondemand.js` (registers slug `echo` but calls `test_server`). Left unrelated tests unchanged.
- `docs:publish:check` reports the new Apps HTML page missing and MCP HTML stale. Generated public docs should be refreshed by the landing caretaker; this branch does not rewrite generated pages. `docs:build` and source doc link checks pass.
- `test-mcp-store-ui.mjs` is a five-minute manual browser fixture, not an assertion suite; it built and listened, then the command timed out. `test-mcp-ui.mjs` was inspected but not run. No new UI, narrow-width/browser bridge validation or official App SDK interoperability is claimed.
- Existing installed dependencies were reused through a local uncommitted symlink; no dependency installation, server restart, merge or push.

## Open issues

- Choose a sandbox deployment: app-managed isolated listener versus configured dedicated HTTPS hostname. Account for phones, reverse proxies, certificates, cookie isolation and lack of app APIs on the sandbox origin.
- Implement HTTP CSP construction, permission policy, two-iframe proxy, bridge and resource lifecycle, bounded requests/cancellation, server-bound approval identity, opt-in setting, mobile frame/fullscreen/fallback. The contract is detailed in the human feature page; none is enabled yet.
- Validate interoperability with official App SDK fixture and real browser at 360 px, including forged messages, HTML escape attempts, remote loads, resource updates, teardown and approval retries before calling the web host ready.
