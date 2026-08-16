# PWA — install, offline shell, update prompts — implementation notes

> Agent-facing reference for [`docs/features/pwa.md`](../../features/pwa.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Build pipeline.** `frontend/public/manifest.webmanifest` and `frontend/public/icons/*.png` are static; Vite's default `publicDir` copies them into `dist/` at build time, and `base: '/'` in `frontend/vite.config.js` keeps every emitted URL at the root. `frontend/build/sw-src.js` is the SW source — a small Vite plugin in `frontend/vite.config.js` reads it on `generateBundle`, replaces `__CACHE_VERSION__` with the first 8 hex chars of `sha256(sw body)`, and emits `dist/sw.js`.
- **Server.** `src/server-web-static.js` serves the built `frontend/dist/` at the root (falling back to the pre-build `frontend/` for development). `applyPwaHeaders()` sets:
  - `Service-Worker-Allowed: /` and `Cache-Control: no-cache` on `/sw.js`,
  - `Cache-Control: public, max-age=31536000, immutable` on fingerprinted `.js`, `.css`, `.png`, `.webp`, `.svg`, `.ico`,
  - `Cache-Control: public, max-age=300` on `manifest.webmanifest`.
  The `/favicon.ico` endpoint serves the real `icons/favicon-32.png`. A legacy `/web/` route 301-redirects to `/` so old bookmarks keep resolving (the hash fragment survives the redirect).
- **Client side.** `frontend/src/sw-registration.js` registers `/sw.js` with `scope: '/'` (no-op in dev), tracks `navigator.onLine` and same-origin app-shell fetch failures to keep an `offline` signal current. `frontend/src/components/PwaBanners.jsx` renders the offline + update banners into the app shell between the header and the main content.
- **Update semantics.** The SW calls `skipWaiting()` on install so the new worker activates immediately. `clients.claim()` lets it intercept the next fetch without a navigation. The page opts in to a reload at `controllerchange` time — the user pressing Reload is what writes the new controller; we don't force-reload mid-action.
- **Lint.** `npm run lint` runs `node -c` on every `.js` file in `bin/`, `src/`, and `frontend/build/`. Three new scripts (`generate-icons.js`, `sw-src.js`, `check-icons.js`) plus `vite.config.js` are wired into the lint chain.
- **Tests.** `scripts/test-pwa.js` stands up an in-process server on an ephemeral port and asserts: `<link rel="manifest">` and `<link rel="apple-touch-icon">` in `/`, manifest JSON shape (`id`/`start_url`/`scope` all `/`), theme color + icons, SW JS body + `Service-Worker-Allowed: /` + `no-cache` + `install`/`activate`/`fetch` handlers + `/api/` bypass, every icon reachable as `image/png` with the PNG magic intact, favicon now returns 200, and the hashed CSS asset carries `immutable`.
