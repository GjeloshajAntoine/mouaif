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
import { signal, computed, effect } from '@preact/signals';
import { createVirtualList } from './virtual-list.js';
import './style.css';

const $ = (sel) => document.querySelector(sel);

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
  if (!h) return { name: 'projects' };
  if (h === 'projects') return { name: 'projects' };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'auth') return { name: 'auth' };
  if (h === 'inspector') return { name: 'inspector' };
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
  return { name: 'projects' };
}

window.addEventListener('hashchange', () => { route.value = parseHash(); });

function nav(toHash) {
  window.location.hash = '#/' + toHash;
}

// ---- Components --------------------------------------------------------

function App() {
  const view = route.value;
  // Drill-in screens (chat, picker) get their own per-screen back button
  // and do not show the global tab bar. Everything else does.
  const showTabBar = view.name !== 'chat' && view.name !== 'picker';
  let body = null;
  if (view.name === 'projects') body = h(ProjectsView, null);
  else if (view.name === 'picker') body = h(ProjectPickerView, { dir: view.dir });
  else if (view.name === 'chat') body = h(ChatView, { chatId: view.chatId, projectDir: view.projectDir });
  else if (view.name === 'settings') body = h(SettingsView, null);
  else if (view.name === 'auth') body = h(AuthView, null);
  else if (view.name === 'inspector') body = h(InspectorView, null);
  else body = h(ProjectsView, null);
  return h('div', { class: 'app__shell' },
    h(Header, null),
    h('main', { class: 'app__main' + (showTabBar ? '' : ' app__main--flush') }, body),
    showTabBar ? h(BottomNav, null) : null
  );
}

function Header() {
  // The header is the brand block on the left plus a transparent
  // spacer on the right. The spacer is a layout placeholder so a
  // future header action (e.g. a search icon) can sit there without
  // pushing the brand around. Kept as small as possible — single
  // line, no subtitle — to maximize the content area on a phone.
  return h('header', { class: 'app__header' },
    h('div', { class: 'app__brand' },
      h('span', { class: 'app__logo', 'aria-hidden': 'true' }, 'm'),
      h('h1', { class: 'app__title' }, 'mouaif')
    ),
    h('span', { class: 'app__header-spacer', 'aria-hidden': 'true' })
  );
}

// ---- Bottom tab bar ---------------------------------------------------
// The three top-level destinations — Projects / Settings / Auth — are
// reached from a fixed bottom tab bar instead of the top header. The
// bar is hidden on the chat and folder-picker drill-in screens, which
// have their own per-screen back button.
//
// Inline SVG icons keep the bundle small and crisp at any density. The
// `currentColor` fill on the path means the existing color tokens
// drive the icon color in any state.

const TabIcon = {
  projects: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44L11.88 8.38a.5.5 0 0 0 .354.146H19.5A1.5 1.5 0 0 1 21 10.027v7.473A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z', fill: 'currentColor' })),
  inspector: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 3v2h16V7H4Zm0 4v2h7v-2H4Zm0 4v2h7v-2H4Zm9 0v2h7v-2h-7Z', fill: 'currentColor' })),
  settings: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })),
  auth: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Zm3 4a1.75 1.75 0 0 1 1 3.16V19a1 1 0 1 1-2 0v-1.84A1.75 1.75 0 0 1 12 14Z', fill: 'currentColor' }))
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
    tab('projects', 'projects', 'Projects'),
    tab('inspector', 'inspector', 'Inspector'),
    tab('settings', 'settings', 'Settings'),
    tab('auth', 'auth', 'Auth')
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

