// mouaif web entry. Built by Vite into /web/assets/index.js and
// served by the Node server at /web/.
//
// Architecture:
//   - One Preact tree, mounted into <main id="app"> from index.html.
//   - A small hash router (no history API; the Node server doesn't
//     rewrite unknown paths to index.html, so deep links would 404
//     anyway; the hash is enough for our two views).
//   - Per-feature components (VirtualList, ChatTest, Auth, Settings,
//     Projects, ChatView) live in this file. They are intentionally
//     not split out: a feature-per-file scheme would force readers to
//     jump between files for small components, and a build step gives
//     us the code-splitting for free when we need it later.

import { render, h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { createVirtualList } from './virtual-list.js';
import './style.css';

// ---- API client --------------------------------------------------------

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text || '{}'); } catch { body = text; }
  return { status: r.status, body };
}

// ---- Hash router -------------------------------------------------------

const route = signal(parseHash());

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { name: 'chats' };
  if (h === 'projects') return { name: 'chats' };
  if (h === 'settings') return { name: 'settings' };
  // Auth belongs to provider configuration. Keep old links working by
  // redirecting the retired standalone route to Settings.
  if (h === 'auth') return { name: 'settings' };
  if (h === 'inspector') return { name: 'inspector' };
  // Settings sub-views: providers, project overrides, GitHub Copilot.
  // Each is a focused screen reached from the settings home.
  if (h === 'settings/providers') return { name: 'settingsProviders' };
  if (h === 'settings/providers/new') return { name: 'settingsProviderNew' };
  if (h.startsWith('settings/providers/')) {
    const id = decodeURIComponent(h.slice('settings/providers/'.length));
    if (id && id !== 'new') return { name: 'settingsProviderEdit', id };
  }
  if (h === 'settings/project') return { name: 'settingsProject' };
  if (h === 'settings/defaults') return { name: 'settingsDefaults' };
  if (h === 'settings/copilot') return { name: 'settingsCopilot' };
  if (h === 'settings/about') return { name: 'settingsAbout' };
  if (h.startsWith('chat/')) {
    const rest = h.slice('chat/'.length);
    const [chatId, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'chat', chatId, projectDir: params.get('projectDir') || '' };
  }
  if (h.startsWith('projects/new')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'picker', dir: params.get('dir') || '' };
  }
  return { name: 'chats' };
}

window.addEventListener('hashchange', () => { route.value = parseHash(); });

function nav(toHash) {
  window.location.hash = '#/' + toHash;
}

// ---- Components --------------------------------------------------------

function App() {
  const view = route.value;
  // The settings sub-views own their back navigation, so they
  // hide the bottom tab bar to give the content the full
  // available height (same as the chat drill-in).
  const showTabBar = view.name !== 'chat' && view.name !== 'picker'
    && view.name !== 'settingsProviders' && view.name !== 'settingsProviderNew'
    && view.name !== 'settingsProviderEdit' && view.name !== 'settingsProject'
    && view.name !== 'settingsDefaults' && view.name !== 'settingsCopilot'
    && view.name !== 'settingsAbout';
  let body = null;
  if (view.name === 'chats') body = h(ProjectsView, null);
  else if (view.name === 'picker') body = h(ProjectPickerView, { dir: view.dir });
  else if (view.name === 'chat') body = h(ChatView, { chatId: view.chatId, projectDir: view.projectDir });
  else if (view.name === 'settings') body = h(SettingsHomeView, null);
  else if (view.name === 'settingsProviders') body = h(SettingsProvidersView, null);
  else if (view.name === 'settingsProviderNew') body = h(SettingsProviderEditView, { id: '' });
  else if (view.name === 'settingsProviderEdit') body = h(SettingsProviderEditView, { id: view.id });
  else if (view.name === 'settingsProject') body = h(SettingsProjectView, null);
  else if (view.name === 'settingsDefaults') body = h(SettingsDefaultsView, null);
  else if (view.name === 'settingsCopilot') body = h(SettingsCopilotView, null);
  else if (view.name === 'settingsAbout') body = h(SettingsAboutView, null);
  else if (view.name === 'inspector') body = h(InspectorView, null);
  else body = h(ProjectsView, null);
  return h('div', { class: 'app__shell' },
    h(Header, null),
    h('main', { class: 'app__main' + (showTabBar ? '' : ' app__main--flush') }, body),
    showTabBar ? h(BottomNav, null) : null
  );
}

function Header() {
  // The header is just the brand block: a 24 px logo tile and the
  // title on a single line. No subtitle, no right-side action; a
  // future header action (search, profile) can sit in the same row
  // next to the brand. Kept as small as possible to maximize the
  // content area on a phone.
  return h('header', { class: 'app__header' },
    h('div', { class: 'app__brand' },
      h('span', { class: 'app__logo', 'aria-hidden': 'true' }, 'm'),
      h('h1', { class: 'app__title' }, 'mouaif')
    )
  );
}

// ---- Bottom tab bar ---------------------------------------------------
// Three top-level destinations — Chats / Inspector / Settings
// — are reached from a fixed bottom tab bar instead of the top header.
// The bar is hidden on the chat, folder-picker, and auth drill-in screens,
// which have their own per-screen back button.
//
// Inline SVG icons keep the bundle small and crisp at any density. The
// `currentColor` fill on the path means the existing color tokens
// drive the icon color in any state.

const TabIcon = {
  chats: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9.5l-3.72 3.72A1 1 0 0 1 4 22.56V18H5a3 3 0 0 1-3-3V5Z', fill: 'currentColor' })),
  inspector: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 3v2h16V7H4Zm0 4v2h7v-2H4Zm0 4v2h7v-2H4Zm9 0v2h7v-2h-7Z', fill: 'currentColor' })),
  settings: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' }))
};

function BottomNav() {
  const view = route.value;
  const tab = (to, name, label) => h('a', {
    href: '#/' + to,
    class: 'app__tab' + (view.name === name ? ' is-active' : ''),
    'aria-current': view.name === name ? 'page' : null
  },
    h('span', { class: 'app__tab-icon' }, TabIcon[name]),
    h('span', { class: 'app__tab-label' }, label)
  );
  return h('nav', { class: 'app__tabbar', 'aria-label': 'Primary' },
    tab('projects', 'chats', 'Chats'),
    tab('inspector', 'inspector', 'Inspector'),
    tab('settings', 'settings', 'Settings')
  );
}

function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// ============================================================================
// Settings — clean sub-view architecture
// ============================================================================
//
// The previous incarnation of this screen stacked App / Providers /
// Provider accounts / GitHub Copilot / Project overrides into one
// wall of H2s, with a single 500-line SettingsPanel that mixed form
// state, ref-management, and direct DOM writes. The form for adding
// a provider buried the OAuth-account <select> behind a
// visibility-toggled row, the project-override section reused a raw
// <textarea>, and the OAuth sign-in block lived on the same screen
// as the provider it signed in to — so editing a connection and
// signing in were the same screen, with no back button between them.
//
// Shared bits:
//   - loadApp()        GET /api/settings; cached in module scope.
//   - saveApp(patch)   PUT /api/settings/app (shallow merge).
//   - resetApp(keys)   POST /api/settings/app/reset.
//   - listAccounts()   GET /api/auth/accounts; cached briefly.
//   - signIn(provider) start the loopback flow, poll for the new account.
//   - toast(text, state) renders into a small ref-attached bar.

// ---- Settings shared data ---------------------------------------------

let _appCache = null;       // last /api/settings response body
let _appCacheAt = 0;        // epoch ms of the last fetch
const APP_CACHE_TTL_MS = 4000;

async function loadApp({ force = false } = {}) {
  const now = Date.now();
  if (!force && _appCache && (now - _appCacheAt) < APP_CACHE_TTL_MS) return _appCache;
  const r = await fetchJson('/api/settings');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = r.body || {};
  _appCacheAt = now;
  return _appCache;
}

function appProviders() {
  return (_appCache && Array.isArray(_appCache.app && _appCache.app.providers)) ? _appCache.app.providers : [];
}

async function saveApp(patch) {
  const r = await fetchJson('/api/settings/app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {})
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = Object.assign({}, _appCache, { app: r.body.app || (_appCache && _appCache.app) || {} });
  return _appCache;
}

async function resetAppKeys(keys) {
  const r = await fetchJson('/api/settings/app/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: keys || [] })
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = Object.assign({}, _appCache, { app: r.body.app || {} });
  return _appCache;
}

let _accountsCache = null;
let _accountsCacheAt = 0;
const ACCOUNTS_CACHE_TTL_MS = 5000;

async function loadAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && _accountsCache && (now - _accountsCacheAt) < ACCOUNTS_CACHE_TTL_MS) return _accountsCache;
  const r = await fetchJson('/api/auth/accounts');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _accountsCache = (r.body && r.body.accounts) || {};
  _accountsCacheAt = now;
  return _accountsCache;
}

// ---- Settings constants ----------------------------------------------

