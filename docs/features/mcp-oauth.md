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