function AuthPanel() {
  const authOut = useRef(null);
  const refreshAuth = async () => {
    try {
      const r = await fetchJson('/api/auth/accounts');
      if (r.status !== 200) { authOut.current.textContent = 'HTTP ' + r.status; return; }
      const data = r.body;
      const accounts = data.accounts || {};
      const lines = [];
      for (const p of Object.keys(accounts)) {
        const list = accounts[p] || [];
        lines.push((list.length ? list.join(', ') : '(none)') + '  — ' + p);
      }
      authOut.current.textContent = lines.length ? lines.join('\n') : 'no providers';
    } catch (err) { if (authOut.current) authOut.current.textContent = 'network error'; }
  };
  useEffect(() => { refreshAuth(); const t = setInterval(refreshAuth, 5000); return () => clearInterval(t); }, []);

  const signInAnthropic = useRef(null);
  const signInStatus = useRef(null);
  const signInHelp = useRef(null);
  const signInCallback = useRef(null);
  const codeInput = useRef(null);
  const completeCode = useRef(null);
  let pendingState = null, pendingRedirect = null;

  async function startSignIn() {
    signInAnthropic.current.disabled = true;
    signInStatus.current.textContent = 'starting sign-in…';
    try {
      const r = await fetchJson('/api/auth/sign-in/anthropic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.status !== 200) { signInStatus.current.textContent = 'HTTP ' + r.status; signInAnthropic.current.disabled = false; return; }
      pendingState = r.body.state;
      pendingRedirect = r.body.authorizeUrl;
      window.open(pendingRedirect, '_blank', 'noopener');
      signInCallback.current.textContent = r.body.redirectUri || (window.location.origin + '/oauth/callback?provider=anthropic');
      signInHelp.current.hidden = false;
      signInStatus.current.textContent = 'waiting for browser…';
      const beforeResp = await fetchJson('/api/auth/accounts');
      const beforeAccounts = (beforeResp.body && beforeResp.body.accounts) || {};
      const before = new Set(beforeAccounts.anthropic || []);
      const started = Date.now();
      while (Date.now() - started < 5 * 60 * 1000) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const accounts = ((await fetchJson('/api/auth/accounts')).body.accounts || {}).anthropic || [];
          const fresh = accounts.filter(a => !before.has(a));
          if (fresh.length) { signInStatus.current.textContent = 'signed in as ' + fresh[0]; signInAnthropic.current.disabled = false; return; }
        } catch {}
      }
      signInStatus.current.textContent = 'timed out. Paste the code from the redirect URL below if your browser could not reach this host.';
      signInAnthropic.current.disabled = false;
    } catch (err) { if (signInStatus.current) signInStatus.current.textContent = 'network error'; if (signInAnthropic.current) signInAnthropic.current.disabled = false; }
  }

  async function completeWithCode() {
    const raw = (codeInput.current.value || '').trim();
    if (!pendingState || !pendingRedirect) { signInStatus.current.textContent = 'click "Sign in with Anthropic" first'; return; }
    let code = raw;
    try { const u = new URL(raw); const c = u.searchParams.get('code'); if (c) code = c; } catch {}
    if (!code) { signInStatus.current.textContent = 'paste the code from the redirect URL'; return; }
    completeCode.current.disabled = true;
    signInStatus.current.textContent = 'exchanging…';
    try {
      const r = await fetchJson('/oauth/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'anthropic', state: pendingState, code }) });
      if (r.status === 200 && r.body.ok) signInStatus.current.textContent = 'signed in as ' + r.body.account;
      else signInStatus.current.textContent = 'failed: ' + (r.body.error || ('HTTP ' + r.status));
    } catch (err) { if (signInStatus.current) signInStatus.current.textContent = 'network error'; }
    completeCode.current.disabled = false;
  }

  return h('section', null,
    h('p', { class: 'hint' }, 'OAuth tokens live in the OS keychain. The accounts list is read from ', h('code', null, '/api/auth/accounts'), '.'),
    h('pre', { ref: authOut, class: 'settings__out', 'aria-label': 'Auth status' }, 'loading…'),
    h('h3', { class: 'auth__sub' }, 'Sign in with Anthropic'),
    h('p', { class: 'hint' }, 'Opens the public Anthropic OAuth flow. PKCE S256. The access token is stored in the OS keychain under ', h('code', null, 'mouaif/anthropic'), '.'),
    h('div', { class: 'row' },
      h('button', { ref: signInAnthropic, class: 'btn btn--primary', type: 'button', onClick: startSignIn }, 'Sign in with Anthropic'),
      h('span', { ref: signInStatus, class: 'status', 'aria-live': 'polite' })
    ),
    h('div', { ref: signInHelp, class: 'auth__help', hidden: true },
      h('p', null, 'After authorizing, the browser redirects to ', h('code', null, h('span', { ref: signInCallback })), '. If you used the no-browser path, paste the ', h('code', null, 'code'), ' from the redirected URL here:'),
      h('div', { class: 'row' },
        h('input', { ref: codeInput, class: 'input', type: 'text', placeholder: 'code from ?code=...' }),
        h('button', { ref: completeCode, class: 'btn btn--primary', type: 'button', onClick: completeWithCode }, 'Complete sign-in')
      )
    )
  );
}

