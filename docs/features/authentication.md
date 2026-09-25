# Authentication

App access decides who is allowed to open mouaif, and it is off by default: anyone who can reach the server can open it. Turn it on when you start the server, and people must then log in with a username and password, or a passkey.

This is separate from AI provider credentials — connecting a provider lets mouaif call that provider, it does not protect your app. See [AI providers](./providers.md).

## Usage

App access is on for a run when you pass `--auth`, `--auth-setup`, or `--user`. Without one of them the server does not ask for a login, even if you created a user before; the stored user is kept for the next time you turn access on.

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
- [AI providers](./providers.md) — connect the providers mouaif uses.
- [App abilities](./app-abilities.md) — configure tools and use the app.
