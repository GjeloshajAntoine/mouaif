# MCP Apps — remaining implementation plan

## Overview

Continue Track B from `f2efb127` on its isolated branch. This is a proposed sequence, not permission to change deployment, install additional dependencies, merge/push, or restart the running app. Automatic user-text messages were approved and implemented; do not reintroduce a confirmation step for those messages.

The product reference is the [official MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) and its linked official API/specification. Current implementation uses official SDK `2.0.3`, reviewed revision `82221c0c8ce7661efa6771c9d461511b1650495f`. Revalidate linked protocol schemas against the pinned SDK before each capability; use immutable source references for reproducibility, not third-party summaries. A later upgrade requires explicit dependency approval and regression evidence.

## Current baseline

- Project opt-in, tool metadata/visibility, scoped resource reads and bounded session caches.
- Distinct-origin HTTP outer proxy, opaque-origin inner view, HTTP-header CSP, source/origin checked transport and official AppBridge initialization.
- Server-bound app tool calls through ordinary authorization, mobile inline/fullscreen and text/image fallback.
- Automatic `ui/message` user text starts the normal bound-chat AI runner. App/server attribution, 16 blocks/16 KiB, busy rejection and 5-second per-chat attempt limit; acknowledgement only, no chat/AI output returned to the app.
- SDK/stdio, actual HTTP/provider and browser tests run in Docker. Feature source commits exist only on Track B; they are not merged or deployed. Generated artifacts must be refreshed at landing.

## Sequence and priorities

| Phase | Work | Example outcome |
| --- | --- | --- |
| 0 | Security/lifecycle and end-to-end verification | Closing/recycling an app revokes its calls without leaking credentials or leaving approval cards. |
| 1 | HTTPS sandbox hosting on a separate hostname | Installed mouaif at `https://assistant.example.com` renders an app from `https://apps.example.net`, both on port 443. |
| 2 | Bounded model-context updates | A PDF view reports its selected page for the next user prompt, without starting an AI turn. |
| 3 | Image-bearing app messages | A chart sends a selected PNG plus “Explain this”, starting the normal AI turn. |
| 4 | Host-mediated external links and downloads | Tap a PDF's source link or download its export, subject to host policy. |
| 5 | Streaming/preloading and resource subscriptions | A report UI receives arguments while its tool runs and refreshes safely on updates. |
| 6 | Optional device permissions and broader content policies | An explicitly approved recorder uses the microphone; selected apps embed declared external frames. |

Phases 0–1 precede production-facing rollout. Phases 2–4 can ship independently after the security contract is stable. Phase 5 follows mount/lifecycle work. Phase 6 is opt-in and not required for basic Apps support. Each coherent feature includes tests and docs in one Conventional Commit; split links, downloads, device grants and broader CSP policies rather than bundling them.

## Phase 0 — security and lifecycle gates

1. Review actual code, callers and tests in `src/server-handlers-mcp-apps.js`, `src/mcp-apps-sandbox*.js`, `McpAppFrame.jsx` and `mcpAppBridge.js`; preserve existing automatic-message behavior.
2. Correct claims about cookies: `HttpOnly` prevents JS reads, not browser transmission. Different ports do not isolate cookies. The trusted sandbox currently serves no APIs and ignores cookie headers; test that cookie values never enter HTML, messages, logs or responses. Do not claim a separate port guarantees credential isolation.
3. Bind tickets and mounts to exact host origin and live server generation. Recheck URI/tool visibility and revocation on every operation, including source-tool Off changes, server removal/restart, project opt-out and chat deletion.
4. Audit ticket navigation/reuse, iframe reload, wrong origin/source, malicious resource HTML, frame navigation, CSP declaration validation, mount/message concurrency and bounded cleanup. Review HTTP methods and origin/CSRF enforcement, including requests without Origin and null-origin frames.
5. Improve teardown for explicit Close, navigation, virtualized row removal, tab hide/restore and abandoned approvals. Remove stale approval UI and revoke server capability even if the browser cannot complete teardown. Accepted automatic AI turns intentionally continue; only the normal chat Stop cancels them.
6. Add a combined real-host end-to-end browser fixture, rather than relying only on separately mocked browser mount APIs and server tests. Verify automatic message → attributed persisted user row → actual streamed reply → normal tool approval/Stop path, without changing composer drafts or returning AI content to the app.
7. Run browser isolation tests with normal site isolation enabled. The current browser fixture disables site isolation for CDP access to child frames; replace that convenience with appropriate child-target/session inspection, keeping the existing fixture as a secondary check if useful.

