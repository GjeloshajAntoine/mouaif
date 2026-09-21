import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, loadApp, saveApp, route } from '../api.js';

function decode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), (char) => char.charCodeAt(0));
  return bytes.buffer;
}

function encode(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialJson(credential) {
  const response = credential.response;
  const out = {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encode(response.clientDataJSON)
    }
  };
  if (response.attestationObject) out.response.attestationObject = encode(response.attestationObject);
  if (response.authenticatorData) out.response.authenticatorData = encode(response.authenticatorData);
  if (response.signature) out.response.signature = encode(response.signature);
  if (response.userHandle) out.response.userHandle = encode(response.userHandle);
  return out;
}

function registrationOptions(publicKey) {
  return {
    ...publicKey,
    challenge: decode(publicKey.challenge),
    user: { ...publicKey.user, id: decode(publicKey.user.id) },
    excludeCredentials: (publicKey.excludeCredentials || []).map((item) => ({ ...item, id: decode(item.id) }))
  };
}

function authenticationOptions(publicKey) {
  return {
    ...publicKey,
    challenge: decode(publicKey.challenge),
    allowCredentials: (publicKey.allowCredentials || []).map((item) => ({ ...item, id: decode(item.id) }))
  };
}

async function registerPasskey({ code = '', username = '', name = 'This device' } = {}) {
  if (!window.isSecureContext) throw new Error('Passkeys require HTTPS on remote devices (localhost is allowed for local development)');
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkeys are not supported in this browser');
  const options = await fetchJson('/api/access/passkeys/register/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, username })
  });
  if (options.status !== 200) throw new Error(options.body.error || 'Could not start passkey setup');
  const credential = await navigator.credentials.create({ publicKey: registrationOptions(options.body.publicKey) });
  if (!credential) throw new Error('Passkey setup was cancelled');
  const verified = await fetchJson('/api/access/passkeys/register/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: options.body.challengeId, credential: credentialJson(credential), name })
  });
  if (verified.status !== 200) throw new Error(verified.body.error || 'Passkey could not be verified');
  return verified.body;
}

async function loginWithPasskey() {
  if (!window.isSecureContext) throw new Error('Passkeys require HTTPS on remote devices (localhost is allowed for local development)');
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkeys are not supported in this browser');
  const options = await fetchJson('/api/access/passkeys/login/options', { method: 'POST' });
  if (options.status !== 200) throw new Error(options.body.error || 'Could not start passkey sign-in');
  const credential = await navigator.credentials.get({ publicKey: authenticationOptions(options.body.publicKey) });
  if (!credential) throw new Error('Passkey sign-in was cancelled');
  const verified = await fetchJson('/api/access/passkeys/login/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: options.body.challengeId, credential: credentialJson(credential) })
  });
  if (verified.status !== 200) throw new Error(verified.body.error || 'Passkey sign-in failed');
  return verified.body;
}

function AuthFrame({ title, sub, children }) {
  return h('main', { class: 'access-auth' },
    h('section', { class: 'access-auth__card' },
      h('div', { class: 'access-auth__logo', 'aria-hidden': 'true' }, 'm'),
      h('h1', null, title),
      h('p', { class: 'access-auth__sub' }, sub),
      children
    )
  );
}

function LoginView({ status, onAuthenticated, onSetup }) {
  const [username, setUsername] = useState(status.user || '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function login(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    const result = await fetchJson('/api/access/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    });
    setBusy(false);
    if (result.status === 200) onAuthenticated();
    else setMessage(result.body.error || 'Sign-in failed');
  }

  async function passkey() {
    setBusy(true); setMessage('');
    try { await loginWithPasskey(); onAuthenticated(); }
    catch (error) { setMessage(error.message); setBusy(false); }
  }

  return h(AuthFrame, { title: 'Sign in', sub: 'Access your local mouaif server.' },
    h('form', { onSubmit: login, class: 'access-auth__form' },
      h('label', { class: 'label', htmlFor: 'access-user' }, 'User'),
      h('input', { id: 'access-user', class: 'input', autocomplete: 'username', value: username, onInput: (e) => setUsername(e.currentTarget.value), required: true }),
      h('label', { class: 'label', htmlFor: 'access-password' }, 'Password'),
      h('input', { id: 'access-password', class: 'input', type: 'password', autocomplete: 'current-password', value: password, onInput: (e) => setPassword(e.currentTarget.value), required: true }),
      h('button', { class: 'btn btn--primary', type: 'submit', disabled: busy }, busy ? 'Signing in…' : 'Sign in')
    ),
    status.passkeyCount > 0 && h('button', { class: 'btn access-auth__passkey', type: 'button', disabled: busy, onClick: passkey }, 'Use a passkey'),
    message && h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, message),
    h('button', { class: 'access-auth__link', type: 'button', onClick: onSetup }, 'Have a setup code?')
  );
}

