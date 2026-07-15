// mouaif web — Settings home view
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, loadAccounts, appProviders } from '../api.js';

export function SettingsHomeView() {
  const providerCount = useRef(null);
  const projectCount = useRef(null);
  const promptSize = useRef(null);
  const copilot = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (providerCount.current) {
        const n = appProviders().length;
        providerCount.current.textContent = n ? (n === 1 ? '1 provider' : n + ' providers') : 'none yet';
      }
      if (projectCount.current) {
        const projects = (app.app && Array.isArray(app.app.projects)) ? app.app.projects : [];
        const n = projects.length;
        projectCount.current.textContent = n ? (n === 1 ? '1 project' : n + ' projects') : 'none yet';
      }
      if (promptSize.current) {
        const size = (app.app && app.app.promptSize) || 'average';
        promptSize.current.textContent = size;
      }
      if (copilot.current) {
        const c = (app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) || '';
        copilot.current.textContent = c ? 'custom' : 'default';
      }
    } catch (e) { /* leave blank */ }
  }

  useEffect(() => { load(); }, []);

  // Two groups, no page-level "Settings" heading: the tab is the
  // page label. Group titles are kept short ("App") to match the
  // iOS-style inset lists and avoid all-caps noise. The card rows
  // are the <li> elements of each .group__list — no double-wrap.
  function cardLi(to, title, summaryRef, summary) {
    return h('li', null,
      h('a', { href: '#/' + to, class: 'card', 'aria-label': title },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, title),
          h('div', { ref: summaryRef, class: 'card__summary' }, summary || '—')
        ),
        h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
      )
    );
  }
  return h('section', { class: 'settings-home' },
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Connections'),
      h('ul', { class: 'group__list' },
        cardLi('settings/providers', 'Providers', providerCount),
        cardLi('settings/project', 'Project', projectCount)
      )
    ),
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'App'),
      h('ul', { class: 'group__list' },
        cardLi('settings/defaults', 'Defaults', promptSize, 'prompt size'),
        cardLi('settings/copilot', 'GitHub Copilot', copilot),
        h('li', null, h('a', { href: '#/settings/about', class: 'card', 'aria-label': 'About' },
          h('div', { class: 'card__main' },
            h('div', { class: 'card__title' }, 'About & reset')
          ),
          h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
        ))
      )
    )
  );
}
