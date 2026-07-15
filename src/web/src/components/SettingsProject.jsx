// mouaif web — SettingsProjectView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject } from '../api.js';

export function SettingsProjectView({ projectDir: initialDir } = {}) {
  const projectDir = useRef(null);
  const loadBtn = useRef(null);
  const statusEl = useRef(null);
  const resolvedStatus = useRef(null);
  const editor = useRef(null);
  const saveBtn = useRef(null);
  const revertBtn = useRef(null);
  const resolvedOut = useRef(null);
  const resolvedDir = useRef(null);
  const promptsCard = useRef(null);
  const promptsSummary = useRef(null);
  const shellToggle = useRef(null);
  const shellStatus = useRef(null);

  let currentProject = {};
  const loadedDir = useRef('');

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
    loadedDir.current = dir;
    // Make the loaded project the active one for downstream views
    // (Custom prompts, etc.) so the user does not have to re-pick it.
    setActiveProject(dir, '');
    if (promptsCard.current) {
      promptsCard.current.href = '#/settings/prompts?projectDir=' + encodeURIComponent(dir);
    }
    // Refresh the prompts count for the card summary.
    try {
      const pr = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(dir));
      if (promptsSummary.current) {
        if (pr.status === 200) {
          const n = (pr.body.prompts || []).length;
          promptsSummary.current.textContent = n ? (n + (n === 1 ? ' prompt' : ' prompts')) : 'no prompts yet';
        } else {
          promptsSummary.current.textContent = '—';
        }
      }
    } catch { if (promptsSummary.current) promptsSummary.current.textContent = '—'; }
    if (editor.current) {
      editor.current.hidden = false;
      editor.current.value = JSON.stringify(currentProject, null, 2);
    }
    // Sync the shell-tool toggle from the raw project file.
    if (shellToggle.current) {
      const on = !!(currentProject.tools && currentProject.tools.shell && currentProject.tools.shell.enabled);
      shellToggle.current.checked = on;
      shellToggle.current.disabled = false;
    }
    if (shellStatus.current) shellStatus.current.textContent = '';
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

  // Toggle the native shell tool for this project. Persists
  // tools.shell.enabled on the project file. The model can run
  // commands in the project dir only when this is on.
  async function toggleShell(e) {
    const dir = loadedDir.current || (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { if (shellStatus.current) shellStatus.current.textContent = 'load a project first'; return; }
    const want = !!(e && e.target && e.target.checked);
    if (shellToggle.current) shellToggle.current.disabled = true;
    if (shellStatus.current) shellStatus.current.textContent = 'saving…';
    const next = Object.assign({}, currentProject);
    next.tools = Object.assign({}, next.tools);
    next.tools.shell = Object.assign({}, next.tools.shell, { enabled: want });
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir }, next))
    });
    if (shellToggle.current) shellToggle.current.disabled = false;
    if (r.status !== 200) {
      if (shellToggle.current) shellToggle.current.checked = !want;
      if (shellStatus.current) shellStatus.current.textContent = 'HTTP ' + r.status;
      return;
    }
    currentProject = r.body.project || next;
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    if (shellStatus.current) shellStatus.current.textContent = want ? 'shell tool enabled' : 'shell tool disabled';
  }

  // Seed the directory field from the route (?projectDir=...) or the active
  // project, then auto-load so arriving from the Settings home card lands on
  // the project's data without a manual paste + tap.
  useEffect(() => {
    const seed = (initialDir && initialDir.trim())
      || (activeProject.value && activeProject.value.dir)
      || '';
    if (seed && projectDir.current) {
      projectDir.current.value = seed;
      load().catch((e) => setStatus(statusEl, 'load failed: ' + e.message, 'error'));
    }
  }, [initialDir]);

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
      h('div', { ref: resolvedStatus, class: 'status', 'aria-live': 'polite' }),
      h('h3', null, 'Project features'),
      h('label', { class: 'card', 'aria-label': 'Enable shell tool' },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, 'Shell tool'),
          h('div', { class: 'card__summary' }, 'Let the model run commands in this project folder.')
        ),
        h('input', { ref: shellToggle, class: 'checkbox', type: 'checkbox', disabled: true, onChange: toggleShell })
      ),
      h('p', { ref: shellStatus, class: 'hint hint--compact', 'aria-live': 'polite' }, ''),
      h('p', { class: 'hint hint--compact' }, '⚠︎ Commands run with your account, in the project directory. Enable only on projects you trust.'),
      h('a', {
        ref: promptsCard,
        class: 'card',
        'aria-label': 'Custom prompts',
        'data-disabled': '1',
        href: '#/settings/prompts?projectDir=' + encodeURIComponent(loadedDir.current || '')
      },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, 'Custom prompts'),
          h('div', { ref: promptsSummary, class: 'card__summary' }, '—')
        ),
        h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
      )
    )
  );
}