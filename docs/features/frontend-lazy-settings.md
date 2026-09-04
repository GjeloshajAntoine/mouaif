# Frontend bundle: lazy-loaded settings views

## Overview

The mobile web UI code-splits the heavyweight settings sub-pages out of the entry bundle so the first paint (Chats tab and chat view) downloads far less JavaScript. Every settings page that the chat path never needs on load is now a dynamic `import()` resolved behind Preact `<Suspense>`, shrinking the initial `index-*.js` chunk by roughly a third.

## Usage

There is no user-facing change. The Settings tab still opens instantly to its home row; tapping a sub-page (Providers, MCP, Project, Prompts, and so on) briefly shows a `Loading…` placeholder while its chunk arrives, then renders normally. On a slow connection this is the intended trade-off: the chat path no longer pays for settings UI it did not use.

## Behavior

- Entry `index-*.js` falls from ~421 kB (min) / ~122 kB (gzip) to ~284 kB / ~85 kB — a ~33% / ~30% reduction — by moving the settings sub-page code into per-route chunks.
- Settings sub-pages that become lazy chunks: Providers, Provider edit, Project, Defaults, Notifications, About, Prompts, Agents + Agent edit, Actions + Action edit, MCP, MCP edit, MCP registry, Tags, Pricing, Projects.
- Kept eager in the entry: `SettingsHomeView` (the settings tab landing row, a ~90-line index of links) and `AccessSettingsView` (already loaded on every visit via the access gate).
- Shared small modules (`projectQS`, `virtual-list`) are extracted into their own deduplicated chunks, imported by the settings chunks and (where used) the entry — no duplicated copies.
- Already-lazy before this change (unchanged): Inspector view, FileEditor view, and the CodeMirror chunk.

## Implementation notes

- `frontend/src/components/App.jsx` replaces top-level static imports of the settings views with a `lazyNamed` factory that wraps `import()` and maps the module's named export to Preact's default slot, alongside the existing Inspector lazy route.
- `renderRoute` wraps any route in `LAZY_ROUTE_NAMES` with a `<Suspense>` fallback so the lazy view paints its placeholder while the chunk loads.
- View getters (`ROUTES[...][1]`) are unchanged; only the component reference became lazy. Route parsing lives in `frontend/src/router.js` and is untouched.
- `frontend/vite.config.js` keeps the `manualChunks` that already split CodeMirror out of the entry; the settings split is purely statically expressed through `import()`.

## Related

- [Chat load performance](./chat-load-performance.md) — per-chat transcript cost and lazy tool cards.
- [Frontend build config](../../frontend/vite.config.js) — entry hashing, chunk naming, CodeMirror split.
- [Route shell](../../frontend/src/components/App.jsx) — lazy route wiring and `<Suspense>` boundaries.
