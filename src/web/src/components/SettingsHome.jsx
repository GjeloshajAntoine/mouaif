// mouaif web — Settings home view
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, appProviders, activeProject } from '../api.js';

export function SettingsHomeView() {
  const providerSummary = useRef(null);
  const promptSize = useRef(null);
  const pricingSummary = useRef(null);
  // Rows that only make sense against a project. Their href picks up the
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
  // Group titles stay short to match the iOS-style inset lists. The rows
  // use the standard .group__row pattern from layout.css (same as every
  // other drill-in settings list).
  function rowLi(to, label, opts = {}) {
    const { detailRef = null, detail = null, sub = null } = opts;
    return h('li', null,
      h('a', { href: '#/' + to, class: 'group__row', 'aria-label': label },
        h('span', { class: 'group__row-label' }, label),
        sub && !detailRef && !detail
          ? h('span', { class: 'group__row-detail' }, sub)
          : h('span', { ref: detailRef, class: 'group__row-detail' }, detail || sub || ''),
        h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  return h('section', { class: 'settings-home' },
    // ---- Providers: account-level connections, not layered. -------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Providers'),
      h('ul', { class: 'group__list' },
        rowLi('settings/providers', 'Providers', { detailRef: providerSummary, detail: 'API keys & sign-ins' })
      )
    ),
    // ---- App defaults: settings that apply everywhere unless a project
    // changes them. Rows describe what the setting is, not the layering —
    // the one-line footer explains "a project can change these" once. ----
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'App defaults', h('span', { class: 'group__title-note' }, 'Apply to every project')),
      h('ul', { class: 'group__list' },
        rowLi('settings/defaults', 'Chat defaults', { detailRef: promptSize, detail: 'prompt style' }),
        rowLi('settings/access', 'Access & passkeys', { sub: 'password, WebAuthn & sign out' }),
        rowLi('settings/notifications', 'Notifications', { sub: 'questions, approvals & completion' }),
        rowLi('settings/mcp', 'MCP servers', { sub: 'servers & default permission' }),
        rowLi('settings/pricing', 'Model pricing', { detailRef: pricingSummary, detail: 'cost table' }),
        rowLi('settings/about', 'About & reset', { sub: 'storage · danger zone' })
      )
    ),
    // ---- This project: settings stored with the project. Header names the
    // project so the scope is concrete. Rows describe the setting; the
    // project page itself explains how each one relates to the app layer.
    h('div', { class: 'group' },
      h('div', { class: 'group__title' },
        'This project',
        h('span', { class: 'group__title-note' }, projectName || projectDir || 'none selected')
      ),
      projectDir
        ? h('ul', { class: 'group__list' },
            rowLi('settings/project' + projectQS, 'Project settings', { sub: 'prompt style, tools, agents' }),
            rowLi('settings/mcp' + projectQS, 'MCP servers', { sub: 'app servers + this project\'s own' }),
            rowLi('settings/prompts' + projectQS, 'Custom prompts', { sub: 'system prompts for this project' }),
            /* file tags setting entry removed */
          )
        : h('p', { class: 'hint hint--compact settings-home__empty' },
            'Open a chat or pick a project first, then this project\'s settings (prompt style, tools, MCP servers, custom prompts) show up here.')
    ),
    // ---- One-line footer: explains the layering once, plainly, instead of
    // repeating "overrides / wins / shadows" on every row above. ---------
    h('p', { class: 'hint hint--compact settings-home__resolution' },
      'App defaults apply everywhere. A project can change any of them for its own folder.')
  );
}