// The five providers the AI client knows about. The set is the
// source of truth for the provider <select> and the "+ Add provider"
// screen; it matches src/ai.js -> ENDPOINTS.
const SETTINGS_PROVIDERS = [
  { id: 'openai-compatible', label: 'OpenAI compatible',  defaultBaseUrl: 'https://api.openai.com/v1',                hint: 'OpenAI, Together, Groq, LM Studio, Ollama (via /v1), any OpenAI-shaped API.' },
  { id: 'anthropic',         label: 'Anthropic',          defaultBaseUrl: 'https://api.anthropic.com',                hint: 'Claude Messages API. Use the OAuth flow below for Claude Pro/Max; otherwise paste an API key.' },
  { id: 'gemini',            label: 'Google Gemini',      defaultBaseUrl: 'https://generativelanguage.googleapis.com', hint: 'Google AI Studio / Gemini API. API key authentication.' },
  { id: 'ollama',            label: 'Ollama',             defaultBaseUrl: 'http://127.0.0.1:11434',                   hint: 'Local Ollama server. No API key required.' },
  { id: 'github-copilot',    label: 'GitHub Copilot',     defaultBaseUrl: 'https://api.githubcopilot.com',            hint: 'Requires OAuth. A Copilot subscription on the signed-in account is required to chat.', reserved: true }
];

function providerDef(id) {
  return SETTINGS_PROVIDERS.find(p => p.id === id) || null;
}

// Map an AI client provider id to the keyring namespace. The
// keyring is keyed by the auth provider (openai, anthropic, ...),
// not by the AI client provider name. Today the two are identical
// for everything except openai-compatible, which shares the openai
// namespace.
function authNsForProvider(id) {
  if (id === 'openai-compatible') return 'openai';
  return id;
}

// ---- Tiny toast helper -----------------------------------------------

function setStatus(ref, text, state) {
  if (!ref || !ref.current) return;
  ref.current.textContent = text || '';
  if (state) ref.current.dataset.state = state;
  else delete ref.current.dataset.state;
}

// ============================================================================
// SettingsHomeView
// ============================================================================
//
// The landing screen for /settings. A single column of cards, each
// tapping into a focused sub-view. The cards are the only place
// where the user sees a summary of "what's set up"; the sub-views
// are where the user makes changes.

function SettingsHomeView() {
  // Most-recent values for each card. Updated in load(). Refs
  // are used for the summary lines so we don't re-render the
  // whole tree on every refresh.
  const providerCount = useRef(null);
  const projectCount = useRef(null);
  const accountsCount = useRef(null);
  const promptSize = useRef(null);
  const copilot = useRef(null);

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
    } catch (e) { /* leave summary blank; the sub-views will show their own errors */ }
  }

  useEffect(() => { load(); }, []);

  // A card is a single <a> with a title, a one-line summary, and
  // a chevron. Tap navigates to the sub-view; the sub-view owns
  // the back button.
  function card(to, title, summaryRef, extra) {
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
    card('settings/providers', 'Provider connections', providerCount,
      h('p', { class: 'settings-home__hint' }, 'OpenAI, Anthropic, Gemini, Ollama, GitHub Copilot. Credentials are stored once and used by every project.')),
    card('settings/project', 'Project overrides', projectCount,
      h('p', { class: 'settings-home__hint' }, 'Per-project settings live in .mouaif.json inside the project folder. Models reference a provider above.')),
    h('h3', null, 'App defaults'),
    card('settings/defaults', 'App defaults', promptSize,
      h('p', { class: 'settings-home__hint' }, 'Default prompt-size profile for new chats.')),
    card('settings/copilot', 'GitHub Copilot OAuth app', copilot,
      h('p', { class: 'settings-home__hint' }, 'Custom OAuth client_id so Copilot sign-in works on this host.')),
    h('a', { href: '#/settings/about', class: 'card', 'aria-label': 'About' },
      h('div', { class: 'card__main' },
        h('div', { class: 'card__title' }, 'About & reset'),
        h('div', { class: 'card__summary' }, 'Storage location and destructive actions')
      ),
      h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
    )
  );
}

// ============================================================================
// SettingsProvidersView — list of configured providers + an "Add" entry
// ============================================================================

function SettingsProvidersView() {
  const listEl = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    try {
      await loadApp({ force: true });
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); return; }
    render();
  }

  function render() {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    const list = appProviders();
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'providers__empty';
      li.textContent = 'No providers yet. Tap "Add provider" to configure your first connection.';
      listEl.current.appendChild(li);
      setStatus(statusEl, '0 providers');
      return;
    }
    for (const p of list) {
      listEl.current.appendChild(renderProviderRow(p));
    }
    setStatus(statusEl, list.length + (list.length === 1 ? ' provider' : ' providers'), 'success');
  }

  function renderProviderRow(p) {
    const li = document.createElement('li');
    li.className = 'provider-row';

    const main = document.createElement('a');
    main.className = 'provider-row__main';
    main.href = '#/settings/providers/' + encodeURIComponent(p.id);
    const def = providerDef(p.id);
    const name = document.createElement('div');
    name.className = 'provider-row__name';
    name.textContent = (def && def.label) || p.id;
    const meta = document.createElement('div');
    meta.className = 'provider-row__meta';
    const auth = p.auth || 'apikey';
    const bits = [];
    if (p.baseUrl) bits.push(p.baseUrl);
    if (auth === 'oauth') {
      bits.push('OAuth');
      if (p.oauthAccount) bits.push('as ' + p.oauthAccount);
    } else if (p.hasApiKey) {
      bits.push('key saved');
    } else {
      bits.push('no key');
    }
    meta.textContent = bits.join('  ·  ');
    main.appendChild(name);
    main.appendChild(meta);

    const chev = document.createElement('div');
    chev.className = 'provider-row__chev';
    chev.textContent = '›';
    main.appendChild(chev);

    li.appendChild(main);
    return li;
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Provider connections')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Credentials are stored once at the app level. Each project\'s models reference one of these providers.'),
      h('ul', { ref: listEl, class: 'providers__list', 'aria-label': 'Configured providers' }),
      h('div', { class: 'row row--actions' },
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' }),
        h('a', { href: '#/settings/providers/new', class: 'btn btn--primary' }, '+ Add provider')
      )
    )
  );
}

// ============================================================================
// SettingsProviderEditView — single-provider editor (used for new + edit)
// ============================================================================
//
// One provider at a time, with all of the relevant fields visible
// at once. Auth mode and OAuth account stay in lockstep with the
// <select>; reserved providers (github-copilot) force oauth and
// disable the apiKey option.

