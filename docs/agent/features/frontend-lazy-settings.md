# Frontend bundle: lazy-loaded settings views — implementation notes

> Agent-facing reference for [`docs/features/frontend-lazy-settings.md`](../../features/frontend-lazy-settings.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/components/App.jsx` replaces top-level static imports of the settings views with a `lazyNamed` factory that wraps `import()` and maps the module's named export to Preact's default slot, alongside the existing Inspector lazy route.
- `renderRoute` wraps any route in `LAZY_ROUTE_NAMES` with a `<Suspense>` fallback so the lazy view paints its placeholder while the chunk loads.
- View getters (`ROUTES[...][1]`) are unchanged; only the component reference became lazy. Route parsing lives in the table in `frontend/src/routes.js` (`router.js` is only the hash listener and `nav()`); see [Routing](../../features/routing.md).
- `frontend/vite.config.js` keeps the `manualChunks` that already split CodeMirror out of the entry; the settings split is purely statically expressed through `import()`. Vite's default `cssCodeSplit: true` lets each lazy component import its own CSS.
- The Inspector and FileEditor CSS import their own stylesheets (`import '../inspector.css'` / `import '../file-editor.css'`) instead of relying on the global `style.css` `@import` chain; `style.css` drops those two `@import`s.
- `frontend/src/components/App.jsx` maps the `inspector` route in `ROUTES` (previously a special-case branch) so the lazy `InspectorView` resolves through the same route table as the other views.
