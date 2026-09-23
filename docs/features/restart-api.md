# Restart API

## Overview

mouaif runs as a small supervisor that keeps a worker process alive. Restarting replaces the worker, so server-side code and settings are reloaded, while the supervisor, and the terminal you started it from, keep running.

## Usage

- In a chat, ask the assistant to restart the app, or send `@restart_app`. See [Restart from chat](./chat-app-restart.md).
- From a script, send an authenticated `POST` to `/api/restart` on the running server:

```bash
curl -X POST http://127.0.0.1:5732/api/restart
```

When access authentication is on, add `-u <user>:<password>`. The page reconnects on its own once the new worker is up.

## Related

- [Restart from chat](./chat-app-restart.md) — the `restart_app` tool and its approval modes.
- [CLI commands](./cli-commands.md) — `mouaif serve` and its `--watch` option.
