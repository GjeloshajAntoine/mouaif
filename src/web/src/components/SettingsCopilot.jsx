// mouaif web — SettingsCopilotView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, saveApp, setStatus } from '../api.js';

export function SettingsCopilotView() {
  const clientId = useRef(null);
  const saveBtn = useRef(null);
  const resetBtn = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (clientId.current) {
        clientId.current.value = (app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) || '';
      }
    } catch { /* leave blank */ }
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const value = (clientId.current && clientId.current.value || '').trim();
    const body = value ? { githubCopilot: { clientId: value } } : { githubCopilot: { clientId: null } };
    try {
      await saveApp(body);
      setStatus(statusEl, value ? 'saved.' : 'cleared (using default).', 'success');
    } catch (e) { setStatus(statusEl, 'save failed: ' + e.message, 'error'); }
    if (saveBtn.current) saveBtn.current.disabled = false;
  }

  async function resetDefault() {
    if (resetBtn.current) resetBtn.current.disabled = true;
    setStatus(statusEl, 'resetting…', 'busy');
    try {
      await saveApp({ githubCopilot: { clientId: null } });
      if (clientId.current) clientId.current.value = '';
      setStatus(statusEl, 'using default.', 'success');
    } catch (e) { setStatus(statusEl, 'reset failed: ' + e.message, 'error'); }
    if (resetBtn.current) resetBtn.current.disabled = false;
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'GitHub Copilot OAuth app')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'GitHub does not allow third-party apps to use the public Copilot client_id with a custom loopback URL. To sign in, create a personal OAuth app at ', h('code', null, 'github.com/settings/developers'), ' (Settings → Developer settings → OAuth Apps → New OAuth App) with callback URL ', h('code', null, 'http://127.0.0.1:5732/oauth/callback?provider=github-copilot'), ', then paste the client_id below. The default is shipped for convenience but will not work without registering the callback.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-copilot-id' }, 'Client ID'),
        h('input', { ref: clientId, class: 'input', id: 'sp-copilot-id', type: 'text', placeholder: 'Iv1.xxxxxxxxxxxxxxxx' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
        h('button', { ref: resetBtn, class: 'btn', type: 'button', onClick: resetDefault }, 'Use default'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}