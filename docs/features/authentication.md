# Authentication

## Overview

Connect AI providers so mouaif can use their models, and optionally require a login to open mouaif. These are two independent setups; you can do either one without the other:

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

### Where credentials are kept

- **API keys** are saved in the app's own settings store on the computer that runs mouaif (`~/.mouaif/store.sqlite`), never in a project folder. The web UI only learns whether a key is set; it never receives the key itself.
- **Browser sign-in tokens** are saved in the operating system's keychain.
- Credentials never leave that computer except in requests to the provider they belong to.
- You can sign in with more than one account for the same provider and pick the account in the provider form.
- **Delete** in the provider form removes a connection. Models in your projects that use it stop working until you add it again.

See [OpenRouter](./openrouter.md) and [Anthropic sign-in](./oauth-anthropic.md) for those browser sign-in flows.

## App access — control who can open mouaif

App access is off by default: anyone who can reach the server can open it. Turn it on when you start mouaif, and after that people must log in with a username and password (or a passkey). This is separate from provider credentials above.

App access is on for a run when you pass `--auth`, `--auth-setup`, or `--user`. Without one of them the server does not ask for a login, even if you set up a user before; the stored user is kept for the next time you turn access on.

The npm package is named [`mouaif`](https://www.npmjs.com/package/mouaif), and it exposes the command with the same name. The examples below use `npx mouaif`, so they work without a global install. If you installed the package with `npm install -g mouaif`, you can replace `npx mouaif` with `mouaif`.

### Create access from the setup page

```bash
npx mouaif serve --auth-setup
```

The terminal prints a setup link, a QR code, and an eight-character short code. Open the link, scan the QR code with another device, or open `/#/setup` and type the short code. The invitation expires after 15 minutes and works once. Use it to create the app username and password, then optionally add a passkey.

On the first start with `--auth`, when no user exists yet, the same invitation is printed automatically.

For a URL that another device can open:

```bash
npx mouaif serve \
  --host 0.0.0.0 \
  --public-origin https://mouaif.example.com \
  --auth-setup
```

A `127.0.0.1` address only works on the computer that runs mouaif. Use HTTPS when exposing mouaif to other devices.

### Set the username and password from the CLI

Prefer an environment variable so the password is not saved in shell history:

```bash
MOUAIF_PASSWORD='a-long-password' \
  npx mouaif serve --auth --user alice
```

PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
npx mouaif serve --auth --user alice
```

A direct CLI argument is also supported, but may remain in shell history:

```bash
npx mouaif serve --auth --user alice --password 'a-long-password'
```

The password must contain at least eight characters. `--user` and the password must be given together.

Giving a new username or password replaces the access user, signs out every browser, and removes existing passkeys. Starting again with the same username and password changes nothing, so you can keep them in a start script.

### Reuse existing access settings

After initial setup, require login on future starts with:

```bash
npx mouaif serve --auth
```

To create a fresh setup invitation or replace the access user later:

```bash
npx mouaif serve --auth-setup
```

### Passkeys

After setting a password, choose **Add a passkey** to sign in with your device's fingerprint, face, or PIN instead. Passkeys need a secure address: HTTPS for other devices, while `localhost` works on the computer that runs mouaif. On a plain `http://` network address, the app says so and only password sign-in is offered.

Password sign-in keeps working after you add a passkey, and removing a passkey does not change the password.

## Manage access in the app

Open **Settings → Access & passkeys** to:

- change the password;
- add or remove passkeys;
- review and revoke signed-in sessions.

Changing the password signs out every other browser and removes existing passkeys; the device you changed it from stays signed in. The username stays the same.

To be alerted when a new browser signs in, see [Login notification](./login-notification.md).

## Authenticate command-line requests

When app access is enabled, command-line requests such as `curl` must send HTTP Basic authentication with the app username and password you created during setup:

```bash
curl --user 'alice:a-long-password' http://127.0.0.1:5732/api/settings
```

Browsers sign in once and reuse a session cookie automatically.

## Next steps

- [Getting started](./getting-started.md) — install and start mouaif.
- [App abilities](./app-abilities.md) — configure tools and use the app.
