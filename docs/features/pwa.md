# PWA — install, offline shell, update prompts

The mobile UI served at `/` (the root) is a Progressive Web App: it ships a manifest, a service worker, and the iOS-specific meta tags needed for an Add-to-Home-Screen experience. The feature is opt-in for the user (a browser decides when to surface the install prompt) and the chat surface stays fundamentally a live one — the SW guards the API and SSE endpoints out of its cache. Its manifest identity is `/`, so an installation follows the domain that serves mouaif without a hard-coded hostname.

## Overview

The PWA scaffolding covers four things:

- A `manifest.webmanifest` declaring the app's display metadata, theme color, start URL, scope, and icon set. Vite copies it verbatim from `frontend/public/manifest.webmanifest` into `dist/`, where the Node server serves it at `/manifest.webmanifest` with the `application/manifest+json` MIME.
- A tiny, hand-rolled service worker (no Workbox, no dependencies) that precaches the app shell, runs cache-first for fingerprinted JS/CSS/icons and network-first for navigation, and bypasses `/api/*`, `/events`, `/data`, `/oauth/*`, cross-origin, and any non-GET request. Because the SW is registered with `scope: '/'`, those live endpoints are bypassed explicitly rather than by a path-prefix shell like the old `/` layout.
- iOS-specific meta tags and an `apple-touch-icon` so an iPhone user can tap Share → Add to Home Screen and get a standalone shortcut with the mouaif glyph as its home-screen icon.
- Two app-state banners in the app shell: a thin offline indicator and a "new version ready" prompt. Browsers may still expose their own install affordance in the URL bar, but mouaif no longer shows an in-app install banner just because the page became installable.

## Usage

There is no command to run. The PWA plumbing is built into every `npm run build:web`. After the build, opening `http://127.0.0.1:5732/` in a browser exposes the install affordance the browser already supports:

````markdown
```bash
# Generate icons (idempotent — checks PNG signatures first).
node frontend/build/generate-icons.js
node frontend/build/check-icons.js

# Build the bundle + emit dist/sw.js.
npm run build:web

# Run the live-server smoke test for manifest, SW headers, icons.
node scripts/test-pwa.js
```
````

On Chrome (desktop and Android), the browser may show an "Install" icon in the URL bar once the manifest is reachable. mouaif does not show its own in-app install banner on first load. On iOS Safari, the user taps Share → Add to Home Screen.

Once installed:

- Launching the shortcut opens `http://127.0.0.1:5732/` in a standalone window (no URL bar, no navigation chrome).
- The standing screen icon is the mouaif glyph on the blue gradient, exactly the in-app logo.
- A first launch with the server reachable primes the cache so a later offline launch still renders the shell.

## Behavior

- **Manifest URL.** `/manifest.webmanifest`. The Node server emits `application/manifest+json; charset=utf-8` and a 5-minute `Cache-Control: public, max-age=300` so the browser re-fetches the manifest on the next session without keeping a stale one around forever.
- **Service worker URL.** `/sw.js`. Served with `Service-Worker-Allowed: /` (so the script installed from `/sw.js` can claim the entire `/` prefix) and `Cache-Control: no-cache` (so the browser always revalidates the script and the activate handler can evict the old cache on the next load). Registration uses `scope: '/'`.
- **Cache strategy.**
  - `install` precaches the shell (`/`, the manifest, the three icons). Best-effort: a single failed icon does not block activation.
  - `activate` deletes any cache whose name doesn't match the current build hash, then `clients.claim()` so the new version is live without a navigation.
  - `fetch`:
    - Same-origin GET under the root whose path is a PWA asset → handled.
      - Navigation request (mode === `navigate` or `Accept: text/html`) → network-first with a fallback to the cached shell on offline.
      - Static asset → cache-first (fingerprinted filenames, so a cache hit is always valid).
    - Cross-origin, `/api/*`, `/events`, `/data`, `/oauth/*`, the favicon, non-GET, and SSE GETs → bypassed. The chat surface stays live; the SW never sits in front of a streaming response.
