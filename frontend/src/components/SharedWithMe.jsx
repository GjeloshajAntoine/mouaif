// mouaif web — Shared with me (docs/features/share-project.md)
//
// + Add project → Shared with me. Lists the projects other mouaifs offered to
// this one: the pending ones with an Add button (and the first-time code field
// when the two mouaifs have not been paired yet), then the ones already added.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { shareState, loadShareState, shareApi, projectsReload } from '../api.js';
import { subscribeChanges } from '../liveEvents.js';
import { back } from '../router.js';

function accessLabel(access) {
  return access === 'full' ? 'Files and shell' : 'Files only';
}

function PendingShare({ share }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  async function add(e) {
    e.preventDefault();
    setBusy(true);
    setStatus('Adding…');
    try {
      await shareApi('POST', '/api/share/shares/' + share.id + '/accept', share.needsCode ? { code } : {});
      setStatus('');
      await loadShareState();
      projectsReload.value++;
      back('projects');
    } catch (err) {
      setStatus(err.message);
      setBusy(false);
    }
  }
  return h('li', { class: 'shared-in__card' },
    h('div', { class: 'shared-in__name' }, share.projectName || share.projectDir),
    h('div', { class: 'shared-in__path' }, share.projectDir),
    h('div', { class: 'shared-in__meta' },
      h('span', { class: 'share-sheet__dot', 'data-online': share.online ? '1' : '0', 'aria-hidden': 'true' }),
      'from ' + share.machine + ' · ' + accessLabel(share.access) + (share.online ? '' : ' · offline')),
    h('form', { class: 'shared-in__form', onSubmit: add },
      share.needsCode ? h('input', {
        class: 'input shared-in__code', type: 'text', inputmode: 'text', autocomplete: 'one-time-code',
        autocapitalize: 'characters', spellcheck: 'false', maxLength: 9, placeholder: 'Code, e.g. ABCD-2345',
        'aria-label': 'Code shown on ' + share.machine, value: code, disabled: busy,
        onInput: (e) => setCode(e.currentTarget.value.toUpperCase())
      }) : null,
      h('button', {
        class: 'btn btn--primary shared-in__add', type: 'submit',
        disabled: busy || !share.online || (share.needsCode && code.replace(/[^A-Z0-9]/gi, '').length !== 8)
      }, busy ? 'Adding…' : 'Add')),
    share.needsCode ? h('p', { class: 'shared-in__hint' }, 'First time with ' + share.machine + ': type the code shown in its Share project sheet.') : null,
    status ? h('p', { class: 'shared-in__status', 'aria-live': 'polite' }, status) : null);
}

function AddedShare({ share }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!confirm('Remove "' + (share.projectName || share.projectDir) + '" from this mouaif? It stays on ' + share.machine + '.')) return;
    setBusy(true);
    try { await shareApi('DELETE', '/api/share/shares/' + share.id); await loadShareState(); projectsReload.value++; }
    catch (err) { alert(err.message); }
    setBusy(false);
  }
  return h('li', { class: 'shared-in__card' },
    h('div', { class: 'shared-in__name' }, share.projectName || share.projectDir),
    h('div', { class: 'shared-in__meta' },
      h('span', { class: 'share-sheet__dot', 'data-online': share.online ? '1' : '0', 'aria-hidden': 'true' }),
      'from ' + share.machine + ' · ' + accessLabel(share.access) + (share.online ? '' : ' · offline')),
    h('button', { class: 'btn btn--danger shared-in__remove', type: 'button', disabled: busy, onClick: remove }, 'Remove'));
}

export function SharedWithMeView() {
  const state = shareState.value;
  useEffect(() => {
    loadShareState();
    // Refetched when the share state changes on the server
    // (docs/features/live-events.md).
    return subscribeChanges({ app: ['share'], onChange: () => loadShareState() });
  }, []);
  const pending = (state.incoming || []).filter((s) => s.status === 'pending');
  const added = (state.incoming || []).filter((s) => s.status === 'active');
  return h('section', { class: 'shared-in' },
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects/new', class: 'view-back', 'aria-label': 'Back to Add project' }, '←'),
      h('h2', { class: 'view-title' }, 'Shared with me')),
    state.loaded && !state.enabled ? h('p', { class: 'share-sheet__warn' },
      'Adding a shared project needs app access. Start mouaif with --auth and set up an account.') : null,
    h('ul', { class: 'shared-in__list', 'aria-label': 'Projects waiting to be added' },
      pending.length ? pending.map((s) => h(PendingShare, { key: s.id, share: s }))
        : h('li', { class: 'shared-in__empty' }, state.loaded
          ? 'Nothing waiting. On the mouaif that has the folder, open the project card ⋯ menu → Share project and enter this mouaif\'s address.'
          : 'loading…')),
    added.length ? h('h3', { class: 'shared-in__section' }, 'Added') : null,
    added.length ? h('ul', { class: 'shared-in__list', 'aria-label': 'Shared projects already added' },
      added.map((s) => h(AddedShare, { key: s.id, share: s }))) : null);
}
