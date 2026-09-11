# Content Security Policy

## Overview

Every HTML document the app serves — the shell at `/` and any SPA fallback that resolves to it — carries a `Content-Security-Policy` header. Scripts may only come from the app's own origin: no inline `on*` handler, no `eval`, no remote script. The policy is a second line of defence behind the escaping each surface already does, so a markup-injection bug cannot become script execution in the app's origin, where the access cookie and the whole `/api/*` surface live.

## Usage

Nothing to configure. Open the app and the header is already there:

```bash
curl -sD - -o /dev/null http://127.0.0.1:5732/ | grep -i -E 'content-security|referrer|x-content'
```

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

### What each directive means

| Directive | Value | Why |
|-----------|-------|-----|
| `default-src` | `'self'` | Everything not listed below falls back to same-origin. |
| `script-src` | `'self'` | The bundle is a Vite ESM build under `/assets/*` and `index.html` has no inline `<script>`. This is the directive that stops an injected `on*` handler or a remote script tag. |
| `style-src` | `'self' 'unsafe-inline'` | CodeMirror injects a `<style>` element at runtime. Styles are not a script execution path, so this stays pragmatic. |
| `img-src` | `'self' data: blob:` | Image previews and pasted/attached images arrive as `data:` URLs from the API. |
| `font-src` | `'self' data:` | System font stacks today; `data:` is kept for a future webfont. |
| `media-src` | `'self' data: blob:` | Same reasoning as `img-src`. |
| `connect-src` | `'self' ws: wss:` | `fetch` and `EventSource` are same-origin; the Inspector's CDP socket is the same-origin `/api/inspector/proxy` WebSocket. |
| `worker-src` | `'self' blob:` | The service worker is served from `/sw.js`. |
| `manifest-src` | `'self'` | `/manifest.webmanifest` for the PWA install prompt. |
| `frame-src` | `'self'` | Nothing frames anything today; a same-origin frame stays allowed. |
| `base-uri` | `'none'` | The shell has no `<base>`; `'none'` means a `<base>` injection cannot retarget every relative URL on the page. |
| `object-src` | `'none'` | No `<embed>`, `<object>` or `<applet>` anywhere in the app. |
| `form-action` | `'self'` | A form, if one is ever added, may only post back to us. |
| `frame-ancestors` | `'self'` + localhost/127.0.0.1 on any port | Blocks remote clickjacking while still letting a local shell (host app or test harness) embed the UI. |

### What it deliberately does not do

- It is **not** a substitute for escaping. Markdown rendering, tool output and the file preview each sanitise or sandbox their own input; the policy only makes a mistake in one of them much harder to exploit.
- It does **not** restrict the server. Tools, providers and MCP servers are unaffected — this is a browser-side header on HTML documents.
- It is **not** applied to static assets. Only `.html` responses carry the policy, so an asset can never be turned into a document by a later cache rule.

## Implementation notes

- `src/server-web-static.js` owns the policy string (`WEB_CSP`) and `applyDocumentHeaders()`, called from `serveWebFile()` right next to the existing PWA/Cache-Control headers. Adding a directive is a one-line change; relaxing `script-src` is not (see below).
- `scripts/test-web-csp.js` stands up the real server on an ephemeral port and asserts that `/` and the SPA fallback carry the policy verbatim, that `script-src` is exactly `'self'` with no `unsafe-inline`/`unsafe-eval`, that assets are not policy-carrying documents, and that every directive has a value.
- The inline-handler ban is why `frontend/src/markdown.js` no longer emits `onclick="return false"` on a garbage auto-link: the attribute would be blocked anyway, and the project's own safety test (`scripts/test-markdown-safety.mjs`) forbids the renderer from emitting any `on*` attribute. Such a link is now unwrapped to inert text.
- Tested in Chrome at 360 px against a live build: the shell boots, every Settings route, the chat view and the Inspector load with zero console violations, and an SVG-injection probe that fires `onbegin`/`onerror` handlers on a CSP-free page is inert under this policy.
