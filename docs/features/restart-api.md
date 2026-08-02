# Restart API

Gracefully restart the mouaif server — stops MCP child processes, flushes the response, closes the listening socket, then relaunches a fresh server process. `mouaif serve` runs as a supervisor + worker pair: the supervisor (the process you launched) stays alive and respawns the worker, so a restart loads the latest code from disk. If no launcher hook is available, the process exits with code 0 so an external supervisor (e.g. systemd, Docker) can relaunch.

## Endpoint

`POST /api/restart`

### Request body

All fields are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `reason` | `string` | `"user-requested"` | Logged to stdout and forwarded to the launcher hook. |
| `delayMs` | `number` | `150` | Milliseconds to wait before restarting. Clamped to `0`–`5000`. |

### Response

| Status | Body | Condition |
|---|---|---|
| `200` | `{ ok: true, restarting: true, reason, delayMs, mode }` | Restart initiated. `mode` is `"relaunch"` when a supervisor (CLI) or launcher hook is available, `"exit"` otherwise. |
| `409` | `{ ok: false, restarting: true, error: "Restart already in progress" }` | A restart is already running. |
| `405` | `{ error: "POST only" }` | Non-POST method. |

### Example

```bash
curl -X POST http://localhost:5732/api/restart \
  -H "Content-Type: application/json" \
  -d '{"reason": "switching providers", "delayMs": 500}'
```

Response:

```json
{
  "ok": true,
  "restarting": true,
  "reason": "switching providers",
  "delayMs": 500,
  "mode": "relaunch"
}
```

## Implementation notes

- Defined in [`src/server-handlers-misc.js`](../../src/server-handlers-misc.js) as `handleRestart()` and routed from [`src/http-server.js`](../../src/http-server.js). The supervisor/worker split lives in [`bin/mouaif.js`](../../bin/mouaif.js).
- `mouaif serve` always runs as a **supervisor + worker pair**: the outer process stays alive, and the worker serves HTTP. The worker's `lifecycle.restart` hook closes the listening socket and exits with code 0; the supervisor sees the exit and spawns a brand-new worker process. Every module is re-read from disk (the `require` cache is not reused), and runtime state — MCP children, DB handles, OAuth flows — is fully re-initialized.
- `--watch` reuses the same supervisor: a source change kills the worker and respawns it through the identical path.
- The handler sets `lifecycle.restarting = true` immediately to serialize concurrent requests, then responds synchronously before the delayed teardown begins.
- Teardown (after `delayMs`): stops all MCP children via `mcp.stopAll()`, then calls the optional `lifecycle.restart()` hook. If the hook fails, `restarting` is reset to `false` and the server continues running.
- If no `lifecycle.restart` function exists (e.g. the server is embedded via `createServer()` without a launcher), the process calls `process.exit(0)` so an external supervisor can relaunch it.
- The `delayMs` timeout is `.unref()`'d so it does not keep the process alive if the server is already shutting down.
- The endpoint is not gated behind authentication — it respects the same middleware as all other API routes (session check, CORS, etc.).
