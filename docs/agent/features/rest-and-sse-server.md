# REST + SSE server — implementation notes

> Agent-facing reference for [`docs/features/rest-and-sse-server.md`](../../features/rest-and-sse-server.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Source: [src/index.js](../../src/index.js), entrypoint [bin/mouaif.js](../../bin/mouaif.js).
- Default port is `5732`; do not change without a deprecation note in this file.
