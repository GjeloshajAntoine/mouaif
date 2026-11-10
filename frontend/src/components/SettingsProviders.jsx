// mouaif web — SettingsProvidersView, SettingsProviderNewView + SettingsProviderEditView
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, loadApp, saveApp, appProviders, loadAccounts, checkConnection, providerDef, connectionType, authNsForProvider } from '../api.js';
import { baseUrlProblem, keyIsRequired, providerChoice, uniqueName } from '../providerChoices.js';
import { back, replace } from '../router.js';
import { SettingsProviderPicker } from './SettingsProviderPicker.jsx';

const HEALTH_STATE = { ok: 'success', error: 'error' };

export function SettingsProvidersView() {
  const [list, setList] = useState(null);
  const [health, setHealth] = useState({});
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);

  async function load() {
    try {
      await loadApp({ force: true });
    } catch (e) {
      setLoadError('Couldn\'t load providers: ' + e.message);
      return;
    }
    const providers = appProviders();
    setList(providers);
    // Rows appear at once and each fills in its own status as the answer arrives.
    for (const connection of providers) {
      checkConnection(connection).then((result) => {
        if (alive.current) setHealth((all) => ({ ...all, [connection.id]: result }));
      });
    }
  }

  useEffect(() => {
    load();
    return () => { alive.current = false; };
  }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Providers')
    ),
    // The scroll container. Flush routes (no tab bar) only scroll when
    // <main> has a single root <section> child — `.app__main--flush >
    // section` is the rule that turns it into the internal scroll
    // container. A bare Fragment left a long provider list clipped with
    // no way to reach it.
    h('section', null,
    h('p', { class: 'hint hint--compact' }, 'All your projects share these. Keys stay on the computer running mouaif.'),
    h('ul', { class: 'providers__list', 'aria-label': 'Configured providers' },
      list === null ? null :
      list.length === 0 ? h('li', { class: 'providers__empty' }, 'No providers yet. Add one to start chatting.') :
      list.map(p => {
        const type = connectionType(p);
        const def = providerDef(type);
        const name = p.name || (def && def.label) || p.id;
        const result = health[p.id];
        const bits = [];
        // Tells apart two unnamed connections of the same type.
        if (!p.name && p.id !== type) bits.push(p.id);
        if (p.baseUrl && p.baseUrl !== (def && def.defaultBaseUrl)) bits.push(p.baseUrl);
        if (p.auth === 'oauth' && p.oauthAccount) bits.push(p.oauthAccount);
        return h('li', { class: 'provider-row', key: p.id },
          h('a', { class: 'provider-row__main', href: '#/settings/providers/' + encodeURIComponent(p.id) },
            h('div', { class: 'provider-row__body' },
              h('div', { class: 'provider-row__name' }, name),
              bits.length ? h('div', { class: 'provider-row__meta' }, bits.join('  ·  ')) : null,
              h('div', { class: 'status provider-row__health', 'data-state': result ? HEALTH_STATE[result.state] : undefined }, result ? result.text : 'Checking…')
            ),
            h('div', { class: 'provider-row__chev' }, '›')
          )
        );
      })
    ),
    h('div', { class: 'page-bar' },
      h('span', { class: 'status page-bar__status', 'data-state': loadError ? 'error' : undefined, 'aria-live': 'polite' }, loadError),
      h('a', { href: '#/settings/providers/new', class: 'page-bar__add page-bar__add--label' }, '+ Add provider')
    )
    )
  );
}

// #/settings/providers/new asks how to connect. With a choice in the route it
// opens that choice's form; `key` gives each choice its own form state, so
// nothing typed for one provider can reach another.
export function SettingsProviderNewView({ type }) {
  return providerChoice(type)
    ? h(SettingsProviderEditView, { key: type, type })
    : h(SettingsProviderPicker);
}

