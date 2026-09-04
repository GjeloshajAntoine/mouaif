# Restart the app from chat

## Overview

The `restart_app` tool lets the assistant gracefully relaunch mouaif directly from a chat. The supervisor stays running while the HTTP worker is replaced, so server-side code and configuration are reloaded without manually stopping and starting the command.

## Usage

Ask the assistant to restart the app, for example:
```text
Restart the app.
```
For an immediate explicit restart, enter the direct composer command:
```text
@restart_app apply the latest fix
```
The exact `@restart_app` command is treated as the user's approval and runs without a second confirmation. Autonomous assistant calls still use the project tool authorization mode:
- **Ask** shows an approval card before restarting.
- **Allow** lets the assistant restart immediately.
- **Off** hides the tool from the assistant.

The setting is available under **Settings → Project → Tools → Restart app**. A restart briefly disconnects the chat while the new worker starts; reload or reopen the app if the browser does not reconnect automatically.

## Implementation notes

Autonomous `restart_app` tool calls use the shared graceful-restart scheduler in `src/restart.js` after authorization. The exact `@restart_app` composer command calls the authenticated `POST /api/restart` endpoint directly because the user already requested the destructive action. Both paths share the same scheduler and work with app access authentication.

The scheduler returns the tool result before restarting, waits briefly so the chat can persist and flush the result, stops MCP child processes, and invokes the same supervisor lifecycle hook used by the restart API. The outer `mouaif serve` process remains alive and starts a fresh worker.
