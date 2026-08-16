# Access authentication — implementation notes

> Agent-facing reference for [`docs/features/access-authentication.md`](../../features/access-authentication.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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

All browser requests remain subject to mouaif's same-origin and CSRF-session checks. When the process starts with authentication enabled, app APIs, SSE, push endpoints, and the Inspector WebSocket require an authenticated access session. When authentication is disabled, the UI and APIs remain open while retaining the same-origin browser boundary. Static `/` assets remain public so the Preact shell can render login and setup screens.