export function SettingsProviderEditView(props) {
  // `id` is the connection being edited ('' when adding one). `choice` is what
  // was picked when adding. `currentId` is the connection's type, which picks
  // its sign-in flow and account list.
  const id = props.id || '';
  const choice = id ? null : providerChoice(props.type);
  const initialType = () => {
    if (!id) return choice ? choice.type : '';
    const known = appProviders().find(p => p && p.id === id);
    return known ? connectionType(known) : id;
  };
  const startingUrl = (pid) => {
    if (choice && choice.baseUrl !== undefined) return choice.baseUrl;
    const d = providerDef(pid);
    return (d && d.defaultBaseUrl) || '';
  };

  const [currentId, setCurrentId] = useState(initialType);
  const [current, setCurrent] = useState(null);

  const reservedFor = (pid) => { const d = providerDef(pid); return !!(d && d.reserved); };
  const [authMode, setAuthMode] = useState(() => choice ? choice.auth : (reservedFor(initialType()) ? 'oauth' : 'apikey'));
  const [baseUrlVal, setBaseUrlVal] = useState(() => startingUrl(initialType()));

  const [nameVal, setNameVal] = useState('');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [oauthAccountVal, setOauthAccountVal] = useState('');
  const [copilotClientIdVal, setCopilotClientIdVal] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('');

  const [signInStatusMsg, setSignInStatusMsg] = useState('');
  const [signInStatusType, setSignInStatusType] = useState('');

  const [copilotStatusMsg, setCopilotStatusMsg] = useState('');
  const [copilotStatusType, setCopilotStatusType] = useState('');

  const [accountsMap, setAccountsMap] = useState({});
  const [health, setHealth] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  // A sign-in can finish long after it started, so it reads these rather than
  // the values from when it began, and stops if you have left the form.
  const alive = useRef(true);
  const latest = useRef({});
  latest.current = { name: nameVal, baseUrl: baseUrlVal, key: apiKeyValue };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function runCheck(connection, { force = false } = {}) {
    setIsChecking(true);
    const result = await checkConnection(connection, { force });
    if (!alive.current) return result;
    setHealth(result);
    setIsChecking(false);
    return result;
  }

  async function load() {
    let app;
    let nextAccounts;
    try {
      app = await loadApp({ force: true });
      nextAccounts = await loadAccounts({ force: true });
      setAccountsMap(nextAccounts);
    } catch (e) {
      setStatusMsg('Couldn\'t load this provider: ' + e.message);
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
    const pid = found ? connectionType(found) : currentId;
    setCurrentId(pid);
    setNameVal((found && found.name) || '');

    if (app && app.app && app.app.githubCopilot && app.app.githubCopilot.clientId) {
      setCopilotClientIdVal(app.app.githubCopilot.clientId);
    } else {
      setCopilotClientIdVal('');
    }

    setAuthMode(choice ? choice.auth : resolveAuthMode(pid, found));
    setBaseUrlVal((found && found.baseUrl) || startingUrl(pid));

    syncOauthAccount(pid, nextAccounts, found);
    setApiKeyValue('');

    setStatusMsg('');
    setStatusType('');
    if (found) runCheck(found);
  }

  const oauthCapable = (pid) => { const d = providerDef(pid); return !!(d && (d.oauth || d.reserved)); };

  function resolveAuthMode(pid, record) {
    if (reservedFor(pid)) return 'oauth';
    if (record && connectionType(record) === pid && record.auth === 'oauth' && oauthCapable(pid)) return 'oauth';
    return 'apikey';
  }

  function syncOauthAccount(pid = currentId, accs = accountsMap, record = current) {
    const list = accs[authNsForProvider(pid)] || [];
    const saved = (record && record.oauthAccount) || '';
    if (saved && list.includes(saved)) setOauthAccountVal(saved);
    else setOauthAccountVal(list.length === 1 ? list[0] : '');
  }

  // Signing in when adding is the whole job, so it creates the connection. When
  // editing, the rest of the form may have unsaved changes, so Save stays yours.
  function finishSignIn(account) {
    if (id) {
      setSignInStatusMsg('Signed in as ' + account + '. Tap Save to use this account.');
      setSignInStatusType('success');
      return;
    }
    setSignInStatusMsg('Signed in as ' + account + '.');
    setSignInStatusType('success');
    save({ account });
  }

  async function startSignIn() {
    const provider = currentId;
    const def = providerDef(provider);
    if (!def) { setSignInStatusMsg('Unknown provider.'); setSignInStatusType('error'); return; }
    if (!oauthCapable(provider)) {
      setSignInStatusMsg(def.label + ' doesn\'t offer sign-in. Use an API key.');
      setSignInStatusType('error');
      return;
    }
    setSignInStatusMsg('Starting sign-in…');
    setSignInStatusType('busy');
    let r;
    try {
      r = await fetchJson('/api/auth/sign-in/' + encodeURIComponent(provider), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri: new URL('/oauth/callback', window.location.href).toString() })
      });
    } catch (err) { setSignInStatusMsg('Network error. Try again.'); setSignInStatusType('error'); return; }
    if (r.status !== 200) { setSignInStatusMsg('Sign-in failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status)); setSignInStatusType('error'); return; }
    const authorizeUrl = r.body.authorizeUrl;

    let completedAccount = '';
    let win;
    const onCompletion = (event) => {
    if (event.origin !== window.location.origin || event.source !== win) return;
    const data = event.data;
    if (data?.type === 'mouaif:oauth-complete' && data.state === r.body.state && typeof data.account === 'string') {
      completedAccount = data.account;
    }
    };
    window.addEventListener('message', onCompletion);
    win = window.open(authorizeUrl, '_blank');
    if (!win) {
      window.removeEventListener('message', onCompletion);
      try { sessionStorage.setItem('oauthPending', JSON.stringify({ provider, connection: id, choice: props.type, started: Date.now() })); } catch (_) { }
      window.location.href = authorizeUrl;
      return;
    }
    setSignInStatusMsg('Waiting for you to finish signing in with ' + def.label + '…');
    setSignInStatusType('busy');

    const before = new Set((accountsMap[authNsForProvider(provider)] || []).slice());
    const start = Date.now();
    try {
    while (Date.now() - start < 5 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      if (!alive.current) return;
      try {
      const next = await loadAccounts({ force: true });
      if (!alive.current) return;
      setAccountsMap(next);
      const list = (next[authNsForProvider(provider)] || []);
      const fresh = list.filter(a => !before.has(a));
      const account = completedAccount || fresh[0];
      if (account && list.includes(account)) {
        setOauthAccountVal(account);
        finishSignIn(account);
        return;
      }
      } catch { /* keep polling */ }
    }
    } finally {
    window.removeEventListener('message', onCompletion);
    }
    setSignInStatusMsg('Sign-in timed out. Start it again.');
    setSignInStatusType('error');
  }

  // Device sign-in works on a phone without a loopback callback.
  const [deviceFlow, setDeviceFlow] = useState(null);
  const [deviceStarting, setDeviceStarting] = useState(false);
  const deviceIdRef = useRef(null);
  const deviceEndpoint = '/api/auth/device/' + encodeURIComponent(currentId);
  const deviceService = currentId === 'codex' ? 'ChatGPT' : 'GitHub';
  useEffect(() => {
    setDeviceFlow(null);
    setDeviceStarting(false);
    return () => {
      const flow = deviceIdRef.current;
      deviceIdRef.current = null;
      if (flow?.id) fetchJson(flow.endpoint + '?id=' + encodeURIComponent(flow.id), { method: 'DELETE' }).catch(() => {});
    };
  }, [currentId]);

  async function startDeviceSignIn() {
    if (deviceIdRef.current) return;
    const request = { id: null, endpoint: deviceEndpoint };
    deviceIdRef.current = request;
    setDeviceStarting(true);
    setSignInStatusMsg('Asking ' + deviceService + ' for a code…');
    setSignInStatusType('busy');
    let r;
    try { r = await fetchJson(deviceEndpoint, { method: 'POST' }); }
    catch (err) {
      if (deviceIdRef.current !== request) return;
      deviceIdRef.current = null;
      setSignInStatusMsg('Network error. Try again.'); setSignInStatusType('error'); return;
    } finally { if (deviceIdRef.current === request || deviceIdRef.current === null) setDeviceStarting(false); }
    if (deviceIdRef.current !== request) {
      if (r.status === 200 && r.body?.id) fetchJson(deviceEndpoint + '?id=' + encodeURIComponent(r.body.id), { method: 'DELETE' }).catch(() => {});
      return;
    }
    if (r.status !== 200) {
      deviceIdRef.current = null;
      setSignInStatusMsg((r.body && r.body.error) || ('Sign-in failed (HTTP ' + r.status + ').')); setSignInStatusType('error'); return;
    }
    const flow = r.body;
    deviceIdRef.current = { id: flow.id, endpoint: deviceEndpoint };
    setDeviceFlow(flow);
    setSignInStatusMsg('Enter the code on ' + deviceService + ', then come back here.');
    setSignInStatusType('busy');
    while (deviceIdRef.current?.id === flow.id && Date.now() < flow.expiresAt + 5000) {
      await new Promise((res) => setTimeout(res, 2000));
      if (deviceIdRef.current?.id !== flow.id) return;
      let st;
      try { st = await fetchJson(deviceEndpoint + '?id=' + encodeURIComponent(flow.id)); } catch { continue; }
      if (deviceIdRef.current?.id !== flow.id) return;
      // A lost flow or expired app session will not recover by polling.
      // Keep retrying transient network/server failures, but expose 4xx errors.
      if (st.status >= 400 && st.status < 500 && st.status !== 408 && st.status !== 429) {
        cancelDeviceSignIn();
        setSignInStatusMsg(st.status === 404
          ? 'The sign-in session was lost. Start sign-in again.'
          : (st.body?.error || ('Sign-in status check failed (HTTP ' + st.status + ').')));
        setSignInStatusType('error');
        return;
      }
      if (st.status !== 200 || !st.body) continue;
      if (st.body.status === 'pending') continue;
      deviceIdRef.current = null;
      setDeviceFlow(null);
      if (st.body.status === 'ok') {
        try {
          const next = await loadAccounts({ force: true });
          setAccountsMap(next);
        } catch { /* the list refreshes on the next load */ }
        setOauthAccountVal(st.body.account);
        finishSignIn(st.body.account);
      } else {
        setSignInStatusMsg(st.body.error || ('Sign-in ' + st.body.status + '.'));
        setSignInStatusType('error');
      }
      return;
    }
    if (deviceIdRef.current?.id === flow.id) {
      cancelDeviceSignIn();
      setSignInStatusMsg('The code expired. Start sign-in again.');
      setSignInStatusType('error');
    }
  }

  function cancelDeviceSignIn() {
    const flow = deviceIdRef.current;
    deviceIdRef.current = null;
    setDeviceFlow(null);
    setSignInStatusMsg('');
    setSignInStatusType('');
    if (flow?.id) fetchJson(flow.endpoint + '?id=' + encodeURIComponent(flow.id), { method: 'DELETE' }).catch(() => {});
  }

  async function copyDeviceCode() {
    if (!deviceFlow) return;
    try { await navigator.clipboard.writeText(deviceFlow.userCode); setSignInStatusMsg('Code copied. Paste it on ' + deviceService + '.'); }
    catch { /* clipboard blocked; the code is on screen */ }
  }

  async function saveCopilotClientId() {
    const value = copilotClientIdVal.trim();
    setCopilotStatusMsg('Saving…');
    setCopilotStatusType('busy');
    try {
      await saveApp({ githubCopilot: { clientId: value || null } });
      setCopilotStatusMsg(value ? 'Saved. You can sign in now.' : 'Cleared. Using the default.');
      setCopilotStatusType('success');
    } catch (e) {
      setCopilotStatusMsg('Couldn\'t save: ' + e.message);
      setCopilotStatusType('error');
    }
  }

  function refuse(message) {
    setStatusMsg(message);
    setStatusType('error');
    setIsSaving(false);
  }

  async function save({ account: signedInAccount } = {}) {
    setIsSaving(true);
    setStatusMsg('Saving…');
    setStatusType('busy');
    const providerId = currentId;
    const def = providerDef(providerId);
    const auth = (def && def.reserved) ? 'oauth' : authMode;
    const urlRequired = !!((choice && choice.urlRequired) || !(def && def.defaultBaseUrl));
    const typed = (latest.current.baseUrl || '').trim();
    const key = (latest.current.key || '').trim();
    const account = (signedInAccount || oauthAccountVal).trim();

    if (!reservedFor(providerId)) {
      const problem = baseUrlProblem(typed, { required: urlRequired });
      if (problem) return refuse(problem);
    }
    // Clearing the URL returns it to the provider's own address.
    const base = typed || (def && def.defaultBaseUrl) || '';

    if (auth === 'oauth' && !signedInAccount) {
      let accs = accountsMap;
      try {
        accs = await loadAccounts({ force: true });
        setAccountsMap(accs);
      } catch { /* fall through */ }
      const list = accs[authNsForProvider(providerId)] || [];
      if (!list.length) return refuse('Sign in to ' + def.label + ' first.');
      if (list.length > 1 && !account) return refuse('Choose which account to use.');
    }
    if (auth === 'apikey' && keyIsRequired(providerId, base) && !key && !(current && current.hasApiKey)) {
      return refuse('Paste your API key.');
    }
    // Adding sends only the type, so a second connection of a type gets its own
    // id instead of overwriting the first.
    const body = id ? { id, auth } : { type: providerId, auth };
    const preset = !id && choice && choice.presetName;
    const taken = appProviders().map(p => p && p.name).filter(Boolean);
    body.name = latest.current.name.trim() || (preset ? uniqueName(preset, taken) : '');
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
    } catch (err) { return refuse('Network error. Try again.'); }
    if (r.status !== 200) return refuse('Couldn\'t save: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));

    // A provider that can't be used shouldn't look finished. It stays saved, and
    // you land on its edit form with the reason, so fixing it can't add a duplicate.
    const saved = r.body.provider;
    setStatusMsg('Checking the connection…');
    setStatusType('busy');
    const result = await runCheck(saved, { force: true });
    if (!alive.current) return;
    setIsSaving(false);
    if (result.state === 'error') {
      if (!id) { replace('settings/providers/' + encodeURIComponent(saved.id)); return; }
      setCurrent(saved);
      setApiKeyValue('');
      setStatusMsg('');
      setStatusType('');
      return;
    }
    back('settings/providers');
  }

  async function deleteProvider() {
    if (!id) return;
    if (!confirm('Delete provider "' + ((current && current.name) || id) + '"? Models in your projects that use it will stop working until you add it again.')) return;
    setIsDeleting(true);
    setStatusMsg('Deleting…');
    setStatusType('busy');
    let r;
    try {
      r = await fetchJson('/api/settings/app/providers/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) { setStatusMsg('Network error. Try again.'); setStatusType('error'); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg('Couldn\'t delete (HTTP ' + r.status + ').'); setStatusType('error'); setIsDeleting(false); return; }
    back('settings/providers');
  }

  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    setCurrentId(initialType());
    setCurrent(null);
    setHealth(null);
  }, [id]);

  const def = providerDef(currentId);
  const titleText = id ? ((current && current.name) || (def && def.label) || id) : (choice ? choice.label : 'Add provider');
  const reserved = !!(def && def.reserved);
  const canOAuth = oauthCapable(currentId);
  const effAuth = reserved ? 'oauth' : (canOAuth ? authMode : 'apikey');
  const accounts = accountsMap[authNsForProvider(currentId)] || [];
  const hasAccounts = accounts.length > 0;
  const hintText = (choice && choice.hint) || (def && def.hint) || '';
  // An empty address falls back to the default, unless this choice has you give one.
  const keyRequired = keyIsRequired(currentId, baseUrlVal || (choice && choice.urlRequired ? '' : (def && def.defaultBaseUrl)));
  const signInButtonClass = hasAccounts ? 'btn' : 'btn btn--primary';
  // Nothing to submit until there is an account: signing in is the action.
  const showSubmit = !!id || effAuth !== 'oauth' || hasAccounts;

  const nameRow = h('div', { class: 'row' },
    h('label', { class: 'label', for: 'sp-name' }, 'Name (optional)'),
    h('input', { class: 'input', id: 'sp-name', type: 'text', maxLength: 80, autocomplete: 'off',
      placeholder: (choice && choice.presetName) || (def && def.label) || 'e.g. Work account',
      value: nameVal, onInput: (e) => setNameVal(e.target.value) })
  );
  const urlRow = reserved ? null : h('div', { class: 'row row--base' },
    h('label', { class: 'label', for: 'sp-base' }, choice && choice.local ? 'Server address' : 'API address'),
    h('input', { class: 'input', id: 'sp-base', type: 'url', autocomplete: 'off',
      placeholder: (def && (def.defaultBaseUrl || def.urlPlaceholder)) || 'https://api.example.com/v1',
      value: baseUrlVal, onInput: (e) => setBaseUrlVal(e.target.value) })
  );
  const keyRow = h('div', { class: 'row row--apikey' },
    h('label', { class: 'label', for: 'sp-key' }, keyRequired ? 'API key' : 'API key (optional)'),
    h('input', { class: 'input', id: 'sp-key', type: 'password', autocomplete: 'off',
      placeholder: current && current.hasApiKey ? 'Saved. Paste a new key to replace it.' : (keyRequired ? 'Paste your key' : 'Leave empty if none is needed'),
      value: apiKeyValue, onInput: (e) => setApiKeyValue(e.target.value) })
  );
  const authRow = id && canOAuth && !reserved ? h('div', { class: 'row' },
    h('label', { class: 'label', for: 'sp-auth' }, 'How to connect'),
    h('select', { class: 'input', id: 'sp-auth', value: effAuth,
      onChange: (e) => { setAuthMode(e.target.value); } },
      h('option', { value: 'apikey' }, 'API key'),
      h('option', { value: 'oauth' }, 'Sign in')
    )
  ) : null;
  const accountRow = hasAccounts ? h('div', { class: 'row row--oauth' },
    h('label', { class: 'label', for: 'sp-account' }, 'Account'),
    h('select', { class: 'input', id: 'sp-account', value: oauthAccountVal, onChange: (e) => setOauthAccountVal(e.target.value) },
      accounts.length > 1 ? h('option', { value: '', disabled: true }, 'Choose an account') : null,
      accounts.map((account) => h('option', { key: account, value: account }, account))
    )
  ) : null;
  const signInStatus = h('span', { class: 'status', 'data-state': signInStatusType || undefined, 'aria-live': 'polite' }, signInStatusMsg);
  const signInRow = def && def.deviceAuth
    ? h('div', { class: 'row row--oauth' },
        deviceFlow
          ? h('div', { class: 'copilot-device' },
              h('button', { class: 'copilot-device__code', type: 'button', onClick: copyDeviceCode, 'aria-label': 'Copy code ' + deviceFlow.userCode, title: 'Copy code' }, deviceFlow.userCode),
              h('div', { class: 'provider-form__actions' },
                h('a', { class: 'btn btn--primary', href: deviceFlow.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, currentId === 'codex' ? 'Open ChatGPT sign-in' : 'Open github.com/login/device'),
                h('button', { class: 'btn', type: 'button', onClick: cancelDeviceSignIn }, 'Cancel')
              ),
              h('p', { class: 'hint hint--compact' }, 'Only approve a code you asked for here.')
            )
          : h('div', { class: 'provider-form__actions' },
              h('button', { class: signInButtonClass, type: 'button', onClick: startDeviceSignIn, disabled: deviceStarting },
                (hasAccounts ? 'Sign in with another ' + deviceService + ' account' : 'Sign in with ' + deviceService + ' code'))
            ),
        signInStatus
      )
    : h('div', { class: 'row row--oauth' },
        h('div', { class: 'provider-form__actions' },
          h('button', { class: signInButtonClass, type: 'button', onClick: startSignIn },
            hasAccounts ? 'Sign in with another account' : 'Sign in with ' + ((def && def.signInWith) || (def && def.label) || 'this provider'))
        ),
        signInStatus
      );
  const copilotOptions = currentId === 'github-copilot' ? h('div', { class: 'row' },
    h('label', { class: 'label', for: 'sp-copilot-id' }, 'GitHub OAuth app client ID'),
    h('p', { class: 'hint hint--compact' }, 'Optional. Leave empty to use the built-in app. Your own app must have Device Flow turned on (Developer settings → OAuth Apps). For browser sign-in instead, register the callback ', h('code', null, new URL('/oauth/callback?provider=github-copilot', typeof window !== 'undefined' ? window.location.href : 'http://127.0.0.1:5732/').toString()), '.'),
    h('input', { class: 'input', id: 'sp-copilot-id', type: 'text', placeholder: 'Iv1.xxxxxxxxxxxxxxxx', autocomplete: 'off',
      value: copilotClientIdVal, onInput: (e) => setCopilotClientIdVal(e.target.value) }),
    h('div', { class: 'provider-form__actions' },
      h('button', { class: 'btn', type: 'button', onClick: saveCopilotClientId }, 'Save client ID'),
      h('button', { class: 'btn', type: 'button', onClick: startSignIn }, 'Sign in with browser')
    ),
    h('span', { class: 'status', 'data-state': copilotStatusType || undefined, 'aria-live': 'polite' }, copilotStatusMsg)
  ) : null;

  // Adding asks only for what this choice can't work without; the rest waits in
  // Advanced. Editing shows it all, because you came here to change something.
  const fields = id
    ? h(Fragment, null,
        nameRow,
        authRow,
        urlRow,
        effAuth === 'apikey' ? keyRow : h(Fragment, null, accountRow, signInRow),
        copilotOptions ? h('details', { class: 'provider-form__more' }, h('summary', { class: 'label' }, 'Advanced'), copilotOptions) : null
      )
    : h(Fragment, null,
        choice && choice.urlFirst ? urlRow : null,
        effAuth === 'apikey' && !(choice && choice.local) ? keyRow : null,
        effAuth === 'oauth' ? h(Fragment, null, accountRow, signInRow) : null,
        h('details', { class: 'provider-form__more' },
          h('summary', { class: 'label' }, 'Advanced'),
          nameRow,
          choice && choice.urlFirst ? null : urlRow,
          choice && choice.local ? keyRow : null,
          copilotOptions
        )
      );

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: id ? '#/settings/providers' : '#/settings/providers/new', class: 'view-back', 'aria-label': id ? 'Back to providers' : 'Back to the provider list' }, '←'),
      h('h2', { class: 'view-title' }, titleText)
    ),
    h('section', null,
      id && def ? h('p', { class: 'hint hint--compact' }, def.label + ' · id ', h('code', null, id)) : null,
      hintText ? h('p', { class: 'hint hint--compact' }, hintText) : null,
      id && (health || isChecking)
        ? h('div', { class: 'provider-health', role: 'status', 'data-state': isChecking ? 'busy' : HEALTH_STATE[health.state] },
            h('strong', null, isChecking ? 'Checking the connection…' : health.text),
            !isChecking && health.state !== 'ok' && health.detail ? h('span', { class: 'provider-health__detail' }, health.detail) : null
          )
        : null,
      fields,
      h('div', { class: 'provider-form__actions provider-form__actions--submit' },
        showSubmit ? h('button', { class: 'btn btn--primary', type: 'button', disabled: isSaving, onClick: () => save() }, id ? 'Save' : 'Add provider') : null,
        id ? h('button', { class: 'btn', type: 'button', disabled: isChecking || isSaving, onClick: () => current && runCheck(current, { force: true }) }, 'Test saved settings') : null,
        id ? h('button', { class: 'btn btn--danger', type: 'button', disabled: isDeleting, onClick: deleteProvider }, 'Delete') : null
      ),
      h('p', { class: 'status provider-form__status', 'data-state': statusType || undefined, 'aria-live': 'polite' }, statusMsg)
    )
  );
}
