# Getting started

## Overview

Install mouaif, create your login, connect a provider, and send your first chat about a project — in about five minutes. mouaif runs as a small server on your computer, and you use it from a browser on that computer or on your phone.

## Before you start

You need:

- **Node.js 20 or newer.** Check with `node --version`. If it is missing or older, install it from [nodejs.org](https://nodejs.org/).
- **An AI provider.** Either an account and API key (OpenAI, Anthropic, Google Gemini, OpenRouter, Mistral, Groq, DeepSeek, Azure OpenAI), a GitHub Copilot or Anthropic account for browser sign-in, or a model running locally with Ollama, llama.cpp, or LM Studio (no key needed).
- **A project folder** under your home directory that you want to work on. It can be empty.

```bash
node --version   # must print v20 or higher
```

## Step 1 — Start mouaif

Pick one of the three ways to run it. If you are not sure, use the first.

- **Option A — `npx`:** try it without installing, always the latest release.
- **Option B — global install:** daily use with a short `mouaif` command.
- **From source:** only if you want to change mouaif itself.

### Option A — run with npx (no install)

```bash
npx mouaif serve --auth
```

The first run downloads the package, which can take a minute. `npx` keeps it in its own cache, so nothing is written to the folder you run it from.

### Option B — install the command globally

```bash
npm install -g mouaif
mouaif serve --auth
```

### Install from source

```bash
git clone https://github.com/GjeloshajAntoine/mouaif.git
cd mouaif
npm install
npm link
mouaif serve --auth
```

`npm install` also builds the web interface, and `npm link` puts the `mouaif` command on your `PATH`.

### What you should see

The terminal prints the address of the app and, the first time, a setup invitation:

```text
🚀 mouaif server running at http://127.0.0.1:5732
   Web:    /             — mobile UI
   ...

🔐 Set up app access (expires in 15 minutes)
   Link:   http://127.0.0.1:5732/#/setup?code=XXXX-XXXX
   Code:   XXXX-XXXX
   (QR code)
   Press Ctrl+C to stop
```

**Leave this terminal open** — closing it or pressing `Ctrl+C` stops mouaif.

`--auth` means a login is required to open the app. It is strongly recommended; leave it out only on a computer nobody else can reach. See [Authentication](./authentication.md) for every access option.

## Step 2 — Create your login

1. Open the **Link** printed in the terminal (or scan the QR code with your phone if the phone can reach this computer — see [Use mouaif from your phone](#use-mouaif-from-your-phone)).
2. Choose a username and a password of at least 8 characters.
3. Optionally add a passkey to sign in with your fingerprint, face, or device PIN.

The invitation works once and expires after 15 minutes. If it expired, stop the server and start it again with `--auth-setup` to get a new one.

From now on, opening `http://127.0.0.1:5732/` shows the login screen.

## Step 3 — Connect an AI provider

1. Open the **Settings** tab, then **Providers**.
2. Tap **+** (Add provider) and choose a provider.
3. Paste its API key, or tap **Sign in** for Anthropic, OpenRouter, or GitHub Copilot.
   - **Ollama**: no key; make sure Ollama is running.
   - **llama.cpp / LM Studio**: choose **OpenAI-compatible**, leave the key empty, and set the base URL (for example `http://127.0.0.1:8080/v1`). See [Local OpenAI-compatible servers](./local-openai-servers.md).
4. Tap **Add provider**.

Providers are shared by all your projects. Keys stay on the computer running mouaif; the browser never receives them.

## Step 4 — Add a project

1. Open the **Chats** tab.
2. Tap **+** (Add project).
3. Browse to your project folder and select it, or create a new folder.

The project appears as a card on the Chats tab. Adding a project never deletes or moves anything; removing it later leaves the folder on disk.

## Step 5 — Start your first chat

1. On the project card, tap **New chat**.
2. Tap the **model** button in the chat header. The picker lists the models of every provider you connected; tap ↻ if the list is empty.
3. Pick a model and send a message, for example *"Summarize what this project does."*

The assistant can only look at or change your files after you allow it. To let it read files or run commands, open the project's settings and set **File tools** or **Shell** to **Ask** (you approve each call) or **Allow**. See [App abilities](./app-abilities.md).

## Use mouaif from your phone

By default mouaif only listens on the computer that runs it. To open it from a phone on the same Wi-Fi network:

```bash
mouaif serve --auth --host 0.0.0.0
```

The terminal then prints an address such as `http://192.168.1.20:5732` — open that on the phone. If it does not load, allow port `5732` through the computer's firewall.

Keep `--auth` on whenever other devices can reach the app. Passkeys need HTTPS on a remote device; over plain `http://` on your network, sign in with the password. To reach mouaif from outside your network, put it behind an HTTPS reverse proxy and pass `--public-origin` — see [CLI commands](./cli-commands.md#behind-a-reverse-proxy).

## Everyday use

```bash
mouaif serve --auth            # start (login required)
mouaif serve --auth --port 9000 # start on another port
mouaif --version               # show the installed version
```

Stop mouaif with `Ctrl+C` in its terminal. Your projects, chats, and settings are kept and reappear on the next start.

The full list of commands and options is in [CLI commands](./cli-commands.md).

## Update

| Installed with | Update command |
|---|---|
| `npx` | Nothing to do — `npx mouaif` fetches the latest release. Use `npx mouaif@latest serve --auth` if an old copy is cached. |
| `npm install -g` | `npm install -g mouaif@latest` |
| Source checkout | `git pull && npm install` |

Restart `mouaif serve` after updating. Your data is not touched by an update.

## Where your data lives

| What | Where |
|---|---|
| App settings, provider keys, chats, login | `~/.mouaif/store.sqlite` (change with `MOUAIF_HOME`) |
| Browser sign-in tokens (Anthropic, OpenRouter, Copilot, MCP) | Your operating system's keychain |
| Project settings | `<project>/.mouaif.json` (can be moved into the app store per project) |
| Chat traces, when enabled | `<project>/.mouaif/traces/` |

## Uninstall

```bash
npm uninstall -g mouaif   # global install
npm unlink -g mouaif      # source checkout linked with npm link
```

This removes the command but keeps your data. To also delete every setting, key, and chat, remove the `~/.mouaif` folder. Project folders keep their `.mouaif.json`, which you can delete by hand.

## Troubleshooting

| Problem | Fix |
|---|---|
| `mouaif: command not found` | Use `npx mouaif …`, or install globally with `npm install -g mouaif`. After `npm link`, open a new terminal. |
| `EADDRINUSE` when starting | Another program uses port 5732 — often a mouaif that is already running. Stop it, or start with `--port 9000`. |
| Install fails while building `better-sqlite3` or `@napi-rs/keyring` | Your platform has no prebuilt binary. Install build tools (Python 3 and a C/C++ compiler; on Windows the "Desktop development with C++" workload) and retry. |
| `zsh: no matches found: mouaif@0.3.0` | Quote the version: `npx --yes --package "mouaif@0.3.0" mouaif serve --auth`. |
| The setup link expired | Restart with `mouaif serve --auth-setup` to print a new one. |
| Forgot the password | Restart with `mouaif serve --auth-setup`, or set a new one with `MOUAIF_PASSWORD='…' mouaif serve --auth --user <name>`. |
| The phone cannot open the app | Start with `--host 0.0.0.0`, use the network address printed in the terminal (not `127.0.0.1`), and check the firewall. |
| The model picker is empty | Check the provider in **Settings → Providers**, then tap ↻ in the picker. For Ollama or a local server, make sure it is running. |
| "Path must be under the user home" when adding a project | Move the project under your home folder, or start mouaif with `MOUAIF_ALLOW_ANY_ROOT=1`. |

## Next steps

- [CLI commands](./cli-commands.md) — every command, option, and environment variable.
- [Authentication](./authentication.md) — provider credentials, logins, passkeys, and sessions.
- [App abilities](./app-abilities.md) — projects, chats, coding tools, agents, MCP, and the Inspector.
