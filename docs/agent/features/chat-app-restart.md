# Restart the app from chat — implementation notes

> Agent-facing reference for [`docs/features/chat-app-restart.md`](../../features/chat-app-restart.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

Autonomous `restart_app` tool calls use the shared graceful-restart scheduler in `src/restart.js` after authorization. The exact `@restart_app` composer command calls the authenticated `POST /api/restart` endpoint directly because the user already requested the destructive action. Both paths share the same scheduler and work with app access authentication.

`restart_app` is a leaf of the `mouaif` authorization family (`FAMILY_EXTRAS.mouaif` in `src/tools/authorization.js`, `frontend/src/toolGroups.js` for the UI), not a gate of its own: `effectiveConfig(projectDir, 'restart_app')` resolves through `tools.mouaif` plus the optional `tools.restart_app` leaf override. A family `allow` therefore satisfies the gate and the tool runs directly; a leaf `off` still rejects it with `ETOOL_DISABLED`. The advertisement loop drops the spec on either `off`.

The scheduler returns the tool result before restarting, waits briefly so the chat can persist and flush the result, stops MCP child processes, and invokes the same supervisor lifecycle hook used by the restart API. The outer `mouaif serve` process remains alive and starts a fresh worker.
