// InspectorProfilesSheet — manage the Chrome *user profiles* the
// Inspector can attach to.
//
// Why this exists
// ---------------
// The Inspector had exactly one debug endpoint. A user with two Chrome
// profiles ("work" on 9223, "personal" on 9224) had to remember the port
// and retype the URL every time they switched. This sheet lists the
// profiles Chrome actually has on disk, shows the endpoint each one
// points at, and switches with one tap.
//
// What it deliberately is not
// ---------------------------
// It never starts or stops Chrome. The Inspector attaches to a browser
// the user started (docs/features/inspector.md → Getting started); the
// sheet only *describes* what is on disk and chooses which endpoint the
// Inspector uses. So a row for a profile whose Chrome is not running is a
// normal state, not an error — it is listed, selectable, and simply has
// no targets until that Chrome is started.
//
// Shape (mobile-first, docs: .github/copilot-instructions.md)
// ----------------------------------------------------------
//   * a bottom sheet, same overlay + safe-area padding as DetailSheet;
//   * one 44 px row per profile: name, account/host subtitle, port, and
//     an explicit radio-style marker — never a hover-only affordance;
//   * a separate "Endpoint" action per row, because "remember a port for
//     later" and "attach to this profile now" are two different intents
//     and collapsing them into one tap loses the first;
//   * the per-user-data-dir path is shown in muted text so a machine with
//     two `Default` profiles (two user-data-dirs) is readable.
//
// Props
// -----
//   list      — the GET /api/inspector/profiles body, or null while loading
//   loading   — true while the list is being fetched
//   error     — a message to show in place of the list, or ''
//   onSwitch(row)          — make this profile the Inspector's endpoint
//   onSaveEndpoint(row, url) — remember an endpoint without switching
//   onAddDir(dir)          — register an extra user-data-dir
//   onRemoveDir(dir)       — unregister an extra user-data-dir
//   onRefresh()            — re-scan
//   onPickUrl(url)         — copy a profile's endpoint into the URL field
//   onClose()              — dismiss the sheet
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';

