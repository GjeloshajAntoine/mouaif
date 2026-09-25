# Memory footprint and payload size — implementation notes

> Agent-facing reference for [`docs/features/memory-footprint.md`](../../features/memory-footprint.md). The human-facing summary lives in that file. Source paths, measurements, and tests live here.

## Lazy server dependencies

These modules are required on first use instead of at startup:

| Dependency | Loaded when | Where |
| --- | --- | --- |
| `ws` | the Inspector proxy upgrades, or a CDP / webpreview socket opens | `src/inspector.js` (`loadWs()`), `src/http-server.js` creates the `noServer` WebSocketServer on the first upgrade |
| `web-push` (+ `asn1.js`, `bn.js`, `jws`, …) | the first push is sent, or VAPID keys are generated on first run | `src/push.js` (`webpush()`) |
| `@napi-rs/keyring` (native addon) | the first credential or MCP OAuth vault access | `src/auth.js` (`keyringEntry()`), `src/oauth-mcp.js` (`vaultEntry()`) |

`push.ensureVapidKeys()` no longer calls the process-wide `webpush.setVapidDetails()`. Every `sendNotification()` already passes `vapidDetails` built from the subscription's origin, so the global was redundant. Dropping it means a server with existing keys never loads `web-push` at startup.

Measured on Linux, Node 24, an empty `MOUAIF_HOME`, idle for 3 s after start:

| | Modules loaded | RSS |
| --- | --- | --- |
| Before | 137 | ~71 MB |
| After | 85 | ~62 MB |

## Bounded in-memory tables

| Table | Bound |
| --- | --- |
| `accessAttempts` (`src/server-shared.js`) | an IP whose 60 s window empties is deleted instead of being kept as an empty array |
| `includeRegExpCache` (`src/tools/searchEngine.js`) | capped at 64 globs, oldest evicted (the globs come from the model) |
| access challenges (`src/access-auth.js`) | expired, unanswered challenges are swept whenever a new one is issued |

## Compressed static assets

`src/server-web-static.js` negotiates `Accept-Encoding` (`br`, then `gzip`; `q=0` opt-outs are honoured) for HTML, JS, CSS, JSON, the manifest and SVG. Images are sent as-is. Every compressible response carries `Vary: Accept-Encoding` and an exact `Content-Length`.

Each compressed body is produced once per `(encoding, file, mtime, size)` and kept in a byte-capped cache (4 MiB, oldest evicted first). The built bundle compresses to well under that cap. Compressing on every request would create a new zlib/brotli encoder each time, several MB of transient native memory that the allocator tends to keep. The cache avoids that and uses no CPU on a warm server. A rebuilt file has a new mtime and size, so it is recompressed rather than served stale. Brotli runs at quality 9 with a 1 MiB window, which is enough for the largest chunk (~600 kB).

| Asset | Raw | gzip | br |
| --- | --- | --- | --- |
| entry JS | 330 kB | 101 kB | ~94 kB |
| entry CSS | 162 kB | 27 kB | ~26 kB |
| CodeMirror chunk (lazy) | 631 kB | 222 kB | ~207 kB |

## Verifying

```sh
node scripts/test-web-static-compression.js
node scripts/test-push-notifications.js
```

To compare startup footprints, start two servers on a spare port with a throwaway `MOUAIF_HOME` and read `ps -o rss= -p <pid>` after a few seconds.
