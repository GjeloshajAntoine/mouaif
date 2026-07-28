import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';

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
  const [setup, setSetup] = useState(window.location.hash.startsWith('#/setup'));
  const params = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const initialCode = params.get('code') || '';

  async function load() {
    const result = await fetchJson('/api/access/status');
    if (result.status === 200) setStatus(result.body);
  }
  useEffect(() => { load(); }, []);
  if (!status) return h(AuthFrame, { title: 'mouaif', sub: 'Checking access…' });
  if (setup || !status.configured) return h(SetupView, { initialCode, status, onAuthenticated: () => { window.location.hash = '#/projects'; load(); }, onCancel: () => setSetup(false) });
  if (!status.authenticated) return h(LoginView, { status, onAuthenticated: load, onSetup: () => setSetup(true) });
  return children;
}

export function AccessSettingsView() {
  const [status, setStatus] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [state, keys] = await Promise.all([fetchJson('/api/access/status'), fetchJson('/api/access/passkeys')]);
    setStatus(state.body); setPasskeys(keys.body.passkeys || []);
  }
  useEffect(() => { load(); }, []);

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

  return h('section', { class: 'view settings-page' },
    h('header', { class: 'view__head' }, h('a', { href: '#/settings', class: 'view__back', 'aria-label': 'Back' }, '‹'), h('h2', { class: 'view__title' }, 'Access & passkeys')),
    h('div', { class: 'settings-section' },
      h('p', { class: 'hint' }, status ? 'Signed in as ' + status.user + '. Change the password with CLI setup or a one-time setup link.' : 'Loading…'),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', disabled: busy, onClick: add }, 'Add passkey'),
        h('button', { class: 'btn', disabled: busy, onClick: logout }, 'Sign out')
      ),
      h('div', { class: 'access-auth__keys' },
        passkeys.length ? passkeys.map((key) => h('div', { class: 'access-auth__key', key: key.id },
          h('div', null, h('strong', null, key.name), h('small', null, 'Added ' + new Date(key.createdAt).toLocaleDateString())),
          h('button', { class: 'btn btn--danger', disabled: busy, onClick: () => remove(key.id) }, 'Remove')
        )) : h('p', { class: 'hint' }, 'No passkeys yet. Password sign-in remains available.')
      ),
      message && h('p', { class: 'status', role: 'status' }, message)
    )
  );
}