- **Hashed JS/CSS assets** are served with `Cache-Control: public, max-age=31536000, immutable`. The fingerprint changes on every build, so a stale copy is GC'd by the next deploy.
- **Icons.** 192 × 192 and 512 × 512 "any purpose" icons, plus a 512 × 512 "maskable" variant for Android adaptive icons. A 180 × 180 PNG doubles as the iOS `apple-touch-icon`, and a 32 × 32 PNG is the favicon. All are produced by `frontend/build/generate-icons.js` from a hand-rolled PNG encoder (no image library at build time).
- **Update flow.** When a new SW is installed, the page shows a "A new version is ready." banner with a Reload button. Tapping it posts `{ type: 'SKIP_WAITING' }` to the waiting worker; the worker activates and the `controllerchange` listener reloads once. The user is always in control — the page never reloads without consent.
- **Offline indicator.** The off banner ("You are offline. Showing the last cached view.") appears when the browser fires `offline` or when a same-origin app-shell fetch fails. Multiple banners stack: offline at the top, update immediately below.
- **Scope.** Strictly the app shell at `/`. `/api/settings`, `/api/ai/*`, `/events`, `/data`, `/oauth/callback`, and any future same-origin endpoint are untouched by the SW. The SW logs `[mouaif-sw]` warnings for visible problems (partial precache) but does not throw — the chat UI works as a normal web page if the SW is unavailable (private mode, restrictive embedding, etc.).
- **Dev mode.** `npm run dev:web` does not register the SW. Stale code in the cache would defeat Vite's HMR, so registration is a no-op when `import.meta.env.PROD` is `false`.

## Implementation notes

- **Build pipeline.** `frontend/public/manifest.webmanifest` and `frontend/public/icons/*.png` are static; Vite's default `publicDir` copies them into `dist/` at build time, and `base: '/'` in `frontend/vite.config.js` keeps every emitted URL at the root. `frontend/build/sw-src.js` is the SW source — a small Vite plugin in `frontend/vite.config.js` reads it on `generateBundle`, replaces `__CACHE_VERSION__` with the first 8 hex chars of `sha256(sw body)`, and emits `dist/sw.js`.
- **Server.** `src/server-web-static.js` serves the built `frontend/dist/` at the root (falling back to the pre-build `frontend/` for development). `applyPwaHeaders()` sets:
  - `Service-Worker-Allowed: /` and `Cache-Control: no-cache` on `/sw.js`,
  - `Cache-Control: public, max-age=31536000, immutable` on fingerprinted `.js`, `.css`, `.png`, `.webp`, `.svg`, `.ico`,
  - `Cache-Control: public, max-age=300` on `manifest.webmanifest`.
  The `/favicon.ico` endpoint serves the real `icons/favicon-32.png`. A legacy `/` route 301-redirects to `/` so old installs and bookmarks keep resolving (the hash fragment survives the redirect).
- **Client side.** `frontend/src/sw-registration.js` registers `/sw.js` with `scope: '/'` (no-op in dev), tracks `navigator.onLine` and same-origin app-shell fetch failures to keep an `offline` signal current. `frontend/src/components/PwaBanners.jsx` renders the offline + update banners into the app shell between the header and the main content.
- **Update semantics.** The SW calls `skipWaiting()` on install so the new worker activates immediately. `clients.claim()` lets it intercept the next fetch without a navigation. The page opts in to a reload at `controllerchange` time — the user pressing Reload is what writes the new controller; we don't force-reload mid-action.
- **Lint.** `npm run lint` runs `node -c` on every `.js` file in `bin/`, `src/`, and `frontend/build/`. Three new scripts (`generate-icons.js`, `sw-src.js`, `check-icons.js`) plus `vite.config.js` are wired into the lint chain.
- **Tests.** `scripts/test-pwa.js` stands up an in-process server on an ephemeral port and asserts: `<link rel="manifest">` and `<link rel="apple-touch-icon">` in `/`, manifest JSON shape (`id`/`start_url`/`scope` all `/`), theme color + icons, SW JS body + `Service-Worker-Allowed: /` + `no-cache` + `install`/`activate`/`fetch` handlers + `/api/` bypass, every icon reachable as `image/png` with the PNG magic intact, favicon now returns 200, and the hashed CSS asset carries `immutable`.

## Related

- [Chat UI](chat-ui.md) — the Preact + Vite mobile shell that the SW caches.
- [Web serving](rest-and-sse-server.md) — the Node server that serves the bundle and the manifest.
- [Build order decisions](../decisions.md#9-build-order-settings-first) — the order this commit slots into.
