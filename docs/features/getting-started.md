# Getting started

## Overview

Install mouaif, start the app, and open its web interface. Node.js 20 or newer is required.

## Install

The npm package name is [`mouaif`](https://www.npmjs.com/package/mouaif). Run it straight from the registry with `npx`, without installing it globally, and require a login:

```bash
npx mouaif serve --auth
```

On the first authenticated start, use the setup link, QR code, or short code printed in the terminal to create your username and password. Later starts reuse those access settings and show the login screen.

`npx` unpacks the package into its own cache (`~/.npm/_npx`) and launches the CLI from there, so it never writes to the directory you run it from. The first run downloads and unpacks the package, including the prebuilt native binaries (`better-sqlite3`, `@napi-rs/keyring`); this is quick on common platforms, but an unusual platform compiles those binaries and can take a few minutes. Later runs reuse the cache and start immediately.

To pin an exact version, quote the argument. A bare `mouaif@0.3.0` is read as a glob in `zsh` and fails with `no matches found`:

```bash
npx --yes --package "mouaif@0.3.0" mouaif info
```

Install the `mouaif` command globally:

```bash
npm install -g mouaif
```

Or install from a checkout of this repository:

```bash
git clone <repo-url>
cd mouaif
npm install
npm link
```

`npm install` builds the web UI once through the package `prepare` script when the Vite toolchain is present, so a fresh clone works even if `frontend/dist/` is missing from the checkout. `npm link` makes the `mouaif` command available in your terminal.

Every published tarball already contains the pre-built web UI in `frontend/dist/`, so `npm install -g mouaif` and `npx mouaif` never run a frontend build. The package depends on `better-sqlite3` and `@napi-rs/keyring`, which ship prebuilt binaries for common platforms; on an unusual platform Node compiles them during install, so the first install can take a few minutes.

See [CLI commands](./cli-commands.md) for the complete command list and every `mouaif serve` option.

## Run the app

Start mouaif on the default local address with access authentication enabled:

```bash
npx mouaif serve --auth
```

If you installed it globally, use `mouaif serve --auth` instead. Open `http://127.0.0.1:5732/` in a browser and create or enter your access credentials. Keep the terminal open while using the app, and press `Ctrl+C` when you want to stop it. Omit `--auth` only when you intentionally want the app to be accessible without a login.

Useful alternatives:

```bash
# Use another port
mouaif serve --port 9000

# Listen on your local network
mouaif serve --host 0.0.0.0

# Show the installed version and default port
mouaif info
```

When listening on your network, use the address printed by mouaif. Enable access authentication before making the app available to other devices.

## First setup

1. Open the **Chats** tab.
2. Tap the **+** (Add project) button and choose a folder.
3. Open **Settings → Providers** and connect an AI provider.
4. Open the project's settings and add or select a model.
5. Create a chat, select the model, and send a message.

Provider connections are shared by the app. Project settings control the models and abilities available in each project.

## Update a source installation

```bash
git pull
npm install
```

`npm install` rebuilds the web UI when the Vite toolchain is present, so there is no separate build step. Restart your manually started `mouaif serve` process after updating.

## Next steps

- [CLI commands](./cli-commands.md) — every command and `serve` option.
- [Authentication](./authentication.md) — connect AI providers and protect app access.
- [App abilities](./app-abilities.md) — learn what chats, tools, projects, and the Inspector can do.