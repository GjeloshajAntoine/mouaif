# Restart API

Gracefully restart the mouaif server in-process — stops MCP child processes, flushes the response, closes the listening socket, then relaunches. If no launcher hook is available, exits with code 0 so an external supervisor (e.g. systemd, Docker) can relaunch.

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
| `200` | `{ ok: true, restarting: true, reason, delayMs, mode }` | Restart initiated. `mode` is `"relaunch"` when an in-process launcher hook is available, `"exit"` otherwise. |
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

- Defined in [`src/index.js`](../../src/index.js) as `handleRestart()`.
- The handler sets `lifecycle.restarting = true` immediately to serialize concurrent requests, then responds synchronously before the delayed teardown begins.
- Teardown (after `delayMs`): stops all MCP children via `mcp.stopAll()`, then calls the optional `lifecycle.restart()` hook. If the hook fails, `restarting` is reset to `false` and the server continues running.
- If no `lifecycle.restart` function exists, the process calls `process.exit(0)` — an external supervisor must detect the exit and relaunch.
- The `delayMs` timeout is `.unref()`'d so it does not keep the process alive if the server is already shutting down.
- The endpoint is not gated behind authentication — it respects the same middleware as all other API routes (session check, CORS, etc.).