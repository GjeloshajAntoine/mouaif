// mouaif web — SettingsAboutView
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { loadApp, resetAppKeys } from '../api.js';

export function SettingsAboutView() {
  const [homePath, setHomePath] = useState('—');
  const [defaultsText, setDefaultsText] = useState('—');
  const [isResetting, setIsResetting] = useState(false);
  const [status, setStatusObj] = useState({ message: '', type: '' });

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (app.home) setHomePath(app.home);
      if (app.defaults) setDefaultsText(JSON.stringify(app.defaults, null, 2));
    } catch { /* leave blank */ }
  }

  async function reset() {
    if (!confirm('Reset ALL app-level settings to defaults? Every provider, model, account, and project you registered at the app level will be cleared. Project files on disk are not touched.')) return;
    setIsResetting(true);
    setStatusObj({ message: 'resetting…', type: 'busy' });
    try {
      await resetAppKeys(['providers', 'models', 'authAccounts', 'projects', 'promptSize', 'flags']);
      setStatusObj({ message: 'reset.', type: 'success' });
      await load();
    } catch (e) { setStatusObj({ message: 'reset failed: ' + e.message, type: 'error' }); }
    setIsResetting(false);
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'About')
    ),
    h('section', null,
      h('h3', null, 'Storage'),
      h('p', { class: 'hint hint--compact' }, 'App-level settings and the account index live in this SQLite database:'),
      h('pre', { class: 'settings__out' }, homePath),
      h('h3', null, 'Default values'),
      h('p', { class: 'hint hint--compact' }, 'The merge floor for every project. Anything not set in app or project falls back to these.'),
      h('pre', { class: 'settings__out' }, defaultsText),
      h('h3', null, 'Destructive actions'),
      h('p', { class: 'hint hint--compact' }, 'Reset all app-level keys. Project files on disk are not touched.'),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--danger', type: 'button', onClick: reset, disabled: isResetting }, 'Reset all app settings'),
        h('span', { class: `status${status.type ? ' status--' + status.type : ''}`, 'aria-live': 'polite' }, status.message)
      )
    )
  );
}