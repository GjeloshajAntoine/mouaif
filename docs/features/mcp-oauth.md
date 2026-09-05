# MCP OAuth sign-in

## Overview

HTTP MCP servers can use authorization-code OAuth with PKCE instead of a manually entered bearer token. Mouaif discovers the authorization server using the installed MCP SDK, stores credentials in the OS keychain, and refreshes access tokens when the server requests authorization again.

## Usage

1. Open **Settings → MCP servers**, then add or edit an **HTTP** server.
2. Set **Authentication → OAuth sign-in (PKCE)**.
3. Leave **Client ID** empty for automatic dynamic client registration. If the authorization server does not support registration, enter a pre-registered **public client** ID. Confidential clients requiring a client secret are not supported.
4. Optionally enter space-separated OAuth scopes. These are a fallback when the server does not advertise required scopes; the SDK gives server-advertised scopes priority.
5. **Save**, then reopen the server and tap **Sign in**.
6. Tap **Open sign-in page**, approve access, then return to mouaif. The editor checks sign-in status automatically, including after returning from another browser tab. Tap **Start** in the server list to connect and discover tools.

The separate sign-in link works with mobile browsers and PWAs without depending on an automatically opened popup. Pending requests expire after ten minutes. If the request is declined or expires, start sign-in again.

For manual client registration, use the callback URL shown in the editor: your mouaif origin followed by `/oauth/mcp/callback`. Remote access must use HTTPS, including the configured `publicOrigin` when behind a reverse proxy. Plain HTTP is allowed only on loopback (`localhost`, `127.0.0.1`, or `::1`). An HTTP LAN origin needs HTTPS before OAuth can be used.

**Disconnect** removes the local client registration and tokens, cancels pending sign-in, and stops that server's OAuth sessions. It does not revoke the grant remotely; revoke access at the provider if required. App-wide server credentials are shared across projects; project-scoped servers have independent credentials. Changing the endpoint, client ID, scopes, or authentication mode invalidates the previous credentials and requires signing in again.

Manual HTTP headers remain available, but OAuth takes precedence over any `Authorization` header. Other custom headers are sent only to the MCP endpoint, not to OAuth discovery, registration, or token endpoints.

## Implementation notes

- `src/oauth-mcp.js` implements the SDK OAuth provider, guarded HTTP requests, pending state, and keychain adapter. No additional dependency is required.
- The OS keychain service is `mouaif/mcp-oauth`. Identity includes the canonical project path (or app scope), server ID, endpoint, and OAuth settings. Tokens, refresh tokens, and dynamic client credentials never enter `.mcp.json`, app settings, or REST responses. A working OS keychain is required; there is no plaintext fallback.
- The configuration contains only `oauth: { enabled: true, clientId: "", scope: "" }` for HTTP servers. Omit it or send `null` to use manual headers again.
- The SDK handles protected-resource discovery (including `WWW-Authenticate` metadata URLs and scopes), authorization-server metadata, dynamic registration, PKCE S256, token exchange, and refresh. Pre-registered public clients are also supported. MCP OAuth is independent of AI-provider account sign-in.
- The callback accepts a single-use, cryptographically random state tied to the exact server configuration and PKCE verifier. Expired, cancelled, replayed, or configuration-mismatched requests are rejected. In-flight credential writes cannot undo a disconnect.
- Callback pages are public so a mobile browser can return without app cookies; the start/status/disconnect APIs still pass the app access and browser-origin gates. Callback pages and OAuth API responses are not cached. Provider error bodies and codes are never reflected in callback HTML.
- OAuth endpoint requests require HTTPS except on loopback, reject credential-bearing URLs and redirects, and have a 30-second request timeout. Servers that depend on redirecting their OAuth endpoints must publish their final URLs.
- Legacy SSE transport, client-credentials grants, confidential-client secrets, and remote token revocation are not implemented.

### REST endpoints

| Method | Path | Request / response |
|---|---|---|
| `POST` | `/api/mcp/servers/:id/oauth/start` | `{ projectDir? }` → `{ authorizationUrl, redirectUrl, expiresAt }`; uses the saved server configuration |
| `GET` | `/api/mcp/servers/:id/oauth?projectDir=…` | `{ connected, pending, redirectUrl }`; no credential values |
| `DELETE` | `/api/mcp/servers/:id/oauth?projectDir=…` | `{ ok: true }`; disconnect and cancel pending sign-in |
| `GET` | `/oauth/mcp/callback?state=…&code=…` | Public, state/PKCE-protected callback; HTML completion page |

Failures use `EBADINPUT` (400), `EMCP_AUTH` (409), or `EKEYRING` (503); unknown servers return 404. The callback returns 400 for an invalid, expired, declined, or failed exchange.

### Verification

```bash
node scripts/test-mcp-arguments.mjs
node scripts/test-mcp-oauth.js
node scripts/test-mcp-http-transport.js
```

The OAuth integration test runs a local authorization server and real MCP HTTP transport, replacing only the keychain adapter with an in-memory test vault. No third-party account or real credential is required.
