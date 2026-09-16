# Authentication

## Overview

mouaif deals with two unrelated things that both get called "authentication." They are independent — you can set up either one without the other:

| | What it does | Who you prove yourself to | Where you set it up |
|---|---|---|---|
| **Provider credentials** | Let mouaif call an AI model on your behalf | The AI provider (OpenAI, Anthropic, …) | In the app: **Settings → Providers** |
| **App access** | Control who is allowed to open mouaif | mouaif itself, when you log in | On the command line, when you start the server |

The rest of this page covers each one in its own section.

## Provider credentials — let mouaif use models

To send messages to a model, mouaif needs a credential for that model's provider. This is a key (or browser sign-in) you give to the provider — it does **not** log you into mouaif.

1. Open **Settings → Providers**.
2. Choose a provider.
3. Enter the requested API key and base URL, or tap **Sign in** when the provider offers browser sign-in.
4. Save the provider, then run its model refresh or connection test to confirm it works.
5. Open a project's settings and add the model you want to use.

Available connections include OpenAI-compatible services, Anthropic, Google Gemini, Ollama, OpenRouter, GitHub Copilot, Azure OpenAI, Mistral, Groq, and DeepSeek. Ollama normally runs locally without an API key. Anthropic, OpenRouter, and GitHub Copilot offer browser sign-in in the provider form; the rest use an API key.

## App access — control who can open mouaif

App access is off by default: anyone who can reach the server can open it. Turn it on when you start mouaif, and after that people must log in with a username and password (or a passkey). This is separate from provider credentials above.

### Create access from the setup page

```bash
mouaif serve --auth-setup
```

The terminal prints a setup link, QR code, and short code. The invitation expires after 15 minutes. Open it to create the app username and password, then optionally add a passkey.

For a URL that another device can open:

```bash
mouaif serve \
  --host 0.0.0.0 \
  --public-origin https://mouaif.example.com \
  --auth-setup
```

Use HTTPS when exposing mouaif outside the computer that runs it. Passkeys require HTTPS on remote devices.

### Set the username and password from the CLI

Prefer an environment variable so the password is not saved in shell history:

```bash
MOUAIF_PASSWORD='a-long-password' \
  mouaif serve --auth --user alice
```

PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
mouaif serve --auth --user alice
```

A direct CLI argument is also supported, but may remain in shell history:

```bash
mouaif serve --auth --user alice --password 'a-long-password'
```

The password must contain at least eight characters.

### Reuse existing access settings

After initial setup, require login on future starts with:

```bash
mouaif serve --auth
```

To create a fresh setup invitation or replace the access user later:

```bash
mouaif serve --auth-setup
```

## Manage access in the app

Open **Settings → Access & passkeys** to:

- change the password;
- add or remove passkeys;
- review and revoke signed-in sessions.

Changing the password revokes other sessions and removes existing passkeys.

## Authenticate command-line requests

When app access is enabled, command-line requests such as `curl` must send HTTP Basic authentication with the app username and password you created during setup. Browsers sign in once and reuse a session cookie automatically.


## Next steps

- [Getting started](./getting-started.md) — install and start mouaif.
- [App abilities](./app-abilities.md) — configure tools and use the app.