Commit: `fix(mcp): harden app mount lifecycle and isolation` (split independent defects if discovered). No new capabilities until critical findings are resolved. Record findings and coverage gaps; passing tests are not a complete security audit.

### Phase 0 progress

First scoped hardening adds host/generation binding, single-use tickets, source/requested-tool revocation, abandoned leases and Close/tab-hide approval cleanup. Normal-site-isolation browser tests now include a combined real-host official SDK → persisted automatic prompt → authorized MCP tool → actual SSE reply/Stop flow with unchanged drafts and mobile widths. See [implementation findings and gaps](../features/mcp-apps.md#phase-0-securitylifecycle-review). This does not mark the complete security audit done or authorize deployment; hostile navigation/reload storms, multi-follower approval races and external DNS/private-resolution risks remain before production rollout.

## Phase 1 — HTTPS without an extra browser-facing port

Proposed configuration: app-level sandbox public origin, distinct from mouaif's configured public origin. Exact setting names and routing are settled before implementation; never trust a server's `ui.domain` as deployment configuration.

1. Support configured HTTPS sandbox hostname behind the existing TLS reverse proxy. Route it to a sandbox-only handler/listener; both public URLs can use port 443. An internal backend port is acceptable and is not an extra browser-facing port.
2. Reject same-origin, path-only separation, malformed origins and mismatched forwarded host/scheme. Trust forwarding headers only through the app's explicit proxy configuration; do not derive security identity from arbitrary request headers.
3. Separate hostname routing must never expose app APIs or SPA fallback on the sandbox hostname. Apply header CSP, Permissions-Policy, no-store and no service-worker registration. Preserve main port 5732.
4. Use host-only Secure/HttpOnly session cookies; avoid parent-domain cookies. Prefer a separate registrable sandbox domain. For a subdomain deployment, document and test inherited cookie risks. Proxy strips/ignores sandbox cookie/auth headers; do not confuse stripping upstream with preventing the browser from transmitting them.
5. Provide example reverse-proxy/Docker configuration and setup diagnostics. Invalid/unreachable configuration leaves text fallback. Retain direct local HTTP for development.
6. Test with two hostnames and trusted test TLS in Docker, mobile browser/PWA at 360/390/430 px, host spoofing, same-origin rejection, cookie leakage, mixed content, CSP, ticket expiry and API denial. No insecure certificate override in the production path.

Commit: `feat(mcp): support configured HTTPS sandbox hosting`.

## Phase 2 — model-context updates

1. Implement official `ui/updateModelContext`, initially text and bounded structured JSON only; advertise only supported modalities.
2. Store latest context per bound app instance, with per-chat total bounds and expiry, as explicitly labelled untrusted app data. Define deterministic precedence when multiple views are open; do not append unlimited transcript rows on every selection change.
3. Include a snapshot in the next normal AI turn through the shared chat runner. Never write system instructions or replace the user prompt; reject attempts to select a chat/model/provider.
4. Context updates do not start turns or interrupt a running turn. Snapshot at turn start; later updates apply to the next turn. Decide and document whether context survives view closure (proposed: clear on teardown/revocation, no restart persistence).
5. Show a compact “App context” indicator with view/clear controls and server attribution, so users can inspect what the model will receive.
6. Tests: bounds, concurrent views, updates during a turn, revocation/expiry, provider history shapes, context injection labels, no response leakage and no auto-turn.

Commit: `feat(mcp): accept bounded app model context`.

## Phase 3 — richer automatic messages

1. Add image blocks through the existing normalized attachment path: supported image MIME, valid bounded base64, per-image/aggregate limits and attachment count; reject remote URLs and malformed blocks.
2. Preserve automatic sending, source attribution, busy/rate limits and bound chat/model. UI displays image attachments in ordinary user messages; app receives acknowledgement only.
3. Add text+PNG official SDK browser and actual-provider tests, including unsupported image-input model behavior, oversized payloads and duplicate/retry handling. Add server-bound idempotency for host retries without allowing payload changes under one request identity.
4. Keep audio, arbitrary embedded resources and resource links unsupported until they have their own bounded ingestion contract. Do not fetch app-supplied URLs server-side without separate SSRF/provenance review.

Commit: `feat(mcp): send app image messages to bound chats`.

## Phase 4 — external links and downloads

### Links

- Implement official `ui/openLink` through the trusted host. HTTPS links only initially; reject javascript/data/file/custom schemes, credentials and internal administration destinations.
- Display destination and attribution with host policy/user-gesture handling. The approval for automatic chat messages does not approve navigation. No sandbox `allow-top-navigation` shortcut.
- Test popup blockers, mobile taps, denial and malicious URL normalization.

Commit: `feat(mcp): open app links through host policy`.

### Downloads

- Validate official download request shapes, MIME/size limits, filenames and content provenance; deliver bounded content as a host-mediated download, not arbitrary filesystem writes.
- Avoid executable/HTML exports by default; revoke object URLs after use. Any server-side fetch requires SSRF protections and separate review.
- Test mobile download behavior, cancellation, filename traversal, oversize payloads and denial.

Commit: `feat(mcp): handle bounded app downloads`.

## Phase 5 — streaming and resource lifecycle

1. Establish a mount identity from an authorized persisted/in-flight tool call, rather than requiring a completed result. Reuse normal authorization: resource preloading must not auto-start Off servers or execute tools.
2. Send complete input exactly once after initialization, optional partial input while arguments stream, then result or cancellation. Preserve the ordinary text/image result throughout. Reconnect must not replay app effects or create duplicate mounts.
3. Subscribe only if the server advertises resource subscription support. Reference-count per-session subscriptions for shared URIs, unsubscribe on last view teardown, and debounce bounded invalidations.
4. Replace/reinitialize views on resource changes with bounded teardown and ticket rotation; never patch arbitrary HTML into an already trusted bridge. Define state-loss UX and keep a manual Retry fallback.
5. Integrate transcript recycling and height measurement without per-scroll forced reflow. Clamp dimensions and prevent unbounded fullscreen/resize loops.
6. Tests: official SDK input ordering, partial input, cancel-before-ready, late result, concurrent apps, subscribed update storms, restart/disconnect and virtualized removal.

Commit(s): `feat(mcp): stream tool inputs to app views`, then `feat(mcp): subscribe to app resource updates`.

## Phase 6 — optional capabilities

### Device permissions

- Per-server/app explicit user grants, off by default; separate browser prompts remain authoritative. Auto-message approval does not authorize camera/microphone/geolocation/clipboard.
- Map only declared/granted features into Permissions-Policy/iframe allow and advertised sandbox capability; revocation tears down affected views.
- Test real browser behavior: the current opaque-origin child may make APIs unavailable even with allow attributes. Do not weaken origin isolation solely to make a device API work. Explain unsupported features rather than promising them.
- Commit each capability or coherent permission-policy feature separately with mobile tests.

### External resources and frames

- Review wildcard origin syntax, workers/blob needs, nested frames and dedicated domains separately against the official schema. Require declared and approved origins; no arbitrary CSP strings or undeclared allowances.
- Account for DNS rebinding/private-address targets: rejecting numeric IPs/localhost strings alone does not establish that a hostname resolves publicly. Keep narrow policy until the actual threat model and enforcement are tested.
- Preserve parent-navigation denial and same-source bridge binding through nested frames. Document dedicated-origin deployment ownership; app metadata cannot provision or select arbitrary host origins.

## Definition of done per feature

- Targeted tests wired into npm scripts; touched JS syntax checks, JSX/frontend build, lint, tool groups, authorization, subagent and appropriate chat/PWA suites.
- Docker runs actual REST/MCP/official SDK/browser paths, including malicious and denied cases. Use clean test storage and isolated image/ports; never restart the running server with the CLI.
- Review at 360 px first, then 390/430 px; touch targets at least 44 px, safe areas, no horizontal overflow or hover-only controls.
- Update `docs/features/mcp-apps.md`, `docs/agent/features/mcp-apps.md`, changelog and relevant architecture notes in the feature commit. Clearly separate implemented behavior from planned capability.
- Reproduce known baseline failures on untouched committed source before classifying them as unrelated; do not hide regressions or fold in unrelated test repairs.
- Conventional Commits, no dependency installs without approval, no automatic merge/push. Generated frontend/docs artifacts are dependent landing work, not optional: complete them before shipping the merged UI.

## Landing coordination and open decisions

Shared writers: `src/mcp.js`, `src/http-server.js`, `src/server-handlers-chats.js` / AI history assembly, settings/auth modules, SettingsProject, `cards.js`, `transcript.js`, `useChatState.js` and package/lockfile. Coordinate before landing after A/E/C/D; rebase at the authorized merge checkpoint and re-run shared suites against the landed versions.

Blocking decisions only when their phase starts:

- Phase 1: available HTTPS hostname/certificates and reverse proxy ownership. Default proposal: separate sandbox domain on public 443, internal sandbox-only backend; no same-origin path/PWA-scope workaround.
- Phase 2: context retention after closing a view (default proposal: clear, session-only).
- Phase 4/6: navigation/download consent and device grant UX (default proposal: explicit host policy, device grants always opt-in).

No questions block writing this plan. Do not treat the plan as authorization to provision domains/certificates, change deployment, add dependencies or grant browser permissions.