function SetupView({ initialCode = '', status, onAuthenticated, onCancel }) {
  const [code, setCode] = useState(initialCode);
  const [username, setUsername] = useState(status.user || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (initialCode) verify(initialCode); }, [initialCode]);

  async function verify(value = code) {
    setBusy(true); setMessage('');
    const result = await fetchJson('/api/access/setup/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value })
    });
    setBusy(false); setReady(result.status === 200 && result.body.valid);
    if (result.status !== 200) setMessage('That setup code is invalid or expired. Generate a new one in the CLI.');
  }

  async function save(event) {
    event.preventDefault();
    if (password !== confirm) { setMessage('Passwords do not match'); return; }
    setBusy(true); setMessage('');
    const result = await fetchJson('/api/access/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, username, password })
    });
    setBusy(false);
    if (result.status === 200) { setComplete(true); setMessage('Password saved. Add a passkey now, or continue.'); }
    else setMessage(result.body.error || 'Setup failed');
  }

  async function addPasskey() {
    setBusy(true); setMessage('');
    try { await registerPasskey({ username, name: 'Setup device' }); setMessage('Passkey added.'); setComplete(true); }
    catch (error) { setMessage(error.message); }
    setBusy(false);
  }

  if (!ready && !complete) return h(AuthFrame, { title: 'Set up access', sub: 'Open the CLI link, scan its QR code, or enter the short code.' },
    h('div', { class: 'access-auth__form' },
      h('label', { class: 'label', htmlFor: 'setup-code' }, 'Short code'),
      h('input', { id: 'setup-code', class: 'input access-auth__code', autocomplete: 'one-time-code', inputMode: 'text', placeholder: 'ABCD-2345', value: code, onInput: (e) => setCode(e.currentTarget.value.toUpperCase()), maxLength: 9 }),
      h('button', { class: 'btn btn--primary', type: 'button', disabled: busy || !code, onClick: () => verify() }, busy ? 'Checking…' : 'Continue')
    ),
    message && h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, message),
    status.configured && h('button', { class: 'access-auth__link', type: 'button', onClick: onCancel }, 'Back to sign in')
  );

  return h(AuthFrame, { title: complete ? 'Access is ready' : 'Create your account', sub: complete ? 'Use your password or passkey to sign in.' : 'This replaces the current access user and signs out other browsers.' },
    !complete && h('form', { onSubmit: save, class: 'access-auth__form' },
      h('label', { class: 'label', htmlFor: 'setup-user' }, 'User'),
      h('input', { id: 'setup-user', class: 'input', autocomplete: 'username', value: username, onInput: (e) => setUsername(e.currentTarget.value), required: true, maxLength: 128 }),
      h('label', { class: 'label', htmlFor: 'setup-password' }, 'Password'),
      h('input', { id: 'setup-password', class: 'input', type: 'password', autocomplete: 'new-password', value: password, onInput: (e) => setPassword(e.currentTarget.value), required: true, minLength: 8 }),
      h('label', { class: 'label', htmlFor: 'setup-confirm' }, 'Confirm password'),
      h('input', { id: 'setup-confirm', class: 'input', type: 'password', autocomplete: 'new-password', value: confirm, onInput: (e) => setConfirm(e.currentTarget.value), required: true, minLength: 8 }),
      h('button', { class: 'btn btn--primary', type: 'submit', disabled: busy }, busy ? 'Saving…' : 'Save access')
    ),
    complete && h('div', { class: 'access-auth__actions' },
      h('button', { class: 'btn', type: 'button', disabled: busy, onClick: addPasskey }, 'Add a passkey'),
      h('button', { class: 'btn btn--primary', type: 'button', onClick: onAuthenticated }, 'Open mouaif')
    ),
    message && h('p', { class: 'status', 'data-state': message.includes('failed') || message.includes('match') ? 'error' : 'success', role: 'status' }, message)
  );
}

