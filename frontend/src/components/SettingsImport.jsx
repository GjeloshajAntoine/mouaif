// mouaif web — SettingsImportView
// One-shot import of JSON chat transcripts into the SQLite store.
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { fetchJson } from '../api.js';

export function SettingsImportView({ projectDir }) {
  const [isImporting, setIsImporting] = useState(false);
  const [status, setStatus] = useState({ message: '', type: '' });

  async function doImport() {
    setIsImporting(true);
    setStatus({ message: 'importing…', type: 'busy' });
    try {
      const r = await fetchJson('/api/chats/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, skipExisting: true })
      });
      if (r.status === 200) {
        const data = r.body.imported || {};
        let msg = `✅ ${data.chats} chats, ${data.messages} messages imported.`;
        let type = 'success';
        if (data.errors && data.errors.length) {
          msg += ' ⚠️ ' + data.errors.join('; ');
          type = 'warning';
        }
        setStatus({ message: msg, type });
      } else {
        setStatus({ message: 'Import failed: HTTP ' + r.status + ' ' + (r.body && r.body.error || ''), type: 'error' });
      }
    } catch (e) {
      setStatus({ message: 'Import error: ' + e.message, type: 'error' });
    }
    setIsImporting(false);
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
        h('button', { class: 'btn btn--primary', type: 'button', onClick: doImport, disabled: isImporting }, 'Import from JSON files'),
        h('span', { class: `status${status.type ? ' status--' + status.type : ''}`, 'aria-live': 'polite' }, status.message)
      )
    )
  );
}