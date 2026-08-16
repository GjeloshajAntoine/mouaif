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

- Source: [src/index.js](../../src/index.js), entrypoint [bin/mouaif.js](../../bin/mouaif.js).
- Default port is `5732`; do not change without a deprecation note in this file.
- CORS is permissive (`*`) for local UI integration.
- SSE clients receive a `connected` event on attach and a heartbeat comment every 30 s.