export function AccessGate({ children }) {
  const [status, setStatus] = useState(null);
  // The router is the single source of truth for which hash is showing, so
  // the gate subscribes to it rather than reading window.location: opening
  // #/setup, #/disable-access, or a link back to a normal page then re-renders
  // this component instead of leaving a stale screen.
  const view = route.value;
  const setup = view.name === 'setup';
  // /#/disable-access?code=… is the confirmation page a disable QR code
  // opens. It must work on a device with no session, so it bypasses the
  // sign-in wall and posts the one-time code it carries.
  const armAccess = view.name === 'disableAccess';
  const initialCode = view.code || '';

  async function load() {
    const result = await fetchJson('/api/access/status');
    if (result.status === 200) setStatus(result.body);
  }
  useEffect(() => { load(); }, []);
  if (armAccess) return h(ArmAccessView, { initialCode });
  // Keep the page visually empty while the server verifies the session.
  // Protected UI is mounted only after access status has been confirmed.
  if (!status) return null;
  if (!status.enabled) return children;
  if (setup || !status.configured) return h(SetupView, { initialCode, status, onAuthenticated: () => { window.location.hash = '#/projects'; load(); }, onCancel: () => { window.location.hash = '#/login'; } });
  if (!status.authenticated) return h(LoginView, { status, onAuthenticated: load, onSetup: () => { window.location.hash = '#/setup'; } });
  return children;
}

