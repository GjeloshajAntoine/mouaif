// mouaif web — SettingsProvidersView + SettingsProviderEditView
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, loadApp, appProviders, loadAccounts, SETTINGS_PROVIDERS, providerDef, authNsForProvider, setStatus } from '../api.js';
import { nav } from '../router.js';

export function SettingsProvidersView() {
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
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '‹'),
      h('h2', { class: 'view-title' }, 'Providers')
    ),
    h('p', { class: 'hint hint--compact' }, 'Credentials live in the app store. Each project\'s models reference one of these.'),
    h('ul', { ref: listEl, class: 'providers__list', 'aria-label': 'Configured providers' }),
    h('div', { class: 'page-bar' },
      h('span', { ref: statusEl, class: 'status page-bar__status', 'aria-live': 'polite' }),
      h('a', { href: '#/settings/providers/new', class: 'page-bar__add', 'aria-label': 'Add provider' }, '+')
    )
  );
}

export function SettingsProviderEditView(props) {
  const id = props.id || '';

  const idSel = useRef(null);
  const baseUrl = useRef(null);
  const authSel = useRef(null);
  const authLocked = useRef(null);
  const apiKey = useRef(null);
  const oauthAccount = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const statusEl = useRef(null);
  const signInStatus = useRef(null);

  // The form's "current provider" lives in two places: the URL prop
  // (`id`, used as the initial value + to know if we're editing or
  // creating) and the <select> element (`idSel.current.value`,
  // which the user can change to switch the form between providers
  // mid-edit). The notice and the auth-locked state need to react
  // to *both* — a local state mirrors the <select> so the JSX
  // re-renders when the user picks a different provider. The
  // `current` record is also state so the auth select can render
  // with the saved `auth` on the first paint.
  const [currentId, setCurrentId] = useState(id || 'openai-compatible');
  const [current, setCurrent] = useState(null);
  const currentDef0 = () => providerDef(currentId);

  let accounts = {};

  function currentDef() {
    return providerDef(idSel.current ? idSel.current.value : '');
  }

  async function load() {
    try {
      await loadApp({ force: true });
      accounts = await loadAccounts({ force: true });
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); return; }
    const found = id ? appProviders().find(p => p && p.id === id) : null;
    if (id && !found) { setStatus(statusEl, 'Provider not found', 'error'); return; }
    setCurrent(found || null);

    if (idSel.current) {
      idSel.current.value = currentId;
      if (id) idSel.current.disabled = true;
    }
    syncAuth();
    syncOauthAccountOptions();
    syncBaseUrl();
    if (apiKey.current) apiKey.current.value = '';
    if (deleteBtn.current) deleteBtn.current.hidden = !id;
    if (baseUrl.current) baseUrl.current.value = (found && found.baseUrl) || '';
    renderKeyHint();
    setStatus(statusEl, '');
  }

  function syncAuth() {
    if (!authSel.current) return;
    const def = currentDef();
    const reserved = !!(def && def.reserved);
    // Pick the auth mode: reserved forces OAuth; otherwise prefer
    // the existing provider record's saved auth, falling back to
    // "apikey". Falling back to whatever the <select> happens to
    // hold (the pre-fix behavior) leaks the previous selection
    // when the user switches from GitHub Copilot to a non-reserved
    // provider — the OAuth field stays sticky and the API key row
    // is never shown.
    let wantAuth;
    if (reserved) wantAuth = 'oauth';
    else if (current && current.id === (idSel.current ? idSel.current.value : '') && current.auth) wantAuth = current.auth;
    else wantAuth = 'apikey';
    if (authSel.current.value !== wantAuth) authSel.current.value = wantAuth;
    for (const opt of authSel.current.querySelectorAll('option')) {
      if (opt.value === 'apikey') opt.disabled = reserved;
    }
    // Reserved (SSO-only) providers have no choice: hide the auth
    // <select> entirely and show a static "OAuth (required)" badge
    // instead. The select is also disabled while we're at it so its
    // single option can't even be re-opened.
    authSel.current.disabled = reserved;
    // The auth <select> is wrapped in a plain .row, so we hide that
    // whole row when the provider is reserved. The static
    // "OAuth (required)" badge (and its row wrapper) take its place.
    const authSelRow = authSel.current.closest('.row');
    if (authSelRow) authSelRow.classList.toggle('is-hidden', reserved);
    if (authLocked.current) {
      authLocked.current.classList.toggle('is-hidden', !reserved);
      const label = authLocked.current.querySelector('.row__static-value');
      if (label) label.textContent = 'OAuth (required)';
    }
    // The static badge's own .row wrapper is also toggled so it
    // doesn't leave an empty flex column in the layout when hidden.
    const authLockedRow = authLocked.current && authLocked.current.closest('.row');
    if (authLockedRow) authLockedRow.classList.toggle('is-hidden', !reserved);
    const section = authSel.current.closest('section');
    if (section) {
      for (const row of section.querySelectorAll('.row--apikey, .row--oauth, .row--base')) {
        const showWhen = row.getAttribute('data-show-when');
        if (!showWhen) continue;
        // .row--base has data-show-when="!reserved" — hide it for
        // reserved providers because their base URL is hard-coded.
        if (showWhen === '!reserved') {
          row.classList.toggle('is-hidden', reserved);
        } else {
          row.classList.toggle('is-hidden', showWhen !== wantAuth);
        }
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
    const known = SETTINGS_PROVIDERS.map(p => p.defaultBaseUrl).filter(Boolean);
    if (!cur || known.includes(cur)) baseUrl.current.value = target;
  }

  function renderKeyHint() {
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
    const win = window.open(r.body.authorizeUrl, '_blank', 'noopener');
    if (!win) setStatus(signInStatus, 'popup blocked — open the URL manually', 'error');
    setStatus(signInStatus, 'waiting for ' + def.label + ' to redirect back…', 'busy');

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

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const providerId = idSel.current.value;
    const def = providerDef(providerId);
    const auth = (def && def.reserved) ? 'oauth' : authSel.current.value;
    const base = (baseUrl.current.value || '').trim();
    const key = (apiKey.current.value || '').trim();
    const account = (oauthAccount.current.value || '').trim();

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
    nav('settings/providers');
  }

  useEffect(() => { load(); }, [id]);
  // When the route changes to a different provider (the hash flips
  // from /settings/providers/<a> to /settings/providers/<b>), the
  // component instance is reused. Reset the local state to the new
  // id so the next paint reflects the right provider before the
  // useEffect above finishes its async load.
  useEffect(() => {
    setCurrentId(id || 'openai-compatible');
    setCurrent(null);
  }, [id]);

  const def = currentDef0();
  const titleText = id ? ((def && def.label) || id) : 'Add provider';
  const initialReserved = !!(def && def.reserved);
  // Derive the auth mode from the same rule syncAuth() uses, so
  // the <select> renders with the right value on the first paint
  // (before the useEffect-driven DOM mutations can run).
  const initialAuth = initialReserved
    ? 'oauth'
    : (current && current.auth) || 'apikey';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/providers', class: 'view-back', 'aria-label': 'Back to providers' }, '←'),
      h('h2', { class: 'view-title' }, titleText)
    ),
    h('section', null,
      def && def.hint
        ? h('p', { class: initialReserved ? 'notice notice--auth' : 'hint hint--compact' }, def.hint)
        : null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-id' }, 'Provider'),
        h('select', { ref: idSel, class: 'input', id: 'sp-id', disabled: !!id, value: currentId, onChange: (e) => { setCurrentId(e.target.value); syncAuth(); syncOauthAccountOptions(); syncBaseUrl(); renderKeyHint(); } },
          SETTINGS_PROVIDERS.map(p => h('option', { value: p.id, key: p.id, selected: p.id === currentId }, p.label))
        )
      ),
      h('div', { class: 'row row--base', 'data-show-when': '!reserved' },
        h('label', { class: 'label', for: 'sp-base' }, 'API base URL'),
        h('input', { ref: baseUrl, class: 'input', id: 'sp-base', type: 'url', placeholder: 'https://api.openai.com/v1' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-auth' }, 'Authentication'),
        h('select', { ref: authSel, class: 'input', id: 'sp-auth', disabled: initialReserved, value: initialAuth, onChange: () => { syncAuth(); renderKeyHint(); syncOauthAccountOptions(); } },
          h('option', { value: 'apikey', selected: initialAuth === 'apikey' }, 'API key'),
          h('option', { value: 'oauth', selected: initialAuth === 'oauth' }, 'OAuth')
        )
      ),
      h('div', { class: 'row row__static-wrap' },
        h('div', { ref: authLocked, class: 'row__static is-hidden' },
          h('span', { class: 'label' }, 'Authentication'),
          h('span', { class: 'row__static-value' }, 'OAuth (required)'),
          h('span', { class: 'row__static-note' }, 'This provider only supports OAuth sign-in.')
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