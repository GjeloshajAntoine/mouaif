// mouaif web — SettingsProvidersView + SettingsProviderEditView
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, loadApp, saveApp, appProviders, loadAccounts, SETTINGS_PROVIDERS, providerDef, authNsForProvider, setStatus } from '../api.js';
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
  // GitHub Copilot's OAuth flow needs a per-install OAuth-app client_id
  // (the public default won't work with our loopback callback). It lives in
  // app settings under githubCopilot.clientId, but conceptually it belongs
  // to the Copilot provider's sign-in, so the field is rendered here — right
  // above the Sign in button — instead of on a separate Settings screen.
  const copilotClientId = useRef(null);
  const copilotStatus = useRef(null);
  // OpenRouter uses an "app name" to identify the client to
  // OpenRouter's leaderboard (sent as the X-OpenRouter-Title
  // header — the current canonical attribution header — on every
  // chat-completions request, per OpenRouter's attribution docs).
  // The user sets it once per install; the value lives in
  // app.openRouter.appName and is read by the AI client at request
  // time. Blank = fall back to the shipped 'mouaif' default.
  // Persisted via saveApp() behind its own Save button, same
  // pattern as the Copilot client_id field it sits next to.
  const openrouterAppName = useRef(null);
  const openrouterStatus = useRef(null);
  // OpenRouter also needs an owned HTTP-Referer URL to actually
  // publish the app on its public leaderboard (the X-OpenRouter-
  // Title is just the name shown next to the URL; OpenRouter
  // scrapes the URL for og:* tags to build the leaderboard entry).
  // The shipped default (https://mouaif.local) is a fictitious
  // domain nobody owns, so app-name attribution is invisible
  // without the user setting this. Lives in
  // app.openRouter.httpReferer, read by the AI client at request
  // time. Blank = fall back to the shipped default.
  const openrouterHttpReferer = useRef(null);
  const openrouterRefererStatus = useRef(null);

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
  // Auth mode is reactive state, NOT a DOM value we mutate imperatively.
  // The old code toggled `.is-hidden` on the OAuth/API-key rows from
  // syncAuth() by hand; but this is a Preact component, so any re-render
  // (e.g. changing the provider <select>) re-ran the JSX and blew those
  // mutations away — the auth <select> snapped back to `apikey` and the
  // OAuth rows (incl. the "Sign in" button) stayed collapsed. Driving
  // visibility from state means the render is the single source of truth.
  const reservedFor = (pid) => { const d = providerDef(pid); return !!(d && d.reserved); };
  const [authMode, setAuthMode] = useState(reservedFor(id || 'openai-compatible') ? 'oauth' : 'apikey');
  // Base URL is a controlled field too. It used to be written imperatively
  // by syncBaseUrl() reading currentId/current from a stale render closure,
  // which left it lagging one provider behind when the user switched the
  // provider <select>. Keeping it in state means each provider change sets
  // it in the same tick the id changes.
  const initialBaseUrl = (() => { const d = providerDef(id || 'openai-compatible'); return (d && d.defaultBaseUrl) || ''; })();
  const [baseUrlVal, setBaseUrlVal] = useState(initialBaseUrl);

  const currentDef0 = () => providerDef(currentId);

  let accounts = {};

  function currentDef() {
    return providerDef(currentId);
  }

  async function load() {
    let app;
    try {
      app = await loadApp({ force: true });
      accounts = await loadAccounts({ force: true });
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); return; }
    const found = id ? appProviders().find(p => p && p.id === id) : null;
    if (id && !found) { setStatus(statusEl, 'Provider not found', 'error'); return; }
    setCurrent(found || null);
    // Prefill the Copilot OAuth-app client_id (blank = using the default).
    if (copilotClientId.current) {
      copilotClientId.current.value = (app && app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) || '';
    }
    // Prefill the OpenRouter app name (blank = shipped 'mouaif' default,
    // resolved by the AI client at request time).
    if (openrouterAppName.current) {
      const or = (app && app.app && app.app.openRouter) || {};
      openrouterAppName.current.value = (typeof or.appName === 'string' && or.appName) || '';
    }
    // Prefill the OpenRouter HTTP-Referer URL (blank = shipped
    // 'https://mouaif.local' default, which is a fictitious domain
    // nobody owns and so does not produce a leaderboard entry).
    if (openrouterHttpReferer.current) {
      const or2 = (app && app.app && app.app.openRouter) || {};
      openrouterHttpReferer.current.value = (typeof or2.httpReferer === 'string' && or2.httpReferer) || '';
    }

    // Resolve the auth mode from data (reserved → oauth, else the saved
    // record's auth, else apikey) and push it into reactive state so the
    // <select> and the row visibility both follow.
    setAuthMode(resolveAuthMode(currentId, found));
    setBaseUrlVal(nextBaseUrl(currentId, found, (found && found.baseUrl) || ''));

    syncOauthAccountOptions();
    if (apiKey.current) apiKey.current.value = '';
    if (deleteBtn.current) deleteBtn.current.hidden = !id;
    renderKeyHint();
    setStatus(statusEl, '');
  }

  // Does the server actually have an OAuth flow for this provider?
  // Only these may offer the OAuth option; the rest are API-key only and
  // would 404 on POST /api/auth/sign-in/<id>.
  const oauthCapable = (pid) => { const d = providerDef(pid); return !!(d && (d.oauth || d.reserved)); };

  // The single rule for what auth a provider should show: reserved
  // providers are OAuth-only; an existing record keeps its saved auth (but
  // only if the provider still supports it); everything else defaults to
  // API key.
  function resolveAuthMode(pid, record) {
    if (reservedFor(pid)) return 'oauth';
    if (record && record.id === pid && record.auth === 'oauth' && oauthCapable(pid)) return 'oauth';
    if (record && record.id === pid && record.auth === 'apikey') return 'apikey';
    return 'apikey';
  }

  function syncOauthAccountOptions(pid = currentId) {
    if (!oauthAccount.current) return;
    const ns = authNsForProvider(pid);
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

  // Compute the base URL a provider should show. If the user has typed a
  // custom URL (one that isn't any provider's default) we keep it; otherwise
  // we snap to the target provider's configured/default URL. Returns the
  // value to store in state.
  function nextBaseUrl(pid, record, currentVal) {
    const def = providerDef(pid);
    const configured = (record && record.id === pid) ? record : null;
    const target = (configured && configured.baseUrl) || (def && def.defaultBaseUrl) || '';
    const cur = (currentVal || '').trim();
    const known = SETTINGS_PROVIDERS.map(p => p.defaultBaseUrl).filter(Boolean);
    return (!cur || known.includes(cur)) ? target : cur;
  }

  function renderKeyHint() {
    const section = authSel.current && authSel.current.closest('section');
    const hint = section && section.querySelector('.key-hint');
    if (!hint) return;
    if (authMode === 'apikey' && current && current.hasApiKey) {
      hint.textContent = 'a key is already saved for this provider; leave the field empty to keep it';
      hint.hidden = false;
    } else {
      hint.textContent = '';
      hint.hidden = true;
    }
  }

  async function startSignIn() {
    const provider = currentId;
    const def = providerDef(provider);
    if (!def) { setStatus(signInStatus, 'unknown provider', 'error'); return; }
    if (!oauthCapable(provider)) {
      setStatus(signInStatus, def.label + ' does not support OAuth sign-in; use an API key.', 'error');
      return;
    }
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

  // Persist the GitHub Copilot OAuth-app client_id to app settings. Empty
  // clears it back to the shipped default. This is decoupled from the
  // provider Save button so the user can set the client_id, then sign in,
  // then save the provider record — the natural order.
  async function saveCopilotClientId() {
    const value = (copilotClientId.current && copilotClientId.current.value || '').trim();
    setStatus(copilotStatus, 'saving…', 'busy');
    try {
      await saveApp({ githubCopilot: { clientId: value || null } });
      setStatus(copilotStatus, value ? 'saved — you can sign in now.' : 'cleared (using default).', 'success');
    } catch (e) { setStatus(copilotStatus, 'save failed: ' + e.message, 'error'); }
  }

  // Persist the OpenRouter app name to app settings. Sent as the
  // X-Title header on every OpenRouter chat-completions request,
  // per OpenRouter's attribution docs. Empty clears it back to
  // the shipped 'mouaif' default. Decoupled from the provider
  // Save so the natural order is: set the app name -> sign in ->
  // save the provider record. The X-Title is read by the AI
  // client at request time (see src/ai.js → ENDPOINTS.openrouter
  // → staticHeaders), so changing the value here takes effect on
  // the next chat send with no provider-record rewrite.
  async function saveOpenRouterAppName() {
    const value = (openrouterAppName.current && openrouterAppName.current.value || '').trim();
    setStatus(openrouterStatus, 'saving…', 'busy');
    try {
      await saveApp({ openRouter: { appName: value || null } });
      setStatus(openrouterStatus, value ? 'saved — applies to the next chat send.' : 'cleared (using default).', 'success');
    } catch (e) { setStatus(openrouterStatus, 'save failed: ' + e.message, 'error'); }
  }

  // Persist the OpenRouter HTTP-Referer URL to app settings. Sent
  // as the HTTP-Referer header on every OpenRouter chat-completions
  // request. Per OpenRouter's attribution docs, OpenRouter scrapes
  // this URL for og:* tags when building the public-leaderboard
  // entry, so without an owned domain the app name is not visible
  // publicly even when the X-OpenRouter-Title header is set.
  // Empty clears it back to the shipped default. The value is
  // validated client-side as an http(s) URL; the server does not
  // silently drop invalid values (it validates too).
  async function saveOpenRouterHttpReferer() {
    const raw = (openrouterHttpReferer.current && openrouterHttpReferer.current.value || '').trim();
    if (raw) {
      try { const u = new URL(raw); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)'); }
      catch { setStatus(openrouterRefererStatus, 'must be an absolute http(s) URL', 'error'); return; }
    }
    setStatus(openrouterRefererStatus, 'saving…', 'busy');
    try {
      await saveApp({ openRouter: { httpReferer: raw || null } });
      setStatus(openrouterRefererStatus, raw ? 'saved — applies to the next chat send.' : 'cleared (using default).', 'success');
    } catch (e) { setStatus(openrouterRefererStatus, 'save failed: ' + e.message, 'error'); }
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const providerId = currentId;
    const def = providerDef(providerId);
    const auth = (def && def.reserved) ? 'oauth' : authMode;
    const base = (baseUrlVal || '').trim();
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
  const reserved = !!(def && def.reserved);
  const canOAuth = oauthCapable(currentId);
  // Reserved providers are OAuth-only, so the effective auth is forced to
  // 'oauth'. Providers with no OAuth flow are forced to 'apikey' so the UI
  // can never send the user into a sign-in that 404s. Otherwise the user's
  // authMode choice wins. Row visibility is derived here, in the render, so
  // it can never drift from the <select> the way the old imperative
  // .is-hidden toggling did.
  const effAuth = reserved ? 'oauth' : (canOAuth ? authMode : 'apikey');
  // Hide the auth <select> when there is only one possible mode: reserved
  // (OAuth-only, replaced by the static badge) OR API-key-only (no OAuth
  // flow — no point showing a one-option picker).
  const singleAuth = reserved || !canOAuth;
  const hide = (cond) => 'row' + (cond ? ' is-hidden' : '');

  // When the provider <select> changes, move currentId AND recompute the
  // auth mode for the new provider in one shot, so switching from a
  // reserved (OAuth-only) provider back to a normal one restores the API
  // key row instead of staying stuck on OAuth.
  function onProviderChange(e) {
    const pid = e.target.value;
    setCurrentId(pid);
    setAuthMode(resolveAuthMode(pid, current));
    // Pass pid explicitly: setCurrentId() is async, so reading currentId
    // here would use the previous provider and lag the fields one change
    // behind (the bug that left the base URL / OAuth rows out of sync).
    setBaseUrlVal((cur) => nextBaseUrl(pid, current, cur));
    syncOauthAccountOptions(pid);
    renderKeyHint();
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/providers', class: 'view-back', 'aria-label': 'Back to providers' }, '←'),
      h('h2', { class: 'view-title' }, titleText)
    ),
    h('section', null,
      def && def.hint
        ? h('p', { class: reserved ? 'notice notice--auth' : 'hint hint--compact' }, def.hint)
        : null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-id' }, 'Provider'),
        h('select', { ref: idSel, class: 'input', id: 'sp-id', disabled: !!id, onChange: onProviderChange },
          SETTINGS_PROVIDERS.map(p => h('option', { value: p.id, key: p.id, selected: p.id === currentId }, p.label))
        )
      ),
      // API base URL — hidden for reserved providers (their base URL is
      // hard-coded server-side).
      h('div', { class: hide(reserved) + ' row--base' },
        h('label', { class: 'label', for: 'sp-base' }, 'API base URL'),
        h('input', { ref: baseUrl, class: 'input', id: 'sp-base', type: 'url', placeholder: 'https://api.openai.com/v1',
          value: baseUrlVal, onInput: (e) => setBaseUrlVal(e.target.value) })
      ),
      // Auth <select> — hidden when there is only one possible mode:
      // reserved (OAuth-only, replaced by the badge below) or a provider
      // with no OAuth flow (API-key only). The OAuth <option> is only
      // rendered for OAuth-capable providers.
      h('div', { class: hide(singleAuth) },
        h('label', { class: 'label', for: 'sp-auth' }, 'Authentication'),
        h('select', { ref: authSel, class: 'input', id: 'sp-auth',
          onChange: (e) => { setAuthMode(e.target.value); renderKeyHint(); syncOauthAccountOptions(); } },
          h('option', { value: 'apikey', selected: effAuth === 'apikey' }, 'API key'),
          canOAuth ? h('option', { value: 'oauth', selected: effAuth === 'oauth' }, 'OAuth') : null
        )
      ),
      h('div', { class: hide(!reserved) + ' row__static-wrap' },
        h('div', { ref: authLocked, class: 'row__static' },
          h('span', { class: 'label' }, 'Authentication'),
          h('span', { class: 'row__static-value' }, 'OAuth (required)'),
          h('span', { class: 'row__static-note' }, 'This provider only supports OAuth sign-in.')
        )
      ),
      h('div', { class: hide(effAuth !== 'apikey') + ' row--apikey' },
        h('label', { class: 'label', for: 'sp-key' }, 'Provider API key'),
        h('input', { ref: apiKey, class: 'input', id: 'sp-key', type: 'password', placeholder: 'paste key', autocomplete: 'off' })
      ),
      h('p', { class: 'hint hint--compact key-hint', hidden: true }),
      h('div', { class: hide(effAuth !== 'oauth') + ' row--oauth' },
        h('label', { class: 'label', for: 'sp-account' }, 'OAuth account'),
        h('select', { ref: oauthAccount, class: 'input', id: 'sp-account' })
      ),
      // GitHub Copilot only: the OAuth-app client_id required to make the
      // loopback sign-in work. Rendered here so everything Copilot-auth
      // lives in one place (no separate Settings screen).
      h('div', { class: hide(effAuth !== 'oauth' || currentId !== 'github-copilot') + ' row--oauth row--copilot' },
        h('label', { class: 'label', for: 'sp-copilot-id' }, 'GitHub OAuth app client ID'),
        h('p', { class: 'hint hint--compact' }, 'GitHub does not allow third-party apps to use the public Copilot client_id with a loopback callback. Create a personal OAuth app at ', h('code', null, 'github.com/settings/developers'), ' (Developer settings → OAuth Apps → New OAuth App) with callback ', h('code', null, 'http://127.0.0.1:5732/oauth/callback?provider=github-copilot'), ', then paste its client_id here and Save before signing in. Leave blank to use the shipped default.'),
        h('input', { ref: copilotClientId, class: 'input', id: 'sp-copilot-id', type: 'text', placeholder: 'Iv1.xxxxxxxxxxxxxxxx', autocomplete: 'off' }),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: saveCopilotClientId }, 'Save client ID'),
          h('span', { ref: copilotStatus, class: 'status', 'aria-live': 'polite' })
        )
      ),
      // OpenRouter only: the "app name" sent as the X-OpenRouter-
      // Title header on every chat-completions request, per
      // OpenRouter's attribution docs. Identifies this app to
      // OpenRouter's leaderboard. Persisted in app settings
      // (app.openRouter.appName) and read by the AI client at
      // request time. Blank = shipped 'mouaif' default. The
      // field sits next to the Copilot client_id field (the same
      // pattern: per-install setting that's part of the provider's
      // sign-in story but lives at the app scope).
      h('div', { class: hide(currentId !== 'openrouter') + ' row--openrouter' },
        h('label', { class: 'label', for: 'sp-or-appname' }, 'App name'),
        h('p', { class: 'hint hint--compact' }, 'Shown to OpenRouter as the X-OpenRouter-Title header on every chat-completions request (per OpenRouter\u2019s attribution docs). Identifies this app on the public leaderboard. Blank uses the shipped default.'),
        h('input', { ref: openrouterAppName, class: 'input', id: 'sp-or-appname', type: 'text', placeholder: 'mouaif', maxlength: 64, autocomplete: 'off' }),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: saveOpenRouterAppName }, 'Save app name'),
          h('span', { ref: openrouterStatus, class: 'status', 'aria-live': 'polite' })
        )
      ),
      // OpenRouter only: the HTTP-Referer URL sent on every
      // chat-completions request. Per OpenRouter's attribution
      // docs, this is the URL OpenRouter scrapes for og:* tags to
      // build the public-leaderboard entry for the app. The shipped
      // default (https://mouaif.local) is a fictitious domain
      // nobody owns, so without the user setting a real URL here
      // the app name is not visible on the public leaderboard even
      // when the X-OpenRouter-Title header is set. Lives in
      // app.openRouter.httpReferer; read by the AI client at
      // request time. Blank = shipped default.
      h('div', { class: hide(currentId !== 'openrouter') + ' row--openrouter' },
        h('label', { class: 'label', for: 'sp-or-referer' }, 'HTTP-Referer URL'),
        h('p', { class: 'hint hint--compact' }, 'OpenRouter scrapes this URL for og:* tags to build the public-leaderboard entry for this app. Must be an absolute http(s) URL you own; the shipped default (https://mouaif.local) is a fictitious domain and produces no leaderboard entry. Blank uses the shipped default.'),
        h('input', { ref: openrouterHttpReferer, class: 'input', id: 'sp-or-referer', type: 'url', placeholder: 'https://mouaif.local', autocomplete: 'off' }),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: saveOpenRouterHttpReferer }, 'Save URL'),
          h('span', { ref: openrouterRefererStatus, class: 'status', 'aria-live': 'polite' })
        )
      ),
      h('div', { class: hide(effAuth !== 'oauth') + ' row--oauth' },
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