// ArmAccessView — the "turn access off?" page. Reached by scanning the QR
// code shown in Settings → Access & passkeys, or by opening the link. It is
// deliberately reachable without a session: the one-time code is the proof,
// and the whole point is to disarm a server whose password was forgotten.
export function ArmAccessView({ initialCode = '' }) {
  const [code, setCode] = useState(String(initialCode || '').toUpperCase());
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm(event) {
    event.preventDefault();
    setBusy(true); setMessage(''); setTone('');
    const result = await fetchJson('/api/access/disable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    setBusy(false);
    if (result.status === 200) {
      setTone('success');
      setMessage('Access protection is off. Anyone who can reach this server can open it.');
    } else {
      setTone('error');
      setMessage(result.body.error || 'Could not turn access off');
    }
  }

  const done = tone === 'success';
  return h(AuthFrame, {
    title: done ? 'Access is off' : 'Turn off access?',
    sub: done
      ? 'You can turn protection back on from Settings → Access & passkeys.'
      : 'This removes the password and passkey wall for this server. It can be turned back on later.'
  },
    !done && h('form', { onSubmit: confirm, class: 'access-auth__form' },
      h('label', { class: 'label', htmlFor: 'disable-code' }, 'Confirmation code'),
      h('input', {
        id: 'disable-code', class: 'input access-auth__code', value: code, maxLength: 9,
        inputMode: 'text', autocomplete: 'one-time-code', placeholder: 'ABCD-2345',
        onInput: (e) => setCode(e.currentTarget.value.toUpperCase())
      }),
      h('button', { class: 'btn btn--danger', type: 'submit', disabled: busy || !code }, busy ? 'Turning off…' : 'Disable access')
    ),
    message && h('p', { class: 'status', 'data-state': tone || undefined, role: 'status' }, message),
    done
      ? h('button', { class: 'btn btn--primary', type: 'button', onClick: () => { window.location.hash = '#/projects'; } }, 'Open mouaif')
      : h('button', { class: 'access-auth__link', type: 'button', onClick: () => { window.location.hash = '#/settings/access'; } }, 'Set this up on the signed-in device instead')
  );
}

export function AccessSettingsView() {
  const [status, setStatus] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  // Disable flow. The code and its QR are minted on demand and exist only
  // for their 15-minute window; nothing is shown until the user asks for it.
  const [disableCode, setDisableCode] = useState('');
  const [disableQr, setDisableQr] = useState('');
  const [disableUntil, setDisableUntil] = useState(0);
  const [disableMessage, setDisableMessage] = useState('');
  // Sign-in / access-change alerts. Same app-level `notifications.login`
  // switch the Notifications screen owns; surfaced here because this is the
  // screen that creates the disable QR the alert covers.
  const [alertsOn, setAlertsOn] = useState(true);
  // The other notification channels. `saveApp` merges at the top level, so a
  // patch that carried only `{ login }` would replace the whole notifications
  // object and silently switch off the status and authorization channels.
  const [otherPrefs, setOtherPrefs] = useState({ status: true, authorization: true, quickActions: true });

  async function load() {
    const [state, keys, app] = await Promise.all([
      fetchJson('/api/access/status'),
      fetchJson('/api/access/passkeys'),
      loadApp({ force: true })
    ]);
    setStatus(state.body); setPasskeys(keys.body.passkeys || []);
    const saved = (app && app.app && app.app.notifications) || {};
    setAlertsOn(saved.login === undefined ? true : saved.login === true);
    setOtherPrefs({
      status: saved.status === undefined ? true : saved.status === true,
      authorization: saved.authorization === undefined ? true : saved.authorization === true,
      quickActions: saved.quickActions !== false
    });
  }
  useEffect(() => { load(); }, []);

  async function saveLoginAlerts(checked) {
    setAlertsOn(checked);
    setDisableMessage('');
    try {
      await saveApp({ notifications: { ...otherPrefs, login: checked } });
      setDisableMessage(checked ? 'Access alerts are on.' : 'Access alerts are off.');
    } catch (error) {
      setAlertsOn(!checked);
      setDisableMessage('Could not save alerts: ' + error.message);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setPasswordMessage('New passwords do not match'); return; }
    setPasswordMessage(''); setBusy(true);
    const result = await fetchJson('/api/access/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    setBusy(false);
    if (result.status === 200) {
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setPasswordMessage('Password changed. Other devices were signed out and passkeys were removed.');
      load();
    } else setPasswordMessage(result.body.error || 'Password could not be changed');
  }

  async function add() {
    setBusy(true); setMessage('');
    try { await registerPasskey(); await load(); setMessage('Passkey added.'); }
    catch (error) { setMessage(error.message); }
    setBusy(false);
  }

  async function remove(id) {
    setBusy(true); await fetchJson('/api/access/passkeys/' + encodeURIComponent(id), { method: 'DELETE' }); await load(); setBusy(false);
  }

  async function logout() {
    await fetchJson('/api/access/logout', { method: 'POST' }); window.location.hash = '#/login'; window.location.reload();
  }

  async function startDisable() {
    setBusy(true); setDisableMessage('');
    const result = await fetchJson('/api/access/disable/code', { method: 'POST' });
    setBusy(false);
    if (result.status !== 200) { setDisableMessage(result.body.error || 'Could not create a disable code'); return; }
    setDisableCode(result.body.code);
    setDisableUntil(result.body.expiresAt || 0);
    setDisableQr('/api/access/disable/qr?code=' + encodeURIComponent(result.body.code));
  }

  function cancelDisable() {
    setDisableCode(''); setDisableQr(''); setDisableUntil(0); setDisableMessage('');
  }

  async function enableAccess() {
    setBusy(true); setDisableMessage('');
    const result = await fetchJson('/api/access/enable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    setBusy(false);
    if (result.status === 200) { setDisableMessage('Access protection is on again.'); load(); }
    else setDisableMessage(result.body.error || 'Could not turn access back on');
  }

  const enabled = !!(status && status.enabled);
  const armed = !!(status && status.armed);

  return h('section', { class: 'view settings-page' },
    h('header', { class: 'view-head' }, h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back' }, '‹'), h('h2', { class: 'view-title' }, 'Access & passkeys')),
    h('div', { class: 'settings-section' },
      h('p', { class: 'access-state__badge', 'data-state': status ? (enabled ? 'on' : 'off') : 'busy' },
        status ? (enabled ? 'Protection on' : 'Protection off') : 'Checking…'),
      h('p', { class: 'hint' }, !status
        ? 'Loading…'
        : enabled
          ? 'Signed in as ' + status.user + '. Changing the password signs out other devices and removes passkeys.'
          : (armed
              ? 'No sign-in is required on this server right now.'
              : 'This server was started without an access flag, so no sign-in is required.')),

      // ---- Turn protection back on (only meaningful once it was on) ----
      armed && !enabled && h('div', { class: 'access-auth__actions' },
        h('button', { class: 'btn btn--primary', type: 'button', disabled: busy, onClick: enableAccess }, busy ? 'Working…' : 'Turn access back on'),
        h('p', { class: 'hint hint--compact' }, 'Password and passkey sign-in return. This device stays signed in.')
      ),

      // ---- Turn protection off (needs the one-time code + QR) ----------
      enabled && !disableCode && h('div', { class: 'access-auth__actions' },
        h('button', { class: 'btn btn--danger', type: 'button', disabled: busy, onClick: startDisable }, busy ? 'Preparing…' : 'Create disable QR & code'),
        h('p', { class: 'hint hint--compact' }, 'Creates a one-time code and QR code. Open the QR on any device, or enter the code on the confirmation page, to remove the sign-in wall.')
      ),
      enabled && disableCode && h('div', { class: 'access-auth__quota' },
        h('p', { class: 'hint hint--compact' }, 'Scan with another device, or open the confirmation page here.'),
        disableQr && h('img', { class: 'access-auth__qr', src: disableQr, width: 240, height: 240, alt: 'Disable access QR code' }),
        h('p', { class: 'access-auth__code' }, disableCode),
        h('p', { class: 'hint hint--compact' },
          'Single use' + (disableUntil ? ' · expires ' + new Date(disableUntil).toLocaleTimeString() : '')),
        h('div', { class: 'row row--actions' },
          h('a', { class: 'btn btn--primary', href: '#/disable-access?code=' + encodeURIComponent(disableCode) }, 'Open confirmation page'),
          h('button', { class: 'btn', type: 'button', disabled: busy, onClick: cancelDisable }, 'Cancel')
        )
      ),

      // ---- Password change --------------------------------------------
      enabled && h('form', { class: 'settings-section__form', onSubmit: changePassword },
        h('label', { class: 'label', htmlFor: 'current-password' }, 'Current password'),
        h('input', { id: 'current-password', class: 'input', type: 'password', autocomplete: 'current-password', value: currentPassword, onInput: (e) => setCurrentPassword(e.currentTarget.value), required: true }),
        h('label', { class: 'label', htmlFor: 'new-password' }, 'New password'),
        h('input', { id: 'new-password', class: 'input', type: 'password', autocomplete: 'new-password', minLength: 8, value: newPassword, onInput: (e) => setNewPassword(e.currentTarget.value), required: true }),
        h('label', { class: 'label', htmlFor: 'confirm-password' }, 'Confirm new password'),
        h('input', { id: 'confirm-password', class: 'input', type: 'password', autocomplete: 'new-password', minLength: 8, value: confirmPassword, onInput: (e) => setConfirmPassword(e.currentTarget.value), required: true }),
        h('button', { class: 'btn btn--primary', type: 'submit', disabled: busy }, busy ? 'Saving…' : 'Change password')
      ),
      passwordMessage && h('p', { class: 'status', 'data-state': passwordMessage.includes('do not match') || passwordMessage.includes('incorrect') ? 'error' : 'success', role: 'status' }, passwordMessage),

      enabled && h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', disabled: busy, onClick: add }, 'Add passkey'),
        h('button', { class: 'btn', disabled: busy, onClick: logout }, 'Sign out')
      ),
      enabled && h('div', { class: 'access-auth__keys' },
        passkeys.length ? passkeys.map((key) => h('div', { class: 'access-auth__key', key: key.id },
          h('div', null, h('strong', null, key.name), h('small', null, 'Added ' + new Date(key.createdAt).toLocaleDateString())),
          h('button', { class: 'btn btn--danger', disabled: busy, onClick: () => remove(key.id) }, 'Remove')
        )) : h('p', { class: 'hint' }, 'No passkeys yet. Password sign-in remains available.')
      ),

      // ---- Sign-in alerts ---------------------------------------------
      // The disable QR is only useful if the person holding the phone sees
      // it, so the state-changing events (sign-in, access on/off) are
      // surfaced here with a one-tap way to mute them.
      h('label', { class: 'group__row settings-notifications__event' },
        h('span', { class: 'group__row-body' },
          h('span', { class: 'group__row-label' }, 'Access alerts'),
          h('span', { class: 'group__row-detail' }, 'Sign-in and access on/off notifications to your other devices.')
        ),
        h('input', {
        type: 'checkbox', class: 'checkbox', checked: alertsOn, disabled: busy || !status,
        onChange: (e) => saveLoginAlerts(e.currentTarget.checked)
        })
      ),

      disableMessage && h('p', { class: 'status', 'data-state': disableMessage.includes('again') ? 'success' : 'error', role: 'status' }, disableMessage),
      message && h('p', { class: 'status', role: 'status' }, message)
    )
  );
}
