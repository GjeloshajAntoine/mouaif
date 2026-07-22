// mouaif web — Settings home view
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, appProviders, activeProject } from '../api.js';

export function SettingsHomeView() {
  const providerSummary = useRef(null);
  const promptSize = useRef(null);
  const pricingSummary = useRef(null);
  // Cards that only make sense against a project. Their href picks up the
  // active project (if any) so the user does not have to re-enter the path.
  const projectDir = (activeProject.value && activeProject.value.dir) || '';
  const projectName = (activeProject.value && activeProject.value.name) || '';
  const projectQS = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (providerSummary.current) {
        const n = appProviders().length;
        providerSummary.current.textContent = n ? (n === 1 ? '1 connected' : n + ' connected') : 'none yet — tap to add';
      }
      if (promptSize.current) {
        promptSize.current.textContent = (app.app && app.app.promptSize) || 'average';
      }
      if (pricingSummary.current) {
        const table = (app.app && app.app.modelPricing) || {};
        const n = Object.keys(table).length;
        pricingSummary.current.textContent = n ? (n === 1 ? '1 model priced' : n + ' models priced') : 'defaults';
      }
    } catch (e) { /* summaries fall back to their static defaults */ }
  }

  useEffect(() => { load(); }, []);

  // No page-level "Settings" heading — the tab bar already labels the page.
  // Group titles stay short to match the iOS-style inset lists. The card
  // rows are the <li> elements of each .group__list (no double wrap). A
  // `summary` is the static fallback shown before load() resolves, so the
  // list never flashes a bare "—".
  function cardLi(to, title, opts = {}) {
    const { summaryRef = null, summary = null, sub = null } = opts;
    return h('li', null,
      h('a', { href: '#/' + to, class: 'card', 'aria-label': title },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, title),
          sub && !summaryRef && !summary
            ? h('div', { class: 'card__summary' }, sub)
            : h('div', { ref: summaryRef, class: 'card__summary' }, summary || sub || '')
        ),
        h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  return h('section', { class: 'settings-home' },
    // ---- Models & providers: everything you connect to. -----------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Models & providers'),
      h('ul', { class: 'group__list' },
        cardLi('settings/providers', 'Providers', { summaryRef: providerSummary, summary: 'API keys & sign-ins' })
      )
    ),
    // ---- Active project: per-project settings. Header shows which project
    // these cards apply to so "project overrides" is not abstract. --------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' },
        'Active project',
        h('span', { class: 'group__title-note' }, projectName || projectDir || 'none selected')
      ),
      projectDir
        ? h('ul', { class: 'group__list' },
            cardLi('settings/project' + projectQS, 'Project overrides', { sub: '.mouaif.json for this project' }),
            cardLi('settings/mcp' + projectQS, 'MCP servers', { sub: 'this project (+ app-wide in effect)' }),
            cardLi('settings/prompts' + projectQS, 'Custom prompts', { sub: 'system prompts for this project' }),
            cardLi('settings/project' + projectQS, 'Agents', { sub: 'project personas — in Project overrides' })
          )
        : h('p', { class: 'hint hint--compact settings-home__empty' },
            'Open a chat or pick a project first, then per-project settings (overrides, MCP servers, custom prompts) show up here.')
    ),
    // ---- Application: global, not tied to a project. --------------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Application'),
      h('ul', { class: 'group__list' },
        cardLi('settings/mcp', 'MCP servers', { sub: 'app-wide, every project' }),
        cardLi('settings/defaults', 'Chat defaults', { summaryRef: promptSize, summary: 'prompt style (tool verbosity)' }),
        cardLi('settings/pricing', 'Model pricing', { summaryRef: pricingSummary, summary: 'cost per 1K tokens' }),
        cardLi('settings/about', 'About & reset', { sub: 'storage · danger zone' })
      )
    )
  );
}
