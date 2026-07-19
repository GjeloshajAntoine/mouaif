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
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject, projectsReload } from '../api.js';
import { nav } from '../router.js';

export function SettingsProjectView({ projectDir: initialDir, chatId: initialChatId } = {}) {
  const statusEl = useRef(null);
  const pathEl = useRef(null);
  // Structured controls
  const promptSizeSel = useRef(null);
  const promptSizeStatus = useRef(null);
  const [traceCardVisible, setTraceCardVisible] = useState(!!(initialChatId && initialChatId.trim()));
  const chatTraceToggle = useRef(null);
  const chatTraceStatus = useRef(null);
  const exportTraceBtn = useRef(null);
  const exportTraceStatus = useRef(null);
  const shellStatus = useRef(null);
  const shellModeSel = useRef(null);
  const shellAllowlist = useRef(null);
  const shellAllowlistWrap = useRef(null);
  const fileStatus = useRef(null);
  const fileModeSel = useRef(null);
  const fileAllowlist = useRef(null);
  const fileAllowlistWrap = useRef(null);
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
  const loadedChatId = useRef((initialChatId || '').trim());

  function dir() { return loadedDir.current; }
  function chatId() { return loadedChatId.current; }

  // The allowlist textarea only matters in "allowlist" mode; in every
  // other mode it is dead weight on the screen. Hide it so the tool
  // card shows only the controls that actually apply.
  function syncAllowlistVisibility(modeSel, wrap) {
    if (!wrap) return;
    wrap.hidden = !modeSel || modeSel.value !== 'allowlist';
  }
  function onShellModeChange() { syncAllowlistVisibility(shellModeSel.current, shellAllowlistWrap.current); }
  function onFileModeChange() { syncAllowlistVisibility(fileModeSel.current, fileAllowlistWrap.current); }

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

    setTraceCardVisible(!!chatId());
    if (chatTraceStatus.current) chatTraceStatus.current.textContent = '';
    if (exportTraceStatus.current) exportTraceStatus.current.textContent = '';
    if (chatId()) {
      try {
        const cr = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(d));
        if (cr.status === 200 && cr.body && cr.body.chat) {
          const on = cr.body.chat.trace === true;
          if (chatTraceToggle.current) {
            chatTraceToggle.current.checked = on;
            chatTraceToggle.current.setAttribute('aria-checked', on ? 'true' : 'false');
          }
          if (chatTraceStatus.current) chatTraceStatus.current.textContent = on ? 'trace on' : 'trace off';
          if (exportTraceBtn.current) exportTraceBtn.current.disabled = false;
        } else {
          if (chatTraceStatus.current) chatTraceStatus.current.textContent = 'chat not found';
          if (exportTraceBtn.current) exportTraceBtn.current.disabled = true;
        }
      } catch {
        if (chatTraceStatus.current) chatTraceStatus.current.textContent = 'failed to load chat';
        if (exportTraceBtn.current) exportTraceBtn.current.disabled = true;
      }
    } else if (chatTraceStatus.current) {
      chatTraceStatus.current.textContent = 'Open from a chat to edit trace.';
    }

    if (shellStatus.current) shellStatus.current.textContent = '';

    try {
      const authz = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(d));
      const shell = authz.status === 200 && authz.body.tools && authz.body.tools.shell;
      const shellMode = (shell && shell.mode) || 'ask';
      if (shellModeSel.current) shellModeSel.current.value = shellMode;
      syncAllowlistVisibility(shellModeSel.current, shellAllowlistWrap.current);
      if (shellAllowlist.current) shellAllowlist.current.value = shell && Array.isArray(shell.allowlist) ? shell.allowlist.join('\n') : '';
      const file = authz.status === 200 && authz.body.tools && authz.body.tools.file;
      const fileMode = (file && file.mode) || 'ask';
      if (fileModeSel.current) fileModeSel.current.value = fileMode;
      syncAllowlistVisibility(fileModeSel.current, fileAllowlistWrap.current);
      if (fileAllowlist.current) fileAllowlist.current.value = file && Array.isArray(file.allowlist) ? file.allowlist.join('\n') : '';
    } catch { /* keep ask + empty allowlist */ }

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

  async function onChatTraceChange() {
    if (!chatId() || !chatTraceToggle.current) return;
    const want = !!chatTraceToggle.current.checked;
    chatTraceToggle.current.setAttribute('aria-checked', want ? 'true' : 'false');
    if (chatTraceStatus.current) chatTraceStatus.current.textContent = 'saving…';
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), trace: want })
    });
    if (r.status === 200) {
      const on = r.body && r.body.chat && r.body.chat.trace === true;
      if (chatTraceToggle.current) {
        chatTraceToggle.current.checked = on;
        chatTraceToggle.current.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      if (chatTraceStatus.current) chatTraceStatus.current.textContent = on ? 'trace on' : 'trace off';
    } else if (chatTraceStatus.current) {
      chatTraceStatus.current.textContent = 'HTTP ' + r.status;
      chatTraceToggle.current.checked = !want;
      chatTraceToggle.current.setAttribute('aria-checked', !want ? 'true' : 'false');
    }
  }

  async function exportTrace() {
    if (!chatId()) return;
    if (exportTraceStatus.current) exportTraceStatus.current.textContent = 'exporting trace…';
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '/trace/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir() })
    });
    if (exportTraceStatus.current) {
      exportTraceStatus.current.textContent = r.status === 200 ? ('exported: ' + r.body.path) : ('export failed: HTTP ' + r.status);
    }
  }

  async function deleteChat() {
    if (!chatId()) return;
    if (!confirm('Delete this chat? Its messages will be removed; any exported trace file will be kept.')) return;
    if (chatTraceStatus.current) chatTraceStatus.current.textContent = 'deleting chat…';
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(dir()), { method: 'DELETE' });
    if (r.status === 200) {
      projectsReload.value++;
      nav('projects');
    } else if (chatTraceStatus.current) {
      chatTraceStatus.current.textContent = 'delete failed: HTTP ' + r.status;
    }
  }

  // Save tool authorization for one tool (shell / file). The mode
  // select auto-saves on change; the allowlist auto-saves on a short
  // debounce, so the row stays one line tall and matches the other
  // items in the list.
  async function saveToolAuthorization(tool, modeSel, allowlistEl, statusEl) {
    const mode = modeSel && modeSel.current ? modeSel.current.value : 'ask';
    const allowlist = allowlistEl && allowlistEl.current
      ? allowlistEl.current.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    if (statusEl && statusEl.current) statusEl.current.textContent = 'saving…';
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { [tool]: { mode, allowlist } } })
    });
    if (statusEl && statusEl.current) {
      statusEl.current.textContent = r.status === 200 ? 'saved' : ('HTTP ' + r.status);
    }
  }
  function saveShellAuthorization() { saveToolAuthorization('shell', shellModeSel, shellAllowlist, shellStatus); }
  function saveFileAuthorization() { saveToolAuthorization('file', fileModeSel, fileAllowlist, fileStatus); }
  // Debounced allowlist auto-save. Each tool has its own timer so the
  // shell and file lists don't collide.
  function makeAllowlistSaver(tool, modeSel, allowlistEl, statusEl) {
    let t = null;
    return () => {
      if (t) clearTimeout(t);
      if (statusEl && statusEl.current) statusEl.current.textContent = '…';
      t = setTimeout(() => saveToolAuthorization(tool, modeSel, allowlistEl, statusEl), 350);
    };
  }
  const saveShellAllowlistDebounced = useRef(makeAllowlistSaver('shell', shellModeSel, shellAllowlist, shellStatus));
  const saveFileAllowlistDebounced = useRef(makeAllowlistSaver('file', fileModeSel, fileAllowlist, fileStatus));

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
      h('a', { href: chatId() ? ('#/chat/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(dir() || initialDir || '')) : '#/settings', class: 'view-back', 'aria-label': chatId() ? 'Back to chat' : 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Project settings')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'settings-project__hero' },
        h('div', { class: 'settings-project__eyebrow' }, 'This project'),
        h('p', { class: 'settings-project__path' }, h('code', { ref: pathEl }, '…')),
        h('p', { class: 'settings-project__lede' }, 'Saved in ', h('code', null, '.mouaif.json'), '. These choices override app defaults for this folder only.'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      // ---- Project ----------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Project defaults', h('span', { class: 'group__title-note' }, 'Overrides app defaults')),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-prompt-size' }, 'Prompt context size'),
              h('div', { class: 'settings-project__item-note' }, 'How much project context the model receives.'),
              h('div', { ref: promptSizeStatus, class: 'settings-project__item-status', 'aria-live': 'polite' }, 'Inherits the app default until changed here')
            ),
            h('select', { ref: promptSizeSel, class: 'input settings-project__select', id: 'sp-prompt-size', disabled: true, onChange: onPromptSize },
              h('option', { value: '' }, 'Inherit app default'),
              h('option', { value: 'very-small' }, 'Very small'),
              h('option', { value: 'average' }, 'Average (recommended)'),
              h('option', { value: 'extensive' }, 'Extensive')
            )
          ),
          h('li', { class: 'settings-project__item settings-project__item--col', hidden: !traceCardVisible },
            h('div', { class: 'settings-project__item-row' },
              h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sp-chat-trace' }, 'Trace this chat'),
                h('div', { class: 'settings-project__item-note' }, 'Write this chat to a project trace file.'),
                h('div', { ref: chatTraceStatus, class: 'settings-project__item-status', 'aria-live': 'polite' }, '')
              ),
              h('label', { class: 'switch' },
                h('input', { ref: chatTraceToggle, id: 'sp-chat-trace', type: 'checkbox', role: 'switch', 'aria-checked': 'false', onChange: onChatTraceChange }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
              )
            ),
            h('div', { class: 'settings-project__item-actions' },
              h('span', { ref: exportTraceStatus, class: 'settings-project__item-status', 'aria-live': 'polite' }),
              h('button', { ref: exportTraceBtn, class: 'btn', type: 'button', onClick: exportTrace, disabled: true }, 'Export trace'),
              h('button', { class: 'btn btn--danger btn--sm', type: 'button', onClick: deleteChat }, 'Delete chat')
            )
          )
        )
      ),

      // ---- Tools ------------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Tool permissions', h('span', { class: 'group__title-note' }, 'Per project')),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-shell-mode' }, 'Shell commands'),
              h('div', { class: 'settings-project__item-note' },
                'The AI can run terminal commands in this folder. Commands run as your user account. ',
                h('span', { ref: shellStatus, class: 'settings-project__item-status', 'aria-live': 'polite' })
              )
            ),
            h('select', { ref: shellModeSel, class: 'input', id: 'sp-shell-mode', onChange: function (e) { onShellModeChange(); saveShellAuthorization(); } },
              h('option', { value: 'ask' }, 'Ask every time'),
              h('option', { value: 'allowlist' }, 'Allowlist — trusted commands run, others ask'),
              h('option', { value: 'allow' }, 'Always allow (runs without asking)'),
              h('option', { value: 'off' }, 'Off — requests fail immediately')
            ),
            h('div', { ref: shellAllowlistWrap, class: 'settings-project__allowlist', hidden: true },
              h('label', { class: 'label', for: 'sp-shell-allowlist' }, 'Allowed command patterns'),
              h('p', { class: 'settings-project__help' }, 'One regular expression per line, matched against the full command. Auto-saves.'),
              h('textarea', { ref: shellAllowlist, class: 'input settings-project__mono', id: 'sp-shell-allowlist', rows: 3, spellcheck: false, placeholder: `^npm test$\n^git status$`, onInput: function () { saveShellAllowlistDebounced.current(); } })
            )
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-file-mode' }, 'File tools'),
              h('div', { class: 'settings-project__item-note' },
                'The AI can read, search, and edit files in this folder. Edits stay inside this project folder. ',
                h('span', { ref: fileStatus, class: 'settings-project__item-status', 'aria-live': 'polite' })
              )
            ),
            h('select', { ref: fileModeSel, class: 'input', id: 'sp-file-mode', onChange: function (e) { onFileModeChange(); saveFileAuthorization(); } },
              h('option', { value: 'ask' }, 'Ask every time'),
              h('option', { value: 'allowlist' }, 'Allowlist — trusted paths open, others ask'),
              h('option', { value: 'allow' }, 'Always allow (runs without asking)'),
              h('option', { value: 'off' }, 'Off — requests fail immediately')
            ),
            h('div', { ref: fileAllowlistWrap, class: 'settings-project__allowlist', hidden: true },
              h('label', { class: 'label', for: 'sp-file-allowlist' }, 'Allowed path patterns'),
              h('p', { class: 'settings-project__help' }, 'One regular expression per line, matched against the project-relative path. Auto-saves.'),
              h('textarea', { ref: fileAllowlist, class: 'input settings-project__mono', id: 'sp-file-allowlist', rows: 3, spellcheck: false, placeholder: `^src/.*\\.js$\n^README\\.md$`, onInput: function () { saveFileAllowlistDebounced.current(); } })
            )
          )
        )
      ),

      // ---- Links ------------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Project add-ons'),
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
        h('summary', null, 'Advanced: raw project file'),
        h('p', { class: 'hint hint--compact' }, 'Use this only if you need to hand-edit ', h('code', null, '.mouaif.json'), '. The controls above write the same file.'),
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
