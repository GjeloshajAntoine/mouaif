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
import { sectionIcon, segMode, toolModeSegs } from './settingsProjectUi.js';
import { McpAuthSeg } from './settings/toolAuth.js';
import { AgentFilePicker } from './AgentFilePicker.jsx';

export function SettingsProjectView({ projectDir: initialDir, chatId: initialChatId, page = 'main' } = {}) {
  const statusEl = useRef(null);
  const pathEl = useRef(null);
  // Structured controls
  const promptSizeSel = useRef(null);
  const promptSizeStatus = useRef(null);
  // Tool output profile (size / structure). Set during load() from the
  // resolved settings so the File tool options page has defaults even
  // when the project never set a toolOutput key.
  const outputSizeSel = useRef(null);
  const outputStructureSel = useRef(null);
  const outputStatus = useRef(null);
  const outputJson = useRef(null);
  const [traceCardVisible, setTraceCardVisible] = useState(!!(initialChatId && initialChatId.trim()));
  const chatTraceToggle = useRef(null);
  const chatTraceStatus = useRef(null);
  const exportTraceBtn = useRef(null);
  const exportTraceStatus = useRef(null);
  // Tool permissions live in state (not refs) so the segmented
  // Off/Ask/Allow control re-renders when the user taps a segment.
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
  // MCP authorization (layered, decisions §18) + the configured server
  // list. The tree shows the shared gate ("MCP default") and one
  // Off/Ask/Allow row per server; the maps mirror GET
  // /api/tools/authorization so every configured override renders.
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [mcpAuthStatusMsg, setMcpAuthStatusMsg] = useState('');
  const [mcpServers, setMcpServers] = useState([]);
  const agentFilesStatus = useRef(null);
  const agentFilesToggle = useRef(null);
  const agentFileNames = useRef(null);
  // Agent file picker overlay (browse + append a project-relative path).
  const [agentFilePickerOpen, setAgentFilePickerOpen] = useState(false);
  const skillsToggle = useRef(null);
  const disabledSkills = useRef(null);
  const skillsStatus = useRef(null);
  const promptsCard = useRef(null);
  const promptsSummary = useRef(null);
  const mcpCard = useRef(null);
  const mcpSummary = useRef(null);
  // Agents — subagent delegation personas (list + inline create only;
  // editing happens in SettingsAgents.jsx)
  const [agentPresets, setAgentPresets] = useState([]);
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

  // The loaded project settings. Held in a ref (not a render-local
  // `let`) so async reads after any re-render see the latest value
  // instead of a freshly-reset `{}`.
  const currentProject = useRef({});
  const loadedDir = useRef('');
  const loadedChatId = useRef((initialChatId || '').trim());

  function dir() { return loadedDir.current; }
  function chatId() { return loadedChatId.current; }

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
    currentProject.current = projRes.body.project || {};
    // Make the loaded project the active one for downstream views.
    setActiveProject(d, '');
    if (pathEl.current) pathEl.current.textContent = projRes.body.path || d;
    if (promptsCard.current) promptsCard.current.href = '#/settings/prompts?projectDir=' + encodeURIComponent(d);
    if (mcpCard.current) mcpCard.current.href = '#/settings/mcp?projectDir=' + encodeURIComponent(d);

    // Prompt size (project override; '' means "inherit app default").
    if (promptSizeSel.current) {
      promptSizeSel.current.value = (currentProject.current.promptSize && String(currentProject.current.promptSize)) || '';
      promptSizeSel.current.disabled = false;
    }
    if (promptSizeStatus.current) promptSizeStatus.current.textContent = '';

    // Tool output profile. The source of truth is the *resolved*
    // settings (defaults → app → project), so an empty project still
    // gets a working default and a project override shows through.
    const resolved = (resolvedRes.status === 200 && resolvedRes.body && resolvedRes.body.resolved) || {};
    const to = (resolved && resolved.toolOutput && typeof resolved.toolOutput === 'object') ? resolved.toolOutput : {};
    const outSize = (to && to.size) || 'average';
    const outStruct = (to && to.structure) || 'full';
    if (outputSizeSel.current) {
      outputSizeSel.current.value = outSize;
      outputSizeSel.current.disabled = false;
    }
    if (outputStructureSel.current) {
      outputStructureSel.current.value = outStruct;
      outputStructureSel.current.disabled = false;
    }
    if (outputJson.current) {
      const show = { size: outSize, structure: outStruct };
      outputJson.current.textContent = JSON.stringify(show, null, 2);
    }
    if (outputStatus.current) outputStatus.current.textContent = '';

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
      // MCP: the shared gate (layers 3-4) + the persisted per-server /
      // per-tool override maps. `servers`/`tools` mirror what's in
      // .mcp.json so rows render even for stopped servers.
      const mcp = authz.status === 200 && authz.body && authz.body.mcp;
      setMcpAuth({
        mode: (mcp && mcp.mode) || 'ask',
        allowlist: mcp && Array.isArray(mcp.allowlist) ? mcp.allowlist : [],
        servers: (mcp && mcp.servers && typeof mcp.servers === 'object') ? mcp.servers : {},
        tools: (mcp && mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {}
      });
      setMcpAuthStatusMsg('');
    } catch { /* keep ask + empty allowlist */ }

    // Load the tools catalog for the visibility tree. This is the
    // same data the chat view uses, so the settings page shows the
    // same hierarchical checkbox list.
    try {
      const toolsRes = await fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(d));
      if (toolsRes.status === 200 && Array.isArray(toolsRes.body.tools)) {
        setToolsCatalog(toolsRes.body.tools);
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
      if (mr.status === 200 && Array.isArray(mr.body.servers)) setMcpServers(mr.body.servers);
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
      const on = currentProject.current.agentFiles === true;
      agentFilesToggle.current.checked = on;
      agentFilesToggle.current.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (agentFileNames.current) {
      agentFileNames.current.value = Array.isArray(currentProject.current.agentFileNames)
        ? currentProject.current.agentFileNames.join('\n')
        : '';
    }
    if (skillsToggle.current) skillsToggle.current.checked = currentProject.current.skills !== false;
    if (disabledSkills.current) disabledSkills.current.value = Array.isArray(currentProject.current.disabledSkills)
      ? currentProject.current.disabledSkills.join('\n') : '';

    // Advanced: raw project file + resolved object.
    if (editor.current) editor.current.value = JSON.stringify(currentProject.current, null, 2);
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
    currentProject.current = r.body.project || Object.assign({}, currentProject.current, patch);
    if (editor.current) editor.current.value = JSON.stringify(currentProject.current, null, 2);
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
      currentProject.current = r.body.project || {};
      if (editor.current) editor.current.value = JSON.stringify(currentProject.current, null, 2);
      if (promptSizeStatus.current) promptSizeStatus.current.textContent = 'following the app default';
    } else if (promptSizeStatus.current) {
      promptSizeStatus.current.textContent = 'HTTP ' + r.status;
    }
  }

  // Save the tool output profile (size / structure) into .mouaif.json
  // key `toolOutput`. Both selects read from the resolved value, but the
  // stored project key holds the whole { size, structure } object so a
  // change to one keeps the other. The handler reads the sibling select's
  // live value to merge.
  async function saveToolOutput() {
    const size = outputSizeSel.current ? outputSizeSel.current.value : 'average';
    const structure = outputStructureSel.current ? outputStructureSel.current.value : 'full';
    if (outputStatus.current) outputStatus.current.textContent = 'saving…';
    const ok = await patchProject({ toolOutput: { size, structure } }, outputStatus, 'saved');
    if (ok && outputJson.current) {
      outputJson.current.textContent = JSON.stringify({ size, structure }, null, 2);
    }
  }
  function onOutputSize() { saveToolOutput(); }
  function onOutputStructure() { saveToolOutput(); }

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
  // control saves immediately on tap.
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

  // ---- MCP authorization ----------------------------------------
  // The shared MCP fallback gate lives under `mcp.mode` in the
  // authorization payload (not `tools.mcp`), so it gets its own save
  // path. Per-server overrides write `mcp.servers.<slug>` instead
  // (decisions §18: tool → server → project gate → app gate).
  async function saveMcpAuthorization(patch) {
    setMcpAuthStatusMsg('saving…');
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), mcp: patch })
    });
    if (r.status === 200) {
      setMcpAuthStatusMsg('saved');
      const m = r.body && r.body.mcp;
      if (m) {
        setMcpAuth((prev) => ({
          mode: (m && m.mode) || prev.mode,
          allowlist: m && Array.isArray(m.allowlist) ? m.allowlist : prev.allowlist,
          servers: (m && m.servers && typeof m.servers === 'object') ? m.servers : prev.servers,
          tools: (m && m.tools && typeof m.tools === 'object') ? m.tools : prev.tools
        }));
      }
    } else {
      setMcpAuthStatusMsg('HTTP ' + r.status);
    }
  }

  // Shared gate: picking Allow clears the patterns; Ask keeps them
  // (the McpAuthSeg normalizes ask+patterns to allowlist mode, but
  // direct calls from the checkbox path pass a plain mode).
  function pickMcpMode(newMode) {
    const allowlist = newMode === 'allow' ? [] : mcpAuth.allowlist;
    setMcpAuth(Object.assign({}, mcpAuth, { mode: newMode, allowlist }));
    saveMcpAuthorization({ mode: newMode, allowlist });
  }

  // Per-server override: 'allow' clears the server's patterns; any
  // other mode keeps them so an ask→off→ask round-trip survives.
  function pickServerAuthMode(slug, newMode) {
    const servers = Object.assign({}, mcpAuth.servers);
    const prev = servers[slug];
    servers[slug] = {
      mode: newMode,
      allowlist: newMode === 'allow' ? [] : (prev && Array.isArray(prev.allowlist) ? prev.allowlist : [])
    };
    setMcpAuth(Object.assign({}, mcpAuth, { servers }));
    saveMcpAuthorization({ servers: { [slug]: servers[slug] } });
  }

  // Clearing an override (null patch) restores inheritance: the shared
  // gate applies again.
  function clearServerAuthMode(slug) {
    const servers = Object.assign({}, mcpAuth.servers);
    delete servers[slug];
    setMcpAuth(Object.assign({}, mcpAuth, { servers }));
    saveMcpAuthorization({ servers: { [slug]: null } });
  }

  // Quick Off/Ask toggle for a per-server MCP override (the group
  // checkbox is the same shortcut the "MCP default" gate and native
  // groups use: check -> ask, uncheck -> off). The server itself is
  // always on — there is no separate enable flag.
  function toggleMcpServerAuth(slug, checked) {
    if (checked) {
      const servers = Object.assign({}, mcpAuth.servers);
      delete servers[slug];
      setMcpAuth(Object.assign({}, mcpAuth, { servers }));
      saveMcpAuthorization({ servers: { [slug]: null } });
      setMcpAuthStatusMsg('server override cleared (defaults to ' + segMode(mcpAuth.mode || 'ask') + ')');
    } else {
      pickServerAuthMode(slug, 'off');
      setMcpAuthStatusMsg('server override off');
    }
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
      currentProject.current = r.body.project || Object.assign({}, currentProject.current, patch);
      if (editor.current) editor.current.value = JSON.stringify(currentProject.current, null, 2);
      if (agentFilesStatus.current) agentFilesStatus.current.textContent = 'saved';
    } else if (agentFilesStatus.current) {
      agentFilesStatus.current.textContent = 'HTTP ' + r.status;
    }
  }
  async function saveSkills() {
    const ids = ((disabledSkills.current && disabledSkills.current.value) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    await patchProject({ skills: skillsToggle.current ? !!skillsToggle.current.checked : true, disabledSkills: ids }, skillsStatus, 'saved');
  }

  // Agent file picker: append a picked file's project-relative path to
  // the "File names to look for" textarea (deduped), then autosave.
  function onAgentFilePicked(relPath) {
    if (!relPath || !agentFileNames.current) { setAgentFilePickerOpen(false); return; }
    const current = (agentFileNames.current.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!current.includes(relPath)) current.push(relPath);
    agentFileNames.current.value = current.join('\n');
    setAgentFilePickerOpen(false);
    saveAgentFiles();
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
    if (editor.current) editor.current.value = JSON.stringify(currentProject.current, null, 2);
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

  // Build tool groups for the settings tree. Each group row carries
  // its authorization segment as an inline control on the same
  // line; the parent checkbox is a shortcut for Off ↔ Ask (the
  // "disabled / enabled" toggle). Full Off/Ask/Allow still lives in
  // the segment — the checkbox never blocks it.
  function buildSettingsToolGroups(catalog) {
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
        extra: shellStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, shellStatusMsg) : null
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
        extra: fileStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, fileStatusMsg) : null
      });
    }

    // ---- MCP authorization (layered, decisions §18) --------------
    // The shared gate row ("MCP default") is the project-wide fallback
    // for every MCP call; each configured server gets its own row with
    // an Off/Ask/Allow segment for the per-server override. The group
    // checkbox is that override's Off ↔ Ask shortcut, matching the
    // shared gate and the native tool groups. The server itself is
    // always on. Per-tool overrides stay in the server editor's
    // "Discovered tools" section.
    const servers = (mcpServers || []).filter((s) => s && s.id);
    if (servers.length) {
      groups.push({
        id: 'mcp',
        name: 'MCP default',
        description: 'gate for MCP servers without an override',
        checked: (mcpAuth.mode || 'ask') !== 'off',
        control: h(McpAuthSeg, {
          name: 'MCP default',
          slug: null,
          servers: mcpAuth.servers,
          shared: mcpAuth,
          namePrefix: 'sp-mcp',
          onSave: (patch) => {
            if (!patch) return;
            const mode = patch.mode || 'ask';
            const allowlist = Array.isArray(patch.allowlist) ? patch.allowlist : [];
            setMcpAuth(Object.assign({}, mcpAuth, { mode, allowlist }));
            saveMcpAuthorization({ mode, allowlist });
          }
        }),
        tools: [],
        extra: mcpAuthStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, mcpAuthStatusMsg) : null
      });

      for (const server of servers) {
        const slug = server.slug || server.id;
        const entry = mcpAuth.servers && mcpAuth.servers[slug];
        const overridden = !!(entry && entry.mode);
        const effMode = overridden ? entry.mode : (mcpAuth.mode || 'ask');
        const toolCount = (Array.isArray(server.tools) ? server.tools.length : 0)
          || (toolsCatalog || []).filter((t) => t && t.kind === 'mcp' && t.source === slug).length;
        groups.push({
          id: 'mcp-' + server.id,
          name: server.name || server.id,
          description: (server.status || 'stopped') + (toolCount ? ' · ' + toolCount + (toolCount === 1 ? ' tool' : ' tools') : '')
            + (overridden ? ' · override: ' + segMode(effMode) : ' · default (' + segMode(effMode) + ')'),
          checked: effMode !== 'off',
          control: h(McpAuthSeg, {
            name: server.name || server.id,
            slug,
            servers: mcpAuth.servers,
            shared: mcpAuth,
            namePrefix: 'sp-mcp',
            onSave: (patch) => {
              if (!patch || !patch.servers) return;
              const key = Object.keys(patch.servers)[0];
              const val = patch.servers[key];
              if (val == null) clearServerAuthMode(key);
              else {
                const serversNext = Object.assign({}, mcpAuth.servers);
                serversNext[key] = val;
                setMcpAuth(Object.assign({}, mcpAuth, { servers: serversNext }));
                saveMcpAuthorization({ servers: { [key]: val } });
              }
            }
          }),
          tools: [],
          extra: null
        });
      }
    }

    return groups;
  }

  // Checkbox on a settings group = enabled/disabled shortcut:
  //   uncheck -> save mode 'off'
  //   check   -> save mode 'ask' (the safe default)
  // The segment remains the only way to pick 'allow'.
  // MCP groups: the shared gate checkbox is Off ↔ Ask of `mcp.mode`;
  // a per-server group checkbox is that server's override Off ↔ Ask,
  // matching the shared gate and the native tool groups.
  function toggleSettingsGroup(groupId, checked) {
    const mode = checked ? 'ask' : 'off';
    if (groupId === 'shell') pickShellMode(mode);
    else if (groupId === 'subagent') pickSubagentMode(mode);
    else if (groupId === 'task') pickTaskMode(mode);
    else if (groupId === 'report_progress') pickProgressMode(mode);
    else if (groupId === 'ask_user') pickAskUserMode(mode);
    else if (groupId === 'files') pickFileMode(mode);
    else if (groupId === 'mcp') pickMcpMode(mode);
    else if (groupId.startsWith('mcp-')) toggleMcpServerAuth(groupId.slice(4), checked);
  }

  // ---- Agent handlers -------------------------------------------------

  // Agent editing lives in SettingsAgents.jsx (#/settings/agents/<name>);
  // this page only lists agents and creates new ones.

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
    // Jump straight into the full editor for the new agent.
    if (created) nav('settings/agents/' + encodeURIComponent(created) + '?projectDir=' + encodeURIComponent(dir()));
  }

  if (page === 'output') return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project?projectDir=' + encodeURIComponent(dir() || initialDir || ''), class: 'view-back', 'aria-label': 'Back to project settings' }, '←'),
      h('h2', { class: 'view-title' }, 'File tool options')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'Tool output')
        ),
        h('p', { class: 'hint hint--compact' }, 'How much of a tool result the model sees, and how the result is structured. Applies to file tools and all native/MCP tool output.')
      ),
      h('ul', { class: 'group__list' },
        // Output size — mirrors the Prompt style select (very-small /
        // average / extensive), stranded at "average" so a small result
        // stays token-frugal while a full read still gets through.
        h('li', { class: 'settings-project__item' },
          h('div', { class: 'settings-project__item-main' },
            h('label', { class: 'settings-project__item-title', for: 'sp-output-size' }, 'Output size'),
            h('div', { class: 'settings-project__item-note' }, 'How much of a tool result the model sees before truncation.'),
            h('div', { ref: outputStatus, class: 'settings-project__item-status', 'aria-live': 'polite' }, '')
          ),
          h('select', { ref: outputSizeSel, class: 'input settings-project__select', id: 'sp-output-size', disabled: true, onChange: onOutputSize },
            h('option', { value: 'very-small' }, 'Very small — a quarter of the cap'),
            h('option', { value: 'average' }, 'Average — the standard cap (default)'),
            h('option', { value: 'full' }, 'Full — up to four times the cap'),
            h('option', { value: 'extensive' }, 'Extensive — never truncate')
          )
        ),
        // Structure — how the result body is laid out for the model.
        // `full` keeps the raw body; `concise` re-serializes JSON to a
        // single line and collapses blank runs in plain text, so the
        // same content costs fewer tokens before the size cap applies.
        h('li', { class: 'settings-project__item' },
          h('div', { class: 'settings-project__item-main' },
            h('label', { class: 'settings-project__item-title', for: 'sp-output-structure' }, 'Output structure'),
            h('div', { class: 'settings-project__item-note' }, 'How the result body is arranged for the model.'),
            h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, '')
          ),
          h('select', { ref: outputStructureSel, class: 'input settings-project__select', id: 'sp-output-structure', disabled: true, onChange: onOutputStructure },
            h('option', { value: 'full' }, 'Full — keep the raw body'),
            h('option', { value: 'concise' }, 'Concise — compact JSON, no blank runs')
          )
        )
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Stored value'),
        h('p', { class: 'hint hint--compact' }, 'Written to ', h('code', null, '.mouaif.json'), ' under ', h('code', null, 'toolOutput'), '. Leave a control to inherit the app default.'),
        h('pre', { ref: outputJson, class: 'settings__out' }, '')
      )
    )
  );

  if (page === 'technical') return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project?projectDir=' + encodeURIComponent(dir() || initialDir || ''), class: 'view-back', 'aria-label': 'Back to project settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Technical details')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Raw project file'),
        h('p', { class: 'hint hint--compact' }, 'Hand-edit ', h('code', null, '.mouaif.json'), '. The main settings page writes the same file.'),
        h('textarea', { ref: editor, class: 'input settings-project__code', id: 'sp-project-editor', rows: 10, spellcheck: false }),
        h('div', { class: 'row row--actions' },
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: saveRaw, disabled: true }, 'Save file'),
          h('button', { ref: revertBtn, class: 'btn', type: 'button', onClick: revertRaw, disabled: true }, 'Revert'),
          h('span', { ref: editorStatus, class: 'status', 'aria-live': 'polite' })
        )
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Resolved settings'),
        h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. Provider keys are redacted.'),
        h('pre', { ref: resolvedOut, class: 'settings__out' })
      )
    )
  );

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: chatId() ? ('#/chat/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(dir() || initialDir || '')) : '#/settings', class: 'view-back', 'aria-label': chatId() ? 'Back to chat' : 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Project settings')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'settings-project__intro' },
        h('div', { class: 'settings-project__intro-top' },
          h('p', { class: 'settings-project__path' }, h('code', { ref: pathEl }, '…')),
          h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
        ),
        h('p', { class: 'settings-project__lede' }, 'Only for this project — everything saves automatically.')
      ),
      // ---- Project overrides ------------------------------------------
      // Settings that live in .mouaif.json and win over the app-level
      // value for this folder only (decisions §2). The select's "Inherit
      // app default" option is the visible end of the resolution chain.
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('general'),
          h('span', null, 'General'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About these settings' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Settings here live in ', h('code', null, '.mouaif.json'), ' and override the app-level defaults for this folder only. Leave a control untouched to inherit the app default.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-prompt-size' }, 'Prompt style'),
              h('div', { class: 'settings-project__item-note' }, 'How much tool and instruction detail chats receive.'),
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
      h('div', { class: 'group settings-project__section', hidden: !traceCardVisible },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('chat'),
          h('span', null, 'Current chat'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About tracing' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Tracing appends this chat’s events to ', h('code', null, '.mouaif/traces/<chatId>.ndjson'), ' in the project so you can commit it alongside your code. “Export trace” writes the file once, on demand.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-row' },
              h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sp-chat-trace' }, 'Trace this chat'),
                h('div', { class: 'settings-project__item-note' }, 'Append this chat’s events to a trace file in the project.'),
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
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'Tools'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About tool permissions' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Each tool has three modes:'),
              h('ul', null,
                h('li', null, h('strong', null, 'Off'), ' — hidden from the model, zero prompt tokens.'),
                h('li', null, h('strong', null, 'Ask'), ' — you approve every call (the default).'),
                h('li', null, h('strong', null, 'Allow'), ' — calls run without asking.')
              ),
              h('p', null, 'The checkbox next to a group is a quick Off ↔ Ask toggle. Allowlists (regex patterns that skip the prompt) are still honored if set in the project file, but are edited from the raw JSON in Technical details.')
            )
          )
        ),
        h('div', { class: 'settings-project__tools-tree' },
          toolsCatalog.length
            ? h(ToolTree, {
                groups: buildSettingsToolGroups(toolsCatalog),
                onToggleGroup: toggleSettingsGroup,
                onToggleTool: (groupId, toolId, checked) => {
                  // MCP server rows carry no leaf tools here (per-tool
                  // overrides live in the server editor's "Discovered
                  // tools"); the row checkbox is the server enable, so
                  // there is nothing to toggle per tool.
                  if (!groupId.startsWith('mcp-')) toggleSettingsGroup(groupId, checked);
                },
                collapsedByDefault: true
              })
            : h('div', { class: 'settings-project__item-note' }, 'Loading tools…')
        ),
        h('a', {
          class: 'group__row settings-project__link-row settings-project__options-link',
          'aria-label': 'File tool options',
          href: '#/settings/project/output?projectDir=' + encodeURIComponent(dir())
        },
          h('span', { class: 'group__row-body' },
            h('span', { class: 'group__row-label' }, 'File tool options'),
            h('span', { class: 'settings-project__link-sub' }, 'Output size, structure, and the JSON value')
          ),
          h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
        )
      ),

      // ---- Agent files ------------------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('files'),
          h('span', null, 'Agent files'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About agent files' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Agent files are markdown files at the project root that get injected into the model’s context at the start of every chat. Use them for project conventions, architecture notes, or standing instructions. A chat can still opt out individually.')
            )
          )
        ),
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
              h('label', { class: 'settings-project__item-title', for: 'sp-skills' }, 'Skills'),
              h('div', { class: 'settings-project__item-note' }, 'Inject .agents/skills/*/SKILL.md files. Disable the family here or in the chat Tools popup. ', h('span', { ref: skillsStatus, class: 'settings-project__item-status' }))
            ),
            h('label', { class: 'switch' },
              h('input', { ref: skillsToggle, id: 'sp-skills', type: 'checkbox', role: 'switch', onChange: saveSkills }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
            )
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-disabled-skills' }, 'Disabled skills'),
              h('div', { class: 'settings-project__item-note' }, 'One skill folder name per line. These skills stay disabled while other Agent files remain active.')
            ),
            h('textarea', { ref: disabledSkills, class: 'input settings-project__mono', id: 'sp-disabled-skills', rows: 3, spellcheck: false, placeholder: 'legacy-skill', onChange: saveSkills })
          ),
          h('li', { class: 'settings-project__tool' },
            h('div', { class: 'settings-project__tool-head' },
              h('label', { class: 'settings-project__item-title', for: 'sp-agent-file-names' }, 'File names to look for'),
              h('div', { class: 'settings-project__item-note' },
                'One file name per line, relative to the project root. Leave empty to use the defaults (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md).'
              )
            ),
            h('div', { class: 'settings-project__afn-row' },
              h('textarea', {
                ref: agentFileNames,
                class: 'input settings-project__mono settings-project__afn-text',
                id: 'sp-agent-file-names',
                rows: 3,
                spellcheck: false,
                placeholder: 'AGENTS.md\nCLAUDE.md\n.github/copilot-instructions.md',
                onInput: function () { saveAgentFilesDebounced.current(); }
              }),
              h('button', {
                class: 'btn btn--ghost settings-project__afn-pick',
                type: 'button',
                onClick: () => setAgentFilePickerOpen(true)
              }, 'Pick file…')
            )
          )
        )
      ),

      // ---- Agents -----------------------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('agents'),
          h('span', null, 'Agents'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About agents' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Agents are reusable sub-personas the main chat can delegate to. Each has its own name, instructions, an optional model override, and an optional tool allowlist (no allowlist = all tools). Tap an agent to edit it; edits save automatically.')
            )
          )
        ),
        h('div', { class: 'settings-project__agents' },
          agentPresets.length > 0 && h('ul', { class: 'settings-project__agents-list' },
            agentPresets.map(a => h('li', { key: a.name },
              h('a', {
                class: 'group__row settings-project__agent-link',
                href: '#/settings/agents/' + encodeURIComponent(a.name) + '?projectDir=' + encodeURIComponent(dir()),
                'aria-label': 'Configure ' + a.name
              },
                h('span', { class: 'group__row-body' },
                  h('span', { class: 'group__row-label' }, a.name),
                  h('span', { class: 'settings-project__link-sub' }, a.modelId || 'Inherits chat model')
                ),
                h('span', { class: 'group__row-detail' }, a.tools === undefined ? 'All tools' : (a.tools.length + (a.tools.length === 1 ? ' tool' : ' tools'))),
                h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
              )
            ))
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
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('more'),
          h('span', null, 'More settings')
        ),
        h('ul', { class: 'group__list' },
          h('li', null,
            h('a', {
              ref: mcpCard,
              class: 'group__row settings-project__link-row',
              'aria-label': 'MCP servers',
              href: '#/settings/mcp?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'MCP servers'),
                h('span', { class: 'settings-project__link-sub' }, 'Connect external tool servers')
              ),
              h('span', { ref: mcpSummary, class: 'group__row-detail' }, '—'),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
            h('a', {
              ref: promptsCard,
              class: 'group__row settings-project__link-row',
              'aria-label': 'Custom prompts',
              href: '#/settings/prompts?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'Custom prompts'),
                h('span', { class: 'settings-project__link-sub' }, 'Reusable system and role prompts')
              ),
              h('span', { ref: promptsSummary, class: 'group__row-detail' }, '—'),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
            h('a', {
              class: 'group__row settings-project__link-row',
              'aria-label': 'Import chats from JSON files',
              href: '#/settings/project/import?projectDir=' + encodeURIComponent(loadedDir.current || '')
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'Import chats'),
                h('span', { class: 'settings-project__link-sub' }, 'Reimport from .mouaif.messages.*.json files')
              ),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          )
        )
      ),

      // Technical information stays last and opens on a dedicated page.
      h('div', { class: 'group settings-project__section' },
        h('ul', { class: 'group__list' },
          h('li', null,
            h('a', {
              class: 'group__row settings-project__link-row',
              href: '#/settings/project/technical?projectDir=' + encodeURIComponent(dir())
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'Technical details'),
                h('span', { class: 'settings-project__link-sub' }, 'Raw project file and resolved settings')
              ),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          )
        )
      ),

      // Agent file picker overlay (browse the project and append a
      // relative path to the file-names list).
      agentFilePickerOpen && h(AgentFilePicker, {
        projectDir: dir(),
        onPick: onAgentFilePicked,
        onClose: () => setAgentFilePickerOpen(false)
      })
    )
  );
}
