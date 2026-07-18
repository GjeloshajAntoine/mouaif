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
  const fileToggle = useRef(null);
  const fileStatus = useRef(null);
  const fileModeSel = useRef(null);
  const fileAllowlist = useRef(null);
  const promptsCard = useRef(null);
  const promptsSummary = useRef(null);
  const mcpCard = useRef(null);
  const mcpSummary = useRef(null);
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
    if (mcpCard.current) mcpCard.current.href = '#/settings/mcp?projectDir=' + encodeURIComponent(d);

    // Prompt size (project override; '' means "inherit app default").
    if (promptSizeSel.current) {
      promptSizeSel.current.value = (currentProject.promptSize && String(currentProject.promptSize)) || '';
      promptSizeSel.current.disabled = false;
    }
    if (promptSizeStatus.current) promptSizeStatus.current.textContent = '';

    // Legacy enable flags no longer hide base tools. Authorization mode is
    // the sole execution gate; keep the controls checked for clarity.
    if (shellToggle.current) {
      shellToggle.current.checked = true;
      shellToggle.current.disabled = true;
    }
    if (shellStatus.current) shellStatus.current.textContent = '';

    try {
      const authz = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(d));
      const shell = authz.status === 200 && authz.body.tools && authz.body.tools.shell;
      if (shellModeSel.current) shellModeSel.current.value = shell && shell.mode || 'ask';
      if (shellAllowlist.current) shellAllowlist.current.value = shell && Array.isArray(shell.allowlist) ? shell.allowlist.join('\n') : '';
      const file = authz.status === 200 && authz.body.tools && authz.body.tools.file;
      if (fileModeSel.current) fileModeSel.current.value = file && file.mode || 'ask';
      if (fileAllowlist.current) fileAllowlist.current.value = file && Array.isArray(file.allowlist) ? file.allowlist.join('\n') : '';
    } catch { /* keep ask + empty allowlist */ }

    // File tools toggle.
    if (fileToggle.current) {
      fileToggle.current.checked = true;
      fileToggle.current.disabled = true;
    }
    if (fileStatus.current) fileStatus.current.textContent = '';

    // MCP server count for the card summary.
    try {
      const mr = await fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(d));
      if (mcpSummary.current) {
        if (mr.status === 200) {
          const n = (mr.body.servers || []).length;
          mcpSummary.current.textContent = n ? (n + (n === 1 ? ' server' : ' servers')) : 'no servers yet';
        } else { mcpSummary.current.textContent = '—'; }
      }
    } catch { if (mcpSummary.current) mcpSummary.current.textContent = '—'; }

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

  async function saveFileAuthorization() {
    const mode = fileModeSel.current ? fileModeSel.current.value : 'ask';
    const allowlist = fileAllowlist.current
      ? fileAllowlist.current.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    if (fileStatus.current) fileStatus.current.textContent = 'saving authorization…';
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { file: { mode, allowlist } } })
    });
    if (fileStatus.current) fileStatus.current.textContent = r.status === 200 ? 'authorization saved' : ('HTTP ' + r.status);
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
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Project settings')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'settings-project__hero' },
        h('div', { class: 'settings-project__eyebrow' }, 'Project file'),
        h('p', { class: 'settings-project__path' }, h('code', { ref: pathEl }, '…')),
        h('p', { class: 'settings-project__lede' }, 'Saved in .mouaif.json — applies to this project only.'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),

      // ---- Project ----------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Project'),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-prompt-size' }, 'Prompt size'),
              h('div', { ref: promptSizeStatus, class: 'settings-project__item-note', 'aria-live': 'polite' }, 'Inherits unless set here')
            ),
            h('select', { ref: promptSizeSel, class: 'input settings-project__select', id: 'sp-prompt-size', disabled: true, onChange: onPromptSize },
              h('option', { value: '' }, 'Inherit'),
              h('option', { value: 'very-small' }, 'Very small'),
              h('option', { value: 'average' }, 'Average'),
              h('option', { value: 'extensive' }, 'Extensive')
            )
          )
        )
      ),

      // ---- Tools ------------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Tool access'),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('div', { class: 'settings-project__item-main' },
                h('div', { class: 'settings-project__item-title' }, 'Shell'),
                h('div', { class: 'settings-project__item-note' }, 'Run commands in this project folder')
              ),
              h('input', { ref: shellToggle, class: 'checkbox', type: 'checkbox', checked: true, disabled: true })
            ),
            h('div', { class: 'settings-project__sub' }, 'Authorization'),
            h('label', { class: 'label', for: 'sp-shell-mode' }, 'Mode'),
            h('select', { ref: shellModeSel, class: 'input', id: 'sp-shell-mode' },
              h('option', { value: 'off' }, 'Off'),
              h('option', { value: 'ask' }, 'Ask every time'),
              h('option', { value: 'allowlist' }, 'Allowlist, then ask'),
              h('option', { value: 'allow' }, 'Always allow')
            ),
            h('label', { class: 'label', for: 'sp-shell-allowlist' }, 'Full-command regex allowlist'),
            h('textarea', { ref: shellAllowlist, class: 'input', id: 'sp-shell-allowlist', rows: 3, spellcheck: false, placeholder: '^npm test$\n^git status$' }),
            h('div', { class: 'settings-project__actions' },
              h('span', { ref: shellStatus, class: 'status', 'aria-live': 'polite' }),
              h('button', { class: 'btn', type: 'button', onClick: saveShellAuthorization }, 'Save')
            ),
            h('p', { class: 'settings-project__warning' }, 'Commands run with your account. Enable only on projects you trust.')
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('div', { class: 'settings-project__item-main' },
                h('div', { class: 'settings-project__item-title' }, 'Files'),
                h('div', { class: 'settings-project__item-note' }, 'Read, list, search, and edit files')
              ),
              h('input', { ref: fileToggle, class: 'checkbox', type: 'checkbox', checked: true, disabled: true })
            ),
            h('div', { class: 'settings-project__sub' }, 'Authorization'),
            h('label', { class: 'label', for: 'sp-file-mode' }, 'Mode'),
            h('select', { ref: fileModeSel, class: 'input', id: 'sp-file-mode' },
              h('option', { value: 'off' }, 'Off'),
              h('option', { value: 'ask' }, 'Ask every time'),
              h('option', { value: 'allowlist' }, 'Allowlist, then ask'),
              h('option', { value: 'allow' }, 'Always allow')
            ),
            h('label', { class: 'label', for: 'sp-file-allowlist' }, 'Path regex allowlist'),
            h('textarea', { ref: fileAllowlist, class: 'input', id: 'sp-file-allowlist', rows: 3, spellcheck: false, placeholder: '^src/.*\\.js$\n^README\\.md$' }),
            h('div', { class: 'settings-project__actions' },
              h('span', { ref: fileStatus, class: 'status', 'aria-live': 'polite' }),
              h('button', { class: 'btn', type: 'button', onClick: saveFileAuthorization }, 'Save')
            ),
            h('p', { class: 'settings-project__warning' }, 'Allowlist matches the path requested by file tools.')
          )
        )
      ),

      // ---- Links ------------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Project extras'),
        h('ul', { class: 'group__list' },
          h('li', null,
            h('a', {
              ref: mcpCard,
              class: 'card',
              'aria-label': 'MCP servers',
              href: '#/settings/mcp?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('div', { class: 'card__main' },
                h('div', { class: 'card__title' }, 'MCP servers'),
                h('div', { ref: mcpSummary, class: 'card__summary' }, '—')
              ),
              h('div', { class: 'card__chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
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
            )
          )
        )
      ),

      // ---- Advanced (raw file + resolved) ----------------------------
      h('details', { class: 'settings__advanced settings-project__advanced' },
        h('summary', null, 'Advanced'),
        h('p', { class: 'hint hint--compact' }, 'Edit ', h('code', null, '.mouaif.json'), ' directly. Structured controls write the same file.'),
        h('label', { class: 'label', for: 'sp-project-editor' }, 'Project file'),
        h('textarea', { ref: editor, class: 'input settings-project__code', id: 'sp-project-editor', rows: 10, spellcheck: false }),
        h('div', { class: 'row row--actions' },
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: saveRaw, disabled: true }, 'Save file'),
          h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revertRaw, disabled: true }, 'Revert'),
          h('span', { ref: editorStatus, class: 'status', 'aria-live': 'polite' })
        ),
        h('div', { class: 'group__title settings-project__subhead' }, 'Resolved settings'),
        h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. Provider keys are redacted.'),
        h('pre', { ref: resolvedOut, class: 'settings__out' })
      )
    )
  );
}
