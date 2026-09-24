// mouaif web — SettingsProvidersView + SettingsProviderEditView
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, loadApp, saveApp, appProviders, loadAccounts, SETTINGS_PROVIDERS, providerDef, authNsForProvider } from '../api.js';
import { nav } from '../router.js';

export function SettingsProvidersView() {
  const [list, setList] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('');

  async function load() {
    try {
      await loadApp({ force: true });
    } catch (e) {
      setStatusMsg('load failed: ' + e.message);
      setStatusType('error');
      return;
    }
    const providers = appProviders();
    setList(providers);
    if (!providers.length) {
      setStatusMsg('0 providers');
      setStatusType('');
    } else {
      setStatusMsg(providers.length + (providers.length === 1 ? ' provider' : ' providers'));
      setStatusType('success');
    }
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '‹'),
      h('h2', { class: 'view-title' }, 'Providers')
    ),
    h('p', { class: 'hint hint--compact' }, 'Credentials live in the app store. Each project\'s models reference one of these.'),
    h('ul', { class: 'providers__list', 'aria-label': 'Configured providers' },
      list === null ? null :
      list.length === 0 ? h('li', { class: 'providers__empty' }, 'No providers yet. Tap "Add provider" to configure your first connection.') :
      list.map(p => {
        const def = providerDef(p.id);
        const name = (def && def.label) || p.id;
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
        return h('li', { class: 'provider-row', key: p.id },
          h('a', { class: 'provider-row__main', href: '#/settings/providers/' + encodeURIComponent(p.id) },
            h('div', { class: 'provider-row__name' }, name),
            h('div', { class: 'provider-row__meta' }, bits.join('  ·  ')),
            h('div', { class: 'provider-row__chev' }, '›')
          )
        );
      })
    ),
    h('div', { class: 'page-bar' },
      h('span', { class: 'status page-bar__status' + (statusType ? ' status--' + statusType : ''), 'aria-live': 'polite' }, statusMsg),
      h('a', { href: '#/settings/providers/new', class: 'page-bar__add', 'aria-label': 'Add provider' }, '+')
    )
  );
}

