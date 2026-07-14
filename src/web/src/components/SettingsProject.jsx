// mouaif web — SettingsProjectView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';

export function SettingsProjectView() {
  const projectDir = useRef(null);
  const loadBtn = useRef(null);
  const statusEl = useRef(null);
  const resolvedStatus = useRef(null);
  const editor = useRef(null);
  const saveBtn = useRef(null);
  const revertBtn = useRef(null);
  const resolvedOut = useRef(null);
  const resolvedDir = useRef(null);

  let currentProject = {};

  async function load() {
    const dir = (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    if (loadBtn.current) loadBtn.current.disabled = true;
    setStatus(statusEl, 'loading…', 'busy');
    const [projRes, resolvedRes] = await Promise.all([
      fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(dir)),
      fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(dir))
    ]);
    if (loadBtn.current) loadBtn.current.disabled = false;
    if (projRes.status !== 200) { setStatus(statusEl, 'project: HTTP ' + projRes.status + (projRes.body && projRes.body.error ? ' ' + projRes.body.error : ''), 'error'); return; }
    currentProject = projRes.body.project || {};
    if (editor.current) {
      editor.current.hidden = false;
      editor.current.value = JSON.stringify(currentProject, null, 2);
    }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (revertBtn.current) revertBtn.current.disabled = false;
    setStatus(statusEl, 'path: ' + (projRes.body.path || ''), 'success');
    if (resolvedRes.status === 200) {
      const currentResolved = resolvedRes.body.resolved || {};
      if (resolvedDir.current) resolvedDir.current.textContent = dir;
      if (resolvedOut.current) {
        const redacted = JSON.parse(JSON.stringify(currentResolved));
        if (Array.isArray(redacted.providers)) {
          redacted.providers = redacted.providers.map((p) => {
            if (!p || typeof p !== 'object') return p;
            if (typeof p.apiKey === 'string') p.apiKey = p.apiKey ? '•••' : '';
            return p;
          });
        }
        resolvedOut.current.hidden = false;
        resolvedOut.current.textContent = JSON.stringify(redacted, null, 2);
      }
      if (resolvedStatus.current) setStatus(resolvedStatus, 'ok', 'success');
    } else {
      if (resolvedStatus.current) setStatus(resolvedStatus, 'HTTP ' + resolvedRes.status, 'error');
    }
  }

  async function save() {
    const dir = (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    let parsed;
    try { parsed = JSON.parse((editor.current && editor.current.value) || '{}'); }
    catch (e) { setStatus(statusEl, 'invalid JSON: ' + e.message, 'error'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus(statusEl, 'project body must be a JSON object', 'error');
      return;
    }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir }, parsed))
    });
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved.', 'success');
    currentProject = r.body.project || currentProject;
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    await load();
  }

  function revert() {
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    setStatus(statusEl, 'reverted.', 'success');
  }

  useEffect(() => { /* nothing to do until the user picks a directory */ }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Project overrides')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Project files live at ', h('code', null, '.mouaif.json'), ' inside the project folder. Models reference a provider configured at the app level.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-project-dir' }, 'Project directory'),
        h('div', { class: 'row row--inline' },
          h('input', { ref: projectDir, class: 'input', id: 'sp-project-dir', type: 'text', placeholder: 'C:/path/to/project' }),
          h('button', { ref: loadBtn, class: 'btn', type: 'button', onClick: load }, 'Load')
        )
      ),
      h('div', { class: 'row' },
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-project-editor' }, 'Project file'),
        h('textarea', { ref: editor, class: 'input', id: 'sp-project-editor', rows: 10, hidden: true, spellcheck: false })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save, disabled: true }, 'Save'),
        h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revert, disabled: true }, 'Revert')
      ),
      h('h3', null, 'Resolved (effective for this project)'),
      h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. The chat layer reads this merged object. Provider keys are redacted.'),
      h('p', { class: 'hint hint--compact' }, h('code', { ref: resolvedDir }, '')),
      h('pre', { ref: resolvedOut, class: 'settings__out', hidden: true }),
      h('div', { ref: resolvedStatus, class: 'status', 'aria-live': 'polite' })
    )
  );
}