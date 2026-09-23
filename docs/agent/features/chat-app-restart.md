# Restart the app from chat — implementation notes

> Agent-facing reference for [`docs/features/chat-app-restart.md`](../../features/chat-app-restart.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

Autonomous `restart_app` tool calls use the shared graceful-restart scheduler in `src/restart.js` after authorization. The exact `@restart_app` composer command calls the authenticated `POST /api/restart` endpoint directly because the user already requested the destructive action. Both paths share the same scheduler and work with app access authentication.

The scheduler returns the tool result before restarting, waits briefly so the chat can persist and flush the result, stops MCP child processes, and invokes the same supervisor lifecycle hook used by the restart API. The outer `mouaif serve` process remains alive and starts a fresh worker.