export function SettingsProviderEditView(props) {
  const id = props.id || '';

  const [currentId, setCurrentId] = useState(id || 'openai-compatible');
  const [current, setCurrent] = useState(null);

  const reservedFor = (pid) => { const d = providerDef(pid); return !!(d && d.reserved); };
  const [authMode, setAuthMode] = useState(reservedFor(id || 'openai-compatible') ? 'oauth' : 'apikey');
  const initialBaseUrl = (() => { const d = providerDef(id || 'openai-compatible'); return (d && d.defaultBaseUrl) || ''; })();
  const [baseUrlVal, setBaseUrlVal] = useState(initialBaseUrl);

  const [apiKeyValue, setApiKeyValue] = useState('');
  const [oauthAccountVal, setOauthAccountVal] = useState('');
  const [copilotClientIdVal, setCopilotClientIdVal] = useState('');
  const [oauthAccountOptions, setOauthAccountOptions] = useState([]);

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('');

  const [signInStatusMsg, setSignInStatusMsg] = useState('');
  const [signInStatusType, setSignInStatusType] = useState('');

  const [copilotStatusMsg, setCopilotStatusMsg] = useState('');
  const [copilotStatusType, setCopilotStatusType] = useState('');

  const [accountsMap, setAccountsMap] = useState({});

  const currentDef0 = () => providerDef(currentId);

  async function load() {
    let app;
    let nextAccounts;
    try {
      app = await loadApp({ force: true });
      nextAccounts = await loadAccounts({ force: true });
      setAccountsMap(nextAccounts);
    } catch (e) {
      setStatusMsg('load failed: ' + e.message);
      setStatusType('error');
      return;
    }
    const found = id ? appProviders().find(p => p && p.id === id) : null;
    if (id && !found) {
      setStatusMsg('Provider not found');
      setStatusType('error');
      return;
    }
    setCurrent(found || null);
    
    if (app && app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) {
      setCopilotClientIdVal(app.app.githubCopilot.clientId);
    } else {
      setCopilotClientIdVal('');
    }

    setAuthMode(resolveAuthMode(currentId, found));
    setBaseUrlVal(nextBaseUrl(currentId, found, (found && found.baseUrl) || ''));

    syncOauthAccountOptions(currentId, nextAccounts, found);
    setApiKeyValue('');
    
    setStatusMsg('');
    setStatusType('');
  }

  const oauthCapable = (pid) => { const d = providerDef(pid); return !!(d && (d.oauth || d.reserved)); };

  function resolveAuthMode(pid, record) {
    if (reservedFor(pid)) return 'oauth';
    if (record && record.id === pid && record.auth === 'oauth' && oauthCapable(pid)) return 'oauth';
    if (record && record.id === pid && record.auth === 'apikey') return 'apikey';
    return 'apikey';
  }

  function syncOauthAccountOptions(pid = currentId, accs = accountsMap, record = current) {
    const ns = authNsForProvider(pid);
    const list = (accs[ns] || []).slice();
    let opts = [];
    let newVal = '';
    
    if (list.length === 0) {
      opts.push({ value: '', text: '— no accounts yet; sign in below —', disabled: true });
    } else if (list.length === 1) {
      opts.push({ value: '', text: '(auto — ' + list[0] + ')' });
    } else {
      opts.push({ value: '', text: '(pick an account)', disabled: true });
    }
    for (const a of list) {
      opts.push({ value: a, text: a });
    }
    setOauthAccountOptions(opts);
    
    const cur = (record && record.oauthAccount) || '';
    if (cur && list.includes(cur)) newVal = cur;
    setOauthAccountVal(newVal);
  }

  function nextBaseUrl(pid, record, currentVal) {
    const def = providerDef(pid);
    const configured = (record && record.id === pid) ? record : null;
    const target = (configured && configured.baseUrl) || (def && def.defaultBaseUrl) || '';
    const cur = (currentVal || '').trim();
    const known = SETTINGS_PROVIDERS.map(p => p.defaultBaseUrl).filter(Boolean);
    return (!cur || known.includes(cur)) ? target : cur;
  }

  async function startSignIn() {
    const provider = currentId;
    const def = providerDef(provider);
    if (!def) { setSignInStatusMsg('unknown provider'); setSignInStatusType('error'); return; }
    if (!oauthCapable(provider)) {
      setSignInStatusMsg(def.label + ' does not support OAuth sign-in; use an API key.');
      setSignInStatusType('error');
      return;
    }
    setSignInStatusMsg('starting sign-in…');
    setSignInStatusType('busy');
    let r;
    try {
      r = await fetchJson('/api/auth/sign-in/' + encodeURIComponent(provider), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri: new URL('/oauth/callback', window.location.href).toString() })
      });
    } catch (err) { setSignInStatusMsg('network error'); setSignInStatusType('error'); return; }
    if (r.status !== 200) { setSignInStatusMsg('HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : '')); setSignInStatusType('error'); return; }
    const authorizeUrl = r.body.authorizeUrl;
    
    const win = window.open(authorizeUrl, '_blank');
    if (!win) {
      try { sessionStorage.setItem('oauthPending', JSON.stringify({ provider, started: Date.now() })); } catch (_) { }
      window.location.href = authorizeUrl;
      return;
    }
    setSignInStatusMsg('waiting for ' + def.label + ' to redirect back…');
    setSignInStatusType('busy');

    const before = new Set((accountsMap[authNsForProvider(provider)] || []).slice());
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const next = await loadAccounts({ force: true });
        setAccountsMap(next);
        const list = (next[authNsForProvider(provider)] || []);
        const fresh = list.filter(a => !before.has(a));
        if (fresh.length) {
          syncOauthAccountOptions(provider, next, current);
          setSignInStatusMsg('signed in as ' + fresh[0]);
          setSignInStatusType('success');
          return;
        }
      } catch { /* keep polling */ }
    }
    setSignInStatusMsg('timed out. Paste the redirect URL or its code below.');
    setSignInStatusType('error');
  }

  async function saveCopilotClientId() {
    const value = copilotClientIdVal.trim();
    setCopilotStatusMsg('saving…');
    setCopilotStatusType('busy');
    try {
      await saveApp({ githubCopilot: { clientId: value || null } });
      setCopilotStatusMsg(value ? 'saved — you can sign in now.' : 'cleared (using default).');
      setCopilotStatusType('success');
    } catch (e) {
      setCopilotStatusMsg('save failed: ' + e.message);
      setCopilotStatusType('error');
    }
  }

  async function save() {
    setIsSaving(true);
    setStatusMsg('saving…');
    setStatusType('busy');
    const providerId = currentId;
    const def = providerDef(providerId);
    const auth = (def && def.reserved) ? 'oauth' : authMode;
    const base = (baseUrlVal || '').trim();
    const key = apiKeyValue.trim();
    const account = oauthAccountVal.trim();

    if (auth === 'oauth') {
      let accs = accountsMap;
      try {
        accs = await loadAccounts({ force: true });
        setAccountsMap(accs);
      } catch { /* fall through */ }
      const list = accs[authNsForProvider(providerId)] || [];
      if (!list.length) { setStatusMsg('sign in to ' + providerId + ' first'); setStatusType('error'); setIsSaving(false); return; }
      if (list.length > 1 && !account) { setStatusMsg('pick which signed-in account to use'); setStatusType('error'); setIsSaving(false); return; }
    }
    // Local OpenAI-shaped servers (llama.cpp's llama-server, LM Studio, a
    // local Ollama at /v1) take no key. A provider that marks its key
    // optional lets the user save a keyless connection; the server then
    // sends no Authorization header. Hosted endpoints still require a key.
    const keyOptional = !!(def && (def.keyOptional || providerId === 'ollama'));
    if (auth === 'apikey' && !keyOptional && !key && !(current && current.hasApiKey)) {
    setStatusMsg('API key is required for ' + providerId);
    setStatusType('error');
    setIsSaving(false);
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
    } catch (err) { setStatusMsg('network error'); setStatusType('error'); setIsSaving(false); return; }
    setIsSaving(false);
    if (r.status !== 200) { setStatusMsg('HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : '')); setStatusType('error'); return; }
    setStatusMsg('saved ' + providerId);
    setStatusType('success');
    nav('settings/providers');
  }

  async function deleteProvider() {
    if (!id) return;
    if (!confirm('Delete provider "' + id + '"? Models in your projects that reference it will stop working until you re-add it.')) return;
    setIsDeleting(true);
    setStatusMsg('deleting…');
    setStatusType('busy');
    let r;
    try {
      r = await fetchJson('/api/settings/app/providers/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) { setStatusMsg('network error'); setStatusType('error'); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg('HTTP ' + r.status); setStatusType('error'); setIsDeleting(false); return; }
    nav('settings/providers');
  }

  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    setCurrentId(id || 'openai-compatible');
    setCurrent(null);
  }, [id]);

  const def = currentDef0();
  const titleText = id ? ((def && def.label) || id) : 'Add provider';
  const reserved = !!(def && def.reserved);
  const canOAuth = oauthCapable(currentId);
  const effAuth = reserved ? 'oauth' : (canOAuth ? authMode : 'apikey');
  const singleAuth = reserved || !canOAuth;
  const hide = (cond) => 'row' + (cond ? ' is-hidden' : '');

  function onProviderChange(e) {
    const pid = e.target.value;
    setCurrentId(pid);
    setAuthMode(resolveAuthMode(pid, current));
    setBaseUrlVal((cur) => nextBaseUrl(pid, current, cur));
    syncOauthAccountOptions(pid, accountsMap, current);
  }

  const showKeyHint = authMode === 'apikey' && current && current.hasApiKey;

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
        h('select', { class: 'input', id: 'sp-id', disabled: !!id, value: currentId, onChange: onProviderChange },
          SETTINGS_PROVIDERS.map(p => h('option', { value: p.id, key: p.id }, p.label))
        )
      ),
      h('div', { class: hide(reserved) + ' row--base' },
        h('label', { class: 'label', for: 'sp-base' }, 'API base URL'),
        h('input', { class: 'input', id: 'sp-base', type: 'url', placeholder: 'https://api.openai.com/v1',
          value: baseUrlVal, onInput: (e) => setBaseUrlVal(e.target.value) })
      ),
      h('div', { class: hide(singleAuth) },
        h('label', { class: 'label', for: 'sp-auth' }, 'Authentication'),
        h('select', { class: 'input', id: 'sp-auth', value: effAuth,
          onChange: (e) => { setAuthMode(e.target.value); } },
          h('option', { value: 'apikey' }, 'API key'),
          canOAuth ? h('option', { value: 'oauth' }, 'OAuth') : null
        )
      ),
      h('div', { class: hide(!reserved) + ' row__static-wrap' },
        h('div', { class: 'row__static' },
          h('span', { class: 'label' }, 'Authentication'),
          h('span', { class: 'row__static-value' }, 'OAuth (required)'),
          h('span', { class: 'row__static-note' }, 'This provider only supports OAuth sign-in.')
        )
      ),
      h('div', { class: hide(effAuth !== 'apikey') + ' row--apikey' },
        h('label', { class: 'label', for: 'sp-key' }, 'Provider API key'),
        h('input', { class: 'input', id: 'sp-key', type: 'password', placeholder: 'paste key', autocomplete: 'off',
          value: apiKeyValue, onInput: (e) => setApiKeyValue(e.target.value) })
      ),
      h('p', { class: 'hint hint--compact key-hint', hidden: !showKeyHint },
        showKeyHint ? 'a key is already saved for this provider; leave the field empty to keep it' : ''
      ),
      h('div', { class: hide(effAuth !== 'oauth') + ' row--oauth' },
        h('label', { class: 'label', for: 'sp-account' }, 'OAuth account'),
        h('select', { class: 'input', id: 'sp-account', value: oauthAccountVal, onChange: (e) => setOauthAccountVal(e.target.value) },
          oauthAccountOptions.map((opt, i) => h('option', { key: i, value: opt.value, disabled: opt.disabled }, opt.text))
        )
      ),
      h('div', { class: hide(effAuth !== 'oauth' || currentId !== 'github-copilot') + ' row--oauth row--copilot' },
        h('label', { class: 'label', for: 'sp-copilot-id' }, 'GitHub OAuth app client ID'),
        h('p', { class: 'hint hint--compact' }, 'GitHub does not allow third-party apps to use the public Copilot client_id with a loopback callback. Create a personal OAuth app at ', h('code', null, 'github.com/settings/developers'), ' (Developer settings → OAuth Apps → New OAuth App) with callback ', h('code', null, 'http://127.0.0.1:5732/oauth/callback?provider=github-copilot'), ', then paste its client_id here and Save before signing in. Leave blank to use the shipped default.'),
        h('input', { class: 'input', id: 'sp-copilot-id', type: 'text', placeholder: 'Iv1.xxxxxxxxxxxxxxxx', autocomplete: 'off',
          value: copilotClientIdVal, onInput: (e) => setCopilotClientIdVal(e.target.value) }),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: saveCopilotClientId }, 'Save client ID'),
          h('span', { class: 'status' + (copilotStatusType ? ' status--' + copilotStatusType : ''), 'aria-live': 'polite' }, copilotStatusMsg)
        )
      ),
      h('div', { class: hide(effAuth !== 'oauth') + ' row--oauth' },
        h('div', { class: 'auth__help-inline' },
          h('p', { class: 'hint hint--compact' }, 'Sign in to this provider below; the OAuth-account list refreshes automatically.'),
          h('div', { class: 'row row--actions' },
            h('button', { class: 'btn', type: 'button', onClick: startSignIn }, 'Sign in'),
            h('span', { class: 'status' + (signInStatusType ? ' status--' + signInStatusType : ''), 'aria-live': 'polite' }, signInStatusMsg)
          )
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', type: 'button', disabled: isSaving, onClick: save }, id ? 'Save' : 'Add provider'),
        h('button', { class: 'btn btn--danger', type: 'button', disabled: isDeleting, onClick: deleteProvider, hidden: !id }, 'Delete'),
        h('span', { class: 'status' + (statusType ? ' status--' + statusType : ''), 'aria-live': 'polite' }, statusMsg)
      )
    )
  );
}
