# REST + SSE server

Baseline feature present at `v1.0.0`. Kept here as the reference example of the doc format.

## Overview

`mouaif serve` starts an HTTP server that exposes a small REST surface plus a Server-Sent Events stream. Clients subscribe to `/events` and receive broadcasts whenever `POST /data` mutates the shared store.

## Usage

````bash
mouaif serve --port 5732 --host 0.0.0.0
````

Endpoints:

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/`        | Server info                          |
| GET    | `/data`    | Get stored data                      |
| POST   | `/data`    | Update data (send JSON body)         |
| GET    | `/events`  | Subscribe to Server-Sent Events      |

## Behavior

- CORS is permissive (`*`) for all routes; `OPTIONS` is handled and the
	advertised methods include `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.
- SSE clients receive a `connected` event on attach and a heartbeat comment every 30 s.
- Mutating `POST /data` triggers an SSE `data-update` event for every connected client.

## Implementation notes

- Source: [src/index.js](../../src/index.js), entrypoint [bin/mouaif.js](../../bin/mouaif.js).
- Default port is `5732`; do not change without a deprecation note in this file.

## Related

- Per-chat NDJSON traces are documented in [Chat UI](./chat-ui.md). They do not reuse this global SSE broadcast path; each trace is a project-local file.
