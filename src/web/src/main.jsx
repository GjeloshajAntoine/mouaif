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
  if (view.name === 'projects') return h('div', null, Header({ links: h(AppNav, null) }), h(ProjectsView, null));
  if (view.name === 'picker') return h('div', null, Header({ links: h(AppNav, null) }), h(ProjectPickerView, { dir: view.dir }));
  if (view.name === 'chat') return h('div', null, Header({ links: h(AppNav, null) }), h(ChatView, { chatId: view.chatId, projectDir: view.projectDir }));
  if (view.name === 'settings') return h('div', null, Header({ links: h(AppNav, null) }), h(SettingsView, null));
  if (view.name === 'auth') return h('div', null, Header({ links: h(AppNav, null) }), h(AuthView, null));
  return h('div', null, Header({ links: h(AppNav, null) }), h(ProjectsView, null));
}

function Header(props) {
  return h('header', { class: 'app__header' },
    h('div', { class: 'app__brand' },
      h('h1', { class: 'app__title' }, 'mouaif'),
      h('p', { class: 'app__sub' }, 'mobile UI')
    ),
    props.links
      ? h('nav', { class: 'app__nav' }, props.links)
      : null
  );
}

// ---- App nav ---------------------------------------------------------
// The header exposes a "Settings" + "Auth" link so the user can reach
// the model editor and the sign-in flow without leaving the page.
// Active route is highlighted via the [aria-current] attribute.

function AppNav() {
  const view = route.value;
  const link = (to, name, label) => h('a', {
    href: '#/' + to,
    class: 'app__nav-link' + (view.name === name ? ' is-active' : ''),
    'aria-current': view.name === name ? 'page' : null
  }, label);
  return h('nav', { class: 'app__nav' },
    link('projects', 'projects', 'Projects'),
    link('settings', 'settings', 'Settings'),
    link('auth', 'auth', 'Auth')
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
      signInCallback.current.textContent = window.location.origin + '/oauth/callback';
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
  const addBtn = useRef(null), addModelStatus = useRef(null);

  const projectDir = useRef(null), loadProject = useRef(null), projectStatus = useRef(null), projectOut = useRef(null);

  let currentApp = {};

  async function loadSettings() {
    const r = await fetchJson('/api/settings');
    if (r.status !== 200) { if (appStatus.current) appStatus.current.textContent = 'HTTP ' + r.status; return; }
    currentApp = r.body.app || {};
    if (promptSize.current) promptSize.current.value = currentApp.promptSize || 'average';
    if (traceByDefault.current) traceByDefault.current.checked = !!currentApp.traceByDefault;
    renderModels(currentApp.models || []);
    if (appStatus.current) appStatus.current.textContent = '';
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
      meta.textContent = [m.label, m.baseUrl, m.apiKey ? 'key: •••' : null, m.auth && m.auth !== 'apikey' ? 'auth: ' + m.auth : null].filter(Boolean).join('  ·  ');
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
    if (!id) { addModelStatus.current.textContent = 'id is required'; return; }
    addBtn.current.disabled = true;
    addModelStatus.current.textContent = 'adding…';
    const body = { id, provider, label };
    if (baseUrl) body.baseUrl = baseUrl;
    if (apiKey) body.apiKey = apiKey;
    const r = await fetchJson('/api/settings/app/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    addBtn.current.disabled = false;
    if (r.status === 200) {
      currentApp.models = r.body.models;
      renderModels(r.body.models);
      addModelStatus.current.textContent = 'added ' + id + '.';
      mId.current.value = ''; mLabel.current.value = ''; mBaseUrl.current.value = ''; mApiKey.current.value = '';
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

  useEffect(() => { loadSettings(); const t = setInterval(loadSettings, 30000); return () => clearInterval(t); }, []);

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
    h('p', { class: 'hint' }, 'Add an entry per model you want to chat with. API keys are stored as plain text in the app SQLite store.'),
    h('ul', { ref: modelsList, class: 'models__list', 'aria-label': 'Configured models' }),
    h('details', { class: 'models__add' },
      h('summary', null, 'Add a model'),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mId' }, 'id (slug)'), h('input', { ref: mId, class: 'input', id: 'mId', type: 'text', placeholder: 'gpt-4o-mini' })),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mProvider' }, 'provider'),
        h('select', { ref: mProvider, class: 'input', id: 'mProvider' },
          h('option', { value: 'openai-compatible' }, 'openai-compatible'),
          h('option', { value: 'anthropic' }, 'anthropic'),
          h('option', { value: 'gemini' }, 'gemini'),
          h('option', { value: 'ollama' }, 'ollama')
        )
      ),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mLabel' }, 'label'), h('input', { ref: mLabel, class: 'input', id: 'mLabel', type: 'text', placeholder: 'GPT-4o mini' })),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mBaseUrl' }, 'base URL (optional)'), h('input', { ref: mBaseUrl, class: 'input', id: 'mBaseUrl', type: 'text', placeholder: 'https://api.openai.com' })),
      h('div', { class: 'row' }, h('label', { class: 'label', for: 'mApiKey' }, 'API key'), h('input', { ref: mApiKey, class: 'input', id: 'mApiKey', type: 'password', placeholder: 'sk-...' })),
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

const projectsReload = signal(0);

function ProjectsView() {
  const refreshProjects = useRef(null);
  const projectsList = useRef(null);
  const projectsStatus = useRef(null);

  async function loadProjects() {
    projectsStatus.current.textContent = 'loading…';
    let r;
    try { r = await fetchJson('/api/projects/registered'); }
    catch (err) { if (projectsStatus.current) projectsStatus.current.textContent = 'network error'; return; }
    if (r.status !== 200) { projectsStatus.current.textContent = 'HTTP ' + r.status; return; }
    const list = r.body.projects || [];
    projectsList.current.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'projects__empty';
      empty.textContent = 'No projects registered. Tap "Add project" to pick a folder.';
      projectsList.current.appendChild(empty);
      projectsStatus.current.textContent = list.length + ' projects';
      return;
    }
    projectsStatus.current.textContent = list.length + ' projects';
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
      empty.textContent = 'no messages yet — type below to start';
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
    statusEl.current.textContent = 'streaming…';
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
      if (statusEl.current) statusEl.current.textContent = 'network error';
      finalizeLiveMessage({ content: '[network error]' });
      if (sendBtn.current) sendBtn.current.disabled = false;
      return;
    }
    if (!resp.ok) {
      const text = await resp.text();
      statusEl.current.textContent = 'HTTP ' + resp.status;
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
      statusEl.current.textContent = usage ? ('done — ' + usage.promptTokens + ' in, ' + usage.completionTokens + ' out') : 'done';
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