function SettingsProviderEditView(props) {
  const id = props.id || '';

  // The form refs. Keeping them flat keeps the JSX readable.
  const idSel = useRef(null);
  const baseUrl = useRef(null);
  const authSel = useRef(null);
  const apiKey = useRef(null);
  const oauthAccount = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const statusEl = useRef(null);

  // The OAuth sign-in helper. Lives in the form because the user
  // always needs to sign in before an OAuth provider can be saved.
  const signInStatus = useRef(null);

  // Cache the loaded record so the form does not flicker on every
  // field change. Updated by load().
  let current = null;
  let accounts = {};

  async function load() {
    try {
      await loadApp({ force: true });
      accounts = await loadAccounts({ force: true });
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); return; }
    current = id ? appProviders().find(p => p && p.id === id) : null;
    if (id && !current) { setStatus(statusEl, 'Provider not found', 'error'); return; }

    if (idSel.current) {
      idSel.current.value = id || 'openai-compatible';
      if (id) idSel.current.disabled = true; // the id is the upsert key; do not let the user silently rename
    }
    syncAuth();
    syncOauthAccountOptions();
    syncBaseUrl();
    if (apiKey.current) apiKey.current.value = ''; // never pre-fill; the redacted form shows the hint instead
    if (deleteBtn.current) deleteBtn.current.hidden = !id;
    if (baseUrl.current) baseUrl.current.value = (current && current.baseUrl) || '';
    renderKeyHint();
    setStatus(statusEl, '');
  }

  // ---- Form sync helpers ------------------------------------------

  function syncAuth() {
    if (!authSel.current) return;
    const def = providerDef(idSel.current.value);
    const reserved = !!(def && def.reserved);
    // For reserved providers, force oauth. Otherwise respect
    // the select's current value.
    let wantAuth = authSel.current.value;
    if (reserved) wantAuth = 'oauth';
    if (authSel.current.value !== wantAuth) authSel.current.value = wantAuth;
    // Disable the apiKey option for reserved providers.
    for (const opt of authSel.current.querySelectorAll('option')) {
      if (opt.value === 'apikey') opt.disabled = reserved;
    }
    // Show / hide the right rows. Both rows live in the DOM and
    // toggle visibility via a class; that keeps the form layout
    // stable when the user switches auth.
    const section = authSel.current.closest('section');
    if (section) {
      for (const row of section.querySelectorAll('.row--apikey, .row--oauth')) {
        const showWhen = row.getAttribute('data-show-when');
        if (!showWhen) continue;
        row.classList.toggle('is-hidden', showWhen !== wantAuth);
      }
    }
  }

  function syncOauthAccountOptions() {
    if (!oauthAccount.current) return;
    const ns = authNsForProvider(idSel.current.value);
    const list = (accounts[ns] || []).slice();
    oauthAccount.current.innerHTML = '';
    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '— no accounts yet; sign in below —';
      opt.disabled = true; opt.selected = true;
      oauthAccount.current.appendChild(opt);
      oauthAccount.current.value = '';
      return;
    }
    if (list.length === 1) {
      const opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '(auto — ' + list[0] + ')';
      oauthAccount.current.appendChild(opt0);
    } else {
      const opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '(pick an account)';
      opt0.disabled = true; opt0.selected = true;
      oauthAccount.current.appendChild(opt0);
    }
    for (const a of list) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      oauthAccount.current.appendChild(opt);
    }
    const cur = (current && current.oauthAccount) || '';
    if (cur && list.includes(cur)) oauthAccount.current.value = cur;
  }

  function syncBaseUrl() {
    if (!baseUrl.current) return;
    const def = providerDef(idSel.current.value);
    const configured = (current && current.id === idSel.current.value) ? current : null;
    const target = (configured && configured.baseUrl) || (def && def.defaultBaseUrl) || '';
    const cur = baseUrl.current.value.trim();
    // Don't clobber a user-typed URL on provider change. Only set
    // the default if the field is empty or still matches the
    // previous default.
    const known = SETTINGS_PROVIDERS.map(p => p.defaultBaseUrl).filter(Boolean);
    if (!cur || known.includes(cur)) baseUrl.current.value = target;
  }

  function renderKeyHint() {
    // The apiKey field is type=password and starts empty. Render
    // a small "key saved" hint inline so the user knows the
    // existing key is in place without us echoing the secret.
    // Only relevant for the apikey auth mode.
    const section = authSel.current && authSel.current.closest('section');
    const hint = section && section.querySelector('.key-hint');
    if (!hint) return;
    const wantAuth = authSel.current && authSel.current.value;
    if (wantAuth === 'apikey' && current && current.hasApiKey) {
      hint.textContent = 'a key is already saved for this provider; leave the field empty to keep it';
      hint.hidden = false;
    } else {
      hint.textContent = '';
      hint.hidden = true;
    }
  }

  // ---- Sign in (oauth providers only) -----------------------------

  async function startSignIn() {
    const provider = idSel.current.value;
    const def = providerDef(provider);
    if (!def) { setStatus(signInStatus, 'unknown provider', 'error'); return; }
    setStatus(signInStatus, 'starting sign-in…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/auth/sign-in/' + encodeURIComponent(provider), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    } catch (err) { setStatus(signInStatus, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(signInStatus, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    // Open the provider's authorize URL in a new tab. A new tab
    // is a fresh user gesture so popups are not blocked.
    const win = window.open(r.body.authorizeUrl, '_blank', 'noopener');
    if (!win) setStatus(signInStatus, 'popup blocked — open the URL manually', 'error');
    setStatus(signInStatus, 'waiting for ' + def.label + ' to redirect back…', 'busy');

    // Poll for the new account so the OAuth-account <select> can
    // be re-populated while the user is still at the provider.
    const before = new Set((accounts[authNsForProvider(provider)] || []).slice());
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const next = await loadAccounts({ force: true });
        accounts = next;
        const list = (next[authNsForProvider(provider)] || []);
        const fresh = list.filter(a => !before.has(a));
        if (fresh.length) {
          syncOauthAccountOptions();
          setStatus(signInStatus, 'signed in as ' + fresh[0], 'success');
          return;
        }
      } catch { /* keep polling */ }
    }
    setStatus(signInStatus, 'timed out. Paste the redirect URL or its code below.', 'error');
  }

  // ---- Save / delete ----------------------------------------------

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const providerId = idSel.current.value;
    const def = providerDef(providerId);
    const auth = (def && def.reserved) ? 'oauth' : authSel.current.value;
    const base = (baseUrl.current.value || '').trim();
    const key = (apiKey.current.value || '').trim();
    const account = (oauthAccount.current.value || '').trim();

    // Re-fetch accounts so we don't accidentally publish a stale
    // empty list when the user just signed in.
    if (auth === 'oauth') {
      try { accounts = await loadAccounts({ force: true }); } catch { /* fall through */ }
      const list = accounts[authNsForProvider(providerId)] || [];
      if (!list.length) { setStatus(statusEl, 'sign in to ' + providerId + ' first', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
      if (list.length > 1 && !account) { setStatus(statusEl, 'pick which signed-in account to use', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    }
    if (auth === 'apikey' && providerId !== 'ollama' && !key && !(current && current.hasApiKey)) {
      setStatus(statusEl, 'API key is required for ' + providerId, 'error');
      if (apiKey.current) apiKey.current.focus();
      if (saveBtn.current) saveBtn.current.disabled = false;
      return;
    }
    const body = { id: providerId, auth };
    if (base) body.baseUrl = base;
    if (auth === 'apikey' && key) body.apiKey = key;
    if (auth === 'oauth' && account) body.oauthAccount = account;
    let r;
    try {
      r = await fetchJson('/api/settings/app/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) { setStatus(statusEl, 'network error', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved ' + providerId, 'success');
    // Refresh local cache and bounce back to the list.
    _appCache = null; _appCacheAt = 0;
    nav('settings/providers');
  }

  async function deleteProvider() {
    if (!id) return;
    if (!confirm('Delete provider "' + id + '"? Models in your projects that reference it will stop working until you re-add it.')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/settings/app/providers/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    _appCache = null; _appCacheAt = 0;
    nav('settings/providers');
  }

  useEffect(() => { load(); }, []);

  const def = id ? providerDef(id) : null;
  const titleText = id ? ((def && def.label) || id) : 'Add provider';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/providers', class: 'view-back', 'aria-label': 'Back to providers' }, '←'),
      h('h2', { class: 'view-title' }, titleText)
    ),
    h('section', null,
      def && def.hint ? h('p', { class: 'hint hint--compact' }, def.hint) : null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-id' }, 'Provider'),
        h('select', { ref: idSel, class: 'input', id: 'sp-id', disabled: !!id, onChange: () => { syncAuth(); syncOauthAccountOptions(); syncBaseUrl(); renderKeyHint(); } },
          SETTINGS_PROVIDERS.map(p => h('option', { value: p.id, key: p.id }, p.label))
        )
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-base' }, 'API base URL'),
        h('input', { ref: baseUrl, class: 'input', id: 'sp-base', type: 'url', placeholder: 'https://api.openai.com/v1' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-auth' }, 'Authentication'),
        h('select', { ref: authSel, class: 'input', id: 'sp-auth', onChange: () => { syncAuth(); renderKeyHint(); syncOauthAccountOptions(); } },
          h('option', { value: 'apikey' }, 'API key'),
          h('option', { value: 'oauth' }, 'OAuth')
        )
      ),
      h('div', { class: 'row row--apikey', 'data-show-when': 'apikey' },
        h('label', { class: 'label', for: 'sp-key' }, 'Provider API key'),
        h('input', { ref: apiKey, class: 'input', id: 'sp-key', type: 'password', placeholder: 'paste key', autocomplete: 'off' })
      ),
      h('p', { class: 'hint hint--compact key-hint', hidden: true }),
      h('div', { class: 'row row--oauth', 'data-show-when': 'oauth' },
        h('label', { class: 'label', for: 'sp-account' }, 'OAuth account'),
        h('select', { ref: oauthAccount, class: 'input', id: 'sp-account' })
      ),
      h('div', { class: 'row row--oauth', 'data-show-when': 'oauth' },
        h('div', { class: 'auth__help-inline' },
          h('p', { class: 'hint hint--compact' }, 'Sign in to this provider below; the OAuth-account list refreshes automatically.'),
          h('div', { class: 'row row--actions' },
            h('button', { class: 'btn', type: 'button', onClick: startSignIn }, 'Sign in'),
            h('span', { ref: signInStatus, class: 'status', 'aria-live': 'polite' })
          )
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, id ? 'Save' : 'Add provider'),
        h('button', { ref: deleteBtn, class: 'btn btn--danger', type: 'button', onClick: deleteProvider, hidden: !id }, 'Delete'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

// ============================================================================
// SettingsProjectView — load and edit a project file, see resolved view
// ============================================================================
//
// The previous editor was a raw <textarea> glued to JSON.parse. This
// view keeps the raw editor (project files are JSON and the schema
// is small) but reframes it: the directory lives in its own
// dedicated input, the raw editor only appears after a successful
// load, and the resolved view is always one tap away.

function SettingsProjectView() {
  const projectDir = useRef(null);
  const loadBtn = useRef(null);
  const statusEl = useRef(null);
  const resolvedStatus = useRef(null);
  const editor = useRef(null);
  const saveBtn = useRef(null);
  const revertBtn = useRef(null);
  const resolvedOut = useRef(null);
  const resolvedDir = useRef(null);

  let currentProject = {};
  let currentResolved = {};

  async function load() {
    const dir = (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    if (loadBtn.current) loadBtn.current.disabled = true;
    setStatus(statusEl, 'loading…', 'busy');
    const [projRes, resolvedRes] = await Promise.all([
      fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(dir)),
      fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(dir))
    ]);
    if (loadBtn.current) loadBtn.current.disabled = false;
    if (projRes.status !== 200) { setStatus(statusEl, 'project: HTTP ' + projRes.status + (projRes.body && projRes.body.error ? ' ' + projRes.body.error : ''), 'error'); return; }
    currentProject = projRes.body.project || {};
    if (editor.current) {
      editor.current.hidden = false;
      editor.current.value = JSON.stringify(currentProject, null, 2);
    }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (revertBtn.current) revertBtn.current.disabled = false;
    setStatus(statusEl, 'path: ' + (projRes.body.path || ''), 'success');
    if (resolvedRes.status === 200) {
      currentResolved = resolvedRes.body.resolved || {};
      if (resolvedDir.current) resolvedDir.current.textContent = dir;
      if (resolvedOut.current) {
        // Redact apiKey for display so the resolved view never
        // echoes a secret back into the DOM.
        const redacted = JSON.parse(JSON.stringify(currentResolved));
        if (Array.isArray(redacted.providers)) {
          redacted.providers = redacted.providers.map((p) => {
            if (!p || typeof p !== 'object') return p;
            if (typeof p.apiKey === 'string') p.apiKey = p.apiKey ? '•••' : '';
            return p;
          });
        }
        resolvedOut.current.hidden = false;
        resolvedOut.current.textContent = JSON.stringify(redacted, null, 2);
      }
      if (resolvedStatus.current) setStatus(resolvedStatus, 'ok', 'success');
    } else {
      if (resolvedStatus.current) setStatus(resolvedStatus, 'HTTP ' + resolvedRes.status, 'error');
    }
  }

  async function save() {
    const dir = (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    let parsed;
    try { parsed = JSON.parse((editor.current && editor.current.value) || '{}'); }
    catch (e) { setStatus(statusEl, 'invalid JSON: ' + e.message, 'error'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus(statusEl, 'project body must be a JSON object', 'error');
      return;
    }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir }, parsed))
    });
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved.', 'success');
    currentProject = r.body.project || currentProject;
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    await load();
  }

  function revert() {
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    setStatus(statusEl, 'reverted.', 'success');
  }

  useEffect(() => { /* nothing to do until the user picks a directory */ }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Project overrides')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Project files live at ', h('code', null, '.mouaif.json'), ' inside the project folder. Models reference a provider configured at the app level.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-project-dir' }, 'Project directory'),
        h('div', { class: 'row row--inline' },
          h('input', { ref: projectDir, class: 'input', id: 'sp-project-dir', type: 'text', placeholder: 'C:/path/to/project' }),
          h('button', { ref: loadBtn, class: 'btn', type: 'button', onClick: load }, 'Load')
        )
      ),
      h('div', { class: 'row' },
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-project-editor' }, 'Project file'),
        h('textarea', { ref: editor, class: 'input', id: 'sp-project-editor', rows: 10, hidden: true, spellcheck: false })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save, disabled: true }, 'Save'),
        h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revert, disabled: true }, 'Revert')
      ),
      h('h3', null, 'Resolved (effective for this project)'),
      h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. The chat layer reads this merged object. Provider keys are redacted.'),
      h('p', { class: 'hint hint--compact' }, h('code', { ref: resolvedDir }, '')),
      h('pre', { ref: resolvedOut, class: 'settings__out', hidden: true }),
      h('div', { ref: resolvedStatus, class: 'status', 'aria-live': 'polite' })
    )
  );
}

