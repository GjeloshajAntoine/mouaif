# Access authentication

## Overview

mouaif can optionally protect its web UI and APIs with one local user, a password, and WebAuthn passkeys. Authentication is disabled unless an auth-related CLI option is supplied, preserving the local development workflow.

## Usage

### Set a user and password from the CLI

Enable authentication and print an expiring setup invitation:

```bash
mouaif serve --auth
```

Without `--auth`, `--auth-setup`, or `--user`, the server does not require a login. Existing stored credentials are left intact but are not enforced for that process.

Pass both values when starting the server:

```bash
mouaif serve --auth --user alice --password 'a-long-password'
```

To keep the password out of shell history, use the environment variable instead:

```bash
MOUAIF_PASSWORD='a-long-password' mouaif serve --user alice
```

On PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
mouaif serve --auth --user alice
```

The password must contain at least eight characters. Supplying changed CLI credentials updates the single access user, invalidates existing login sessions, and removes passkeys tied to the replaced account. Repeating the same credentials on a restart is a no-op.

### Use the setup UI

When authentication is enabled and access has not been configured, startup prints:

- an expiring setup link;
- a scannable terminal QR code containing that link;
- an eight-character short code.

Use `--auth-setup` to enable authentication and print a new setup invitation even when access is already configured:

```bash
mouaif serve --host 0.0.0.0 --public-origin https://mouaif.example.test --auth-setup
```

Open the link, scan the QR code on another device, or open `/#/setup` and enter the short code. Setup invitations expire after 15 minutes and are consumed after use. The setup form creates or replaces the user and password, then offers passkey enrollment.

For another device to use the printed URL, the served origin must be reachable from that device. Prefer `--public-origin` behind HTTPS. A loopback origin such as `127.0.0.1` is only reachable on the machine running mouaif.

### Sign in with a passkey

After password setup, choose **Add a passkey**. WebAuthn requires a secure context: HTTPS is required for remote origins, while browsers permit `localhost` as a development exception. On an insecure LAN URL, the UI reports this requirement instead of presenting the failure as missing browser support, and the CLI warns that only password setup is available.

Existing users can manage passkeys under **Settings → Access & passkeys**. Password login remains available. Removing a passkey does not change the password.

### Change the password in the UI

**Settings → Access & passkeys** includes a **Change password** form. Enter the current password and the new one (at least eight characters). Changing the password is treated like a reset: every other browser session is revoked and all passkeys are removed; the current device stays signed in. The username is unchanged.

Alternatively, the CLI setup flow (`--auth-setup`) or a one-time setup link can replace the user and password from outside the UI.

### Authenticate CLI API requests

Browser clients use an HttpOnly session cookie. Non-browser REST clients can use HTTP Basic authentication:

```bash
curl --user 'alice:a-long-password' http://127.0.0.1:5732/api/settings
```
