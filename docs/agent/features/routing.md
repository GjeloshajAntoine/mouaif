# Routing — implementation notes

> Agent-facing reference for [`docs/features/routing.md`](../../features/routing.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/routes.js` holds the table. Entries are `exact(path)`, `exactOrQuery(path)` or `prefix(head)`, each with a `build(match)` that returns a route object or `null` to fall through. Matching is **in order**, which is what keeps `settings/mcp/registry` and `settings/mcp/new` from being read as `settings/mcp/<id>`, and the legacy `settings/project/agents/<name>` from being read as project settings. Adding a route is one entry; adding a sub-page under an existing prefix means putting the exact entry above the prefix entry.
- `frontend/src/router.js` writes the shared `route` signal on load and on `hashchange`, and exports `nav(hash)` (go forward), `back(hash)` (return: pop or replace, never push), `replace(hash)` and `replaceUrl(hash)`. It contains no route knowledge; the history record lives in `frontend/src/navHistory.js`.
- `parseHash()` is pure and never touches `window`, so `scripts/test-routes.js` covers the whole table (legacy aliases, query plumbing, order-sensitive routes, fall-throughs) without a DOM.
- Path segments are decoded with a non-throwing `decodeURIComponent`: a malformed escape (`%zz`, a truncated `%e0`) keeps the segment as written instead of throwing a `URIError` out of the `hashchange` handler, which used to leave the app on a dead hash. `src/util.js` has the same guard server-side (`safeDecode`).
- The previous inline router compared the whole hash remainder for `settings/providers/<id>`, so `#/settings/providers/openai?from=projects` looked up a provider literally named `openai?from=projects`. The table takes the segment before the query.

### Back and history

- The browser does not expose its history list, so `frontend/src/navHistory.js` keeps a small record. Each entry the router sees gets an id in `history.state` (it survives Back/Forward and reloads) plus a pointer to the entry it was pushed from, stored in `sessionStorage`. `back(path)` walks that chain for the nearest entry whose parsed route equals `path`'s. Query order and legacy aliases such as `#/projects` vs `#/` don't matter. It then calls `history.go(-n)`. With no match it falls back to `location.replace()`.
- The record keeps the last 200 entries, and `back()` looks at most 50 steps behind. Anything older is treated as not found, which gives a replace: still loop-free.
- `replaceUrl(path)` rewrites the current entry's URL without routing. The agent editor uses it to follow a rename without remounting the form.
- `scripts/test-nav-history.mjs` runs the real `router.js` against a simulated history and replays the flows in the table in `docs/features/routing.md` → Back and history.