// ============================================================================
// SettingsDefaultsView — app-level defaults (prompt-size, future flags)
// ============================================================================
//
// The app has a small set of cross-project defaults. Today the only
// one is the default prompt-size profile; new flags land here in
// later commits. Each chat stores its own prompt-size so this is
// only the seed value for "new chat" flows.

function SettingsDefaultsView() {
  const promptSize = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (promptSize.current) promptSize.current.value = (app.app && app.app.promptSize) || 'average';
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); }
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    try {
      await saveApp({ promptSize: promptSize.current.value });
      setStatus(statusEl, 'saved.', 'success');
    } catch (e) { setStatus(statusEl, 'save failed: ' + e.message, 'error'); }
    if (saveBtn.current) saveBtn.current.disabled = false;
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'App defaults')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Defaults applied to new chats. Each chat can override these.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sd-prompt-size' }, 'Default prompt size'),
        h('select', { ref: promptSize, class: 'input', id: 'sd-prompt-size' },
          h('option', { value: 'very-small' }, 'very-small'),
          h('option', { value: 'average' }, 'average'),
          h('option', { value: 'extensive' }, 'extensive')
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

// ============================================================================
// SettingsCopilotView — the GitHub Copilot OAuth client_id
// ============================================================================

function SettingsCopilotView() {
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

// ============================================================================
// SettingsAboutView — storage location, defaults, destructive actions
// ============================================================================

function SettingsAboutView() {
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
// ============================================================================
// Old monolithic SettingsPanel / AuthPanel / CopilotAppSection / SettingsView
// ============================================================================
//
// Replaced by SettingsHomeView + SettingsProvidersView +
// SettingsProviderEditView + SettingsProjectView + SettingsCopilotView +
// SettingsAboutView at the top of this file. The old code is intentionally
// removed; the REST surface in src/index.js is unchanged (see
// docs/features/settings-ui.md).


// ---- Inspector ---------------------------------------------------------
// Mobile-friendly, from-scratch DevTools-style UI. Built on top of
// Chrome DevTools Protocol (CDP) over WebSocket — see
// docs/decisions.md section 6. The mouaif server is a thin relay
// (src/inspector.js); the browser speaks CDP directly to Chrome via
// the /api/inspector/proxy WebSocket.
//
// The view is a 3-state machine:
//   1. setup   — set the Chrome debugger host URL
//   2. targets — list discoverable targets (pages, service workers, ...)
//   3. inspect — connected to a target, with a Console and Network panel
//
// The WebSocket lives on a ref, not in Preact state, so reconnects and
// message bursts do not thrash the tree. The visible state (connected
// / target / current panel) is held in a ref too, with a tiny render
// trigger (`stateTick`) that bumps the version of the whole subtree.

function InspectorView() {
  const urlInput = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);
  const targetsList = useRef(null);

  // Phase: 'setup' | 'targets' | 'inspect'. The ref is the source of
  // truth; we re-render the whole subtree when it changes.
  const phase = useRef('setup');
  const debuggerUrl = useRef('');
  const defaultUrl = useRef('');
  const targets = useRef([]);
  const currentTarget = useRef(null);
  // Active sub-panel when connected: 'console' | 'network'.
  const panel = useRef('console');
  // Bump to trigger a manual re-render after phase changes.
  const stateTick = useRef(0);
  // CDP connection state. wsRef holds the WebSocket; cmdId holds the
  // next command id. pending is id -> { resolve, reject }. listeners
  // is a Map<eventName, Set<handler>>.
  const wsRef = useRef(null);
  const cmdId = useRef(1);
  const pending = useRef(new Map());
  const listeners = useRef(new Map());
  // Captured event streams.
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);

  function rerender() { stateTick.current++; forceUpdate(); }

  // CDP client: send a command; return a promise that resolves with
  // the `result` field or rejects with `error`.
  function cdpSend(method, params) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = cmdId.current++;
    const msg = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      try { ws.send(msg); }
      catch (e) { pending.current.delete(id); reject(e); }
    });
  }

  function cdpOn(eventName, handler) {
    let set = listeners.current.get(eventName);
    if (!set) { set = new Set(); listeners.current.set(eventName, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  function wsOnMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    // Response to a command: { id, result?, error? }
    if (typeof msg.id === 'number') {
      const slot = pending.current.get(msg.id);
      if (slot) {
        pending.current.delete(msg.id);
        if (msg.error) slot.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code }));
        else slot.resolve(msg.result || {});
      }
      return;
    }
    // Event: { method, params }
    if (typeof msg.method === 'string') {
      const set = listeners.current.get(msg.method);
      if (set) for (const fn of set) { try { fn(msg.params || {}); } catch { /* ignore handler errors */ } }
    }
  }

  function disconnect() {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    for (const slot of pending.current.values()) {
      try { slot.reject(new Error('disconnected')); } catch { /* ignore */ }
    }
    pending.current.clear();
    listeners.current.clear();
    reqMap.current.clear();
    currentTarget.current = null;
    consoleEntries.current = [];
    networkEntries.current = [];
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    // Clear the status line so a stale message from a previous
    // connect/disconnect cycle does not bleed into the next phase.
    if (statusEl.current) statusEl.current.textContent = '';
  }

  function connect(target) {
    if (wsRef.current) disconnect();
    currentTarget.current = target;
    panel.current = 'console';
    phase.current = 'inspect';
    consoleEntries.current = [];
    networkEntries.current = [];
    // Build the proxy URL. The server resolves the target id to the
    // upstream webSocketDebuggerUrl for us; this means the browser
    // never has to talk to /json/list over a second WebSocket.
    const host = encodeURIComponent(debuggerUrl.current);
    const tid = encodeURIComponent(target.id);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const proxyUrl = proto + '//' + window.location.host + '/api/inspector/proxy?host=' + host + '&targetId=' + tid;
    let ws;
    try { ws = new WebSocket(proxyUrl); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'WebSocket open failed: ' + (e.message || e); return; }
    wsRef.current = ws;
    if (statusEl.current) statusEl.current.textContent = 'connecting…';
    ws.addEventListener('open', () => onWsOpen(target));
    ws.addEventListener('message', wsOnMessage);
    ws.addEventListener('close', (ev) => onWsClose(ws, ev));
    ws.addEventListener('error', () => {
      if (wsRef.current === ws && statusEl.current) statusEl.current.textContent = 'WebSocket error';
    });
    rerender();
  }

  function onWsOpen(target) {
    if (statusEl.current) statusEl.current.textContent = 'connected to ' + (target.title || target.url || target.id);
    // Enable the domains we render. Each `*Enable` call returns a
    // resolved promise on success. We don't await — failures are
    // surfaced in the status line via their .catch.
    cdpSend('Runtime.enable').catch((e) => { if (statusEl.current) statusEl.current.textContent = 'Runtime.enable failed: ' + e.message; });
    cdpSend('Network.enable').catch((e) => { if (statusEl.current) statusEl.current.textContent = 'Network.enable failed: ' + e.message; });
    // Subscribe to console events.
    cdpOn('Runtime.consoleAPICalled', onConsoleEvent);
    cdpOn('Runtime.exceptionThrown', onExceptionEvent);
    cdpOn('Network.requestWillBeSent', onRequestWillBeSent);
    cdpOn('Network.responseReceived', onResponseReceived);
    cdpOn('Network.loadingFinished', onLoadingFinished);
    cdpOn('Network.loadingFailed', onLoadingFailed);
  }

  function onWsClose(ws, ev) {
    // A previous socket may finish closing after a reconnect. It must not
    // clear the listeners or status belonging to the replacement socket.
    if (wsRef.current !== ws) return;
    if (statusEl.current) {
      const code = ev && typeof ev.code === 'number' ? ev.code : 0;
      statusEl.current.textContent = 'disconnected (code ' + code + ')';
    }
    wsRef.current = null;
    for (const slot of pending.current.values()) {
      try { slot.reject(new Error('disconnected')); } catch { /* ignore */ }
    }
    pending.current.clear();
    // Drop event listeners so re-connecting doesn't double-fire.
    listeners.current.clear();
  }

  function onConsoleEvent(params) {
    // params.type: 'log'|'debug'|'info'|'error'|'warning'|...
    // params.args: [{ type, value, description, ... }]
    const text = (params.args || []).map(argToString).join(' ');
    const ts = Date.now();
    consoleEntries.current.push({ id: 'c' + ts + '-' + consoleEntries.current.length, kind: 'console', level: params.type || 'log', text, ts });
    pushConsole();
  }
  function onExceptionEvent(params) {
    const ex = params.exceptionDetails || {};
    const text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
    const ts = Date.now();
    consoleEntries.current.push({ id: 'c' + ts + '-' + consoleEntries.current.length, kind: 'exception', level: 'error', text, ts });
    pushConsole();
  }
  function pushConsole() {
    const vl = consoleVL.current;
    if (vl) {
      const data = consoleEntries.current.slice(-2000);
      try { vl.setData(data); vl.scrollToIndex(data.length - 1); } catch { /* vl destroyed */ consoleVL.current = null; }
    }
  }
  function argToString(arg) {
    if (!arg) return '';
    if (typeof arg.value !== 'undefined') return String(arg.value);
    if (typeof arg.description !== 'undefined') return arg.description;
    if (arg.type === 'function') return 'ƒ ' + (arg.description || '');
    return arg.type || '';
  }

  // Network entries are keyed by requestId. We keep a small map of
  // requestId -> entry; responseReceived / loadingFinished / loadingFailed
  // mutate that single record so a row carries the final status + duration.
  const reqMap = useRef(new Map());
  function onRequestWillBeSent(params) {
    const req = params.request || {};
    const entry = {
      id: 'n' + (params.requestId || '') + '-' + reqMap.current.size,
      kind: 'request',
      method: req.method || 'GET',
      url: req.url || '',
      status: 'pending',
      type: (params.type || '').toLowerCase() || null,
      initiator: params.initiator && params.initiator.url || null,
      ts: Date.now(),
      _start: typeof params.timestamp === 'number' ? params.timestamp : null,
      duration: null
    };
    reqMap.current.set(params.requestId, entry);
    networkEntries.current.push(entry);
    pushNetwork();
  }
  function onResponseReceived(params) {
    const r = params.response || {};
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = r.status || 0;
    entry.statusText = r.statusText || '';
    entry.type = r.type || entry.type;
    pushNetwork();
  }
  function onLoadingFinished(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.duration = (typeof params.timestamp === 'number' && entry._start != null) ? Math.round((params.timestamp - entry._start) * 1000) : null;
    pushNetwork();
  }
  function onLoadingFailed(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = 'failed';
    entry.statusText = params.errorText || 'failed';
    pushNetwork();
  }
  function pushNetwork() {
    const vl = networkVL.current;
    if (vl) {
      const data = networkEntries.current.slice(-2000);
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
  }

  // ---- Setup phase ----------------------------------------------------
  async function loadConfig() {
    let r;
    try { r = await fetchJson('/api/inspector/config'); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    debuggerUrl.current = r.body.url || '';
    defaultUrl.current = r.body.defaultUrl || '';
    if (urlInput.current) urlInput.current.value = debuggerUrl.current;
    if (statusEl.current) statusEl.current.textContent = debuggerUrl.current ? ('current: ' + debuggerUrl.current) : 'using default: ' + defaultUrl.current;
    rerender();
  }
  async function saveConfig() {
    if (!urlInput.current) return;
    const next = (urlInput.current.value || '').trim();
    if (!next) { if (statusEl.current) statusEl.current.textContent = 'url is required'; return; }
    saveBtn.current.disabled = true;
    if (statusEl.current) statusEl.current.textContent = 'saving…';
    let r;
    try { r = await fetchJson('/api/inspector/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: next }) }); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    debuggerUrl.current = r.body.url || next;
    if (statusEl.current) statusEl.current.textContent = 'saved.';
  }
  async function loadTargets() {
    if (statusEl.current) statusEl.current.textContent = 'fetching targets…';
    let r;
    try { r = await fetchJson('/api/inspector/targets'); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = msg;
      return;
    }
    targets.current = r.body.targets || [];
    phase.current = 'targets';
    if (statusEl.current) statusEl.current.textContent = targets.current.length + ' targets';
    rerender();
  }

  // ---- Render --------------------------------------------------------
  useEffect(() => { loadConfig(); return () => { disconnect(); }; }, []);

  // Re-render is driven by stateTick.current via forceUpdate() below.
  // forceUpdate() bumps route.value to trigger a full app re-render.

  // Phase 1: setup
  if (phase.current === 'setup') {
    return h(Fragment, null,
      h('section', null,
        h('p', { class: 'hint' }, 'Connect to a Chrome instance started with ', h('code', null, '--remote-debugging-port=9222'), '. The address below is the HTTP base of that instance (used to discover page targets); the WebSocket itself is proxied through mouaif.'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'inspectorUrl' }, 'Chrome debugger URL'),
          h('input', { ref: urlInput, class: 'input', id: 'inspectorUrl', type: 'text', placeholder: 'http://127.0.0.1:9222' })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Discover only')
        ),
        h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
        h('p', { class: 'hint' }, 'Tip: on a phone, run ', h('code', null, 'adb reverse tcp:9222 tcp:9222'), ' and point the URL at ', h('code', null, 'http://127.0.0.1:9222'), '. The address is stored in the app SQLite store.')
      )
    );
  }

  // Phase 2: target picker
  if (phase.current === 'targets') {
    function renderTargets() {
      if (!targetsList.current) return;
      targetsList.current.innerHTML = '';
      if (!targets.current.length) {
        const li = document.createElement('li');
        li.className = 'inspector__empty';
        li.textContent = 'no targets. Open a tab in Chrome and tap "Refresh targets".';
        targetsList.current.appendChild(li);
        return;
      }
      for (const t of targets.current) {
        const li = document.createElement('li');
        li.className = 'inspector__target';
        const top = document.createElement('div');
        top.className = 'inspector__target-top';
        const title = document.createElement('div');
        title.className = 'inspector__target-title';
        title.textContent = t.title || t.url || t.id;
        const type = document.createElement('span');
        type.className = 'inspector__target-type';
        type.textContent = t.type || 'page';
        top.appendChild(title); top.appendChild(type);
        const url = document.createElement('div');
        url.className = 'inspector__target-url';
        url.textContent = t.url || t.webSocketDebuggerUrl || t.id;
        const btn = document.createElement('button');
        btn.className = 'inspector__target-btn btn btn--primary';
        btn.type = 'button';
        btn.textContent = 'Connect';
        btn.addEventListener('click', () => connect(t));
        li.appendChild(top); li.appendChild(url); li.appendChild(btn);
        targetsList.current.appendChild(li);
      }
    }
    // Defer to next tick so the ref is attached.
    setTimeout(renderTargets, 0);
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to inspector setup', onClick: (e) => { e.preventDefault(); disconnect(); phase.current = 'setup'; rerender(); } }, '←'),
        h('h2', { class: 'view-title' }, 'Pick a target')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'Tap a target to attach the inspector to it. Connection is over ', h('code', null, 'ws://'), ' via mouaif (port ' + String(window.location.port || 5732) + '); data flows both ways in real time.'),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Refresh targets')
        ),
        h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
        h('ul', { ref: targetsList, class: 'inspector__targets', 'aria-label': 'Discoverable targets' })
      )
    );
  }

  // Phase 3: connected — render the Console + Network panels.
  const t = currentTarget.current;
  const activePanel = panel.current;
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); phase.current = 'targets'; rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target'))
    ),
    h('section', null,
      h('p', { class: 'hint' }, h('code', null, (t && t.type) || 'page'), ' — ', h('code', null, t && t.url || '')),
      h('div', { class: 'inspector__subtabs', role: 'tablist' },
        h('button', { class: 'inspector__subtab' + (activePanel === 'console' ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(activePanel === 'console'), onClick: () => { panel.current = 'console'; rerender(); } }, 'Console'),
        h('button', { class: 'inspector__subtab' + (activePanel === 'network' ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(activePanel === 'network'), onClick: () => { panel.current = 'network'; rerender(); } }, 'Network')
      ),
      h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
      activePanel === 'console'
        ? h(ConsolePanel, { vlRef: consoleVL, onReady: (vl) => { consoleVL.current = vl; pushConsole(); } })
        : h(NetworkPanel, { vlRef: networkVL, onReady: (vl) => { networkVL.current = vl; pushNetwork(); } })
    )
  );
}

