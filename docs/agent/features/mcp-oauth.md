# MCP OAuth sign-in — implementation notes

> Agent-facing reference for [`docs/features/mcp-oauth.md`](../../features/mcp-oauth.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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
