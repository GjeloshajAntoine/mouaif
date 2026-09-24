# Assistant server & CLI

## Overview

mouaif runs as a local background process and CLI that hosts the mobile web interface, orchestrates AI provider requests, and manages real-time conversational streaming.

## Usage

Start the server using the default port (`5732`):

```bash
mouaif serve
```

### Options

```bash
mouaif serve --port 9000       # use a custom port
mouaif serve --watch           # restart automatically on local source changes
mouaif info                    # show package version and default port
```

Once running, open `http://127.0.0.1:5732/` in any browser on your machine or phone.

## Request error handling

The route table (`src/http-server.js`) is fail-closed: `handleRequest` wraps
`dispatchRequest`, so a handler that throws synchronously or rejects
asynchronously is logged and answered instead of escaping. Handlers are
`async` and are called without `await`, so an uncaught rejection would
otherwise become an `unhandledRejection` — and Node's default
`--unhandled-rejections=throw` turns that into a process exit, dropping
every connected client over one bad request.

- The failure is logged as `[mouaif] request failed: <METHOD> <url>`.
- If nothing has been written yet, the client gets a `500` with
  `{"error":"Internal server error","code":"EINTERNAL"}`.
- If the response already started (an SSE stream), the socket is
  destroyed so the client sees a truncation rather than a hang.
- `mouaif serve` also installs `unhandledRejection` / `uncaughtException`
  breadcrumbs for failures that originate outside a request.

Path ids are decoded with `safeDecode()` (`src/util.js`), a
`decodeURIComponent` that returns the raw segment instead of throwing a
`URIError`:

```js
const { safeDecode } = require('./util.js');

safeDecode('%zz');  // '%zz'  — malformed escape, no throw
safeDecode('a%20b'); // 'a b'
```

A malformed escape therefore becomes an ordinary `400`/`404` rather than
a crash. `scripts/test-url-decode-safety.js` drives the real server with
malformed paths and asserts the process stays alive.

## No deprecation warnings

The request target is split by `parseRequestTarget()` (`src/util.js`), not
by the deprecated `url.parse()`. The old call printed a `DEP0169`
`DeprecationWarning` on the first request of every `mouaif serve`; the
replacement keeps the raw, still-encoded path and parses the query with
`querystring.parse`, so routing and every `?projectDir=…` value behave
exactly as before. The WHATWG `URL` class is deliberately **not** used:
it percent-decodes and dot-normalizes the path, which would let
`/api/projects/%2e%2e/x` match a route the client never named.

`scripts/test-request-target-parsing.js` pins the equivalence and runs the
real server in a fresh process to prove no warning is emitted.

## Related
- [Chat UI](./chat-ui.md) — the web interface.
- [App and project settings](./app-and-project-settings.md) — configuration hierarchy and defaults.
