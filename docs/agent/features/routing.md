# Routing — implementation notes

> Agent-facing reference for [`docs/features/routing.md`](../../features/routing.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/routes.js` holds the table. Entries are `exact(path)`, `exactOrQuery(path)` or `prefix(head)`, each with a `build(match)` that returns a route object or `null` to fall through. Matching is **in order**, which is what keeps `settings/mcp/registry` and `settings/mcp/new` from being read as `settings/mcp/<id>`, and the legacy `settings/project/agents/<name>` from being read as project settings. Adding a route is one entry; adding a sub-page under an existing prefix means putting the exact entry above the prefix entry.
- `frontend/src/router.js` writes the shared `route` signal on load and on `hashchange`, and exports `nav(hash)` (used by every component that navigates). It contains no route knowledge.
- `parseHash()` is pure and never touches `window`, so `scripts/test-routes.js` covers the whole table (legacy aliases, query plumbing, order-sensitive routes, fall-throughs) without a DOM.
- Path segments are decoded with a non-throwing `decodeURIComponent`: a malformed escape (`%zz`, a truncated `%e0`) keeps the segment as written instead of throwing a `URIError` out of the `hashchange` handler, which used to leave the app on a dead hash. `src/util.js` has the same guard server-side (`safeDecode`).
- The previous inline router compared the whole hash remainder for `settings/providers/<id>`, so `#/settings/providers/openai?from=projects` looked up a provider literally named `openai?from=projects`. The table takes the segment before the query.