// Console / Network panels: a virtual list with a fixed item height.
// The list is mounted once per panel-switch; we forward the instance
// back up so the inspector can push new rows.
function ConsolePanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 44,
      overscan: 6,
      render: (item, node) => {
        node.className = 'inspector__row inspector__row--console inspector__row--' + (item.level || 'log');
        const time = document.createElement('span');
        time.className = 'inspector__row-time';
        time.textContent = fmtTime(item.ts);
        const level = document.createElement('span');
        level.className = 'inspector__row-level';
        level.textContent = (item.level || 'log').toUpperCase();
        const text = document.createElement('span');
        text.className = 'inspector__row-text';
        text.textContent = item.text || '';
        node.replaceChildren(time, level, text);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller', 'aria-label': 'Console output' });
}

function NetworkPanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 48,
      overscan: 6,
      render: (item, node) => {
        node.className = 'inspector__row inspector__row--network';
        const method = document.createElement('span');
        method.className = 'inspector__row-method';
        method.textContent = item.method || '';
        const status = document.createElement('span');
        status.className = 'inspector__row-status inspector__row-status--' + statusClass(item.status);
        status.textContent = statusLabel(item.status);
        const url = document.createElement('span');
        url.className = 'inspector__row-text';
        url.textContent = item.url || '';
        node.replaceChildren(method, status, url);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller', 'aria-label': 'Network log' });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}
function statusLabel(s) {
  if (s === 'pending') return '···';
  if (s === 'failed') return 'FAIL';
  return String(s);
}
function statusClass(s) {
  if (s === 'pending') return 'pending';
  if (s === 'failed') return 'failed';
  const n = Number(s);
  if (!isNaN(n) && n >= 400) return 'error';
  if (!isNaN(n) && n >= 300) return 'redirect';
  if (!isNaN(n) && n >= 200) return 'ok';
  return 'other';
}

// Force a re-render of the whole InspectorView from a ref-only path.
// We attach a state-bearing ref to a no-op <span> via the signal
// pattern: Preact's `useState` would also work but we'd need a hook.
// Easiest correct trick: use the route signal we already have. The
// inspector doesn't depend on the route, but writing to it triggers a
// full app re-render — heavier than necessary but only happens on
// phase changes (rare).
function forceUpdate() { route.value = Object.assign({}, route.value); }



const projectsReload = signal(0);

function ProjectsView() {
  const refreshProjects = useRef(null);
  const projectsList = useRef(null);
  const projectsStatus = useRef(null);

  // Status line helper: sets text + a data-state so the CSS can color
  // it semantically (busy = blue, error = red, success = green, idle
  // = muted). One call site keeps the conventions in one place.
  function setStatus(text, state) {
    if (!projectsStatus.current) return;
    projectsStatus.current.textContent = text;
    if (state) projectsStatus.current.dataset.state = state;
    else delete projectsStatus.current.dataset.state;
  }

  async function loadProjects() {
    setStatus('loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/projects/registered'); }
    catch (err) { setStatus('network error', 'error'); return; }
    if (r.status !== 200) { setStatus('HTTP ' + r.status, 'error'); return; }
    const list = r.body.projects || [];
    projectsList.current.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'projects__empty';
      const icon = document.createElement('span');
      icon.className = 'projects__empty-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44L11.88 8.38a.5.5 0 0 0 .354.146H19.5A1.5 1.5 0 0 1 21 10.027v7.473A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/></svg>';
      const title = document.createElement('p');
      title.className = 'projects__empty-title';
      title.textContent = 'No projects yet';
      const text = document.createElement('p');
      text.className = 'projects__empty-text';
      text.textContent = 'Tap "Add project" to register a folder on disk. Each project keeps its own chats, prompt profile, and trace setting.';
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
      projectsList.current.appendChild(empty);
      setStatus(list.length + ' projects');
      return;
    }
    setStatus(list.length + ' projects', 'success');
    for (const project of list) {
      const li = document.createElement('li');
      li.className = 'project-card';
      li.appendChild(renderProjectCard(project));
      projectsList.current.appendChild(li);
      loadProjectChats(li, project);
    }
  }

  function renderProjectCard(project) {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'project-card__head';
    const name = document.createElement('div');
    name.className = 'project-card__name';
    name.textContent = project.name || project.path;
    head.appendChild(name);
    head.appendChild(renderProjectMenu(project));
    frag.appendChild(head);

    const pathEl = document.createElement('div');
    pathEl.className = 'project-card__path';
    pathEl.textContent = project.path;
    frag.appendChild(pathEl);

    const chatsUl = document.createElement('ul');
    chatsUl.className = 'project-card__chats';
    chatsUl.setAttribute('aria-label', 'Chats in ' + (project.name || project.path));
    const placeholder = document.createElement('li');
    placeholder.className = 'project-card__chats-empty';
    placeholder.textContent = 'loading chats…';
    chatsUl.appendChild(placeholder);
    frag.appendChild(chatsUl);

    const newBtn = document.createElement('button');
    newBtn.className = 'project-card__new';
    newBtn.type = 'button';
    newBtn.textContent = '+ New chat';
    newBtn.addEventListener('click', () => createProjectChat(project, newBtn, chatsUl));
    frag.appendChild(newBtn);

    return frag;
  }

  function renderProjectMenu(project) {
    const wrap = document.createElement('div');
    wrap.className = 'project-card__menu';
    const btn = document.createElement('button');
    btn.className = 'project-card__menu-btn';
    btn.type = 'button';
    btn.textContent = '⋯';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Project options');
    wrap.appendChild(btn);
    const pop = document.createElement('div');
    pop.className = 'project-card__menu-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'menu');
    function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function toggle() { pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', () => close());
    function addItem(label, fn, danger) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      if (danger) b.setAttribute('data-danger', '1');
      b.addEventListener('click', (e) => { e.stopPropagation(); close(); fn(); });
      pop.appendChild(b);
    }
    addItem('Rename…', () => renameProject(project));
    addItem('Unregister', () => unregisterProject(project), true);
    wrap.appendChild(pop);
    return wrap;
  }

  async function loadProjectChats(cardLi, project) {
    const ul = cardLi.querySelector('.project-card__chats');
    let r;
    try { r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path)); }
    catch (err) { renderChatList(ul, [], project); return; }
    if (r.status !== 200) { renderChatList(ul, [], project); return; }
    renderChatList(ul, r.body.chats || [], project);
  }

  function renderChatList(ul, chats, project) {
    ul.innerHTML = '';
    if (!chats.length) {
      const empty = document.createElement('li');
      empty.className = 'project-card__chats-empty';
      empty.textContent = 'no chats yet';
      ul.appendChild(empty);
      return;
    }
    for (const c of chats) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'project-card__chat-title';
      title.textContent = c.title || c.id;
      li.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'project-card__chat-meta';
      meta.textContent = c.promptSize + ' · ' + fmtDate(c.lastOpenedAt || c.createdAt);
      li.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'project-card__chat-delete';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete chat ' + (c.title || c.id));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteProjectChat(project, c, li, ul); });
      li.appendChild(del);
      li.addEventListener('click', () => nav('chat/' + c.id + '?projectDir=' + encodeURIComponent(project.path)));
      ul.appendChild(li);
    }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  async function createProjectChat(project, btn, ul) {
    btn.disabled = true;
    const r = await fetchJson('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: project.path }) });
    btn.disabled = false;
    if (r.status !== 201) { alert('create chat failed: HTTP ' + r.status); return; }
    const card = btn.closest('.project-card');
    if (card) loadProjectChats(card, project);
  }

  async function deleteProjectChat(project, chat, li, ul) {
    if (!confirm('Delete chat "' + (chat.title || chat.id) + '"?')) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path), { method: 'DELETE' });
    if (r.status !== 200) { alert('delete failed: HTTP ' + r.status); return; }
    li.remove();
    if (!ul.children.length) renderChatList(ul, [], project);
  }

  async function renameProject(project) {
    const next = prompt('Rename project', project.name || project.path);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === project.name) return;
    const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed }) });
    if (r.status !== 200) { alert('rename failed: HTTP ' + r.status); return; }
    loadProjects();
  }

  async function unregisterProject(project) {
    if (!confirm('Unregister project "' + (project.name || project.path) + '"? The folder on disk is not touched.')) return;
    const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'DELETE' });
    if (r.status !== 200) { alert('unregister failed: HTTP ' + r.status); return; }
    loadProjects();
  }

  useEffect(() => { loadProjects(); }, [projectsReload.value]);

  return h('section', null,
    h('div', { class: 'row row--actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => nav('projects/new') }, '+ Add project'),
      h('button', { ref: refreshProjects, class: 'btn', type: 'button', onClick: loadProjects }, 'Refresh'),
      h('span', { ref: projectsStatus, class: 'status', 'aria-live': 'polite' })
    ),
    h('ul', { ref: projectsList, class: 'projects__list', 'aria-label': 'Registered projects' })
  );
}

