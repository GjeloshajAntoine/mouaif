# Content Security Policy

## Overview

The app serves a baseline `Content-Security-Policy` header with every HTML document (the shell at `/` and any SPA fallback). It exists as defence in depth: the SVG file preview used to hand a project file's bytes to `innerHTML`, and this header is what keeps that class of bug from becoming script execution in the app's origin. The public-facing reference is [docs/features/content-security-policy.md](../../features/content-security-policy.md).

## Usage

No configuration. `curl -sD - http://127.0.0.1:5732/` shows the header; there is no setting that turns it off and no per-project override. `npm test` runs `scripts/test-web-csp.js` against a real ephemeral server.

## Implementation notes

- File: `src/server-web-static.js` — `WEB_CSP` (the literal policy) and `applyDocumentHeaders(res, absPath)`, called from `serveWebFile()` after `applyPwaHeaders()`. Only `.html` responses get `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; JS/CSS/manifest/icon responses are untouched so a static asset can never become a policy-carrying document. `WEB_CSP` is exported for the test.
- File: `scripts/test-web-csp.js` — starts `createServer(0)` and asserts: header present and byte-identical to `WEB_CSP` on `/` and on the SPA fallback; `script-src` is exactly `'self'` (no `unsafe-inline`, no `unsafe-eval`, no remote origin); `connect-src` keeps `'self'` and `ws:`; `img-src` keeps `data:`; `worker-src` keeps `'self'`; `frame-ancestors` keeps the localhost ports and rejects remote framing; the hashed bundle and the manifest carry no policy header; every directive has a non-empty value.
- File: `frontend/src/markdown.js` — step 9b used to neutralise a garbage auto-linked href with an inline `onclick="return false"`. Under `script-src 'self'` that attribute never runs, and `scripts/test-markdown-safety.mjs` asserts the renderer emits no `on*` attribute at all, so the anchor is now unwrapped to its label text (inert, no href). Removing it was a precondition for the policy, not a style choice: with the handler blocked, the click would have navigated instead of doing nothing.
- Why not nonces: there is no inline script to authorise. The shell loads one hashed module per entry, so `script-src 'self'` is sufficient and does not need a per-response nonce.
- Why `frame-ancestors` is not `'none'`: the UI may legitimately be embedded by a local shell (the host app, a review harness) over `localhost`/`127.0.0.1` on an arbitrary port. `'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*` blocks remote framing without breaking those.
- `style-src` keeps `'unsafe-inline'`: CodeMirror's `style-mod` injects a `<style>` element at runtime (`element.textContent = ...`), which `style-src` governs even when the script is same-origin. Styles are not a script-execution path, and `default-src 'self'` still applies to everything else.
- Verified in Chrome against the built bundle on an ephemeral port: the shell boots, `#/chats`, `#/settings`, `#/settings/providers`, `#/settings/project`, `#/settings/agents`, `#/settings/prompts`, `#/settings/mcp`, `#/settings/defaults`, `#/settings/about` and `#/inspector` all render with an empty console (no CSP violations), and an SVG injection probe that fires `<animate onbegin>` and `<foreignObject><img onerror>` on a CSP-free page is inert under the policy.
