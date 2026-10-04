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
@restart_app
```
The command takes no arguments: `@restart_app` on its own is the user's approval and runs without a second confirmation. Anything typed after it is extra text, so the turn goes to the model instead of restarting the app. Autonomous assistant calls still use the project tool authorization mode:
- **Ask** shows an approval card before restarting.
- **Allow** lets the assistant restart immediately.
- **Off** hides the tool from the assistant.

The setting is available under **Settings → Project → Tools → mouaif**, where **Restart app** is a child of the mouaif family: the family's Off / Ask / Allow segment governs it, and its own segment stores a `tools.restart_app` override. Choosing **Always allow** on any mouaif call therefore also lets the assistant restart the app without asking; turn the restart off on its own if you want the family open and this one gated. A restart briefly disconnects the chat while the new worker starts; reload or reopen the app if the browser does not reconnect automatically.
