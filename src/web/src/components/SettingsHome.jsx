// mouaif web — Settings home view
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, loadAccounts, appProviders, setStatus } from '../api.js';

export function SettingsHomeView() {
  const providerCount = useRef(null);
  const projectCount = useRef(null);
  const accountsCount = useRef(null);
  const promptSize = useRef(null);
  const copilot = useRef(null);
  const promptsCount = useRef(null);

  async function load() {
    try {
      const [app, accounts] = await Promise.all([loadApp({ force: true }), loadAccounts({ force: true })]);
      if (providerCount.current) {
        const n = appProviders().length;
        providerCount.current.textContent = n + (n === 1 ? ' provider configured' : ' providers configured');
      }
      if (projectCount.current) {
        const projects = (app.app && Array.isArray(app.app.projects)) ? app.app.projects : [];
        const n = projects.length;
        projectCount.current.textContent = n + (n === 1 ? ' project' : ' projects');
      }
      if (accountsCount.current) {
        let n = 0;
        for (const k of Object.keys(accounts || {})) n += (accounts[k] || []).length;
        accountsCount.current.textContent = n ? (n + (n === 1 ? ' account signed in' : ' accounts signed in')) : 'no accounts signed in';
      }
      if (promptSize.current) {
        const size = (app.app && app.app.promptSize) || 'average';
        promptSize.current.textContent = 'default prompt size: ' + size;
      }
      if (copilot.current) {
        const c = (app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) || '';
        copilot.current.textContent = c ? 'custom client_id' : 'using default';
      }
      if (promptsCount.current) {
        promptsCount.current.textContent = 'per-project system prompts';
      }
    } catch (e) { /* leave blank */ }
  }

  useEffect(() => { load(); }, []);

  function card(to, title, summaryRef) {
    return h('a', { href: '#/' + to, class: 'card', 'aria-label': title },
      h('div', { class: 'card__main' },
        h('div', { class: 'card__title' }, title),
        h('div', { ref: summaryRef, class: 'card__summary' }, '—')
      ),
      h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
    );
  }

  return h('section', { class: 'settings-home' },
    h('h2', { class: 'settings-home__lead' }, 'Settings'),
    card('settings/providers', 'Provider connections', providerCount),
    card('settings/project', 'Project overrides', projectCount),
    h('h3', null, 'App defaults'),
    card('settings/defaults', 'App defaults', promptSize),
    card('settings/prompts', 'Custom prompts', promptsCount),
    card('settings/copilot', 'GitHub Copilot OAuth app', copilot),
    h('a', { href: '#/settings/about', class: 'card', 'aria-label': 'About' },
      h('div', { class: 'card__main' },
        h('div', { class: 'card__title' }, 'About & reset'),
        h('div', { class: 'card__summary' }, 'Storage location and destructive actions')
      ),
      h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
    )
  );
}