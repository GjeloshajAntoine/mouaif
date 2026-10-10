# Local preview proxy

## Overview

The web preview's **Live** mode frames a page in *your* browser, so `http://localhost:5173/` means the device you are holding — where the dev server is not running. The local preview proxy makes mouaif's own server fetch a page from this machine and serve it again under the app's origin, so a Vite, Next, SvelteKit or plain static server running on the computer with mouaif is reachable from your phone, an iPad, or any other device on the network.

## Usage

1. Open a page that runs on the machine running mouaif, e.g. `npm run dev` in a project.
2. In a chat, use the File tools **Preview** item (or Settings → project → More settings → **Web preview**) and enter the local address — `http://localhost:5173/`.
3. Switch the viewer to **Live**. The frame loads through the proxy and the footer reads `live · 375 × 667 · via proxy`.

Any of these address shapes works:

| You type | What the proxy targets |
|---|---|
| `http://localhost:5173/` | `http://localhost:5173/` |
| `http://127.0.0.1:3000/src/main.jsx` | the same path on the same dev server |
| `http://host.docker.internal:5173/` | the host, from inside the mouaif container |
| `https://localhost:8443/app?x=1` | the same path and query over TLS |

Only the address changes: the page is the dev server's own page, at its own URL. The proxy is addressed by **path** (`/api/preview/http/localhost:5173/...`) rather than by query, so relative links, redirects and `fetch('api/state')` keep working on their own; root-absolute URLs (`/@vite/client`, `/src/main.jsx`, `/style.css`) are pointed back at the proxy as the page is served, so a whole module graph loads. Nothing else about the page changes: it is the same HTML, CSS and JavaScript the dev server produced.

### What the proxy reaches

**This machine only.** `localhost`, anything ending in `.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, and the container-to-host aliases `host.docker.internal`, `gateway.docker.internal` and `host.containers.internal`. Any other hostname is refused with `403 EREMOTE_HOST` — the proxy is not a general-purpose gateway to the network.

### Limits

- **Screenshot mode is unaffected.** A screenshot capture runs in the debug Chrome on the machine that runs mouaif, where `localhost` is already the right machine; the proxy only exists for the frame your own browser must load.
- **`GET` and `HEAD` only.** A request body is refused with `405`. A dev server that needs `POST` to render a page cannot be proxied.
- **No WebSocket.** A dev server's hot-reload socket is not proxied, so an edit does not push itself into the frame. Reload the frame (the **Refresh** button in Live mode) to pick the change up.
- **A URL built at runtime is out of scope.** The rewrite covers URLs in HTML, CSS and JavaScript as they are *written* — an attribute, a `url()`, a string literal, an `import` specifier, a `new URL('/x', …)`, a root-absolute `Location` header. A path assembled from pieces at runtime (`'/api/' + name`) is not visible to it. Rather than a rewrite that corrupts data, the proxy only ever touches those shapes: JSON, plain text and XML bodies are passed through untouched, because a leading slash inside data is not a URL.
- **Cookies do not cross in either direction.** Your mouaif session cookie is never sent to the dev server, and the dev server's `Set-Cookie` never reaches your browser. A dev server that requires its own login is out of scope.
- **A dev server that refuses framing is framed anyway.** The upstream's `X-Frame-Options` and `Content-Security-Policy` are not forwarded, so a page that blocks embedding can still be previewed — the same freedom the Live frame already had for a remote URL.
- **Responses are never cached** (`Cache-Control: no-store`), so a preview always shows the current build.
- **A page with no answer within 30 seconds** is reported as `504 EPREVIEW_TIMEOUT`; a dev server that is not listening is reported as `502 EPREVIEW_UNREACHABLE` with the URL it tried.

### Same-origin note

Because the proxied page is served from the mouaif origin, it is a document in the app's own origin and can reach the app's `/api/*` surface with the session it already has. This is the same trust the Live frame already extends to a page loaded from `localhost` on a desktop browser — a page you started yourself — and it is why the proxy refuses every host that is not this machine. Do not point it at a page you would not run locally.

## Related

- [Web preview tool](./webpreview.md) — the `webpreview` tool and its Live mode.
- [Web preview page](./webpreview-project-page.md) — capture and view a URL from project settings.
- [CLI commands](./cli-commands.md) — running mouaif behind a reverse proxy.
