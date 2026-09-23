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
