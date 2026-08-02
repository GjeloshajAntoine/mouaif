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

Open the link, scan the QR code on another device, or open `/web/#/setup` and enter the short code. Setup invitations expire after 15 minutes and are consumed after use. The setup form creates or replaces the user and password, then offers passkey enrollment.

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

## Implementation notes

### Storage and password hashing

Access records live in the app SQLite database at `~/.mouaif/store.sqlite` (or `$MOUAIF_HOME/store.sqlite`):

- `access_users` stores the username and a randomly salted `scrypt` password hash;
- `access_sessions` stores SHA-256 hashes of random session tokens, never the tokens themselves;
- `access_setup_codes` stores SHA-256 hashes of expiring one-time codes;
- `access_passkeys` stores WebAuthn credential IDs, public keys, algorithms, and signature counters.

There is one local user. Sessions expire after 30 days and use an HttpOnly, SameSite cookie. Password changes revoke every prior session and remove the previous user's passkeys — the session that performed the change is re-issued so the current browser stays signed in. Browser password and passkey sign-in attempts are limited to ten failures per remote address per minute.

### WebAuthn

The server implements WebAuthn registration and assertion verification with Node's built-in `crypto` module. It supports ES256 and RS256 credentials, verifies the challenge, origin, relying-party ID hash, user-presence flag, signature, and monotonic authenticator counter.

The WebAuthn relying-party ID is the served origin's hostname. Configure `--public-origin` when a reverse proxy changes the browser-visible origin.

### HTTP endpoints

The public enrollment and sign-in surface is:

```text
GET    /api/access/status
POST   /api/access/login
POST   /api/access/logout
POST   /api/access/password
POST   /api/access/setup/verify
POST   /api/access/setup
GET    /api/access/setup/qr?code=<short-code>
POST   /api/access/passkeys/register/options
POST   /api/access/passkeys/register/verify
POST   /api/access/passkeys/login/options
POST   /api/access/passkeys/login/verify
GET    /api/access/passkeys
DELETE /api/access/passkeys/<credential-id>
```

All browser requests remain subject to mouaif's same-origin and CSRF-session checks. When the process starts with authentication enabled, app APIs, SSE, push endpoints, and the Inspector WebSocket require an authenticated access session. When authentication is disabled, the UI and APIs remain open while retaining the same-origin browser boundary. Static `/web/` assets remain public so the Preact shell can render login and setup screens.