// endpointLabel(row) — the port is the part that differs between two
// profiles on the same host, so it is what the row shows; a non-default
// port is emphasised by the caller through `isDefault`.
function hostLabel(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

export function InspectorProfilesSheet(props) {
  const [endpointFor, setEndpointFor] = useState(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const [dirDraft, setDirDraft] = useState('');
  const [addingDir, setAddingDir] = useState(false);

  const sheetRef = useModal({ onClose: props.onClose, escape: true });

  const list = props.list || null;
  const profiles = (list && Array.isArray(list.profiles)) ? list.profiles : [];
  const dirs = (list && Array.isArray(list.dirs)) ? list.dirs : [];
  const builtinDirs = new Set(profiles.filter((p) => p.kind !== 'custom').map((p) => p.dir));
  const activeId = (list && list.activeId) || '';

  function openEndpoint(row) {
    setAddingDir(false);
    setEndpointFor(row.id);
    setEndpointDraft(row.url || '');
  }

  function submitEndpoint(event) {
    event.preventDefault();
    const row = profiles.find((p) => p.id === endpointFor);
    if (!row) return;
    const next = (endpointDraft || '').trim();
    if (!next) return;
    props.onSaveEndpoint(row, next);
    setEndpointFor(null);
    setEndpointDraft('');
  }

  function submitDir(event) {
    event.preventDefault();
    const next = (dirDraft || '').trim();
    if (!next) return;
    props.onAddDir(next);
    setDirDraft('');
    setAddingDir(false);
  }

  return h('div', { class: 'inspector__overlay', onClick: props.onClose, role: 'presentation' },
    h('div', {
      class: 'inspector__sheet inspector__sheet--profiles',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Chrome profiles',
      ref: sheetRef,
      onClick: (e) => e.stopPropagation()
    },
      h('div', { class: 'inspector__sheet-head' },
        h('strong', { class: 'inspector__sheet-title' }, 'Chrome profiles'),
        h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: props.onClose }, 'Close')
      ),
      h('div', { class: 'inspector__sheet-body inspector__sheet-body--profiles' },
        h('p', { class: 'inspector__profiles-lead' },
          'Pick the Chrome profile to attach to. mouaif attaches to a browser you started with ',
          h('code', null, '--remote-debugging-port'),
          ' — it does not launch Chrome for you.'
        ),

        props.error
          ? h('p', { class: 'inspector__profiles-error', role: 'alert' }, props.error)
          : null,

        props.loading && !profiles.length
          ? h('p', { class: 'inspector__profiles-empty' }, 'Looking for Chrome profiles…')
          : null,

        !props.loading && !profiles.length && !props.error
          ? h('div', { class: 'inspector__profiles-empty' },
              h('p', null, 'No Chrome profiles found on this machine.'),
              h('p', { class: 'inspector__profiles-empty-hint' },
                'Add the folder you passed to ',
                h('code', null, '--user-data-dir'),
                ' below, or just paste a debugger URL by hand.')
            )
          : null,

        profiles.map((row) => {
          const active = !!row.active || row.id === activeId;
          const isEndpointOpen = endpointFor === row.id;
          return h('div', {
            class: 'inspector__profile' + (active ? ' is-active' : ''),
            key: row.key || (row.dir + '::' + row.id)
          },
            h('button', {
              class: 'inspector__profile-main',
              type: 'button',
              'aria-pressed': String(active),
              'aria-label': 'Attach using ' + row.label + ' on ' + hostLabel(row.url),
              onClick: () => props.onSwitch(row)
            },
              h('span', { class: 'inspector__profile-mark', 'aria-hidden': 'true' }, active ? '●' : '○'),
              h('span', { class: 'inspector__profile-body' },
                h('span', { class: 'inspector__profile-name' }, row.label),
                h('span', { class: 'inspector__profile-sub' },
                  (row.account ? row.account + ' · ' : '')
                  + hostLabel(row.url)
                  + (row.id && row.id !== row.label ? ' · ' + row.id : '')
                )
              ),
              active
                ? h('span', { class: 'inspector__profile-badge' }, 'Active')
                : h('span', { class: 'inspector__profile-badge inspector__profile-badge--port' }, 'Go')
            ),
            h('div', { class: 'inspector__profile-actions' },
              h('button', {
                class: 'inspector__profile-action',
                type: 'button',
                'aria-expanded': String(isEndpointOpen),
                onClick: () => (isEndpointOpen ? setEndpointFor(null) : openEndpoint(row))
              }, isEndpointOpen ? 'Cancel' : 'Endpoint'),
              h('button', {
                class: 'inspector__profile-action',
                type: 'button',
                onClick: () => props.onPickUrl(row.url)
              }, 'Use URL')
            ),
            isEndpointOpen
              ? h('form', { class: 'inspector__profile-form', onSubmit: submitEndpoint },
                  h('label', { class: 'inspector__profile-form-label', for: 'profileEndpoint' }, 'Debugger URL for ' + row.label),
                  h('input', {
                    class: 'input',
                    id: 'profileEndpoint',
                    type: 'url',
                    inputmode: 'url',
                    value: endpointDraft,
                    placeholder: 'http://127.0.0.1:9223',
                    onInput: (e) => setEndpointDraft(e.currentTarget.value)
                  }),
                  h('div', { class: 'inspector__profile-form-actions' },
                    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Save endpoint')
                  ),
                  h('p', { class: 'inspector__profile-form-hint' },
                    'Remembered for this profile only. Switch to it to attach.')
                )
              : null
          );
        }),

        h('h3', { class: 'inspector__sheet-h' }, 'Profile folders'),
        h('p', { class: 'inspector__profiles-hint' },
          'Chrome stores profiles in a user-data-dir. These are scanned automatically.'),
        dirs.map((dir) => {
          const custom = !builtinDirs.has(dir);
          return h('div', { class: 'inspector__profile-dir', key: dir },
            h('span', { class: 'inspector__profile-dir-path' }, dir),
            h('span', { class: 'inspector__profile-dir-kind' }, custom ? 'added' : 'found'),
            custom
              ? h('button', {
                  class: 'inspector__profile-action',
                  type: 'button',
                  'aria-label': 'Stop scanning ' + dir,
                  onClick: () => props.onRemoveDir(dir)
                }, 'Remove')
              : null
          );
        }),

        addingDir
          ? h('form', { class: 'inspector__profile-form', onSubmit: submitDir },
              h('label', { class: 'inspector__profile-form-label', for: 'profileDir' }, 'User-data-dir path'),
              h('input', {
                class: 'input',
                id: 'profileDir',
                type: 'text',
                value: dirDraft,
                placeholder: '/home/me/.config/google-chrome',
                onInput: (e) => setDirDraft(e.currentTarget.value)
              }),
              h('div', { class: 'inspector__profile-form-actions' },
                h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add folder')
              )
            )
          : h('button', {
              class: 'btn inspector__profiles-add',
              type: 'button',
              onClick: () => { setEndpointFor(null); setAddingDir(true); }
            }, 'Add profile folder'),

        h('div', { class: 'inspector__profiles-foot' },
          h('button', { class: 'btn', type: 'button', onClick: props.onRefresh }, 'Re-scan')
        )
      )
    )
  );
}
