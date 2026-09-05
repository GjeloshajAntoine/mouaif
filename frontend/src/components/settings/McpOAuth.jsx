import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';

export function McpOAuth({ id, projectDir, saved, value, onChange }) {
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const base = id ? '/api/mcp/servers/' + encodeURIComponent(id) + '/oauth' : '';
  const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
  const canSignIn = !!(id && saved?.oauth?.enabled && saved.url === value.url
    && (saved.oauth.clientId || '') === value.clientId.trim()
    && (saved.oauth.scope || '') === value.scope.trim());

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
          if (r.body.connected) { setAuthorizationUrl(''); setMessage('Signed in. You can start the server from the MCP list.'); }
          else if (!r.body.pending) setAuthorizationUrl('');
        } else setMessage(r.body?.error || 'Could not read sign-in status.');
      } catch { if (!cancelled) setMessage('Could not reach mouaif.'); }
    }
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [base, qs, canSignIn, value.enabled]);

  async function signIn() {
    setBusy(true);
    setMessage('Preparing sign-in…');
    setAuthorizationUrl('');
    try {
      const r = await fetchJson(base + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir })
      });
      if (r.status !== 200) throw new Error(r.body?.error || 'Could not start sign-in.');
      setAuthorizationUrl(r.body.authorizationUrl);
      setStatus({ connected: false, pending: true, redirectUrl: r.body.redirectUrl });
      setMessage('Open the sign-in page below, then return here. The link expires after 10 minutes.');
    } catch (e) { setMessage(e.message || 'Could not reach mouaif.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!confirm('Disconnect OAuth for this server? App-wide sign-in is shared with all projects.')) return;
    setBusy(true);
    try {
      const r = await fetchJson(base + qs, { method: 'DELETE' });
      if (r.status !== 200) throw new Error(r.body?.error || 'Could not disconnect.');
      setStatus({ connected: false, pending: false });
      setAuthorizationUrl('');
      setMessage('Disconnected. Local OAuth credentials were removed.');
    } catch (e) { setMessage(e.message || 'Could not reach mouaif.'); }
    finally { setBusy(false); }
  }

  return h('div', { class: 'row' },
    h('label', { class: 'label', for: 'mcp-oauth' }, 'Authentication'),
    h('select', { class: 'input', id: 'mcp-oauth', value: value.enabled ? 'oauth' : 'headers', onChange: (e) => onChange({ ...value, enabled: e.target.value === 'oauth' }) },
      h('option', { value: 'headers' }, 'None / manual headers'),
      h('option', { value: 'oauth' }, 'OAuth sign-in (PKCE)')
    ),
    value.enabled ? h('div', { class: 'row' },
      h('label', { class: 'label', for: 'mcp-oauth-client' }, 'Client ID (optional)'),
      h('input', { class: 'input', id: 'mcp-oauth-client', value: value.clientId, placeholder: 'Automatic client registration', onInput: (e) => onChange({ ...value, clientId: e.target.value }) }),
      h('label', { class: 'label', for: 'mcp-oauth-scope' }, 'OAuth scopes (optional)'),
      h('input', { class: 'input', id: 'mcp-oauth-scope', value: value.scope, placeholder: 'Server-discovered scopes', onInput: (e) => onChange({ ...value, scope: e.target.value }) }),
      h('p', { class: 'hint hint--compact' }, 'Uses authorization-code OAuth with PKCE. Tokens stay in the OS keychain, not project files. OAuth replaces any manual Authorization header. Servers without automatic client registration need a pre-registered public client ID.'),
      h('p', { class: 'hint hint--compact', style: 'overflow-wrap:anywhere' }, 'Register this callback URL if needed: ', status?.redirectUrl || (window.location.origin + '/oauth/mcp/callback')),
      !canSignIn ? h('p', { class: 'hint' }, 'Save the HTTP URL and OAuth settings, then reopen this server to sign in.') : h('div', { class: 'row' },
        h('span', { class: 'hint' }, status?.connected ? 'Signed in' : status?.pending ? 'Waiting for sign-in' : 'Not signed in'),
        h('button', { class: 'btn', type: 'button', disabled: busy, onClick: signIn }, status?.connected ? 'Sign in again' : 'Sign in'),
        authorizationUrl ? h('a', { class: 'btn btn--primary', href: authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open sign-in page') : null,
        (status?.connected || status?.pending) ? h('button', { class: 'btn', type: 'button', disabled: busy, onClick: signOut }, status.pending ? 'Cancel sign-in' : 'Disconnect') : null
      ),
      h('span', { class: 'status', role: 'status', 'aria-live': 'polite' }, message)
    ) : null
  );
}
