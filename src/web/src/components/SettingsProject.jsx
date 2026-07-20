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
  // Tool permissions live in state (not refs) so the segmented
  // Off/Ask/Allow control and the allowlist disclosure re-render
  // together when the user taps a segment.
  const [shellAuth, setShellAuth] = useState({ mode: 'ask', allowlist: [] });
  const [fileAuth, setFileAuth] = useState({ mode: 'ask', allowlist: [] });
  const [askUserMode, setAskUserMode] = useState('ask');
  const [shellStatusMsg, setShellStatusMsg] = useState('');
  const [fileStatusMsg, setFileStatusMsg] = useState('');
  const [askUserStatusMsg, setAskUserStatusMsg] = useState('');
  const agentFilesStatus = useRef(null);
  const agentFilesToggle = useRef(null);
  const agentFileNames = useRef(null);
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

  // Tool permission model (see docs/features/tool-authorization.md):
  // exactly three primary choices per tool — Off (hidden from the
  // model, zero tokens), Ask on use, Allow (auto-approved). An
  // allowlist is an advanced refinement of Ask: matching calls run
  // without prompting, the rest still ask. Entering patterns flips
  // the server mode to `allowlist`; clearing them flips back to
  // `ask`. The segmented control never shows "allowlist" as a fourth
  // option — Ask stays selected — so the row reads as one choice.
  function segMode(mode) { return mode === 'allowlist' ? 'ask' : mode; }

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

    setShellStatusMsg('');
    setFileStatusMsg('');
    setAskUserStatusMsg('');

    try {
      const authz = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(d));
      const shell = authz.status === 200 && authz.body.tools && authz.body.tools.shell;
      setShellAuth({
        mode: (shell && shell.mode) || 'ask',
        allowlist: shell && Array.isArray(shell.allowlist) ? shell.allowlist : []
      });
      const file = authz.status === 200 && authz.body.tools && authz.body.tools.file;
      setFileAuth({
        mode: (file && file.mode) || 'ask',
        allowlist: file && Array.isArray(file.allowlist) ? file.allowlist : []
      });
      // ask_user is a binary { off, ask } tool. The server clamps any
      // legacy allowlist / allow value to `ask`; here we read what the
      // server says it is, and fall back to `ask` on the first load.
      const askUser = authz.status === 200 && authz.body.tools && authz.body.tools.ask_user;
      setAskUserMode((askUser && askUser.mode === 'off') ? 'off' : 'ask');
    } catch { /* keep ask + empty allowlist */ }

    if (agentFilesStatus.current) agentFilesStatus.current.textContent = '';

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

    // Agent files: project-level enable + file list.
    if (agentFilesToggle.current) {
      const on = currentProject.agentFiles === true;
      agentFilesToggle.current.checked = on;
      agentFilesToggle.current.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (agentFileNames.current) {
      agentFileNames.current.value = Array.isArray(currentProject.agentFileNames)
        ? currentProject.agentFileNames.join('\n')
        : '';
    }

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

  // Save tool authorization for one tool (shell / file). The segmented
  // control saves immediately on tap; the allowlist textarea saves on
  // a short debounce. Both write through the same helper.
  async function saveToolAuthorization(tool, mode, allowlist, setStatusMsg) {
    setStatusMsg('saving…');
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { [tool]: { mode, allowlist } } })
    });
    setStatusMsg(r.status === 200 ? 'saved' : ('HTTP ' + r.status));
  }

  function pickToolMode(tool, auth, setAuth, setStatusMsg, newMode) {
    // Tapping Allow clears any allowlist: auto-approve-everything
    // makes path/command patterns meaningless, and dropping them
    // keeps .mouaif.json honest about what is actually in force.
    const allowlist = newMode === 'allow' ? [] : auth.allowlist;
    setAuth({ mode: newMode, allowlist });
    saveToolAuthorization(tool, newMode, allowlist, setStatusMsg);
  }
  function pickShellMode(newMode) { pickToolMode('shell', shellAuth, setShellAuth, setShellStatusMsg, newMode); }
  function pickFileMode(newMode) { pickToolMode('file', fileAuth, setFileAuth, setFileStatusMsg, newMode); }

  function onAllowlistInput(tool, auth, setAuth, setStatusMsg, text) {
    const allowlist = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const mode = allowlist.length ? 'allowlist' : 'ask';
    setAuth({ mode, allowlist });
    saveToolAuthorization(tool, mode, allowlist, setStatusMsg);
  }
  // Debounced so typing a regex doesn't fire a PUT per keystroke.
  // Each tool has its own timer so the lists don't collide.
  function makeAllowlistSaver(tool, getAuth, setAuth, setStatusMsg) {
    let t = null;
    return (text) => {
      if (t) clearTimeout(t);
      setStatusMsg('…');
      t = setTimeout(() => onAllowlistInput(tool, getAuth(), setAuth, setStatusMsg, text), 350);
    };
  }
  const shellAuthRef = useRef(shellAuth);
  shellAuthRef.current = shellAuth;
  const fileAuthRef = useRef(fileAuth);
  fileAuthRef.current = fileAuth;
  const saveShellAllowlistDebounced = useRef(makeAllowlistSaver('shell', () => shellAuthRef.current, setShellAuth, setShellStatusMsg));
  const saveFileAllowlistDebounced = useRef(makeAllowlistSaver('file', () => fileAuthRef.current, setFileAuth, setFileStatusMsg));

  // ask_user is binary: the only valid modes are `ask` (the model
  // asks, the user always answers) and `off` (the tool is hidden
  // from the model and calls fail with ETOOL_DISABLED).
  function pickAskUserMode(newMode) {
    setAskUserMode(newMode);
    setAskUserStatusMsg('saving…');
    fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { ask_user: { mode: newMode, allowlist: [] } } })
    }).then((r) => setAskUserStatusMsg(r.status === 200 ? 'saved' : ('HTTP ' + r.status)));
  }

  // Agent files: project-level enable/disable and custom file list.
  async function saveAgentFiles() {
    const enabled = agentFilesToggle.current ? !!agentFilesToggle.current.checked : false;
    const namesRaw = agentFileNames.current ? agentFileNames.current.value : '';
    const names = namesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (agentFilesStatus.current) agentFilesStatus.current.textContent = 'saving…';
    const patch = { agentFiles: enabled };
    if (names.length) patch.agentFileNames = names;
    else patch.unset = ['agentFileNames'];
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir() }, patch))
    });
    if (r.status === 200) {
      currentProject = r.body.project || Object.assign({}, currentProject, patch);
      if (editor.current) editor.current.value = JSON.stringify(currentProject, null, 2);
      if (agentFilesStatus.current) agentFilesStatus.current.textContent = 'saved';
    } else if (agentFilesStatus.current) {
      agentFilesStatus.current.textContent = 'HTTP ' + r.status;
    }
  }
  // Debounced version for the file-names textarea.
  function makeAgentFilesSaver() {
    let t = null;
    return () => {
      if (t) clearTimeout(t);
      if (agentFilesStatus.current) agentFilesStatus.current.textContent = '…';
      t = setTimeout(saveAgentFiles, 350);
    };
  }
  const saveAgentFilesDebounced = useRef(makeAgentFilesSaver());

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

  // One-tap segmented control for a tool's permission mode. Segments
  // are radio inputs so keyboard and screen-reader users get the
  // same "pick one of N" semantics as the tap targets.
  function toolModeSegs(name, activeMode, onPick, modes) {
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name },
      modes.map((m) =>
        h('label', { key: m.value, class: 'seg__item' + (activeMode === m.value ? ' seg__item--on' : '') },
          h('input', {
            type: 'radio',
            name: 'sp-' + name.replace(/\s+/g, '-').toLowerCase(),
            value: m.value,
            checked: activeMode === m.value,
            onChange: () => onPick(m.value)
          }),
          h('span', { class: 'seg__pill' }, m.label)
        )
      )
    );
  }

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
              h('div', { class: 'settings-project__item-title' }, 'Shell commands'),
              h('div', { class: 'settings-project__item-note' },
                segMode(shellAuth.mode) === 'off'
                  ? 'Hidden from the model — costs no tokens. '
                  : 'Run terminal commands here, as your user account. ',
                h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, shellStatusMsg)
              )
            ),
            toolModeSegs('Shell commands', segMode(shellAuth.mode), pickShellMode, [
              { value: 'off', label: 'Off' },
              { value: 'ask', label: 'Ask' },
              { value: 'allow', label: 'Allow' }
            ]),
            segMode(shellAuth.mode) === 'ask'
              ? h('details', { class: 'settings-project__allowlist' },
                  h('summary', null, shellAuth.allowlist.length ? ('Auto-approve list (' + shellAuth.allowlist.length + ')') : 'Auto-approve list'),
                  h('p', { class: 'settings-project__help' }, 'Commands matching one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
                  h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^npm test$\n^git status$`, value: shellAuth.allowlist.join('\n'), onInput: (e) => saveShellAllowlistDebounced.current(e.target.value) })
                )
              : null
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('div', { class: 'settings-project__item-title' }, 'File tools'),
              h('div', { class: 'settings-project__item-note' },
                segMode(fileAuth.mode) === 'off'
                  ? 'Hidden from the model — costs no tokens. '
                  : 'Read, search, and edit files inside this folder. ',
                h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, fileStatusMsg)
              )
            ),
            toolModeSegs('File tools', segMode(fileAuth.mode), pickFileMode, [
              { value: 'off', label: 'Off' },
              { value: 'ask', label: 'Ask' },
              { value: 'allow', label: 'Allow' }
            ]),
            segMode(fileAuth.mode) === 'ask'
              ? h('details', { class: 'settings-project__allowlist' },
                  h('summary', null, fileAuth.allowlist.length ? ('Auto-approve list (' + fileAuth.allowlist.length + ')') : 'Auto-approve list'),
                  h('p', { class: 'settings-project__help' }, 'Paths matching one of these regexes open without asking; everything else still asks. One per line, auto-saves.'),
                  h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^src/.*\\.js$\n^README\\.md$`, value: fileAuth.allowlist.join('\n'), onInput: (e) => saveFileAllowlistDebounced.current(e.target.value) })
                )
              : null
          ),
          // ask_user is a binary { ask, off } tool. The model can
          // pause the chat and ask the user a structured question;
          // the user picks one option (2+, no cap) and may always
          // add a free-form "extra" answer. There is no allowlist
          // (the model can't predict the user's answer) and no
          // always-allow mode (the user must always be the source
          // of truth).
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('div', { class: 'settings-project__item-title' }, 'Ask the user'),
              h('div', { class: 'settings-project__item-note' },
                askUserMode === 'off'
                  ? 'Hidden from the model — costs no tokens. '
                  : 'The model may pause and ask a structured question. ',
                h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, askUserStatusMsg)
              )
            ),
            toolModeSegs('Ask the user', askUserMode, pickAskUserMode, [
              { value: 'off', label: 'Off' },
              { value: 'ask', label: 'Ask' }
            ])
          )
        )
      ),

      // ---- Agent files ------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Agent files', h('span', { class: 'group__title-note' }, 'Project-level defaults')),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-agent-files' }, 'Inject agent files into chats'),
              h('div', { class: 'settings-project__item-note' },
                'When enabled, instruction files at the project root (e.g. AGENTS.md, CLAUDE.md) are injected into the model context. Chats can still override this. ',
                h('span', { ref: agentFilesStatus, class: 'settings-project__item-status', 'aria-live': 'polite' })
              )
            ),
            h('label', { class: 'switch' },
              h('input', {
                ref: agentFilesToggle,
                id: 'sp-agent-files',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': 'false',
                onChange: saveAgentFiles
              }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
            )
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-agent-file-names' }, 'File names to look for'),
              h('div', { class: 'settings-project__item-note' },
                'One file name per line, relative to the project root. Leave empty to use the defaults (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md).'
              )
            ),
            h('textarea', {
              ref: agentFileNames,
              class: 'input settings-project__mono',
              id: 'sp-agent-file-names',
              rows: 3,
              spellcheck: false,
              placeholder: 'AGENTS.md\nCLAUDE.md\n.github/copilot-instructions.md',
              onInput: function () { saveAgentFilesDebounced.current(); }
            })
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
