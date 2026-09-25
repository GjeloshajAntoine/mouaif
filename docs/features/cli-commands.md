# CLI commands

## Overview

The `mouaif` command starts the app server and has two small helper commands. This page lists every command, option, and environment variable, with ready-to-copy examples. New to mouaif? Start with [Getting started](./getting-started.md).

## Quick reference

| Command | What it does |
|---|---|
| `mouaif serve [options]` | Start the app (web UI + API). |
| `mouaif info` | Print the version, description, and default port. |
| `mouaif import-chats <projectDir>` | Import legacy JSON chat files. |
| `mouaif --version` (`-V`) | Print the version number. |
| `mouaif --help`, `mouaif help <cmd>` | Show help for mouaif or one command. |

Every example works with `npx` too: replace `mouaif` with `npx mouaif`, for example `npx mouaif serve --auth`.

## Common recipes

```bash
# Start on this computer only, login required (recommended)
mouaif serve --auth

# Reach it from a phone on the same Wi-Fi
mouaif serve --auth --host 0.0.0.0

# Use another port
mouaif serve --auth --port 9000

# Print a fresh setup link / QR code (new user, lost password)
mouaif serve --auth-setup

# Create or replace the login without an interactive setup page
MOUAIF_PASSWORD='a-long-password' mouaif serve --auth --user alice

# Behind an HTTPS reverse proxy
mouaif serve --auth --public-origin https://mouaif.example.com

# Keep data in another folder (for a second, separate instance)
MOUAIF_HOME="$HOME/.mouaif-work" mouaif serve --auth --port 5733
```

## `mouaif serve`

Starts the web interface and API, by default at `http://127.0.0.1:5732/`, and runs until you press `Ctrl+C`.

```text
mouaif serve [--port <port>] [--host <host>] [--public-origin <origin>]
             [--auth] [--auth-setup] [--user <user> [--password <password>]]
             [--watch]
```

### Options

| Option | Default | What it does |
|--------|---------|--------------|
| `-p, --port <port>` | `5732` | Port to listen on. |
| `-h, --host <host>` | `127.0.0.1` | Address to listen on. `127.0.0.1` = this computer only; `0.0.0.0` = every network interface (phone, LAN). |
| `--public-origin <origin>` | `$MOUAIF_PUBLIC_ORIGIN` | The public `https://…` address when mouaif is behind a reverse proxy. Used for setup links, passkeys, and push notifications. |
| `--auth` | off | Require a login to open the app. |
| `--auth-setup` | off | Turn on login and print a new one-time setup link, QR code, and short code, then keep serving. |
| `--user <user>` | — | Create or replace the login user before starting. Turns on login. Needs a password. |
| `--password <password>` | `$MOUAIF_PASSWORD` | Password for `--user` (at least 8 characters). Prefer the environment variable, which stays out of shell history. |
| `-w, --watch` | off | Restart the server when a file under `bin/` or `src/` changes. For development in a source checkout. |
| `--help` | — | Show the option list. |

Note that `-h` means `--host` for `serve`; use `--help` to see help.

### Access and login

Login is **off unless you ask for it**. It is on for a run when you pass `--auth`, `--auth-setup`, or `--user`. A user created earlier is kept when you start without these flags, but the app does not ask for a login during that run.

| You want to… | Run |
|---|---|
| Require login; create the first user from a setup page | `mouaif serve --auth` (the invitation prints automatically when no user exists) |
| Get a new setup invitation (expired link, lost password, new user) | `mouaif serve --auth-setup` |
| Set the user from a script, without a setup page | `MOUAIF_PASSWORD='…' mouaif serve --auth --user alice` |

- The setup invitation works once and expires after 15 minutes. Open the link, scan the QR code, or go to `/#/setup` and type the `XXXX-XXXX` code.
- `--user` and a password must be given together; otherwise the command exits with an error.
- A **different** username or password replaces the user, signs out every browser, and removes passkeys. The **same** username and password change nothing, so they are safe in a start script.

PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
mouaif serve --auth --user alice
```

Details, passkeys, and session management: [Authentication](./authentication.md).

### Reach mouaif from other devices

```bash
mouaif serve --auth --host 0.0.0.0
```

The terminal prints the computer's network address (for example `http://192.168.1.20:5732`); open it on the other device. Always combine `--host 0.0.0.0` with `--auth`. Over plain `http://` only password login works; passkeys need HTTPS.

### Behind a reverse proxy

When a proxy (Caddy, nginx, a tunnel) serves mouaif over HTTPS, keep mouaif on `127.0.0.1` and tell it its public address:

```bash
mouaif serve --auth --public-origin https://mouaif.example.com
```

The proxy must forward WebSocket upgrades and must not buffer responses, because chats stream over Server-Sent Events.

### Restarts

`mouaif serve` runs a small supervisor that starts the actual server as a child process. When the app restarts itself — through the assistant's **Restart app** tool or `POST /api/restart` — only the child is replaced, so the terminal and the port stay the same. See [Restart from chat](./chat-app-restart.md) and [Restart API](./restart-api.md).

Press `Ctrl+C` once to stop everything.

## `mouaif info`

```bash
mouaif info
```

```text
📦 mouaif v0.3.5
   Mobile-first AI coding assistant for local projects
   Default port: 5732
```

Prints the installed version, description, and default port. It does not start a server. `mouaif --version` prints only the version number.

## `mouaif import-chats`

```bash
mouaif import-chats <projectDir> [--skip-existing]
```

Only needed if you used a very old mouaif that saved chats as `.mouaif.messages.<id>.json` files in the project folder. It copies those chats into the app store so they appear in the app again.

| Argument / option | What it does |
|---|---|
| `<projectDir>` | The project folder that contains the JSON files. A relative path is resolved from the current folder. |
| `--skip-existing` | Import only chats and messages that are not already in the store. Use it when running the import a second time. |

```bash
mouaif import-chats ~/code/my-app --skip-existing
```

The command prints how many chats and messages it imported and lists any file it could not read, without stopping. The JSON files are left in place.

## Environment variables

| Variable | Used by | What it does |
|---|---|---|
| `MOUAIF_PASSWORD` | `serve --user` | Password for the login user, instead of `--password`. |
| `MOUAIF_PUBLIC_ORIGIN` | `serve` | Default for `--public-origin`. |
| `MOUAIF_HOME` | all commands | Folder for the app store. Default `~/.mouaif`. Use a different value to run a fully separate instance. |
| `MOUAIF_ALLOW_ANY_ROOT` | `serve` | Set to `1` to allow projects and file browsing outside your home folder. |
| `MOUAIF_CHROME_URL` | `serve` | Default debugger address for the Inspector. Default `http://127.0.0.1:9222`. |
| `MOUAIF_RG_PATH` | `serve` | Path to a `ripgrep` binary for project search, when it is not on `PATH`. |
| `MOUAIF_RG_DISABLE` | `serve` | Set to any value to skip `ripgrep` and use the built-in search. |

## Exit codes and errors

| Situation | Result |
|---|---|
| `--user` without a password, or a password without `--user` | Prints `--user and --password (or MOUAIF_PASSWORD) must be supplied together`, exit code `1`. |
| Password shorter than 8 characters | Prints `Could not set app access: …`, exit code `1`. |
| Port already in use (`EADDRINUSE`) | Another program — often a running mouaif — uses the port. Stop it or pick `--port`. |
| `import-chats` folder does not exist | Prints `Project directory does not exist`, exit code `1`. |
| Unknown command or option | Prints an error and the help text. |

## Install, update, and release

- Install, update, and uninstall: [Getting started](./getting-started.md#update).
- Package contents and publishing a release (maintainers): [npm package](./npm-package.md).

## Related

- [Getting started](./getting-started.md) — install and complete first setup.
- [Authentication](./authentication.md) — app access, passwords, passkeys, and sessions.
- [REST and SSE server](./rest-and-sse-server.md) — the HTTP API that `mouaif serve` exposes.