function SettingsPanel() {
  const promptSize = useRef(null);
  const traceByDefault = useRef(null);
  const saveBtn = useRef(null);
  const resetBtn = useRef(null);
  const appStatus = useRef(null);

  const modelsList = useRef(null);
  const mId = useRef(null), mProvider = useRef(null), mLabel = useRef(null), mBaseUrl = useRef(null), mApiKey = useRef(null);
  const mAuth = useRef(null), mOauthAccount = useRef(null);
  const addBtn = useRef(null), addModelStatus = useRef(null);

  const projectDir = useRef(null), loadProject = useRef(null), projectStatus = useRef(null), projectOut = useRef(null);

  let currentApp = {};
  // Most recent snapshot of /api/auth/accounts. Re-fetched when the
  // user toggles auth to "oauth" so the oauthAccount <select> can
  // show the signed-in emails for the chosen provider.
  let lastAccounts = {};

  async function loadSettings() {
    const r = await fetchJson('/api/settings');
    if (r.status !== 200) { if (appStatus.current) appStatus.current.textContent = 'HTTP ' + r.status; return; }
    currentApp = r.body.app || {};
    if (promptSize.current) promptSize.current.value = currentApp.promptSize || 'average';
    if (traceByDefault.current) traceByDefault.current.checked = !!currentApp.traceByDefault;
    renderModels(currentApp.models || []);
    if (appStatus.current) appStatus.current.textContent = '';
  }

  async function refreshAccounts() {
    const r = await fetchJson('/api/auth/accounts');
    if (r.status === 200) lastAccounts = (r.body && r.body.accounts) || {};
    return lastAccounts;
  }

  function providerKeyringNamespace(provider) {
    // For now, the keyring namespace for OAuth equals the AI client
    // provider (anthropic → anthropic). If a future provider diverges
    // (e.g. openai-compatible keyring, github-copilot keyring), this
    // is the one place to teach the UI about it.
    return provider;
  }

  function renderOauthAccountOptions(provider) {
    const sel = mOauthAccount.current;
    if (!sel) return;
    const ns = providerKeyringNamespace(provider);
    const accounts = (lastAccounts[ns] || []).slice();
    sel.innerHTML = '';
    // "(auto)" is the default and matches auth.resolveAccount's
    // single-account fallback. With multiple signed-in accounts, the
    // user must pick one explicitly.
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = accounts.length === 0
      ? '(auto — no accounts signed in)'
      : (accounts.length === 1
          ? '(auto — ' + accounts[0] + ')'
          : '(auto — pick one when multiple are signed in)');
    sel.appendChild(opt0);
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      sel.appendChild(opt);
    }
  }

  function renderModels(list) {
    modelsList.current.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No models configured. Add one below.';
      empty.style.color = 'var(--muted)';
      modelsList.current.appendChild(empty);
      return;
    }
    for (const m of list) {
      const li = document.createElement('li');
      const row = document.createElement('div'); row.className = 'models__row';
      const idSpan = document.createElement('span'); idSpan.className = 'models__id';
      idSpan.textContent = m.id + '  (' + m.provider + ')';
      const del = document.createElement('button'); del.className = 'btn btn--danger'; del.type = 'button'; del.textContent = 'Delete';
      del.addEventListener('click', () => deleteModel(m.id));
      row.appendChild(idSpan); row.appendChild(del);
      const meta = document.createElement('div'); meta.className = 'models__meta';
      const auth = m.auth || 'apikey';
      const bits = [m.label, m.baseUrl];
      if (auth === 'oauth') {
        bits.push('auth: oauth');
        if (m.oauthAccount) bits.push('account: ' + m.oauthAccount);
      } else if (m.hasApiKey) {
        bits.push('key: •••');
      }
      meta.textContent = bits.filter(Boolean).join('  ·  ');
      li.appendChild(row); li.appendChild(meta);
      modelsList.current.appendChild(li);
    }
  }

  async function saveApp() {
    saveBtn.current.disabled = true;
    appStatus.current.textContent = 'saving…';
    const r = await fetchJson('/api/settings/app', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promptSize: promptSize.current.value, traceByDefault: !!traceByDefault.current.checked }) });
    saveBtn.current.disabled = false;
    if (r.status === 200) { currentApp = r.body.app || currentApp; appStatus.current.textContent = 'saved.'; }
    else appStatus.current.textContent = 'HTTP ' + r.status;
  }

  async function resetApp() {
    if (!confirm('Reset all app-level settings to defaults? Models and other keys will be cleared.')) return;
    resetBtn.current.disabled = true;
    appStatus.current.textContent = 'resetting…';
    const r = await fetchJson('/api/settings/app/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['models', 'promptSize', 'traceByDefault', 'authAccounts', 'projects', 'flags'] }) });
    resetBtn.current.disabled = false;
    if (r.status === 200) { currentApp = r.body.app || {}; await loadSettings(); appStatus.current.textContent = 'reset.'; }
    else appStatus.current.textContent = 'HTTP ' + r.status;
  }

  async function addModel() {
    const id = (mId.current.value || '').trim();
    const provider = mProvider.current.value;
    const label = (mLabel.current.value || '').trim() || id;
    const baseUrl = (mBaseUrl.current.value || '').trim();
    const apiKey = (mApiKey.current.value || '').trim();
    const auth = mAuth.current ? mAuth.current.value : 'apikey';
    const oauthAccount = mOauthAccount.current ? (mOauthAccount.current.value || '').trim() : '';
    if (!id) { addModelStatus.current.textContent = 'id is required'; return; }
    if (auth === 'oauth') {
      // Re-fetch so we don't accidentally publish a stale empty list
      // if the user signed in on the Auth tab without coming back here.
      await refreshAccounts();
      const list = lastAccounts[providerKeyringNamespace(provider)] || [];
      if (list.length === 0) {
        addModelStatus.current.textContent = 'no signed-in account for "' + provider + '" — sign in on the Auth tab first';
        return;
      }
    }
    addBtn.current.disabled = true;
    addModelStatus.current.textContent = 'adding…';
    const body = { id, provider, label, auth };
    if (baseUrl) body.baseUrl = baseUrl;
    if (auth === 'apikey' && apiKey) body.apiKey = apiKey;
    if (auth === 'oauth' && oauthAccount) body.oauthAccount = oauthAccount;
    const r = await fetchJson('/api/settings/app/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    addBtn.current.disabled = false;
    if (r.status === 200) {
      currentApp.models = r.body.models;
      renderModels(r.body.models);
      addModelStatus.current.textContent = 'added ' + id + '.';
      mId.current.value = ''; mLabel.current.value = ''; mBaseUrl.current.value = ''; mApiKey.current.value = '';
      if (mOauthAccount.current) mOauthAccount.current.value = '';
    } else addModelStatus.current.textContent = 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : '');
  }

  async function deleteModel(id) {
    if (!confirm('Delete model ' + id + '?')) return;
    const r = await fetchJson('/api/settings/app/models/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.status === 200) { currentApp.models = r.body.models; renderModels(r.body.models); }
    else alert('delete failed: HTTP ' + r.status);
  }

  async function loadProjectFile() {
    const dir = (projectDir.current.value || '').trim();
    if (!dir) { projectStatus.current.textContent = 'projectDir is required'; return; }
    loadProject.current.disabled = true;
    projectStatus.current.textContent = 'loading…';
    const r = await fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(dir));
    loadProject.current.disabled = false;
    if (r.status === 200) {
      projectStatus.current.textContent = 'path: ' + r.body.path;
      projectOut.current.hidden = false;
      projectOut.current.textContent = JSON.stringify(r.body.project, null, 2);
    } else { projectStatus.current.textContent = 'HTTP ' + r.status; projectOut.current.hidden = true; }
  }

  useEffect(() => {
    loadSettings();
    refreshAccounts().then(() => {
      // Run the visibility toggler once so the form starts in a
      // consistent state. Defer one frame so the details element's
      // children are guaranteed to be in the DOM and refs attached.
      requestAnimationFrame(() => onAuthOrProviderChange());
    });
    const t = setInterval(loadSettings, 30000);
    const ta = setInterval(refreshAccounts, 10000);
    return () => { clearInterval(t); clearInterval(ta); };
  }, []);

  // When the user toggles auth <-> oauth, or picks a different
  // provider, refresh the oauthAccount <select> so it lists the
  // signed-in emails for that provider (if any). For apikey auth,
  // we still rebuild the select so the "(auto — none signed in)"
  // hint stays accurate, but the field is hidden via CSS below.
  function onAuthOrProviderChange() {
    const auth = mAuth.current ? mAuth.current.value : 'apikey';
    // Toggle the apikey/oauth row visibility. The form renders with
    // both rows in the DOM, so we just add/remove `.is-hidden` based
    // on the current auth value. Uses dataset so we don't have to
    // hardcode the row class name in the CSS rule.
    const details = mAuth.current && mAuth.current.closest('details');
    if (details) {
      for (const row of details.querySelectorAll('.row--apikey, .row--oauth')) {
        const showWhen = row.getAttribute('data-show-when');
        if (!showWhen) continue;
        row.classList.toggle('is-hidden', showWhen !== auth);
      }
    }
    refreshAccounts().then(() => renderOauthAccountOptions(mProvider.current.value));
  }

  return h('section', null,
    h('p', { class: 'hint' }, 'App-level settings are stored in ', h('code', null, '~/.mouaif/store.sqlite'), '. They are the default; project settings override per project.'),
    h('h3', null, 'App'),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: 'promptSize' }, 'Default prompt size'),
      h('select', { ref: promptSize, class: 'input', id: 'promptSize' },
        h('option', { value: 'very-small' }, 'very-small'),
        h('option', { value: 'average' }, 'average'),
        h('option', { value: 'extensive' }, 'extensive')
      )
    ),
    h('div', { class: 'row row--inline' },
      h('label', { class: 'label', for: 'traceByDefault' }, 'Trace to file by default'),
      h('input', { ref: traceByDefault, class: 'checkbox', id: 'traceByDefault', type: 'checkbox' })
    ),
    h('div', { class: 'row row--actions' },
      h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: saveApp }, 'Save app settings'),
      h('button', { ref: resetBtn, class: 'btn', type: 'button', onClick: resetApp }, 'Reset app'),
      h('span', { ref: appStatus, class: 'status', 'aria-live': 'polite' })
    ),
    h('h3', null, 'Models'),
    h('p', { class: 'hint' }, 'Add an entry per model you want to chat with. API keys are stored as plain text in the app SQLite store. For OAuth models, sign in on the Auth tab first — the access token lives in the OS keychain and is never sent to the browser.'),
    h('ul', { ref: modelsList, class: 'models__list', 'aria-label': 'Configured models' }),
    h('details', { class: 'models__add' },
      h('summary', null, 'Add a model'),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mId' }, 'id (slug)'), h('input', { ref: mId, class: 'input', id: 'mId', type: 'text', placeholder: 'gpt-4o-mini' })),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mProvider' }, 'provider'),
        h('select', { ref: mProvider, class: 'input', id: 'mProvider',
          onChange: onAuthOrProviderChange
        },
          h('option', { value: 'openai-compatible' }, 'openai-compatible'),
          h('option', { value: 'anthropic' }, 'anthropic'),
          h('option', { value: 'gemini' }, 'gemini'),
          h('option', { value: 'ollama' }, 'ollama')
        )
      ),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mAuth' }, 'auth'),
        h('select', { ref: mAuth, class: 'input', id: 'mAuth',
          onChange: onAuthOrProviderChange
        },
          h('option', { value: 'apikey' }, 'apikey'),
          h('option', { value: 'oauth' }, 'oauth')
        )
      ),
      h('div', { class: 'row row--oauth', 'data-show-when': 'oauth' },
        h('label', { class: 'label', for: 'mOauthAccount' }, 'OAuth account'),
        h('select', { ref: mOauthAccount, class: 'input', id: 'mOauthAccount' })
      ),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mLabel' }, 'label'), h('input', { ref: mLabel, class: 'input', id: 'mLabel', type: 'text', placeholder: 'GPT-4o mini' })),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mBaseUrl' }, 'base URL (optional)'), h('input', { ref: mBaseUrl, class: 'input', id: 'mBaseUrl', type: 'text', placeholder: 'https://api.openai.com' })),
      h('div', { class: 'row row--apikey', 'data-show-when': 'apikey' },
        h('label', { class: 'label', for: 'mApiKey' }, 'API key'),
        h('input', { ref: mApiKey, class: 'input', id: 'mApiKey', type: 'password', placeholder: 'sk-...' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: addBtn, class: 'btn btn--primary', type: 'button', onClick: addModel }, 'Add'),
        h('span', { ref: addModelStatus, class: 'status', 'aria-live': 'polite' })
      )
    ),
    h('h3', null, 'Project'),
    h('p', { class: 'hint' }, 'Project settings live in ', h('code', null, '<projectDir>/.mouaif.json'), ' and override app-level values for that project.'),
    h('div', { class: 'row' }, h('label', { class: 'label', for: 'projectDir' }, 'project directory'), h('input', { ref: projectDir, class: 'input', id: 'projectDir', type: 'text', placeholder: 'C:/path/to/project' })),
    h('div', { class: 'row row--inline' },
      h('label', { class: 'label', for: 'loadProject' }, 'load'),
      h('button', { ref: loadProject, class: 'btn', id: 'loadProject', type: 'button', onClick: loadProjectFile }, 'Load'),
      h('span', { ref: projectStatus, class: 'status', 'aria-live': 'polite' })
    ),
    h('pre', { ref: projectOut, class: 'settings__out', hidden: true })
  );
}

