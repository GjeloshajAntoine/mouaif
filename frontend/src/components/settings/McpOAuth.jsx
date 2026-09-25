import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';

// OAuth settings for a remote (HTTP or legacy SSE) MCP server.
//
// Two grants (docs/features/mcp-oauth.md):
//   * authorization_code — browser sign-in with PKCE. Public client (dynamic
//     registration or a pre-registered ID) or confidential client (ID + secret).
//   * client_credentials — machine-to-machine: ID + secret, no browser.
// The client secret is write-only: the API only says whether one is stored.
export function McpOAuth({ id, projectDir, saved, value, onChange }) {
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const base = id ? '/api/mcp/servers/' + encodeURIComponent(id) + '/oauth' : '';
  const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
  const grant = value.grant === 'client_credentials' ? 'client_credentials' : 'authorization_code';
  const isCC = grant === 'client_credentials';
  const secretStored = !!saved?.oauth?.secretConfigured && !value.clearClientSecret;
  const canSignIn = !!(id && saved?.oauth?.enabled && saved.url === value.url
    && (saved.oauth.clientId || '') === value.clientId.trim()
    && (saved.oauth.scope || '') === value.scope.trim()
    && (saved.oauth.grant || 'authorization_code') === grant
    && !value.clientSecret.trim() && !value.clearClientSecret
    && (!isCC || !!saved.oauth.secretConfigured));

  useEffect(() => {
    setStatus(null);
    setAuthorizationUrl('');
    setMessage('');
    if (!canSignIn || !value.enabled) return;
    let cancelled = false;
    async function refresh() {
      try {
        const r = await fetchJson(base + qs);
        if (cancelled) return;
        if (r.status === 200) {
          setStatus(r.body);
          if (r.body.connected) { setAuthorizationUrl(''); setMessage(isCC ? 'Connected. You can start the server from the MCP list.' : 'Signed in. You can start the server from the MCP list.'); }
          else if (!r.body.pending) setAuthorizationUrl('');
        } else setMessage(r.body?.error || 'Could not read sign-in status.');
      } catch { if (!cancelled) setMessage('Could not reach mouaif.'); }
    }
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [base, qs, canSignIn, value.enabled, isCC]);

  async function signIn() {
    setBusy(true);
    setMessage(isCC ? 'Requesting a token…' : 'Preparing sign-in…');
    setAuthorizationUrl('');
    try {
      const r = await fetchJson(base + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir })
      });
      if (r.status !== 200) throw new Error(r.body?.error || 'Could not start sign-in.');
      if (r.body.connected) {
        setStatus({ connected: true, pending: false, grant });
        setMessage('Connected. You can start the server from the MCP list.');
      } else {
        setAuthorizationUrl(r.body.authorizationUrl);
        setStatus({ connected: false, pending: true, redirectUrl: r.body.redirectUrl });
        setMessage('Open the sign-in page below, then return here. The link expires after 10 minutes.');
      }
    } catch (e) { setMessage(e.message || 'Could not reach mouaif.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!confirm('Disconnect OAuth for this server? mouaif asks the server to revoke the tokens, then removes them locally. App-wide sign-in is shared with all projects.')) return;
    setBusy(true);
    try {
      const r = await fetchJson(base + qs, { method: 'DELETE' });
      if (r.status !== 200) throw new Error(r.body?.error || 'Could not disconnect.');
      setStatus({ connected: false, pending: false });
      setAuthorizationUrl('');
      const revoked = r.body && r.body.revoked;
      setMessage(revoked === 'revoked' ? 'Disconnected. Tokens were revoked at the server and removed locally.'
        : revoked === 'unsupported' ? 'Disconnected locally. The server does not offer token revocation; revoke access at the provider if required.'
        : revoked === 'failed' ? 'Disconnected locally. Remote revocation failed; revoke access at the provider if required.'
        : 'Disconnected. Local OAuth credentials were removed.');
    } catch (e) { setMessage(e.message || 'Could not reach mouaif.'); }
    finally { setBusy(false); }
  }

  const set = (patch) => onChange({ ...value, ...patch });
  const secretHint = secretStored
    ? 'A secret is stored in the OS keychain. Leave blank to keep it.'
    : isCC ? 'Required for client credentials.' : 'Only for a confidential client. Leave blank for a public client.';

  return h('div', { class: 'row' },
    h('label', { class: 'label', for: 'mcp-oauth' }, 'Authentication'),
    h('select', { class: 'input', id: 'mcp-oauth', value: value.enabled ? 'oauth' : 'headers', onChange: (e) => set({ enabled: e.target.value === 'oauth' }) },
      h('option', { value: 'headers' }, 'None / manual headers'),
      h('option', { value: 'oauth' }, 'OAuth')
    ),
    value.enabled ? h('div', { class: 'row' },
      h('label', { class: 'label', for: 'mcp-oauth-grant' }, 'Grant'),
      h('select', { class: 'input', id: 'mcp-oauth-grant', value: grant, onChange: (e) => set({ grant: e.target.value }) },
        h('option', { value: 'authorization_code' }, 'Sign in with browser (authorization code + PKCE)'),
        h('option', { value: 'client_credentials' }, 'Client credentials (no browser)')
      ),
      h('label', { class: 'label', for: 'mcp-oauth-client' }, isCC ? 'Client ID' : 'Client ID (optional)'),
      h('input', { class: 'input', id: 'mcp-oauth-client', value: value.clientId, autocomplete: 'off', placeholder: isCC ? 'Required' : 'Automatic client registration', onInput: (e) => set({ clientId: e.target.value }) }),
      (isCC || value.clientId.trim()) ? h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-oauth-secret' }, isCC ? 'Client secret' : 'Client secret (optional)'),
        h('input', { class: 'input', id: 'mcp-oauth-secret', type: 'password', autocomplete: 'off', value: value.clientSecret,
          placeholder: secretStored ? '•••••••• (stored)' : 'paste secret', onInput: (e) => set({ clientSecret: e.target.value, clearClientSecret: false }) }),
        h('span', { class: 'hint hint--compact' }, secretHint),
        secretStored && !isCC ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => set({ clientSecret: '', clearClientSecret: true }) }, 'Remove stored secret') : null
      ) : null,
      h('label', { class: 'label', for: 'mcp-oauth-scope' }, 'OAuth scopes (optional)'),
      h('input', { class: 'input', id: 'mcp-oauth-scope', value: value.scope, placeholder: 'Server-discovered scopes', onInput: (e) => set({ scope: e.target.value }) }),
      h('p', { class: 'hint hint--compact' }, isCC
        ? 'mouaif requests a token directly from the authorization server with the client ID and secret, and gets a new one when it expires. Tokens and the secret stay in the OS keychain, not project files.'
        : 'Uses authorization-code OAuth with PKCE. Tokens stay in the OS keychain, not project files. OAuth replaces any manual Authorization header. Servers without automatic client registration need a pre-registered client ID (plus its secret for a confidential client).'),
      !isCC ? h('p', { class: 'hint hint--compact', style: 'overflow-wrap:anywhere' }, 'Register this callback URL if needed: ', status?.redirectUrl || (window.location.origin + '/oauth/mcp/callback')) : null,
      !canSignIn ? h('p', { class: 'hint' }, 'Save the URL and OAuth settings, then reopen this server to ' + (isCC ? 'connect.' : 'sign in.')) : h('div', { class: 'row' },
        h('span', { class: 'hint' }, status?.connected ? (isCC ? 'Connected' : 'Signed in') : status?.pending ? 'Waiting for sign-in' : (isCC ? 'Not connected' : 'Not signed in')),
        h('button', { class: 'btn', type: 'button', disabled: busy, onClick: signIn }, isCC ? (status?.connected ? 'Get a new token' : 'Connect') : (status?.connected ? 'Sign in again' : 'Sign in')),
        authorizationUrl ? h('a', { class: 'btn btn--primary', href: authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open sign-in page') : null,
        (status?.connected || status?.pending) ? h('button', { class: 'btn', type: 'button', disabled: busy, onClick: signOut }, status.pending ? 'Cancel sign-in' : 'Disconnect') : null
      ),
      h('span', { class: 'status', role: 'status', 'aria-live': 'polite' }, message)
    ) : null
  );
}
