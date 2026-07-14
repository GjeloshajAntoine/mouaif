// mouaif web — SettingsAboutView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, resetAppKeys, setStatus } from '../api.js';

export function SettingsAboutView() {
  const homeEl = useRef(null);
  const defaultsEl = useRef(null);
  const resetBtn = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (homeEl.current && app.home) homeEl.current.textContent = app.home;
      if (defaultsEl.current && app.defaults) {
        defaultsEl.current.textContent = JSON.stringify(app.defaults, null, 2);
      }
    } catch { /* leave blank */ }
  }

  async function reset() {
    if (!confirm('Reset ALL app-level settings to defaults? Every provider, model, account, and project you registered at the app level will be cleared. Project files on disk are not touched.')) return;
    if (resetBtn.current) resetBtn.current.disabled = true;
    setStatus(statusEl, 'resetting…', 'busy');
    try {
      await resetAppKeys(['providers', 'models', 'authAccounts', 'projects', 'promptSize', 'flags']);
      setStatus(statusEl, 'reset.', 'success');
      await load();
    } catch (e) { setStatus(statusEl, 'reset failed: ' + e.message, 'error'); }
    if (resetBtn.current) resetBtn.current.disabled = false;
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
      h('pre', { ref: homeEl, class: 'settings__out' }, '—'),
      h('h3', null, 'Default values'),
      h('p', { class: 'hint hint--compact' }, 'The merge floor for every project. Anything not set in app or project falls back to these.'),
      h('pre', { ref: defaultsEl, class: 'settings__out' }, '—'),
      h('h3', null, 'Destructive actions'),
      h('p', { class: 'hint hint--compact' }, 'Reset all app-level keys. Project files on disk are not touched.'),
      h('div', { class: 'row row--actions' },
        h('button', { ref: resetBtn, class: 'btn btn--danger', type: 'button', onClick: reset }, 'Reset all app settings'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}