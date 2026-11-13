// mouaif web — Share project sheet (docs/features/share-project.md)
//
// Opened from a project card's ⋯ menu on the mouaif that has the folder. A
// bottom sheet: the shares of this project (with their first-time code while
// one is waiting, the access level, and Stop sharing), then the form to share
// with another mouaif.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { shareState, loadShareState, shareApi } from '../api.js';

const ACCESS = [
  { value: 'files', label: 'Files only', hint: 'Chats, files and git history. No shell or commands.' },
  { value: 'full', label: 'Files and shell', hint: 'Also the shell, the terminal and project commands.' }
];

function minutesLeft(expiresAt) {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60000);
  return 'expires in ' + min + ' min';
}

function AccessChoice({ name, value, onChange, disabled }) {
  return h('div', { class: 'share-sheet__access', role: 'radiogroup', 'aria-label': 'What the share allows' },
    ACCESS.map((opt) => h('label', { key: opt.value, class: 'share-sheet__access-opt' + (value === opt.value ? ' is-on' : '') },
      h('input', {
        type: 'radio', name, value: opt.value, checked: value === opt.value, disabled,
        onChange: () => onChange(opt.value)
      }),
      h('span', { class: 'share-sheet__access-text' },
        h('span', { class: 'share-sheet__access-label' }, opt.label),
        h('span', { class: 'share-sheet__access-hint' }, opt.hint))
    )));
}

function CodeBox({ code, expiresAt, address }) {
  return h('div', { class: 'share-sheet__code', role: 'status' },
    h('p', { class: 'share-sheet__code-lead' }, 'First time with this mouaif. On ' + address + ', open + Add project → Shared with me and type:'),
    h('p', { class: 'share-sheet__code-value', 'aria-label': 'Code ' + code.split('').join(' ') }, code),
    h('p', { class: 'share-sheet__code-meta' }, minutesLeft(expiresAt)));
}

function ShareRow({ share, codes, onCode, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const peer = share.peer || {};
  const code = codes[share.id];
  const where = peer.machine ? peer.machine + ' · ' + peer.address : peer.address;
  async function run(fn) {
    setBusy(true);
    try { await fn(); await onChanged(); }
    catch (e) { onError(e.message); }
    setBusy(false);
  }
  return h('li', { class: 'share-sheet__row' },
    h('div', { class: 'share-sheet__row-head' },
      h('span', { class: 'share-sheet__dot', 'data-online': peer.online ? '1' : '0', 'aria-hidden': 'true' }),
      h('span', { class: 'share-sheet__where' }, where || 'another mouaif'),
      h('span', { class: 'share-sheet__state' }, share.status === 'active' ? 'Added' : 'Waiting to be added')),
    !peer.online ? h('p', { class: 'share-sheet__note' }, 'Not connected right now. It reconnects on its own.') : null,
    share.status !== 'active' && !peer.paired
      ? (code ? h(CodeBox, { code: code.code, expiresAt: code.expiresAt, address: peer.address })
        : h('button', { class: 'btn share-sheet__btn', type: 'button', disabled: busy,
          onClick: () => run(async () => { const r = await shareApi('POST', '/api/share/shares/' + share.id + '/code'); if (r.code) onCode(share.id, r.code); }) }, 'Show a new code'))
      : null,
    h(AccessChoice, {
      name: 'share-access-' + share.id, value: share.access, disabled: busy,
      onChange: (access) => run(() => shareApi('PATCH', '/api/share/shares/' + share.id, { access }))
    }),
    h('button', {
      class: 'btn btn--danger share-sheet__btn share-sheet__stop', type: 'button', disabled: busy,
      onClick: () => run(() => shareApi('DELETE', '/api/share/shares/' + share.id))
    }, 'Stop sharing'));
}

export function ShareSheet({ project, onClose }) {
  const [address, setAddress] = useState('');
  const [access, setAccess] = useState('files');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  // Codes are shown once, when issued; the server keeps only their hash.
  const [codes, setCodes] = useState({});
  const inputRef = useRef(null);
  // The latest onClose, so the polling effect below runs once per opening
  // rather than on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const state = shareState.value;
  const mine = (state.outgoing || []).filter((s) => s.projectDir === project.path);

  useEffect(() => {
    loadShareState();
    const timer = setInterval(() => loadShareState(), 4000);
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, []);

  function onCode(id, code) { setCodes((prev) => Object.assign({}, prev, { [id]: code })); }

  async function share(e) {
    e.preventDefault();
    if (!address.trim()) { setStatus('Enter the address of the other mouaif.'); return; }
    setBusy(true);
    setStatus('Connecting…');
    try {
      const out = await shareApi('POST', '/api/share/shares', { address: address.trim(), projectDir: project.path, access });
      if (out.code) onCode(out.share.id, out.code);
      setAddress('');
      setStatus(out.code ? '' : 'Shared. Add it on the other mouaif under + Add project → Shared with me.');
      await loadShareState();
    } catch (err) {
      setStatus(err.message);
    }
    setBusy(false);
  }

  const disabled = state.loaded && !state.enabled;
  return h('div', { class: 'share-sheet__overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
    h('section', { class: 'share-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-sheet-title' },
      h('div', { class: 'share-sheet__handle', 'aria-hidden': 'true' }),
      h('div', { class: 'share-sheet__head' },
        h('div', null,
          h('h2', { id: 'share-sheet-title', class: 'share-sheet__title' }, 'Share project'),
          h('p', { class: 'share-sheet__sub' }, project.name || project.path)),
        h('button', { class: 'share-sheet__close', type: 'button', 'aria-label': 'Close', onClick: onClose }, '×')),
      disabled ? h('p', { class: 'share-sheet__warn' },
        'Sharing needs app access. Start mouaif with --auth and set up an account, on this mouaif and on the other one.') : null,
      mine.length ? h('ul', { class: 'share-sheet__list', 'aria-label': 'Shares of this project' },
        mine.map((s) => h(ShareRow, { key: s.id, share: s, codes, onCode, onChanged: loadShareState, onError: setStatus }))) : null,
      h('form', { class: 'share-sheet__form', onSubmit: share },
        h('label', { class: 'share-sheet__label', for: 'share-address' }, mine.length ? 'Share with another mouaif' : 'Address of the other mouaif'),
        h('input', {
          ref: inputRef, id: 'share-address', class: 'input share-sheet__input', type: 'url', inputmode: 'url',
          placeholder: 'mouaif.example.com or 192.168.1.20:5732', value: address, list: 'share-addresses',
          autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', disabled: disabled || busy,
          onInput: (e) => setAddress(e.currentTarget.value)
        }),
        h('datalist', { id: 'share-addresses' },
          (state.addresses || []).map((a) => h('option', { key: a.address, value: a.address }, a.machine || a.address))),
        (state.addresses || []).length ? h('div', { class: 'share-sheet__recent' },
          (state.addresses || []).slice(0, 4).map((a) => h('button', {
            key: a.address, type: 'button', class: 'share-sheet__chip', disabled: disabled || busy,
            onClick: () => setAddress(a.address)
          }, a.machine || a.address))) : null,
        h(AccessChoice, { name: 'share-access-new', value: access, onChange: setAccess, disabled: disabled || busy }),
        h('button', { class: 'btn btn--primary share-sheet__btn', type: 'submit', disabled: disabled || busy }, busy ? 'Sharing…' : 'Share'),
        h('p', { class: 'share-sheet__status', 'aria-live': 'polite' }, status))
    ));
}