// ---- Project picker ----------------------------------------------------
// A mobile-first filesystem browser. Lets the user drill into directories
// (anywhere under the user home, per /api/projects) and register the
// current folder as a project, or create a new folder and drill into it.
//
// The hash route is #/projects/new?dir=<abs>. The query string carries
// the current directory across reloads; an empty dir starts at the
// user home (the API defaults the same way).
//
// Renders with direct DOM writes — same pattern as ProjectsView —
// because the list is small (immediate subdirs only) and we want zero
// layout thrash.
function ProjectPickerView(props) {
  const statusEl = useRef(null);
  const listEl = useRef(null);
  const newNameEl = useRef(null);
  const createBtn = useRef(null);
  const currentDir = signal(typeof props.dir === 'string' ? props.dir : '');

  async function load(dir) {
    if (dir) currentDir.value = dir;
    const useDir = currentDir.value;
    if (statusEl.current) statusEl.current.textContent = 'loading…';
    if (listEl.current) listEl.current.innerHTML = '';
    const url = useDir ? ('/api/projects?dir=' + encodeURIComponent(useDir)) : '/api/projects';
    let r;
    try { r = await fetchJson(url); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      return;
    }
    currentDir.value = r.body.dir || useDir;
    if (statusEl.current) statusEl.current.textContent = r.body.entries.length + ' folders';
    renderEntries(r.body.entries || [], r.body.dir);
  }

  function renderEntries(entries, dir) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'picker__empty';
      li.textContent = 'no subfolders here';
      listEl.current.appendChild(li);
      return;
    }
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'picker__row';
      const name = document.createElement('span');
      name.className = 'picker__name';
      name.textContent = e.name;
      li.appendChild(name);
      if (e.hasChildren) {
        const open = document.createElement('button');
        open.className = 'picker__open';
        open.type = 'button';
        open.textContent = 'Open';
        open.setAttribute('aria-label', 'Open ' + e.name);
        open.addEventListener('click', () => nav('projects/new?dir=' + encodeURIComponent(e.path)));
        li.appendChild(open);
      } else {
        const leaf = document.createElement('span');
        leaf.className = 'picker__leaf';
        leaf.textContent = 'empty';
        li.appendChild(leaf);
      }
      const select = document.createElement('button');
      select.className = 'picker__select';
      select.type = 'button';
      select.textContent = 'Select';
      select.setAttribute('aria-label', 'Select ' + e.name);
      select.addEventListener('click', () => selectDir(e.path));
      li.appendChild(select);
      listEl.current.appendChild(li);
    }
  }

  async function selectDir(dir) {
    if (statusEl.current) statusEl.current.textContent = 'registering…';
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'register', dir }) }); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      return;
    }
    projectsReload.value++;
    nav('projects');
  }

  async function createFolder() {
    const name = (newNameEl.current && newNameEl.current.value || '').trim();
    if (!name) { if (statusEl.current) statusEl.current.textContent = 'name is required'; return; }
    const parent = currentDir.value;
    if (createBtn.current) createBtn.current.disabled = true;
    if (statusEl.current) statusEl.current.textContent = 'creating…';
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', parent, name }) }); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; if (createBtn.current) createBtn.current.disabled = false; return; }
    if (r.status === 201) {
      if (newNameEl.current) newNameEl.current.value = '';
      if (statusEl.current) statusEl.current.textContent = 'created.';
      // Drill into the new folder so the user can see it and select it.
      nav('projects/new?dir=' + encodeURIComponent(r.body.path));
    } else {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (createBtn.current) createBtn.current.disabled = false;
    }
  }

  function parentDir() {
    const d = currentDir.value;
    if (!d) return null;
    // Walk up one level. Works for both \ and / separators.
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : '';
  }

  useEffect(() => { load(props.dir || ''); }, [props.dir]);

  return h('section', null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
      h('h2', { class: 'view-title' }, 'Pick a project folder')
    ),
    h('p', { class: 'hint picker__path' }, currentDir.value || 'user home'),
    h('div', { class: 'row row--actions' },
      currentDir.value ? h('button', { class: 'btn', type: 'button', onClick: () => { const p = parentDir(); nav('projects/new?dir=' + encodeURIComponent(p || '')); } }, '↑ Up') : null,
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => selectDir(currentDir.value) }, 'Select this folder'),
      h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
    ),
    h('ul', { ref: listEl, class: 'picker__list', 'aria-label': 'Subfolders' }),
    h('details', { class: 'picker__create' },
      h('summary', null, 'Create new folder'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'newFolderName' }, 'name'),
        h('input', { ref: newNameEl, class: 'input', id: 'newFolderName', type: 'text', placeholder: 'my-new-app' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: createBtn, class: 'btn btn--primary', type: 'button', onClick: createFolder }, 'Create')
      )
    )
  );
}

