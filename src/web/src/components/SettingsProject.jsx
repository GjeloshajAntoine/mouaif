// mouaif web — SettingsProjectView
//
// Per-project settings, mobile-first. The project is known on arrival
// (from its card or the Settings → Active project link via ?projectDir),
// so there is no directory picker here. The primary UI is structured
// controls (prompt size, shell tool, custom prompts); the raw
// .mouaif.json editor and the resolved (effective) object live in a
// collapsed "Advanced" section for power users who want to hand-edit the
// file (decisions §1 — the project file is meant to be editable by hand).
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject } from '../api.js';

export function SettingsProjectView({ projectDir: initialDir } = {}) {
  const statusEl = useRef(null);
  const pathEl = useRef(null);
  // Structured controls
  const promptSizeSel = useRef(null);
  const promptSizeStatus = useRef(null);
  const shellToggle = useRef(null);
  const shellStatus = useRef(null);
  const shellModeSel = useRef(null);
  const shellAllowlist = useRef(null);
  const promptsCard = useRef(null);
  const promptsSummary = useRef(null);
  // Advanced (raw JSON + resolved)
  const editor = useRef(null);
  const saveBtn = useRef(null);
  const revertBtn = useRef(null);
  const editorStatus = useRef(null);
  const resolvedOut = useRef(null);

  let currentProject = {};
  const loadedDir = useRef('');

  function dir() { return loadedDir.current; }

  async function load(seedDir) {
    const d = (seedDir || '').trim();
    if (!d) { setStatus(statusEl, 'no project selected', 'error'); return; }
    loadedDir.current = d;
    setStatus(statusEl, 'loading…', 'busy');
    const [projRes, resolvedRes] = await Promise.all([
      fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(d)),
      fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(d))
    ]);
    if (projRes.status !== 200) {
      setStatus(statusEl, 'project: HTTP ' + projRes.status + (projRes.body && projRes.body.error ? ' ' + projRes.body.error : ''), 'error');
      return;
    }
    currentProject = projRes.body.project || {};
    // Make the loaded project the active one for downstream views.
    setActiveProject(d, '');
    if (pathEl.current) pathEl.current.textContent = projRes.body.path || d;
    if (promptsCard.current) promptsCard.current.href = '#/settings/prompts?projectDir=' + encodeURIComponent(d);

    // Prompt size (project override; '' means "inherit app default").
    if (promptSizeSel.current) {
      promptSizeSel.current.value = (currentProject.promptSize && String(currentProject.promptSize)) || '';
      promptSizeSel.current.disabled = false;
    }
    if (promptSizeStatus.current) promptSizeStatus.current.textContent = '';

    // Shell tool toggle.
    if (shellToggle.current) {
      shellToggle.current.checked = !!(currentProject.tools && currentProject.tools.shell && currentProject.tools.shell.enabled);
      shellToggle.current.disabled = false;
    }
    if (shellStatus.current) shellStatus.current.textContent = '';

    try {
      const authz = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(d));
      const shell = authz.status === 200 && authz.body.tools && authz.body.tools.shell;
      if (shellModeSel.current) shellModeSel.current.value = shell && shell.mode || 'ask';
      if (shellAllowlist.current) shellAllowlist.current.value = shell && Array.isArray(shell.allowlist) ? shell.allowlist.join('\n') : '';
    } catch { /* keep ask + empty allowlist */ }

    // Prompts count for the card summary.
    try {
      const pr = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(d));
      if (promptsSummary.current) {
        if (pr.status === 200) {
          const n = (pr.body.prompts || []).length;
          promptsSummary.current.textContent = n ? (n + (n === 1 ? ' prompt' : ' prompts')) : 'no prompts yet';
        } else { promptsSummary.current.textContent = '—'; }
      }
    } catch { if (promptsSummary.current) promptsSummary.current.textContent = '—'; }

    // Advanced: raw project file + resolved object.
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (revertBtn.current) revertBtn.current.disabled = false;
    if (resolvedRes.status === 200 && resolvedOut.current) {
      const redacted = JSON.parse(JSON.stringify(resolvedRes.body.resolved || {}));
      if (Array.isArray(redacted.providers)) {
        redacted.providers = redacted.providers.map((p) => {
          if (!p || typeof p !== 'object') return p;
          if (typeof p.apiKey === 'string') p.apiKey = p.apiKey ? '•••' : '';
          return p;
        });
      }
      resolvedOut.current.textContent = JSON.stringify(redacted, null, 2);
    }
    setStatus(statusEl, 'loaded', 'success');
  }

  // PATCH one key into the project file, keeping currentProject + the
  // advanced editor in sync. Returns true on success.
  async function patchProject(patch, statusRef, okMsg) {
    const d = dir();
    if (!d) { if (statusRef && statusRef.current) statusRef.current.textContent = 'no project'; return false; }
    if (statusRef && statusRef.current) statusRef.current.textContent = 'saving…';
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: d }, patch))
    });
    if (r.status !== 200) {
      if (statusRef && statusRef.current) statusRef.current.textContent = 'HTTP ' + r.status;
      return false;
    }
    currentProject = r.body.project || Object.assign({}, currentProject, patch);
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    if (statusRef && statusRef.current) statusRef.current.textContent = okMsg || 'saved';
    return true;
  }

  async function onPromptSize(e) {
    const v = e && e.target ? e.target.value : '';
    // Empty string clears the project override (inherit app default).
    if (v) {
      await patchProject({ promptSize: v }, promptSizeStatus, 'set to ' + v);
      return;
    }
    const d = dir();
    if (promptSizeStatus.current) promptSizeStatus.current.textContent = 'saving…';
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: d, unset: ['promptSize'] })
    });
    if (r.status === 200) {
      currentProject = r.body.project || {};
      if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
      if (promptSizeStatus.current) promptSizeStatus.current.textContent = 'inheriting app default';
    } else if (promptSizeStatus.current) {
      promptSizeStatus.current.textContent = 'HTTP ' + r.status;
    }
  }

  async function onShellToggle(e) {
    const want = !!(e && e.target && e.target.checked);
    if (shellToggle.current) shellToggle.current.disabled = true;
    const next = { tools: Object.assign({}, currentProject.tools) };
    next.tools.shell = Object.assign({}, next.tools && next.tools.shell, { enabled: want });
    const ok = await patchProject(next, shellStatus, want ? 'shell tool enabled' : 'shell tool disabled');
    if (shellToggle.current) shellToggle.current.disabled = false;
    if (!ok && shellToggle.current) shellToggle.current.checked = !want;
  }

  async function saveShellAuthorization() {
    const mode = shellModeSel.current ? shellModeSel.current.value : 'ask';
    const allowlist = shellAllowlist.current
      ? shellAllowlist.current.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    if (shellStatus.current) shellStatus.current.textContent = 'saving authorization…';
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { shell: { mode, allowlist } } })
    });
    if (shellStatus.current) shellStatus.current.textContent = r.status === 200 ? 'authorization saved' : ('HTTP ' + r.status);
  }

  // Advanced: save the raw JSON editor verbatim.
  async function saveRaw() {
    const d = dir();
    if (!d) { if (editorStatus.current) editorStatus.current.textContent = 'no project'; return; }
    let parsed;
    try { parsed = JSON.parse((editor.current && editor.current.value) || '{}'); }
    catch (e) { if (editorStatus.current) editorStatus.current.textContent = 'invalid JSON: ' + e.message; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (editorStatus.current) editorStatus.current.textContent = 'must be a JSON object';
      return;
    }
    if (saveBtn.current) saveBtn.current.disabled = true;
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: d }, parsed))
    });
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { if (editorStatus.current) editorStatus.current.textContent = 'HTTP ' + r.status; return; }
    if (editorStatus.current) editorStatus.current.textContent = 'saved';
    // Re-sync the structured controls from the saved file.
    await load(d);
  }

  function revertRaw() {
    if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
    if (editorStatus.current) editorStatus.current.textContent = 'reverted';
  }

  // Seed the project silently from the route (?projectDir=...) or the
  // active project, then auto-load. No manual directory entry.
  useEffect(() => {
    const seed = (initialDir && initialDir.trim())
      || (activeProject.value && activeProject.value.dir)
      || '';
    if (seed) load(seed).catch((e) => setStatus(statusEl, 'load failed: ' + e.message, 'error'));
    else setStatus(statusEl, 'open this from a project card', 'error');
  }, [initialDir]);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
      h('h2', { class: 'view-title' }, 'Project settings')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' },
        h('code', { ref: pathEl }, '…'),
        ' — settings live in ', h('code', null, '.mouaif.json'), ' and can be committed with the project.'
      ),
      h('div', { class: 'row' }, h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })),

      // ---- Prompt size ------------------------------------------------
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-prompt-size' }, 'Prompt size (this project)'),
        h('select', { ref: promptSizeSel, class: 'input', id: 'sp-prompt-size', disabled: true, onChange: onPromptSize },
          h('option', { value: '' }, 'Inherit app default'),
          h('option', { value: 'very-small' }, 'very-small'),
          h('option', { value: 'average' }, 'average'),
          h('option', { value: 'extensive' }, 'extensive')
        ),
        h('span', { ref: promptSizeStatus, class: 'hint hint--compact', 'aria-live': 'polite' }, '')
      ),

      // ---- Tools ------------------------------------------------------
      h('h3', null, 'Tools'),
      h('label', { class: 'card', 'aria-label': 'Enable shell tool' },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, 'Shell tool'),
          h('div', { class: 'card__summary' }, 'Let the model run commands in this project folder.')
        ),
        h('input', { ref: shellToggle, class: 'checkbox', type: 'checkbox', disabled: true, onChange: onShellToggle })
      ),
      h('p', { ref: shellStatus, class: 'hint hint--compact', 'aria-live': 'polite' }, ''),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-shell-mode' }, 'Shell authorization'),
        h('select', { ref: shellModeSel, class: 'input', id: 'sp-shell-mode' },
          h('option', { value: 'off' }, 'Off'),
          h('option', { value: 'ask' }, 'Ask every time'),
          h('option', { value: 'allowlist' }, 'Allowlist, then ask'),
          h('option', { value: 'allow' }, 'Allow this session')
        ),
        h('label', { class: 'label', for: 'sp-shell-allowlist' }, 'Full-command regex allowlist (one per line)'),
        h('textarea', { ref: shellAllowlist, class: 'input', id: 'sp-shell-allowlist', rows: 3, spellcheck: false, placeholder: '^npm test$\n^git status$' }),
        h('button', { class: 'btn', type: 'button', onClick: saveShellAuthorization }, 'Save authorization')
      ),
      h('p', { class: 'hint hint--compact' }, '⚠︎ Commands run with your account, in the project directory. Enable only on projects you trust.'),

      // ---- Prompts ----------------------------------------------------
      h('h3', null, 'Prompts'),
      h('a', {
        ref: promptsCard,
        class: 'card',
        'aria-label': 'Custom prompts',
        href: '#/settings/prompts?projectDir=' + encodeURIComponent(loadedDir.current || '')
      },
        h('div', { class: 'card__main' },
          h('div', { class: 'card__title' }, 'Custom prompts'),
          h('div', { ref: promptsSummary, class: 'card__summary' }, '—')
        ),
        h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
      ),

      // ---- Advanced (raw file + resolved) ----------------------------
      h('details', { class: 'settings__advanced' },
        h('summary', null, 'Advanced — raw file & resolved settings'),
        h('p', { class: 'hint hint--compact' }, 'Edit ', h('code', null, '.mouaif.json'), ' directly. The structured controls above write the same file.'),
        h('label', { class: 'label', for: 'sp-project-editor' }, 'Project file'),
        h('textarea', { ref: editor, class: 'input', id: 'sp-project-editor', rows: 10, spellcheck: false }),
        h('div', { class: 'row row--actions' },
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: saveRaw, disabled: true }, 'Save file'),
          h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revertRaw, disabled: true }, 'Revert'),
          h('span', { ref: editorStatus, class: 'status', 'aria-live': 'polite' })
        ),
        h('h3', null, 'Resolved (effective)'),
        h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. The chat layer reads this. Provider keys are redacted.'),
        h('pre', { ref: resolvedOut, class: 'settings__out' })
      )
    )
  );
}
