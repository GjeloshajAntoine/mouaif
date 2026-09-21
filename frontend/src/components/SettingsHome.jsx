// mouaif web — Settings home view
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { loadApp, appProviders, activeProject } from '../api.js';

export function SettingsHomeView() {
  const [providerSummary, setProviderSummary] = useState('API keys & sign-ins');
  const [promptSize, setPromptSize] = useState('prompt style');

  // Rows that only make sense against a project. Their href picks up the
  // active project (if any) so the user does not have to re-enter the path.
  const projectDir = (activeProject.value && activeProject.value.dir) || '';
  const projectName = (activeProject.value && activeProject.value.name) || '';
  const projectQS = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';

  async function load() {
    try {
      const app = await loadApp({ force: true });
      const nProviders = appProviders().length;
      setProviderSummary(nProviders ? (nProviders === 1 ? '1 connected' : nProviders + ' connected') : 'none yet — tap to add');
      
      setPromptSize((app.app && app.app.promptSize) || 'average');
    } catch (e) { /* summaries fall back to their static defaults */ }
  }

  useEffect(() => { load(); }, []);

  // No page-level "Settings" heading — the tab bar already labels the page.
  // Group titles stay short to match the iOS-style inset lists. The rows
  // use the standard .group__row pattern from layout.css (same as every
  // other drill-in settings list).
  function rowLi(to, label, opts = {}) {
    const { detail = null, sub = null } = opts;
    return h('li', null,
      h('a', { href: '#/' + to, class: 'group__row', 'aria-label': label },
        h('span', { class: 'group__row-label' }, label),
        sub && !detail
          ? h('span', { class: 'group__row-detail' }, sub)
          : h('span', { class: 'group__row-detail' }, detail || sub || ''),
        h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
      )
    );
  }

  return h('section', { class: 'settings-home' },
    // ---- Providers: account-level connections, not layered. -------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Providers'),
      h('ul', { class: 'group__list' },
        rowLi('settings/providers', 'Providers', { detail: providerSummary }),
        rowLi('settings/projects', 'Projects', { sub: 'registered folders' })
      )
    ),
    // ---- App defaults: settings that apply everywhere unless a project
    // changes them. Rows describe what the setting is, not the layering —
    // the one-line footer explains "a project can change these" once. ----
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'App defaults', h('span', { class: 'group__title-note' }, 'Apply to every project')),
      h('ul', { class: 'group__list' },
        rowLi('settings/defaults', 'Chat defaults', { detail: promptSize }),
        rowLi('settings/dictation', 'Dictation', { sub: 'speech-to-text model & transcript' }),
        rowLi('settings/prompts', 'Custom prompts', { sub: 'app-wide system prompts' }),
        rowLi('settings/access', 'Access & passkeys', { sub: 'password, WebAuthn, disable QR' }),
        rowLi('settings/notifications', 'Notifications', { sub: 'questions, approvals & completion' }),
        rowLi('settings/mcp', 'MCP servers', { sub: 'servers; permissions live in project Tools' }),
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
            rowLi('settings/prompts' + projectQS, 'Custom prompts', { sub: 'system prompts for this project' })
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
