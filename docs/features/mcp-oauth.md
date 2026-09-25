# MCP OAuth sign-in

## Overview

Remote MCP servers (Streamable HTTP or legacy SSE) can use OAuth instead of a manually entered bearer token. Two grants are supported: browser sign-in with PKCE (authorization code), and client credentials for machine-to-machine servers. Mouaif discovers the authorization server with the installed MCP SDK, stores tokens and client secrets in the OS keychain, refreshes access tokens, and revokes them at the server when you disconnect.

## Usage

### Browser sign-in (authorization code + PKCE)

1. Open **Settings → MCP servers**, then add or edit an **HTTP** or **SSE (legacy)** server.
2. Set **Authentication → OAuth** and **Grant → Sign in with browser**.
3. Choose the client:
   - Leave **Client ID** empty for automatic dynamic client registration.
   - Enter a pre-registered **public client** ID if the server has no registration.
   - For a **confidential client**, enter its ID and **Client secret**. mouaif picks `client_secret_basic` or `client_secret_post` from the server's metadata.
4. Optionally enter space-separated OAuth scopes. Scopes the server advertises take priority.
5. **Save**, then reopen the server and tap **Sign in**.
6. Tap **Open sign-in page**, approve access, and return to mouaif. The editor picks up the result by itself. Tap **Start** in the server list to connect and discover tools.

The sign-in opens as a separate link, so it works in mobile browsers and PWAs without relying on a popup. A pending request expires after ten minutes. If it is declined or expires, start sign-in again.

For manual client registration, use the callback URL shown in the editor: your mouaif origin followed by `/oauth/mcp/callback`. Remote access must use HTTPS, including a configured `publicOrigin` behind a reverse proxy. Plain HTTP works only on loopback (`localhost`, `127.0.0.1`, or `::1`).

### Client credentials (no browser)

1. Set **Authentication → OAuth** and **Grant → Client credentials**.
2. Enter the **Client ID** and **Client secret**, and scopes if the server needs them.
3. **Save**, reopen the server, and tap **Connect**. mouaif requests a token straight from the token endpoint.

When the token expires or the server returns `401`, mouaif requests a new one automatically.

### Client secret

- The secret is write-only. The editor shows only that a secret is stored, and the API returns `secretConfigured: true|false`.
- Leave the field blank to keep the stored secret. Type a new one to replace it, or tap **Remove stored secret**.
- The secret lives in the OS keychain, never in `.mcp.json` or the app store. Disconnect keeps it; turning OAuth off or deleting the server removes it.

### Disconnect and revocation

**Disconnect** first asks the authorization server to revoke the tokens (RFC 7009): the refresh token, then the access token, authenticated as the client. It then removes the local tokens and registration, cancels any pending sign-in, and stops that server's OAuth sessions. The editor shows the result:

- **revoked** — the server accepted the revocation.
- **unsupported** — the server does not advertise a `revocation_endpoint`. Revoke access at the provider if needed.
- **failed** — revocation failed or timed out after 10 s. Local credentials are removed anyway.

`DELETE /api/mcp/servers/:id/oauth?revoke=0` skips the remote call.

## Behavior

- App-wide server credentials are shared across projects; project-scoped servers keep their own.
- Changing the endpoint, client ID, scopes, grant, or authentication mode invalidates the previous tokens and requires signing in again. Changing the client secret stops running sessions.
- Manual HTTP headers still work, but OAuth takes precedence over any `Authorization` header. Other custom headers are sent only to the MCP endpoint (and, for SSE, to its same-origin message endpoint), never to OAuth discovery, registration, token, or revocation endpoints.
- OAuth, token, and revocation requests never follow redirects, require HTTPS except on loopback, and time out after 30 s.

## API

```text
GET    /api/mcp/servers/:id/oauth?projectDir=…   -> { connected, pending, redirectUrl, grant, secretConfigured, revocationSupported }
POST   /api/mcp/servers/:id/oauth/start          -> { authorizationUrl, redirectUrl, expiresAt } | { connected: true, grant: 'client_credentials' }
DELETE /api/mcp/servers/:id/oauth?projectDir=…[&revoke=0] -> { ok, revoked: 'revoked'|'unsupported'|'failed'|'none'|'skipped' }
```

Server entries accept `oauth: { enabled, clientId, scope, grant?, clientSecret?, clearClientSecret? }`. `grant` is `client_credentials` or omitted for authorization code. `clientSecret` and `clearClientSecret` are write-only.
