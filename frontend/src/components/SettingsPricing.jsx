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
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, saveApp, fetchJson, setStatus } from '../api.js';

export function SettingsPricingView() {
  const editor = useRef(null);
  const saveBtn = useRef(null);
  const revertBtn = useRef(null);
  const statusEl = useRef(null);
  const knownList = useRef(null);

  // Hold the most recently loaded snapshot so revert() can restore it.
  const lastLoaded = useRef({});

  async function load() {
    try {
      const app = await loadApp({ force: true });
      const table = (app.app && app.app.modelPricing) || {};
      lastLoaded.current = JSON.parse(JSON.stringify(table));
      if (editor.current) editor.current.value = JSON.stringify(table, null, 2);
      if (saveBtn.current) saveBtn.current.disabled = false;
      if (revertBtn.current) revertBtn.current.disabled = false;
      await renderKnownList();
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); }
  }

  // The known-list is a small hint that shows: (a) the model ids the
  // user has actually configured across all projects, and (b) the
  // built-in entries. The user can copy any id into the table above.
  async function renderKnownList() {
    if (!knownList.current) return;
    knownList.current.innerHTML = '';
    // 1) Built-in entries — the short list the chat UI can use
    // without any app-level override. We read it from the server's
    // /api/usage/builtin so we don't duplicate the list in the web
    // bundle; the server is the source of truth.
    let builtin = [];
    try {
      const r = await fetchJson('/api/usage/builtin');
      if (r.status === 200 && r.body && Array.isArray(r.body.ids)) builtin = r.body.ids;
    } catch { /* leave empty */ }

    const appendGroup = (title, ids) => {
      if (!ids.length) return;
      const li = document.createElement('li');
      li.className = 'pricing__group';
      const t = document.createElement('div');
      t.className = 'pricing__group-title';
      t.textContent = title;
      li.appendChild(t);
      const list = document.createElement('ul');
      list.className = 'pricing__ids';
      for (const id of ids) {
        const row = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = id;
        row.appendChild(code);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--small pricing__copy';
        btn.textContent = 'copy';
        btn.title = 'Copy the id to the table above (as a placeholder entry)';
        btn.addEventListener('click', () => copyIdToEditor(id));
        row.appendChild(btn);
        list.appendChild(row);
      }
      li.appendChild(list);
      knownList.current.appendChild(li);
    };
    appendGroup('Built-in defaults', builtin);

    // 2) Configured models — every model id the user has set up
    // across every registered project. The set is deduplicated and
    // case-sensitive (model ids are exact strings).
    let configured = [];
    try {
      const r = await fetchJson('/api/ai/models-all');
      if (r.status === 200 && r.body && Array.isArray(r.body.ids)) configured = r.body.ids;
    } catch { /* leave empty */ }
    appendGroup('Models you have configured', configured);
  }

  // copyIdToEditor inserts a zero-cost placeholder entry for the id
  // so the user can edit the prices in place. Doing this beats
  // re-typing the id by hand and matches what the JSON editor's
  // user expects from a "copy" affordance.
  function copyIdToEditor(id) {
    if (!editor.current) return;
    let parsed;
    try { parsed = JSON.parse(editor.current.value || '{}'); }
    catch { setStatus(statusEl, 'fix JSON syntax first', 'error'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    if (parsed[id]) return; // already present; no-op
    parsed[id] = { inputPer1K: 0, outputPer1K: 0 };
    editor.current.value = JSON.stringify(parsed, null, 2);
    setStatus(statusEl, 'added ' + id + ' — set its prices and Save', 'success');
  }

  async function save() {
    if (!editor.current) return;
    let parsed;
    try { parsed = JSON.parse(editor.current.value || '{}'); }
    catch (e) { setStatus(statusEl, 'invalid JSON: ' + e.message, 'error'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus(statusEl, 'table must be a JSON object', 'error');
      return;
    }
    // Validate every entry. Bad entries are rejected with a clear
    // error; the rest of the table is not saved. This keeps a typo
    // from poisoning the whole settings blob.
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        setStatus(statusEl, 'entry "' + id + '" must be an object', 'error');
        return;
      }
      for (const k of ['inputPer1K', 'outputPer1K']) {
        if (entry[k] === undefined) continue;
        const n = Number(entry[k]);
        if (!isFinite(n) || n < 0) {
          setStatus(statusEl, 'entry "' + id + '" has invalid ' + k + ' (must be a non-negative number)', 'error');
          return;
        }
        entry[k] = n;
      }
    }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    try {
      await saveApp({ modelPricing: parsed });
      lastLoaded.current = JSON.parse(JSON.stringify(parsed));
      setStatus(statusEl, 'saved.', 'success');
    } catch (e) {
      setStatus(statusEl, 'save failed: ' + e.message, 'error');
    }
    if (saveBtn.current) saveBtn.current.disabled = false;
  }

  function revert() {
    if (editor.current) editor.current.value = JSON.stringify(lastLoaded.current, null, 2);
    setStatus(statusEl, 'reverted.', 'success');
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
        h('textarea', { ref: editor, class: 'input pricing__editor', id: 'pricing-table', rows: 10, spellcheck: false }),
        h('p', { class: 'hint' }, 'Example: ', h('code', null, '{ "gpt-4o-mini": { "inputPer1K": 0.00015, "outputPer1K": 0.00060 } }'))
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save, disabled: true }, 'Save'),
        h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revert, disabled: true }, 'Revert'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      h('h3', null, 'Known model ids'),
      h('p', { class: 'hint hint--compact' }, 'The chat UI renders a per-turn cost only for ids that resolve through the built-in table or this override. Tap copy to add an id to your table.'),
      h('ul', { ref: knownList, class: 'pricing__known', 'aria-label': 'Known model ids' })
    )
  );
}
