# Local preview proxy — implementation notes

> Agent-facing reference for [`docs/features/local-preview-proxy.md`](../../features/local-preview-proxy.md). The user-facing surface lives in that file; source paths, wire shapes, and edge cases live here.

## Implementation notes

### Why it is a path prefix, not a query parameter

A proxy that took its target from a query string (`/api/preview/fetch?url=…`) could not resolve a *relative* URL: `./main.jsx` inside `/api/preview/fetch?url=…` resolves against `/api/preview/`, not against the dev server. Every relative import, `url(../x.png)` and `fetch('api/state')` would break.

Encoding the target in the **path** fixes that half for free: the document at `/api/preview/http/localhost:5173/` is the base for everything relative, so those all resolve through the proxy. The dev server must be mounted at its root, which is how every one of them is normally run.

What a path prefix does *not* fix is a **root-absolute** URL: `src="/src/main.jsx"` resolves against the origin root — mouaif's own app — no matter where the document lives. Every dev server emits those (Vite's transformed modules are nothing but `import "/@fs/…"` lines), so the proxy rewrites them in the text bodies it serves; see `prefixRootPaths` below.

### Server module

[`src/previewProxy.js`](../../../src/previewProxy.js):

| Export | Role |
|---|---|
| `PREFIX` | `/api/preview/` — the dispatcher's route test and the frontend helper's prefix. |
| `parseProxyPath(pathname)` | → `{ scheme, authority, host, port, targetPath, upstream }`, `null` for a non-proxy path, or a typed throw (`EBADINPUT`, `EREMOTE_HOST`). |
| `splitAuthority(authority)` | → `{ host, wireHost, port }`; the IPv6 literal is re-bracketed for `wireHost`, which is what the upstream URL uses. |
| `isLocalHost(host)` | The allow-list. |
| `proxyPathFor(url)` | The reverse direction, for tests and the frontend mirror. |
| `prefixFor(target)` | The path prefix a body's own root-absolute URLs must use; always ends in `/`. |
| `prefixRootPaths(body, prefix)` | The rewrite, on one already-decoded string. |
| `handlePreviewProxy(req, res, parsed, sessionToken, serverConfig)` | One request, end to end; returns `true` when it answered. |

Route wiring: [`src/http-server.js`](../../../src/http-server.js) requires the module and dispatches `urlPath.startsWith(previewProxy.PREFIX)` **before** the API 404 at the bottom of `dispatchRequest`. Sitting under `/api/` is what makes the existing same-origin (`authorizeBrowserRequest`), session-cookie and access (`authorizeAccessRequest`) gates cover it with no new code — the dispatcher checks both before any route runs. `sessionToken` / `serverConfig` are accepted for signature symmetry and unused.

### Address rules

`PREFIX + '/' + <scheme> + '/' + <host>[:port] + <path>` where:
- `<scheme>` is `http` or `https` — anything else is `400 EBADINPUT`;
- `<host>` must pass `isLocalHost`, else `403 EREMOTE_HOST`;
- an omitted port means 443 for `https`, 80 for `http`; `:0` and `:99999` are refused as malformed rather than silently defaulted;
- userinfo (`user@host`) is refused by the authority charset, so nothing but a host and a port reaches the upstream URL;
- a missing slash after the authority (`/api/preview/http/localhost:5173`) means the root path; `//host:port/x` is read as a missing host, not an empty authority.

### Request and response handling

