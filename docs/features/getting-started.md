# Getting started

## Overview

Install mouaif, start the app, and open its web interface. Node.js 18 or newer is required.

## Install from this repository

```bash
git clone <repo-url>
cd mouaif
npm install
npm link
```

`npm install` builds the web UI once through the package `prepare` script when the Vite toolchain is present, so a fresh clone works even if `frontend/dist/` is missing from the checkout. `npm link` makes the `mouaif` command available in your terminal.

See [CLI commands](./cli-commands.md) for the complete command list and every `mouaif serve` option.

## Run the app

Start mouaif on the default local address:

```bash
mouaif serve
```

Open `http://127.0.0.1:5732/` in a browser. Keep the terminal open while using the app, and press `Ctrl+C` when you want to stop it.

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
2. Tap **Add project** and choose a folder.
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