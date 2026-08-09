// mouaif web — SettingsPricingView
//
// Per-model USD pricing table editor (decision §14). The user can
// override the built-in defaults for any model id they configure;
// unknown model ids fall back to the built-in table, then to `--`.
//
// The editor is a JSON textarea for now — the table is small
// (one entry per model id the user cares about) and a free-form
// JSON editor matches the rest of the Settings section (see
// SettingsProject). A future revision can add per-row editors; the
// data shape on the server is already what the chat UI reads.
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { loadApp, saveApp, fetchJson } from '../api.js';

export function SettingsPricingView() {
  const [table, setTable] = useState('');
  const [builtin, setBuiltin] = useState([]);
  const [configured, setConfigured] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [lastLoaded, setLastLoaded] = useState({});

  async function load() {
    try {
      const app = await loadApp({ force: true });
      const t = (app.app && app.app.modelPricing) || {};
      setLastLoaded(JSON.parse(JSON.stringify(t)));
      setTable(JSON.stringify(t, null, 2));
      await renderKnownList();
    } catch (e) { setStatusMsg({ text: 'load failed: ' + e.message, kind: 'error' }); }
  }

  // The known-list is a small hint that shows: (a) the model ids the
  // user has actually configured across all projects, and (b) the
  // built-in entries. The user can copy any id into the table above.
  async function renderKnownList() {
    // 1) Built-in entries — the short list the chat UI can use
    // without any app-level override. We read it from the server's
    // /api/usage/builtin so we don't duplicate the list in the web
    // bundle; the server is the source of truth.
    try {
      const r = await fetchJson('/api/usage/builtin');
      if (r.status === 200 && r.body && Array.isArray(r.body.ids)) setBuiltin(r.body.ids);
    } catch { /* leave empty */ }

    // 2) Configured models — every model id the user has set up
    // across every registered project. The set is deduplicated and
    // case-sensitive (model ids are exact strings).
    try {
      const r = await fetchJson('/api/ai/models-all');
      if (r.status === 200 && r.body && Array.isArray(r.body.ids)) setConfigured(r.body.ids);
    } catch { /* leave empty */ }
  }

  function Group({ title, ids }) {
    if (!ids.length) return null;
    return h('li', { class: 'pricing__group' },
      h('div', { class: 'pricing__group-title' }, title),
      h('ul', { class: 'pricing__ids' },
        ids.map(id => h('li', { key: id },
          h('code', null, id),
          h('button', {
            type: 'button',
            class: 'btn btn--small pricing__copy',
            title: 'Copy the id to the table above (as a placeholder entry)',
            onClick: () => copyIdToEditor(id)
          }, 'copy')
        ))
      )
    );
  }

  // copyIdToEditor inserts a zero-cost placeholder entry for the id
  // so the user can edit the prices in place. Doing this beats
  // re-typing the id by hand and matches what the JSON editor's
  // user expects from a "copy" affordance.
  function copyIdToEditor(id) {
    let parsed;
    try { parsed = JSON.parse(table || '{}'); }
    catch { setStatusMsg({ text: 'fix JSON syntax first', kind: 'error' }); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    if (parsed[id]) return; // already present; no-op
    parsed[id] = { inputPer1K: 0, outputPer1K: 0 };
    setTable(JSON.stringify(parsed, null, 2));
    setStatusMsg({ text: 'added ' + id + ' — set its prices and Save', kind: 'success' });
  }

  async function save() {
    let parsed;
    try { parsed = JSON.parse(table || '{}'); }
    catch (e) { setStatusMsg({ text: 'invalid JSON: ' + e.message, kind: 'error' }); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatusMsg({ text: 'table must be a JSON object', kind: 'error' });
      return;
    }
    // Validate every entry. Bad entries are rejected with a clear
    // error; the rest of the table is not saved. This keeps a typo
    // from poisoning the whole settings blob.
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        setStatusMsg({ text: 'entry "' + id + '" must be an object', kind: 'error' });
        return;
      }
      for (const k of ['inputPer1K', 'outputPer1K']) {
        if (entry[k] === undefined) continue;
        const n = Number(entry[k]);
        if (!isFinite(n) || n < 0) {
          setStatusMsg({ text: 'entry "' + id + '" has invalid ' + k + ' (must be a non-negative number)', kind: 'error' });
          return;
        }
        entry[k] = n;
      }
    }
    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });
    try {
      await saveApp({ modelPricing: parsed });
      setLastLoaded(JSON.parse(JSON.stringify(parsed)));
      setStatusMsg({ text: 'saved.', kind: 'success' });
    } catch (e) {
      setStatusMsg({ text: 'save failed: ' + e.message, kind: 'error' });
    }
    setIsSaving(false);
  }

  function revert() {
    setTable(JSON.stringify(lastLoaded, null, 2));
    setStatusMsg({ text: 'reverted.', kind: 'success' });
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Model pricing')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Override the cost-per-1 000 tokens (USD) for any model id. The chat UI uses this to render the per-turn cost line. Verify prices with your provider — the built-in defaults may be outdated.'),
      h('p', { class: 'hint hint--compact' }, 'This is the app-level fallback. A per-model pricing block on a project model record wins over this table; an id missing here falls back to the built-in defaults, then to --.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'pricing-table' }, 'Pricing table (JSON)'),
        h('textarea', { value: table, onInput: (e) => setTable(e.target.value), class: 'input pricing__editor', id: 'pricing-table', rows: 10, spellcheck: false }),
        h('p', { class: 'hint' }, 'Example: ', h('code', null, '{ "gpt-4o-mini": { "inputPer1K": 0.00015, "outputPer1K": 0.00060 } }'))
      ),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, 'Save'),
        h('button', { class: 'btn', type: 'button', onClick: revert, disabled: isSaving }, 'Revert'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      ),
      h('h3', null, 'Known model ids'),
      h('p', { class: 'hint hint--compact' }, 'The chat UI renders a per-turn cost only for ids that resolve through the built-in table or this override. Tap copy to add an id to your table.'),
      h('ul', { class: 'pricing__known', 'aria-label': 'Known model ids' },
        h(Group, { title: 'Built-in defaults', ids: builtin }),
        h(Group, { title: 'Models you have configured', ids: configured })
      )
    )
  );
}