function ChatView(props) {
  const chatId = props.chatId;
  const projectDir = props.projectDir;
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const traceToggle = useRef(null);
  const promptSizeSelect = useRef(null);
  const transcript = useRef(null);
  const modelSelect = useRef(null);
  const promptInput = useRef(null);
  const sendBtn = useRef(null);
  const statusEl = useRef(null);

  // Status line helper: sets text + a data-state so the CSS can color
  // it semantically. Centralized so the streaming / error / done
  // transitions are all written the same way.
  function setChatStatus(text, state) {
    if (!statusEl.current) return;
    statusEl.current.textContent = text;
    if (state) statusEl.current.dataset.state = state;
    else delete statusEl.current.dataset.state;
  }

  // Latest chat record from the server; populated by load() and by
  // updateChat(). Stored in refs (not signals) because the data is
  // only read in imperative DOM helpers, never in the JSX tree.
  // Using `let signal()` inside the component body would lose state
  // on re-render — refs persist across renders.
  const chatRef = useRef(null);
  const messagesRef = useRef([]);
  const modelsRef = useRef([]);

  async function load() {
    if (!projectDir || !chatId) return;
    const [rChat, rModels, rMsgs] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rChat.status !== 200) { statusEl.current.textContent = 'chat not found'; populateModelSelect(rModels.status === 200 ? (rModels.body.models || []) : []); return; }
    const c = rChat.body.chat;
    chatRef.current = c;
    messagesRef.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
    modelsRef.current = rModels.status === 200 ? (rModels.body.models || []) : [];

    if (chatName.current) chatName.current.textContent = c.title || chatId;
    if (chatMeta.current) chatMeta.current.textContent = (c.promptSize || 'average') + ' · ' + (c.trace ? 'trace on' : 'trace off');
    if (traceToggle.current) traceToggle.current.checked = !!c.trace;
    if (promptSizeSelect.current) promptSizeSelect.current.value = c.promptSize || 'average';

    if (modelSelect.current) populateModelSelect(modelsRef.current);

    renderTranscript();
  }

  // Render the model <select> from a list. Used by load() on the
  // happy path and on the chat-not-found path so the head never
  // shows a blank dropdown.
  function populateModelSelect(list) {
    if (!modelSelect.current) return;
    modelSelect.current.innerHTML = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id + (m.label ? ' — ' + m.label : '');
      modelSelect.current.appendChild(opt);
    }
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no models — define models in project settings)';
      modelSelect.current.appendChild(opt);
    }
  }

  function renderTranscript() {
    if (!transcript.current) return;
    transcript.current.innerHTML = '';
    if (!messagesRef.current.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-view__empty';
      const icon = document.createElement('span');
      icon.className = 'chat-view__empty-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9.586a1.5 1.5 0 0 0-1.06.44l-2.122 2.12A.5.5 0 0 1 6.4 20.146V18H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3 5a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H7Zm0 4a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H7Z"/></svg>';
      const title = document.createElement('p');
      title.className = 'chat-view__empty-title';
      title.textContent = 'Start the conversation';
      const text = document.createElement('p');
      text.className = 'chat-view__empty-text';
      text.textContent = 'Type a message below. The model streams its reply in real time; everything you send is saved to this chat’s transcript on disk.';
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
      transcript.current.appendChild(empty);
      return;
    }
    for (const m of messagesRef.current) appendMessageToTranscript(m, false);
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  function appendMessageToTranscript(m, isLive) {
    if (!transcript.current) return;
    const empty = transcript.current.querySelector('.chat-view__empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--' + m.role;
    if (isLive) row.dataset.live = '1';
    const role = document.createElement('div');
    role.className = 'chat-msg__role';
    role.textContent = m.role;
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    body.textContent = m.content || '';
    const ts = document.createElement('div');
    ts.className = 'chat-msg__ts';
    ts.textContent = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    row.appendChild(role); row.appendChild(body); row.appendChild(ts);
    transcript.current.appendChild(row);
    if (m.role === 'assistant' && isLive) row._body = body;
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  function appendDeltaToLive(delta) {
    if (!transcript.current) return;
    const live = transcript.current.querySelector('[data-live="1"] .chat-msg__body');
    if (live) {
      live.textContent += delta;
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }

  function finalizeLiveMessage(message) {
    if (!transcript.current) return;
    const liveRow = transcript.current.querySelector('[data-live="1"]');
    if (liveRow) {
      delete liveRow.dataset.live;
      if (liveRow._body && message && typeof message.content === 'string') liveRow._body.textContent = message.content;
    }
  }

  // Per-chat settings: PATCH /api/chats/:id with the new field. Each
  // updater writes to the local `chat` signal and refreshes the
  // visible meta line so the user sees the change stick.
  async function updateChat(patch) {
    if (!projectDir || !chatId) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir }, patch || {}))
    });
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    chatRef.current = r.body.chat;
    if (chatMeta.current && chatRef.current) chatMeta.current.textContent = (chatRef.current.promptSize || 'average') + ' · ' + (chatRef.current.trace ? 'trace on' : 'trace off');
  }

  function renameChat() {
    if (!chatRef.current) return;
    const next = prompt('Rename chat', chatRef.current.title || chatId);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === chatRef.current.title) return;
    updateChat({ title: trimmed }).then(() => {
      if (chatRef.current && chatName.current) chatName.current.textContent = chatRef.current.title || chatId;
    });
  }

  function onTraceChange() {
    if (!traceToggle.current) return;
    updateChat({ trace: !!traceToggle.current.checked });
  }

  function onPromptSizeChange() {
    if (!promptSizeSelect.current) return;
    const v = promptSizeSelect.current.value;
    if (['very-small', 'average', 'extensive'].indexOf(v) < 0) return;
    updateChat({ promptSize: v });
  }

  function deleteThisChat() {
    if (!chatRef.current) return;
    if (!confirm('Delete this chat? Its messages will be removed; any exported trace file will be kept.')) return;
    fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' })
      .then((r) => {
        if (r.status === 200) { projectsReload.value++; nav('projects'); }
        else if (statusEl.current) statusEl.current.textContent = 'delete failed: HTTP ' + r.status;
      })
      .catch((err) => { if (statusEl.current) statusEl.current.textContent = 'network error'; });
  }

  async function send() {
    if (!projectDir || !chatId) return;
    const modelId = modelSelect.current ? modelSelect.current.value : '';
    const content = (promptInput.current.value || '').trim();
    if (!content) { statusEl.current.textContent = 'type something'; return; }
    if (!modelId) { statusEl.current.textContent = 'pick a model'; return; }

    sendBtn.current.disabled = true;
    setChatStatus('streaming…', 'busy');
    promptInput.current.value = '';
    autoresize();

    const userMsg = { role: 'user', content, ts: new Date().toISOString() };
    messagesRef.current = messagesRef.current.concat([userMsg]);
    appendMessageToTranscript(userMsg, false);
    const liveMsg = { role: 'assistant', content: '', ts: new Date().toISOString() };
    appendMessageToTranscript(liveMsg, true);

    let resp;
    try {
      resp = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, modelId, content })
      });
    } catch (err) {
      setChatStatus('network error', 'error');
      finalizeLiveMessage({ content: '[network error]' });
      if (sendBtn.current) sendBtn.current.disabled = false;
      return;
    }
    if (!resp.ok) {
      const text = await resp.text();
      setChatStatus('HTTP ' + resp.status, 'error');
      finalizeLiveMessage({ content: '[error: HTTP ' + resp.status + ']' });
      sendBtn.current.disabled = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', assembled = '';
    let usage = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = parseSSEFrame(frame); if (!ev) continue;
        let data; try { data = JSON.parse(ev.data); } catch { continue; }
        if (ev.eventName === 'message' && typeof data.delta === 'string') { assembled += data.delta; appendDeltaToLive(data.delta); }
        else if (ev.eventName === 'done') { usage = data.usage || null; }
        else if (ev.eventName === 'error') { statusEl.current.textContent = 'error: ' + (data.code || '') + ' ' + (data.message || ''); }
      }
    }
    finalizeLiveMessage({ content: assembled });
    messagesRef.current = messagesRef.current.concat([{ role: 'assistant', content: assembled, ts: new Date().toISOString() }]);
    if (statusEl.current.textContent === 'streaming…') {
      setChatStatus(usage ? ('done — ' + usage.promptTokens + ' in, ' + usage.completionTokens + ' out') : 'done', 'success');
    }
    sendBtn.current.disabled = false;
  }

  // Popover state for the ⚙ button in the head. Hidden by default;
  // tapping the button toggles the inline panel that holds the
  // trace toggle + prompt-size selector. Kept as a ref (not state)
  // so Preact doesn't tear down the popover's event listeners on
  // every change.
  const settingsPopRef = useRef(null);
  const settingsBtnRef = useRef(null);

  // Auto-grow the composer textarea. We listen on input, reset the
  // height to 0 so scrollHeight measures the new content, then set
  // the height to the measured value (clamped via CSS to a 140 px
  // max). Listening on input (not keydown) so paste / cut also work.
  // Called once on mount so a long initial draft is sized correctly.
  function autoresize() {
    const el = promptInput.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(140, Math.max(40, el.scrollHeight));
    el.style.height = next + 'px';
  }

  function toggleSettings() {
    const pop = settingsPopRef.current;
    const btn = settingsBtnRef.current;
    if (!pop || !btn) return;
    const open = pop.hidden;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  useEffect(() => {
    // Close the settings popover on outside click / Escape. We attach
    // once on mount and rely on the unmount to detach it; the
    // popover's `hidden` attribute is the source of truth.
    function close() { if (settingsPopRef.current && !settingsPopRef.current.hidden) { settingsPopRef.current.hidden = true; if (settingsBtnRef.current) settingsBtnRef.current.setAttribute('aria-expanded', 'false'); } }
    function onDocClick(e) { const pop = settingsPopRef.current; const btn = settingsBtnRef.current; if (!pop || pop.hidden) return; if (pop.contains(e.target) || (btn && btn.contains(e.target))) return; close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    // Composer textarea auto-grow. We listen on input so paste,
    // cut, and IME end also reset the height.
    if (promptInput.current) { promptInput.current.addEventListener('input', autoresize); autoresize(); }
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (promptInput.current) promptInput.current.removeEventListener('input', autoresize);
    };
  }, []);

  // Enter sends, Shift+Enter inserts a newline. The composer is
  // a single-line textarea by default (it grows to multiple lines
  // as the user types), so Enter-to-send matches the user's
  // expectation for a chat app.
  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  useEffect(() => { load().catch((err) => { if (statusEl.current) statusEl.current.textContent = 'load failed'; }); }, [chatId, projectDir]);

  return h('section', { class: 'chat-view' },
    h('div', { class: 'chat-view__head' },
      h('button', { ref: back, class: 'chat-view__back', type: 'button', onClick: () => nav('projects'), 'aria-label': 'Back to projects' }, '←'),
      h('div', { class: 'chat-view__title-stack' },
        h('div', { ref: chatName, class: 'chat-view__name' }, '…'),
        h('div', { ref: chatMeta, class: 'chat-view__meta' }, '')
      ),
      h('select', { ref: modelSelect, class: 'input chat-view__model', id: 'chatModel', 'aria-label': 'Model' }),
      h('div', { class: 'chat-view__settings-wrap' },
        h('button', { ref: settingsBtnRef, class: 'chat-view__iconbtn', type: 'button', onClick: toggleSettings, 'aria-label': 'Chat settings', 'aria-expanded': 'false', title: 'Settings' },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })
          )
        ),
        h('div', { ref: settingsPopRef, class: 'chat-view__settings-pop', hidden: true, role: 'dialog', 'aria-label': 'Chat settings' },
          h('label', { class: 'row row--inline chat-view__settings-row', for: 'chatPromptSize' },
            h('span', { class: 'label' }, 'Prompt size'),
            h('select', { ref: promptSizeSelect, class: 'input', id: 'chatPromptSize', onChange: onPromptSizeChange },
              h('option', { value: 'very-small' }, 'very-small'),
              h('option', { value: 'average' }, 'average'),
              h('option', { value: 'extensive' }, 'extensive')
            )
          ),
          h('label', { class: 'row row--inline chat-view__settings-row', for: 'chatTrace' },
            h('input', { ref: traceToggle, class: 'checkbox', id: 'chatTrace', type: 'checkbox', onChange: onTraceChange }),
            h('span', { class: 'label' }, 'Trace to file')
          )
        )
      ),
      h('button', { class: 'chat-view__iconbtn', type: 'button', onClick: renameChat, 'aria-label': 'Rename chat', title: 'Rename' }, '✎'),
      h('button', { class: 'chat-view__iconbtn chat-view__iconbtn--danger', type: 'button', onClick: deleteThisChat, 'aria-label': 'Delete chat', title: 'Delete' }, '×')
    ),
    h('div', { ref: transcript, class: 'chat-view__transcript', 'aria-live': 'polite' }),
    h('div', { class: 'chat-view__composer' },
      h('textarea', { ref: promptInput, class: 'input chat-view__textarea', id: 'chatPrompt', rows: 1, placeholder: 'Type a message', onKeydown: onComposerKey }),
      h('button', { ref: sendBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: send, 'aria-label': 'Send' },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
        )
      ),
      h('span', { ref: statusEl, class: 'status chat-view__status', 'aria-live': 'polite' })
    )
  );
}

// ---- Render ------------------------------------------------------------

const root = document.getElementById('app');
if (root) render(h(App, null), root);