// Wraps SettingsPanel with a back link + heading.
function SettingsView() {
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
      h('h2', { class: 'view-title' }, 'Settings')
    ),
    h(SettingsPanel, null)
  );
}

// Wraps AuthPanel with a back link + heading.
function AuthView() {
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
      h('h2', { class: 'view-title' }, 'Auth')
    ),
    h(AuthPanel, null)
  );
}

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
    if (ws) {
      try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    wsRef.current = null;
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
    ws.addEventListener('close', (ev) => onWsClose(ev));
    ws.addEventListener('error', () => { if (statusEl.current) statusEl.current.textContent = 'WebSocket error'; });
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

  function onWsClose(ev) {
    if (statusEl.current) {
      const code = ev && typeof ev.code === 'number' ? ev.code : 0;
      statusEl.current.textContent = 'disconnected (code ' + code + ')';
    }
    wsRef.current = null;
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

  // Re-render is driven by stateTick.current; reading the ref is
  // enough to keep Preact happy when the value doesn't change.
  // (Preact doesn't actually re-render on ref reads, so we mutate
  //  route.value to force it from `forceUpdate()` below.)
  stateTick.current;

  // Phase 1: setup
  if (phase.current === 'setup') {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
        h('h2', { class: 'view-title' }, 'Inspector')
      ),
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
    h('h2', null, 'Projects'),
    h('p', { class: 'hint' }, 'Each card is a registered project. The chat list scrolls inside the card so the page itself stays put. New chats inherit the project\'s ', h('code', null, 'promptSize'), ' and ', h('code', null, 'traceByDefault'), ' settings.'),
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
  // updateChat(). Lets the trace toggle and prompt-size selector
  // render their current state from one source of truth.
  let chat = signal(null);
  let messages = signal([]);
  let models = signal([]);

  async function load() {
    if (!projectDir || !chatId) return;
    const [rChat, rModels, rMsgs] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rChat.status !== 200) { statusEl.current.textContent = 'chat not found'; return; }
    const c = rChat.body.chat;
    chat.value = c;
    messages.value = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
    models.value = rModels.status === 200 ? (rModels.body.models || []) : [];

    if (chatName.current) chatName.current.textContent = c.title || chatId;
    if (chatMeta.current) chatMeta.current.textContent = (c.promptSize || 'average') + ' · ' + (c.trace ? 'trace on' : 'trace off');
    if (traceToggle.current) traceToggle.current.checked = !!c.trace;
    if (promptSizeSelect.current) promptSizeSelect.current.value = c.promptSize || 'average';

    if (modelSelect.current) {
      modelSelect.current.innerHTML = '';
      for (const m of models.value) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id + (m.label ? ' — ' + m.label : '');
        modelSelect.current.appendChild(opt);
      }
      if (!models.value.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no models — add one in Settings)';
        modelSelect.current.appendChild(opt);
      }
    }

    renderTranscript();
  }

  function renderTranscript() {
    if (!transcript.current) return;
    transcript.current.innerHTML = '';
    if (!messages.value.length) {
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
    for (const m of messages.value) appendMessageToTranscript(m, false);
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
    chat.value = r.body.chat;
    if (chatMeta.current && chat.value) chatMeta.current.textContent = (chat.value.promptSize || 'average') + ' · ' + (chat.value.trace ? 'trace on' : 'trace off');
  }

  function renameChat() {
    if (!chat.value) return;
    const next = prompt('Rename chat', chat.value.title || chatId);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === chat.value.title) return;
    updateChat({ title: trimmed }).then(() => {
      if (chat.value && chatName.current) chatName.current.textContent = chat.value.title || chatId;
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
    if (!chat.value) return;
    if (!confirm('Delete this chat? Messages and trace file (if any) will be removed.')) return;
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

    const userMsg = { role: 'user', content, ts: new Date().toISOString() };
    messages.value = messages.value.concat([userMsg]);
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
    messages.value = messages.value.concat([{ role: 'assistant', content: assembled, ts: new Date().toISOString() }]);
    if (statusEl.current.textContent === 'streaming…') {
      setChatStatus(usage ? ('done — ' + usage.promptTokens + ' in, ' + usage.completionTokens + ' out') : 'done', 'success');
    }
    sendBtn.current.disabled = false;
  }

  useEffect(() => { load(); }, [chatId, projectDir]);

  return h('section', { class: 'chat-view' },
    h('div', { class: 'chat-view__head' },
      h('button', { ref: back, class: 'chat-view__back', type: 'button', onClick: () => nav('projects'), 'aria-label': 'Back to projects' }, '←'),
      h('div', { class: 'chat-view__title-stack' },
        h('div', { ref: chatName, class: 'chat-view__name' }, '…'),
        h('div', { ref: chatMeta, class: 'chat-view__meta' }, '')
      ),
      h('button', { class: 'chat-view__iconbtn', type: 'button', onClick: renameChat, 'aria-label': 'Rename chat', title: 'Rename' }, '✎'),
      h('button', { class: 'chat-view__iconbtn chat-view__iconbtn--danger', type: 'button', onClick: deleteThisChat, 'aria-label': 'Delete chat', title: 'Delete' }, '×')
    ),
    h('div', { class: 'chat-view__settings' },
      h('div', { class: 'row row--inline' },
        h('input', { ref: traceToggle, class: 'checkbox', id: 'chatTrace', type: 'checkbox', onChange: onTraceChange }),
        h('label', { class: 'label', for: 'chatTrace' }, 'Trace to file')
      ),
      h('div', { class: 'row row--inline' },
        h('label', { class: 'label', for: 'chatPromptSize' }, 'Prompt size'),
        h('select', { ref: promptSizeSelect, class: 'input', id: 'chatPromptSize', onChange: onPromptSizeChange },
          h('option', { value: 'very-small' }, 'very-small'),
          h('option', { value: 'average' }, 'average'),
          h('option', { value: 'extensive' }, 'extensive')
        )
      )
    ),
    h('div', { ref: transcript, class: 'chat-view__transcript', 'aria-live': 'polite' }),
    h('div', { class: 'chat-view__composer' },
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'chatModel' }, 'Model'),
        h('select', { ref: modelSelect, class: 'input', id: 'chatModel' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'chatPrompt' }, 'Message'),
        h('textarea', { ref: promptInput, class: 'input', id: 'chatPrompt', rows: 3, placeholder: 'Type a message' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: sendBtn, class: 'btn btn--primary', type: 'button', onClick: send }, 'Send'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

// ---- Render ------------------------------------------------------------

const root = document.getElementById('app');
if (root) render(h(App, null), root);
