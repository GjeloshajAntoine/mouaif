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
import { ToolTree, shortDesc } from './ToolTree.jsx';

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
  const [subagentAuth, setSubagentAuth] = useState({ mode: 'ask', allowlist: [] });
  const [progressAuth, setProgressAuth] = useState({ mode: 'ask', allowlist: [] });
  const [taskAuth, setTaskAuth] = useState({ mode: 'ask', allowlist: [] });
  const [askUserMode, setAskUserMode] = useState('ask');
  const [shellStatusMsg, setShellStatusMsg] = useState('');
  const [fileStatusMsg, setFileStatusMsg] = useState('');
  const [subagentStatusMsg, setSubagentStatusMsg] = useState('');
  const [progressStatusMsg, setProgressStatusMsg] = useState('');
  const [taskStatusMsg, setTaskStatusMsg] = useState('');
  const [askUserStatusMsg, setAskUserStatusMsg] = useState('');
  const [toolsCatalog, setToolsCatalog] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpServerAuth, setMcpServerAuth] = useState({});
  const agentFilesStatus = useRef(null);
  const agentFilesToggle = useRef(null);
  const agentFileNames = useRef(null);
  const promptsCard = useRef(null);
  const promptsSummary = useRef(null);
  const mcpCard = useRef(null);
  const mcpSummary = useRef(null);
  // Agents — subagent delegation personas (name + instructions + tools)
  const [agentPresets, setAgentPresets] = useState([]);
  const [agentPresetsOpened, setAgentPresetsOpened] = useState({}); // { [name]: true } for expanded editors
  const [agentCreating, setAgentCreating] = useState(false); // inline new-agent form visible
  const [agentCreateStatus, setAgentCreateStatus] = useState('');
  const newAgentName = useRef(null);
  const agentPresetsStatus = useRef(null);
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
    setSubagentStatusMsg('');
    setProgressStatusMsg('');
    setTaskStatusMsg('');
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
      const sub = authz.status === 200 && authz.body.tools && authz.body.tools.subagent;
      setSubagentAuth({
        mode: (sub && sub.mode) || 'ask',
        allowlist: sub && Array.isArray(sub.allowlist) ? sub.allowlist : []
      });
      const progress = authz.status === 200 && authz.body.tools && authz.body.tools.report_progress;
      setProgressAuth({
        mode: (progress && progress.mode) || 'ask',
        allowlist: progress && Array.isArray(progress.allowlist) ? progress.allowlist : []
      });
      const task = authz.status === 200 && authz.body.tools && authz.body.tools.task;
      setTaskAuth({
        mode: (task && task.mode) || 'ask',
        allowlist: task && Array.isArray(task.allowlist) ? task.allowlist : []
      });
      // ask_user is a binary { off, ask } tool. The server clamps any
      // legacy allowlist / allow value to `ask`; here we read what the
      // server says it is, and fall back to `ask` on the first load.
      const askUser = authz.status === 200 && authz.body.tools && authz.body.tools.ask_user;
      setAskUserMode((askUser && askUser.mode === 'off') ? 'off' : 'ask');
      // Per-server MCP authorization: load the servers map from the
      // MCP authorization block so each server row can show its
      // Off/Ask/Allow segment. Only the mode (not the allowlist) is
      // used here — allowlist editing is in the dedicated MCP page.
      const mcp = authz.status === 200 && authz.body.mcp;
      const servers = (mcp && mcp.servers && typeof mcp.servers === 'object') ? mcp.servers : {};
      setMcpServerAuth(servers);
    } catch { /* keep ask + empty allowlist */ }

    // Load the tools catalog for the visibility tree. This is the
    // same data the chat view uses, so the settings page shows the
    // same hierarchical checkbox list.
    try {
      const [toolsRes, mcpRes] = await Promise.all([
        fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(d)),
        fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(d))
      ]);
      if (toolsRes.status === 200 && Array.isArray(toolsRes.body.tools)) {
        setToolsCatalog(toolsRes.body.tools);
      }
      if (mcpRes.status === 200 && Array.isArray(mcpRes.body.servers)) {
        setMcpServers(mcpRes.body.servers);
      }
    } catch { /* keep empty catalog */ }

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

    // Agent presets.
    try {
      const ar = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(d));
      if (ar.status === 200) setAgentPresets(Array.isArray(ar.body.agents) ? ar.body.agents : []);
    } catch { /* keep empty list */ }

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
      if (promptSizeStatus.current) promptSizeStatus.current.textContent = 'following the app default';
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
  function pickSubagentMode(newMode) { pickToolMode('subagent', subagentAuth, setSubagentAuth, setSubagentStatusMsg, newMode); }
  function pickProgressMode(newMode) { pickToolMode('report_progress', progressAuth, setProgressAuth, setProgressStatusMsg, newMode); }
  function pickTaskMode(newMode) { pickToolMode('task', taskAuth, setTaskAuth, setTaskStatusMsg, newMode); }

  // Per-server MCP authorization (no allowlist — that's in the
  // dedicated MCP settings page). The segment writes the mode
  // directly to mcp.servers.<slug>.
  function pickServerMcpAuth(slug, newMode) {
    const patch = {};
    if (newMode === 'inherit') {
      patch[slug] = null;
    } else {
      patch[slug] = { mode: newMode };
    }
    setMcpServerAuth((prev) => {
      const next = Object.assign({}, prev);
      if (newMode === 'inherit') delete next[slug];
      else next[slug] = { mode: newMode };
      return next;
    });
    fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), mcp: { servers: patch } })
    });
  }

  // The shared MCP fallback gate lives under `mcp.mode` in the
  // authorization payload (not `tools.mcp`), so it gets its own save
  // path. Per-server overrides write `mcp.servers.<slug>` instead.
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
    if (seed) load(seed).catch((err) => setStatus(statusEl, 'load failed: ' + err.message, 'error'));
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

  // Build tool groups for the settings tree. Each group row carries
  // its authorization segment as an inline control on the same
  // line; the parent checkbox is a shortcut for Off ↔ Ask (the
  // "disabled / enabled" toggle). Full Off/Ask/Allow still lives in
  // the segment — the checkbox never blocks it.
  function buildSettingsToolGroups(catalog, mcpServers) {
    const groups = [];
    const isOn = (mode) => mode !== 'off';
    const leaf = (t, extra) => Object.assign({
      id: t.name,
      name: t.name,
      description: shortDesc(t.description),
      title: t.description || ''
    }, extra || {});

    const shellTool = catalog.find((t) => t.name === 'shell');
    if (shellTool) {
      groups.push({
        id: 'shell',
        name: 'Shell',
        description: shortDesc(shellTool.description),
        title: shellTool.description || '',
        checked: isOn(shellAuth.mode),
        control: toolModeSegs('Shell commands', segMode(shellAuth.mode), pickShellMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: [leaf(shellTool, { checked: isOn(shellAuth.mode) })],
        extra: segMode(shellAuth.mode) === 'ask'
          ? h('details', { class: 'settings-project__allowlist' },
              h('summary', null, shellAuth.allowlist.length ? ('Auto-approve list (' + shellAuth.allowlist.length + ')') : 'Auto-approve list'),
              h('p', { class: 'settings-project__help' }, 'Commands matching one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
              h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^npm test$\n^git status$`, value: shellAuth.allowlist.join('\n'), onInput: (e) => saveShellAllowlistDebounced.current(e.target.value) })
            )
          : (shellStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, shellStatusMsg) : null)
      });
    }

    const subTool = catalog.find((t) => t.name === 'subagent');
    if (subTool) {
      groups.push({
        id: 'subagent',
        name: 'Subagent',
        description: shortDesc(subTool.description),
        title: subTool.description || '',
        checked: isOn(subagentAuth.mode),
        control: toolModeSegs('Subagent', segMode(subagentAuth.mode), pickSubagentMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: [leaf(subTool, { checked: isOn(subagentAuth.mode) })],
        extra: subagentStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, subagentStatusMsg) : null
      });
    }

    const progressTool = catalog.find((t) => t.name === 'report_progress');
    if (progressTool) {
      groups.push({
        id: 'report_progress',
        name: 'Progress updates',
        description: shortDesc(progressTool.description),
        title: progressTool.description || '',
        checked: isOn(progressAuth.mode),
        control: toolModeSegs('Progress updates', segMode(progressAuth.mode), pickProgressMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: [leaf(progressTool, { checked: isOn(progressAuth.mode) })],
        extra: progressStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, progressStatusMsg) : null
      });
    }

    const taskTool = catalog.find((t) => t.name === 'task');
    if (taskTool) {
      groups.push({
        id: 'task',
        name: 'Task',
        description: shortDesc(taskTool.description),
        title: taskTool.description || '',
        checked: isOn(taskAuth.mode),
        control: toolModeSegs('Task', segMode(taskAuth.mode), pickTaskMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: [leaf(taskTool, { checked: isOn(taskAuth.mode) })],
        extra: taskStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, taskStatusMsg) : null
      });
    }

    const askTool = catalog.find((t) => t.name === 'ask_user');
    if (askTool) {
      groups.push({
        id: 'ask_user',
        name: 'Ask user',
        description: shortDesc(askTool.description),
        title: askTool.description || '',
        checked: isOn(askUserMode),
        control: toolModeSegs('Ask the user', askUserMode, pickAskUserMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' }
        ]),
        tools: [leaf(askTool, { checked: isOn(askUserMode) })],
        extra: askUserStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, askUserStatusMsg) : null
      });
    }

    const fileTools = catalog.filter((t) => t.kind === 'native' && t.source === 'files');
    if (fileTools.length) {
      groups.push({
        id: 'files',
        name: 'File tools',
        description: 'read, list, search, write, edit',
        checked: isOn(fileAuth.mode),
        control: toolModeSegs('File tools', segMode(fileAuth.mode), pickFileMode, [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: fileTools.map((t) => leaf(t, { checked: isOn(fileAuth.mode) })),
        extra: segMode(fileAuth.mode) === 'ask'
          ? h('details', { class: 'settings-project__allowlist' },
              h('summary', null, fileAuth.allowlist.length ? ('Auto-approve list (' + fileAuth.allowlist.length + ')') : 'Auto-approve list'),
              h('p', { class: 'settings-project__help' }, 'Paths matching one of these regexes open without asking; everything else still asks. One per line, auto-saves.'),
              h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^src/.*\\.js$\n^README\\.md$`, value: fileAuth.allowlist.join('\n'), onInput: (e) => saveFileAllowlistDebounced.current(e.target.value) })
            )
          : (fileStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, fileStatusMsg) : null)
      });
    }

    // One group per configured MCP server (enable checkbox), then
    // the shared MCP authorization gate. Servers render even when
    // stopped — the catalog only lists running servers, so fall
    // back to the cached tool list on the server record.
    const servers = (mcpServers || []).filter((s) => s && s.id);
    for (const server of servers) {
      const slug = server.slug || server.id;
      const prefix = 'mcp__' + slug + '__';
      let serverTools = catalog.filter((t) => t.kind === 'mcp' && t.source === slug);
      if (!serverTools.length && Array.isArray(server.tools)) {
        serverTools = server.tools.map((t) => {
          const name = typeof t === 'string' ? t : (t && t.name);
          if (!name) return null;
          return {
            name: name.startsWith(prefix) ? name : prefix + name,
            kind: 'mcp',
            source: slug,
            description: (t && t.description) || ''
          };
        }).filter(Boolean);
      }
      const off = server.enabled === false;
      const entry = mcpServerAuth[slug];
      const effMode = (entry && entry.mode) || 'ask';
      groups.push({
        id: 'mcp-' + server.id,
        name: server.name || server.id,
        description: server.status || 'stopped',
        checked: !off,
        control: toolModeSegs('mcp-server-' + slug, segMode(effMode), (mode) => pickServerMcpAuth(slug, mode), [
          { value: 'off', label: 'Off' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' }
        ]),
        tools: serverTools.map((t) => {
          const short = t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name;
          return leaf(t, { name: short, checked: !off, disabled: off });
        })
      });
    }

    return groups;
  }

  // Enable/disable one MCP server, then refresh the server list so
  // the tree picks up the new status + cached tools.
  async function toggleMcpServerEnabled(id, enabled) {
    const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), enabled })
    });
    if (r.status !== 200) return;
    const mr = await fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(dir()));
    if (mr.status === 200 && Array.isArray(mr.body.servers)) setMcpServers(mr.body.servers);
  }

  // Checkbox on a settings group = enabled/disabled shortcut:
  //   uncheck -> save mode 'off'
  //   check   -> save mode 'ask' (the safe default)
  // The segment remains the only way to pick 'allow'. MCP server
  // groups enable/disable the server itself instead.
  function toggleSettingsGroup(groupId, checked) {
    if (groupId.startsWith('mcp-')) { toggleMcpServerEnabled(groupId.slice(4), checked); return; }
    const mode = checked ? 'ask' : 'off';
    if (groupId === 'shell') pickShellMode(mode);
    else if (groupId === 'subagent') pickSubagentMode(mode);
    else if (groupId === 'task') pickTaskMode(mode);
    else if (groupId === 'report_progress') pickProgressMode(mode);
    else if (groupId === 'ask_user') pickAskUserMode(mode);
    else if (groupId === 'files') pickFileMode(mode);
    // MCP shared fallback authorization is managed in the dedicated
    // MCP settings page (#/settings/mcp), not here.
  }

  // ---- Agent handlers -------------------------------------------------

  // The tool allowlist choices shown on an agent's editor. Native tools
  // plus one entry per configured MCP server.
  const AGENT_TOOL_CHOICES = [
    { value: 'shell', label: 'shell' },
    { value: 'subagent', label: 'subagent' },
    { value: 'task', label: 'task' },
    { value: 'report_progress', label: 'report_progress' },
    { value: 'ask_user', label: 'ask_user' },
    { value: 'list_features', label: 'list_features' },
    { value: 'read_file', label: 'read_file' },
    { value: 'list_files', label: 'list_files' },
    { value: 'search_files', label: 'search_files' },
    { value: 'write_file', label: 'write_file' }
  ].concat(
    mcpServers.filter(s => s && s.id).map(s => ({
      value: 'mcp__' + (s.slug || s.id),
      label: 'MCP: ' + (s.name || s.id)
    }))
  );

  // Agents are subagent delegation personas: name + instructions +
  // an optional tool allowlist. All edits auto-save (same pattern as
  // the other settings on this page). Name is immutable after create.

  // Debounced per-agent saver for the instructions textarea.
  const agentSaveTimers = useRef({});
  function saveAgentSoon(name, patch, delay) {
    const timers = agentSaveTimers.current;
    if (timers[name]) clearTimeout(timers[name]);
    setAgentStatus(name, '…');
    timers[name] = setTimeout(() => saveAgent(name, patch), delay == null ? 350 : delay);
  }
  function setAgentStatus(name, msg) {
    const el = document.querySelector('[data-agent-status="' + name + '"]');
    if (el) el.textContent = msg;
  }
  async function saveAgent(name, patch) {
    setAgentStatus(name, 'saving…');
    const r = await fetchJson('/api/agents/' + encodeURIComponent(name), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir() }, patch))
    });
    setAgentStatus(name, r.status === 200 ? 'saved' : ('HTTP ' + r.status));
    if (r.status === 200) {
      setAgentPresets((prev) => prev.map((a) => a.name === name ? Object.assign({}, a, r.body.agent || patch) : a));
    }
  }

  function onAgentContentInput(name, value) {
    setAgentPresets((prev) => prev.map((a) => a.name === name ? Object.assign({}, a, { content: value }) : a));
    saveAgentSoon(name, { content: value });
  }

  function onAgentToolToggle(name, tool, checked) {
    const agent = agentPresets.find((a) => a.name === name);
    if (!agent) return;
    const current = Array.isArray(agent.tools) ? agent.tools.slice() : null;
    let next;
    if (current == null) {
      // Was inheriting all tools; unchecking one builds an explicit list.
      const all = AGENT_TOOL_CHOICES.map((c) => c.value);
      next = checked ? all : all.filter((t) => t !== tool);
    } else {
      next = checked ? current.concat(tool) : current.filter((t) => t !== tool);
    }
    // De-dupe, and collapse back to "inherit" when everything is on.
    next = Array.from(new Set(next));
    const full = next.length >= AGENT_TOOL_CHOICES.length;
    const tools = full ? [] : next;
    setAgentPresets((prev) => prev.map((a) => a.name === name ? Object.assign({}, a, { tools: tools.length ? tools : undefined }) : a));
    saveAgent(name, { tools });
  }

  function openAgentCreator() {
    setAgentCreateStatus('');
    setAgentCreating(true);
    // Focus the name field after the form mounts.
    setTimeout(() => { if (newAgentName.current) newAgentName.current.focus(); }, 0);
  }

  async function addAgentPreset() {
    const name = (newAgentName.current && newAgentName.current.value || '').trim();
    if (!name) { setAgentCreateStatus('Name is required'); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      setAgentCreateStatus('Letters, digits, . _ - only; must start with a letter or digit');
      return;
    }
    setAgentCreateStatus('creating…');
    const r = await fetchJson('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), name, content: '' })
    });
    if (r.status !== 201) {
      setAgentCreateStatus(r.body && r.body.error ? r.body.error : ('Create failed: HTTP ' + r.status));
      return;
    }
    const created = r.body.agent && r.body.agent.name;
    setAgentCreating(false);
    setAgentCreateStatus('');
    setAgentPresets((prev) => prev.concat(r.body.agent));
    if (created) setAgentPresetsOpened(p => Object.assign({}, p, { [created]: true }));
  }

  async function deleteAgentPreset(name) {
    if (!confirm('Delete agent "' + name + '"?')) return;
    const r = await fetchJson('/api/agents/' + encodeURIComponent(name) + '?projectDir=' + encodeURIComponent(dir()), { method: 'DELETE' });
    if (r.status === 200) {
      setAgentPresets((prev) => prev.filter((a) => a.name !== name));
    }
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
        h('p', { class: 'settings-project__lede' }, 'Saved in ', h('code', null, '.mouaif.json'), ', committed with the project. Anything left on its default here follows the app-level setting.'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      // ---- Project overrides ------------------------------------------
      // Settings that live in .mouaif.json and win over the app-level
      // value for this folder only (decisions §2). The select's "Inherit
      // app default" option is the visible end of the resolution chain.
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Chat defaults', h('span', { class: 'group__title-note' }, 'For chats in this project')),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-prompt-size' }, 'Default prompt style'),
              h('div', { class: 'settings-project__item-note' }, 'How much tool schema and instruction text new chats get. Smaller = faster, less context used. A single chat can still pick its own.'),
              h('div', { ref: promptSizeStatus, class: 'settings-project__item-status', 'aria-live': 'polite' }, 'Following the app default until you change it here')
            ),
            h('select', { ref: promptSizeSel, class: 'input settings-project__select', id: 'sp-prompt-size', disabled: true, onChange: onPromptSize },
              h('option', { value: '' }, 'Inherit app default'),
              h('option', { value: 'very-small' }, 'Very small — tool names only, no schemas'),
              h('option', { value: 'average' }, 'Average — full tools, recommended'),
              h('option', { value: 'extensive' }, 'Extensive — full tools + best-practice guidance')
            )
          )
        )
      ),

      // ---- This chat --------------------------------------------------
      // Actions that apply to the chat the user came from (?chatId=…),
      // not to the project. Split out of the overrides group so the two
      // scopes are not confused. Hidden when there is no chat in context.
      h('div', { class: 'group', hidden: !traceCardVisible },
        h('div', { class: 'group__title' }, 'This chat', h('span', { class: 'group__title-note' }, 'Only the chat you came from')),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
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
      // One tree, same look as the chat view: each group row carries
      // its enable checkbox AND its Off/Ask/Allow authorization
      // segment on the same line. Only the checkbox / segment are
      // click targets; the row text is inert.
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Tools', h('span', { class: 'group__title-note' }, 'Visibility + authorization per project')),
        h('div', { class: 'settings-project__tools-tree' },
          toolsCatalog.length
            ? h(ToolTree, {
                groups: buildSettingsToolGroups(toolsCatalog, mcpServers),
                onToggleGroup: toggleSettingsGroup,
                onToggleTool: (groupId) => toggleSettingsGroup(groupId, true),
                collapsedByDefault: true
              })
            : h('div', { class: 'settings-project__item-note' }, 'Loading tools…')
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

      // ---- Agents -----------------------------------------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Agents', h('span', { class: 'group__title-note' }, 'Subagent delegation personas')),
        h('p', { class: 'settings-project__help' }, 'Named personas the subagent tool can delegate to. Changes save automatically.'),
        h('div', { class: 'settings-project__agents' },
          agentPresets.length > 0 && h('ul', { class: 'settings-project__agents-list' },
            agentPresets.map(a => {
              const open = !!agentPresetsOpened[a.name];
              const restricted = Array.isArray(a.tools) && a.tools.length > 0;
              return h('li', { key: a.name, class: 'settings-project__agent-row' },
                h('div', { class: 'settings-project__agent-head' },
                  h('button', { type: 'button', class: 'settings-project__agent-chev' + (open ? ' is-open' : ''), onClick: () => setAgentPresetsOpened(p => Object.assign({}, p, { [a.name]: !open })), 'aria-label': open ? 'Collapse' : 'Expand', 'aria-expanded': String(open) }, '›'),
                  h('span', { class: 'settings-project__agent-title' }, a.name),
                  restricted
                    ? h('span', { class: 'settings-project__agent-tools-badge' }, a.tools.length + (a.tools.length === 1 ? ' tool' : ' tools'))
                    : h('span', { class: 'settings-project__agent-tools-badge' }, 'all tools'),
                  h('button', { type: 'button', class: 'btn btn--danger btn--sm settings-project__agent-del', onClick: () => deleteAgentPreset(a.name), 'aria-label': 'Delete' }, '×')
                ),
                open && h('div', { class: 'settings-project__agent-body' },
                  h('label', { class: 'row settings-project__agent-field' },
                    h('span', { class: 'label' }, 'Name'),
                    h('input', { class: 'input', value: a.name, disabled: true, 'aria-readonly': 'true' })
                  ),
                  h('label', { class: 'row settings-project__agent-field' },
                    h('span', { class: 'label' }, 'Instructions ' + (a.content ? a.content.length + ' chars' : '')),
                    h('textarea', { class: 'input settings-project__mono', rows: 4, value: a.content || '', onInput: e => onAgentContentInput(a.name, e.target.value), placeholder: 'You are an assistant who…' })
                  ),
                  h('div', { class: 'settings-project__agent-field' },
                    h('span', { class: 'label' }, 'Tools'),
                    h('div', { class: 'settings-project__agent-tools' },
                      AGENT_TOOL_CHOICES.map(choice =>
                        h('label', { key: choice.value, class: 'checkbox-row' },
                          h('input', { type: 'checkbox', class: 'checkbox', checked: !restricted || a.tools.includes(choice.value), onChange: e => onAgentToolToggle(a.name, choice.value, e.target.checked) }),
                          ' ' + choice.label
                        )
                      )
                    )
                  ),
                  h('div', { class: 'row row--actions' },
                    h('span', { 'data-agent-status': a.name, class: 'status' })
                  )
                )
              );
            })
          ),
          !agentCreating
            ? h('button', { type: 'button', class: 'btn btn--primary settings-project__add-agent', onClick: openAgentCreator }, '+ Add agent')
            : h('div', { class: 'settings-project__agent-create' },
                h('label', { class: 'row settings-project__agent-field' },
                  h('span', { class: 'label' }, 'Name'),
                  h('input', {
                    ref: newAgentName,
                    class: 'input',
                    placeholder: 'reviewer',
                    onKeyDown: (e) => { if (e.key === 'Enter') addAgentPreset(); if (e.key === 'Escape') setAgentCreating(false); }
                  })
                ),
                h('div', { class: 'row row--actions' },
                  h('button', { type: 'button', class: 'btn', onClick: () => setAgentCreating(false) }, 'Cancel'),
                  h('button', { type: 'button', class: 'btn btn--primary', onClick: addAgentPreset }, 'Create'),
                  h('span', { class: 'status', 'aria-live': 'polite' }, agentCreateStatus)
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
              class: 'group__row',
              'aria-label': 'MCP servers',
              href: '#/settings/mcp?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-label' }, 'MCP servers'),
              h('span', { ref: mcpSummary, class: 'group__row-detail' }, '—'),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
            h('a', {
              ref: promptsCard,
              class: 'group__row',
              'aria-label': 'Custom prompts',
              href: '#/settings/prompts?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-label' }, 'Custom prompts'),
              h('span', { ref: promptsSummary, class: 'group__row-detail' }, '—'),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
            h('a', {
              class: 'group__row',
              'aria-label': 'Import chats from JSON files',
              href: '#/settings/project/import?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-label' }, 'Import chats'),
              h('span', { class: 'group__row-detail' }, 'reimport from .mouaif.messages.*.json'),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
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
