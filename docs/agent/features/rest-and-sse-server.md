# REST + SSE server — implementation notes

> Agent-facing reference for [`docs/features/rest-and-sse-server.md`](../../features/rest-and-sse-server.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## REST surface

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/`        | Server info                          |
| GET    | `/data`    | Get stored data                      |
| POST   | `/data`    | Update data (send JSON body)         |
| GET    | `/events`  | Subscribe to Server-Sent Events      |

## Implementation notes

- Source: [src/index.js](../../../src/index.js), entrypoint [bin/mouaif.js](../../../bin/mouaif.js).
- Default port is `5732`; do not change without a deprecation note in this file.
- CORS is permissive (`*`) for local UI integration.
- SSE clients receive a `connected` event on attach and a heartbeat comment every 30 s.

## Request-target parsing

`dispatchRequest` splits `req.url` with `parseRequestTarget()` ([src/util.js](../../../src/util.js)) instead of the deprecated `url.parse(req.url, true)`. The old call printed this on the first request of every `mouaif serve`:

```text
(node:1234) [DEP0169] DeprecationWarning: `url.parse()` behavior is not
standardized and prone to errors that have security implications.
```

`parseRequestTarget` returns the same two fields the dispatcher reads — `pathname` (raw, still percent-encoded) and `query` (a null-prototype object) — so every `parsed.query.<name>` read in the handler modules is unchanged. The query is parsed by `querystring.parse`, which is the call `url.parse(raw, true)` made internally and is **not** deprecated: same null-prototype result, same `''` for a bare key, same array for a repeated key, same literal `%zz` for a malformed escape, same `+` → space.

**The WHATWG `new URL(raw, base)` is not a drop-in replacement** and swapping to it would be a bug, not a cleanup:

- `URL.pathname` percent-decodes, so `/api/projects/%2e%2e/x` would arrive as `/api/projects/../x` and match a route the client never named. [src/server-web-static.js](../../../src/server-web-static.js) depends on the encoded path: a literal `%2e%2e` staying inside `path.join` is the suspenders to its `isInside()` belt.
- `URL.pathname` also normalizes dot segments, so `/a/../b` becomes `/b`.
- `URL` needs a base, and reads `//host/p` as a protocol-relative authority.

One deliberate difference: `url.parse` returned `pathname: null` for an empty or fragment-only target, and the dispatcher's `urlPath.startsWith(...)` then threw a `TypeError` that surfaced as a `500 EINTERNAL`. `parseRequestTarget` always returns a string path, so such a target is an ordinary `404`. A fragment is stripped before the query is split, matching `url.parse` (`/x?a=1#frag` → `a=1`).

Regression test: `node scripts/test-request-target-parsing.js`. It asserts parity with `url.parse` over 29 targets (path, query, and the null prototype), that the path is never decoded or dot-normalized, and — in a **fresh child process** — that driving real requests through a running server emits no `DeprecationWarning`. The child is required because Node emits a given deprecation warning **once per process**: the parity phase has to call `url.parse` to prove equivalence, which consumes `DEP0169` for that process, so an in-process assertion would pass even with the fix reverted.