- **Request**: `GET`/`HEAD` only (`405` + `Allow: GET, HEAD` otherwise; a body is never read). `accept-encoding: identity`, a fixed `accept` and a `mouaif-preview/1.0` user agent. `cookie`, `authorization`, `origin` and `referer` are **not** forwarded — an `Origin` would make the dev server answer as a CORS request, and the rest is the app's own session.
- **Rewriting**: a body whose type matches `REWRITABLE_TYPE` — exactly `text/html`, `text/css`, `text/javascript` and the `application/javascript` pair — is buffered (cap `MAX_REWRITE_BYTES`, 8 MiB) and passed through `prefixRootPaths` before it is sent. JSON, plain text and XML are deliberately **excluded**: a leading `/` in a JSON payload is data (`{"redirect":"/login"}`), and rewriting it corrupts the response the page is about to parse. Past the cap the body is streamed **unrewritten** rather than dropped, and the pipe switches over mid-stream. On the rewritten path `content-length` is always dropped (Node frames it) and a changed body drops `etag`.
- **The rewrite shapes**: `url(/x)` and `@import /x`; any quoted or parenthesized absolute path (`"…"`, `'…'`, `(…)`) — which covers attributes, `new URL('/x', …)`, `fetch('/x')`; and an unquoted `import /x` / `from /x` bare specifier. `//host/x` (protocol-relative), a bare `/`, and a path already under the prefix are left alone, so the rewrite is idempotent. It is a textual pass anchored on those delimiters, so prose (no quote in front of it) and arithmetic (`a /b`) are untouched; a URL assembled at runtime from pieces is out of scope, which is the documented limit.
- **Query**: forwarded from the raw request target (`rawQuery(req)`), not from `parsed.query` — `parseRequestTarget` hands handlers a parsed object, which would re-encode the bytes the page asked for.
- **Response**: `PASS_HEADERS` is an allow-list (`content-type`, `content-length`, `content-language`, `content-range`, `accept-ranges`, `location`) plus `Cache-Control: no-store`. `set-cookie`, `content-security-policy` and `x-frame-options` never cross. A declared `content-encoding` drops the pass-through `content-length`, because undici's `fetch` decodes the body: the upstream's byte count would otherwise describe bytes the browser never receives (`scripts/test-preview-proxy.js` serves a gzipped page to pin this).
- **Redirects** are `redirect: 'manual'` (never followed server-side). A relative `Location` resolves under the prefix as it is. A **root-absolute** one (`Location: /login`) is re-pointed at the prefix, or the browser would resolve it against the app instead of the dev server. A `Location` carrying the dev server's own absolute `http://localhost:5173/…` is passed through untouched: rewriting it would need a host match, and on a phone that address genuinely does not resolve — the honest outcome.
- **Lifecycle**: one `AbortController` per request, aborted when the response closes (the frame navigated away, the phone locked) or after `UPSTREAM_TIMEOUT_MS` (30 s → `504 EPREVIEW_TIMEOUT`). `res.on('close')` also settles the pipe promise so the handler cannot hang on a client that vanished mid-body. A `fetch` rejection is `502 EPREVIEW_UNREACHABLE` carrying `url`.

### Frontend

[`frontend/src/components/chat/webpreviewFrame.js`](../../../frontend/src/components/chat/webpreviewFrame.js) mirrors the server's two pure functions — `isLocalPreviewHost` and `previewProxyPath`, plus `frameSource(url)` = `previewProxyPath(url) || url`. The lists must agree; `scripts/test-webpreview-iframe.mjs` compares them field by field against `require('../src/previewProxy.js')`.

Consumers: [`WebpreviewDock.jsx`](../../../frontend/src/components/chat/WebpreviewDock.jsx) and [`WebpreviewModal.jsx`](../../../frontend/src/components/chat/WebpreviewModal.jsx) both use `src: frameSource(url)` for the Live `<iframe>`. The viewer's footer adds `via proxy` when the payload URL is local, so it is visible that the frame is the app's origin rather than the page's. **Open in new tab** keeps the real URL — that link is followed by the browser directly, where a local dev server is the right target on a desktop and unreachable on a phone.

### Interaction with the rest of the preview stack

- The *screenshot* path (`src/tools/webpreview.js`, debug Chrome) is untouched: the capture runs on the machine that runs mouaif, where loopback is already correct. Only the frame the **user's browser** loads is proxied.
- Authorization is unchanged: a proxied page is only ever reached *through* a preview payload the `webpreview` gate already allowed.
- The app CSP's `frame-src` already allows anything, and the proxy path is same-origin, so no CSP change is needed (`scripts/test-web-csp.js` is the guard).

### Tests

- [`scripts/test-preview-proxy.js`](../../../scripts/test-preview-proxy.js) — parsing/authority rules, the host allow-list, `proxyPathFor` parity, and an end-to-end round trip through a real `createServer` against a stand-in dev server (HTML, a relative asset, the byte-exact query, a passthrough redirect, `HEAD`, gzip, no cookie either way, no `X-Frame-Options`, `403` for a remote host, `400` for a bad scheme, `405` for `POST`, `502` for a closed port, and that `/api/tools/list` is not shadowed).
- [`scripts/test-webpreview-iframe.mjs`](../../../scripts/test-webpreview-iframe.mjs) — the frontend/server host-list parity and that both Live frames use `frameSource`.

### Verified against a real dev server

Loaded through a real throwaway `mouaif serve` (port 5799, a separately launched Vite on 5173) in a 375 px frame, inside the app shell so the session cookie is present: the Vite page booted, and the network log shows the whole module graph resolving under the proxy — `/@vite/client`, `/src/main.jsx`, `/@fs/…/node_modules/.vite/deps/preact.js?v=…`, `chunk-*.js`, `/src/components/chat/Chat.jsx`, 26 requests, all `200`. A second, minimal hand-rolled dev server (HTML + a root-absolute stylesheet + a three-module graph) rendered its heading from a module and applied the stylesheet's colour through the proxy — heading `rgb(0, 170, 0)`, i.e. `/lib.js` was fetched and executed. The same probe against the Vite page through a *direct* navigation (`…/api/preview/…` as the top-level document) gets `401` on the module requests: that navigation carries no session cookie for the app origin, which is why the proxy is only ever reached as a frame inside the app. `test-preview-proxy.js` covers the same paths without a browser.
