// mouaif web — SettingsImportView
// One-shot import of JSON chat transcripts into the SQLite store.
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';

export function SettingsImportView({ projectDir }) {
  const statusEl = useRef(null);
  const btn = useRef(null);

  async function doImport() {
    if (btn.current) btn.current.disabled = true;
    setStatus(statusEl, 'importing…', 'busy');
    try {
      const r = await fetchJson('/api/chats/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, skipExisting: true })
      });
      if (r.status === 200) {
        const data = r.body.imported || {};
        setStatus(statusEl, `✅ ${data.chats} chats, ${data.messages} messages imported.`, 'success');
        if (data.errors && data.errors.length) {
          setStatus(statusEl, statusEl.current.textContent + ' ⚠️ ' + data.errors.join('; '), 'warning');
        }
      } else {
        setStatus(statusEl, 'Import failed: HTTP ' + r.status + ' ' + (r.body && r.body.error || ''), 'error');
      }
    } catch (e) {
      setStatus(statusEl, 'Import error: ' + e.message, 'error');
    }
    if (btn.current) btn.current.disabled = false;
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project?projectDir=' + encodeURIComponent(projectDir || ''), class: 'view-back', 'aria-label': 'Back to project settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Import chats')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Import chat transcripts from the legacy JSON files (.mouaif.messages.*.json) into the SQLite storage. Existing chats in the DB are skipped; only new or missing messages are imported.'),
      h('p', { class: 'hint hint--compact' }, 'Project: ', h('code', null, projectDir || '(none)')),
      h('div', { class: 'row row--actions' },
        h('button', { ref: btn, class: 'btn btn--primary', type: 'button', onClick: doImport }, 'Import from JSON files'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}