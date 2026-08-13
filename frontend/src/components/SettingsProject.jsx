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
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, setActiveProject, activeProject, projectsReload, getProjectStorage, setProjectStorage } from '../api.js';
import { nav } from '../router.js';
import { ToolTree, shortDesc } from './ToolTree.jsx';
import { sectionIcon, segMode, toolModeSegs } from './settingsProjectUi.js';
import { McpAuthSeg } from './settings/toolAuth.js';
import { AgentFilePicker } from './AgentFilePicker.jsx';

export function SettingsProjectView({ projectDir: initialDir, chatId: initialChatId, page = 'main' } = {}) {
  const [globalStatus, setGlobalStatus] = useState({ text: '', state: '' });
  const [projectPath, setProjectPath] = useState('…');

  // Structured controls
  const [promptSize, setPromptSize] = useState('');
  const [promptSizeStatusMsg, setPromptSizeStatusMsg] = useState('Following the app default until you change it here');

  // Tool output profile. Two selects map directly to the backend
  // { size, structure } combo. Values are seeded during load() from the
  // resolved settings so the File tool options page has defaults even when
  // the project never set a toolOutput key.
  const [outputSize, setOutputSize] = useState('average');
  const [outputStructure, setOutputStructure] = useState('full');
  const [outputStatusMsg, setOutputStatusMsg] = useState('');

  // Backend-supported tool output dimensions. Keep these in sync with
  // src/toolFeedback.js so hand-edited .mouaif.json values stay visible in
  // the UI instead of being collapsed into a lossy preset.
  const OUTPUT_SIZES = {
    'very-small': { label: 'Very small — quarter cap' },
    average: { label: 'Average — standard cap (default)' },
    full: { label: 'Full — 4× cap' },
    extensive: { label: 'Extensive — never truncate' }
  };
  const OUTPUT_STRUCTURES = {
    full: { label: 'Raw — preserve body' },
    concise: { label: 'Concise — compact layout' }
  };
  function normalizeOutputSize(size) {
    return Object.prototype.hasOwnProperty.call(OUTPUT_SIZES, size) ? size : 'average';
  }
  function normalizeOutputStructure(structure) {
    return Object.prototype.hasOwnProperty.call(OUTPUT_STRUCTURES, structure) ? structure : 'full';
  }

  const [traceCardVisible, setTraceCardVisible] = useState(!!(initialChatId && initialChatId.trim()));
  const [chatTraceOn, setChatTraceOn] = useState(false);
  const [chatTraceStatusMsg, setChatTraceStatusMsg] = useState('');
  const [canExportTrace, setCanExportTrace] = useState(false);
  const [exportTraceStatusMsg, setExportTraceStatusMsg] = useState('');

  // Tool permissions live in state so the segmented
  // Off/Ask/Allow control re-renders when the user taps a segment.
  const [shellAuth, setShellAuth] = useState({ mode: 'ask', allowlist: [] });
  const [fileAuth, setFileAuth] = useState({ mode: 'ask', allowlist: [] });
  const [fileToolAuth, setFileToolAuth] = useState({});
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

  // MCP authorization
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [mcpAuthStatusMsg, setMcpAuthStatusMsg] = useState('');
  const [mcpServers, setMcpServers] = useState([]);

  const [agentFilesOn, setAgentFilesOn] = useState(false);
  const [agentFileNames, setAgentFileNames] = useState('');
  const [agentFilesStatusMsg, setAgentFilesStatusMsg] = useState('');

  // Agent file picker overlay
  const [agentFilePickerOpen, setAgentFilePickerOpen] = useState(false);
  const [skillsOn, setSkillsOn] = useState(true);
  const [skillsStatusMsg, setSkillsStatusMsg] = useState('');

  const [promptsSummaryMsg, setPromptsSummaryMsg] = useState('—');
  const [mcpSummaryMsg, setMcpSummaryMsg] = useState('—');

  // Agents
  const [agentPresets, setAgentPresets] = useState([]);
  const [agentCreating, setAgentCreating] = useState(false);
  const [agentCreateStatus, setAgentCreateStatus] = useState('');
  const [newAgentNameVal, setNewAgentNameVal] = useState('');

  // Advanced (raw JSON + resolved)
  const [editorText, setEditorText] = useState('{}');
  const [saveDisabled, setSaveDisabled] = useState(true);
  const [revertDisabled, setRevertDisabled] = useState(true);
  const [editorStatusMsg, setEditorStatusMsg] = useState('');
  const [resolvedOutText, setResolvedOutText] = useState('');
  const [dbBacked, setDbBacked] = useState(false);
  const [storageStatusMsg, setStorageStatusMsg] = useState('');

  const [currentProject, setCurrentProject] = useState({});
  const [loadedDir, setLoadedDir] = useState('');
  const [loadedChatId] = useState((initialChatId || '').trim());

  function dir() { return loadedDir; }
  function chatId() { return loadedChatId; }

  async function load(seedDir) {
    const d = (seedDir || '').trim();
    if (!d) { setGlobalStatus({ text: 'no project selected', state: 'error' }); return; }
    setLoadedDir(d);
    setGlobalStatus({ text: 'loading…', state: 'busy' });
    const [projRes, resolvedRes] = await Promise.all([
      fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(d)),
      fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(d))
    ]);
    if (projRes.status !== 200) {
      setGlobalStatus({ text: 'project: HTTP ' + projRes.status + (projRes.body && projRes.body.error ? ' ' + projRes.body.error : ''), state: 'error' });
      return;
    }
    const cp = projRes.body.project || {};
    setCurrentProject(cp);
    setActiveProject(d, '');
    setProjectPath(projRes.body.path || d);
    setDbBacked(projRes.body.dbBacked === true);

    setPromptSize((cp.promptSize && String(cp.promptSize)) || '');
    setPromptSizeStatusMsg('');

    const resolved = (resolvedRes.status === 200 && resolvedRes.body && resolvedRes.body.resolved) || {};
    const to = (resolved && resolved.toolOutput && typeof resolved.toolOutput === 'object') ? resolved.toolOutput : {};
    setOutputSize(normalizeOutputSize(to && to.size));
    setOutputStructure(normalizeOutputStructure(to && to.structure));
    setOutputStatusMsg('');

    setTraceCardVisible(!!chatId());
    setChatTraceStatusMsg('');
    setExportTraceStatusMsg('');
    if (chatId()) {
      try {
        const cr = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(d));
        if (cr.status === 200 && cr.body && cr.body.chat) {
          const on = cr.body.chat.trace === true;
          setChatTraceOn(on);
          setChatTraceStatusMsg(on ? 'trace on' : 'trace off');
          setCanExportTrace(true);
        } else {
          setChatTraceStatusMsg('chat not found');
          setCanExportTrace(false);
        }
      } catch {
        setChatTraceStatusMsg('failed to load chat');
        setCanExportTrace(false);
      }
    } else {
      setChatTraceStatusMsg('Open from a chat to edit trace.');
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
      setFileToolAuth(Object.fromEntries(
        ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].map((name) => [name, authz.status === 200 && authz.body.tools && authz.body.tools[name]])
      ));
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
      const askUser = authz.status === 200 && authz.body.tools && authz.body.tools.ask_user;
      setAskUserMode((askUser && askUser.mode === 'off') ? 'off' : 'ask');
      const mcp = authz.status === 200 && authz.body && authz.body.mcp;
      setMcpAuth({
        mode: (mcp && mcp.mode) || 'ask',
        allowlist: mcp && Array.isArray(mcp.allowlist) ? mcp.allowlist : [],
        servers: (mcp && mcp.servers && typeof mcp.servers === 'object') ? mcp.servers : {},
        tools: (mcp && mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {}
      });
      setMcpAuthStatusMsg('');
    } catch { /* keep ask + empty allowlist */ }

    try {
      const toolsRes = await fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(d));
      if (toolsRes.status === 200 && Array.isArray(toolsRes.body.tools)) {
        setToolsCatalog(toolsRes.body.tools);
      }
    } catch { /* keep empty catalog */ }

    setAgentFilesStatusMsg('');

    try {
      const mr = await fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(d));
      if (mr.status === 200) {
        const n = (mr.body.servers || []).length;
        setMcpSummaryMsg(n ? (n + (n === 1 ? ' server' : ' servers')) : 'no servers yet');
        if (Array.isArray(mr.body.servers)) setMcpServers(mr.body.servers);
      } else { setMcpSummaryMsg('—'); }
    } catch { setMcpSummaryMsg('—'); }

    try {
      const pr = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(d));
      if (pr.status === 200) {
        const n = (pr.body.prompts || []).length;
        setPromptsSummaryMsg(n ? (n + (n === 1 ? ' prompt' : ' prompts')) : 'no prompts yet');
      } else { setPromptsSummaryMsg('—'); }
    } catch { setPromptsSummaryMsg('—'); }

    try {
      const ar = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(d));
      if (ar.status === 200) setAgentPresets(Array.isArray(ar.body.agents) ? ar.body.agents : []);
    } catch { /* keep empty list */ }

    setAgentFilesOn(cp.agentFiles !== false);
    setAgentFileNames(Array.isArray(cp.agentFileNames) ? cp.agentFileNames.join('\n') : '');
    setSkillsOn(cp.skills !== false);

    setEditorText(JSON.stringify(cp, null, 2));
    setSaveDisabled(false);
    setRevertDisabled(false);
    if (resolvedRes.status === 200) {
      const redacted = JSON.parse(JSON.stringify(resolvedRes.body.resolved || {}));
      if (Array.isArray(redacted.providers)) {
        redacted.providers = redacted.providers.map((p) => {
          if (!p || typeof p !== 'object') return p;
          if (typeof p.apiKey === 'string') p.apiKey = p.apiKey ? '•••' : '';
          return p;
        });
      }
      setResolvedOutText(JSON.stringify(redacted, null, 2));
    }
    setGlobalStatus({ text: 'loaded', state: 'success' });
  }

  async function patchProject(patch, setStatusMsg, okMsg) {
    const d = dir();
    if (!d) { if (setStatusMsg) setStatusMsg('no project'); return false; }
    if (setStatusMsg) setStatusMsg('saving…');
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: d }, patch))
    });
    if (r.status !== 200) {
      if (setStatusMsg) setStatusMsg('HTTP ' + r.status);
      return false;
    }
    const nextProj = r.body.project || Object.assign({}, currentProject, patch);
    setCurrentProject(nextProj);
    setEditorText(JSON.stringify(nextProj, null, 2));
    if (setStatusMsg) setStatusMsg(okMsg || 'saved');
    return true;
  }

  async function onPromptSize(e) {
    const v = e && e.target ? e.target.value : '';
    setPromptSize(v);
    if (v) {
      await patchProject({ promptSize: v }, setPromptSizeStatusMsg, 'set to ' + v);
      return;
    }
    const d = dir();
    setPromptSizeStatusMsg('saving…');
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: d, unset: ['promptSize'] })
    });
    if (r.status === 200) {
      const nextProj = r.body.project || {};
      setCurrentProject(nextProj);
      setEditorText(JSON.stringify(nextProj, null, 2));
      setPromptSizeStatusMsg('following the app default');
    } else {
      setPromptSizeStatusMsg('HTTP ' + r.status);
    }
  }

  async function saveToolOutput(size, structure) {
    const nextSize = normalizeOutputSize(size);
    const nextStructure = normalizeOutputStructure(structure);
    setOutputSize(nextSize);
    setOutputStructure(nextStructure);
    setOutputStatusMsg('saving…');
    await patchProject({ toolOutput: { size: nextSize, structure: nextStructure } }, setOutputStatusMsg, 'saved');
  }
  function onOutputSize(e) {
    saveToolOutput(e && e.target ? e.target.value : outputSize, outputStructure);
  }
  function onOutputStructure(e) {
    saveToolOutput(outputSize, e && e.target ? e.target.value : outputStructure);
  }

  async function onChatTraceChange(e) {
    if (!chatId()) return;
    const want = !!e.target.checked;
    setChatTraceOn(want);
    setChatTraceStatusMsg('saving…');
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), trace: want })
    });
    if (r.status === 200) {
      const on = r.body && r.body.chat && r.body.chat.trace === true;
      setChatTraceOn(on);
      setChatTraceStatusMsg(on ? 'trace on' : 'trace off');
    } else {
      setChatTraceStatusMsg('HTTP ' + r.status);
      setChatTraceOn(!want);
    }
  }

  async function exportTrace() {
    if (!chatId()) return;
    setExportTraceStatusMsg('exporting trace…');
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '/trace/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir() })
    });
    setExportTraceStatusMsg(r.status === 200 ? ('exported: ' + r.body.path) : ('export failed: HTTP ' + r.status));
  }


  async function deleteChat() {
    if (!chatId()) return;
    if (!confirm('Delete this chat? Its messages will be removed; any exported trace file will be kept.')) return;
    setChatTraceStatusMsg('deleting chat…');
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(dir()), { method: 'DELETE' });
    if (r.status === 200) {
      projectsReload.value++;
      nav('projects');
    } else {
      setChatTraceStatusMsg('delete failed: HTTP ' + r.status);
    }
  }

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
    const allowlist = newMode === 'allow' ? [] : auth.allowlist;
    setAuth({ mode: newMode, allowlist });
    saveToolAuthorization(tool, newMode, allowlist, setStatusMsg);
  }
  function pickShellMode(newMode) { pickToolMode('shell', shellAuth, setShellAuth, setShellStatusMsg, newMode); }
  function pickFileMode(newMode) {
    const allowlist = newMode === 'allow' ? [] : fileAuth.allowlist;
    const next = { mode: newMode, allowlist };
    setFileAuth(next);
    // Effective leaf entries that inherit the family gate must move with it.
    // Keep only explicit project leaf overrides pinned to their own mode.
    setFileToolAuth((prev) => Object.fromEntries(Object.entries(prev).map(([name, auth]) => [
      name,
      auth && auth.source === 'project-tool' ? auth : Object.assign({}, next, { source: 'project' })
    ])));
    saveToolAuthorization('file', newMode, allowlist, setFileStatusMsg);
  }
  function pickFileToolMode(toolName, newMode) {
    const current = fileToolAuth[toolName] || fileAuth;
    const next = { mode: newMode, allowlist: newMode === 'allow' ? [] : (current.allowlist || []), source: 'project-tool' };
    setFileToolAuth((prev) => Object.assign({}, prev, { [toolName]: next }));
    saveToolAuthorization(toolName, next.mode, next.allowlist, setFileStatusMsg);
  }
  async function pickFileGroupMode(toolNames, newMode) {
    const allowlist = newMode === 'allow' ? [] : fileAuth.allowlist;
    const next = { mode: newMode, allowlist, source: 'project-tool' };
    setFileAuth((prev) => Object.assign({}, prev, { mode: newMode, allowlist }));
    setFileToolAuth((prev) => Object.assign({}, prev,
      Object.fromEntries(toolNames.map((name) => [name, next]))));
    setFileStatusMsg('saving…');
    const tools = Object.fromEntries(['file', ...toolNames].map((name) => [name, { mode: newMode, allowlist }]));
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools })
    });
    setFileStatusMsg(r.status === 200 ? 'saved' : ('HTTP ' + r.status));
  }
  function pickSubagentMode(newMode) { pickToolMode('subagent', subagentAuth, setSubagentAuth, setSubagentStatusMsg, newMode); }
  function pickProgressMode(newMode) { pickToolMode('report_progress', progressAuth, setProgressAuth, setProgressStatusMsg, newMode); }
  function pickTaskMode(newMode) { pickToolMode('task', taskAuth, setTaskAuth, setTaskStatusMsg, newMode); }

  function pickAskUserMode(newMode) {
    setAskUserMode(newMode);
    setAskUserStatusMsg('saving…');
    fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir(), tools: { ask_user: { mode: newMode, allowlist: [] } } })
    }).then((r) => setAskUserStatusMsg(r.status === 200 ? 'saved' : ('HTTP ' + r.status)));
  }

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

  function pickMcpMode(newMode) {
    const allowlist = newMode === 'allow' ? [] : mcpAuth.allowlist;
    setMcpAuth((prev) => Object.assign({}, prev, { mode: newMode, allowlist }));
    saveMcpAuthorization({ mode: newMode, allowlist });
  }

  function pickServerAuthMode(slug, newMode) {
    setMcpAuth((prev) => {
      const entry = prev.servers && prev.servers[slug];
      const next = {
        mode: newMode,
        allowlist: newMode === 'allow' ? [] : (entry && Array.isArray(entry.allowlist) ? entry.allowlist : [])
      };
      const servers = Object.assign({}, prev.servers, { [slug]: next });
      saveMcpAuthorization({ servers: { [slug]: next } });
      return Object.assign({}, prev, { servers });
    });
  }

  function clearServerAuthMode(slug) {
    setMcpAuth((prev) => {
      const servers = Object.assign({}, prev.servers);
      delete servers[slug];
      return Object.assign({}, prev, { servers });
    });
    saveMcpAuthorization({ servers: { [slug]: null } });
  }

  function toggleMcpServerAuth(slug, checked) {
    if (checked) {
      clearServerAuthMode(slug);
      setMcpAuthStatusMsg('server override cleared (defaults to ' + segMode(mcpAuth.mode || 'ask') + ')');
    } else {
      pickServerAuthMode(slug, 'off');
      setMcpAuthStatusMsg('server override off');
    }
  }

  function toggleMcpToolAuth(toolName, checked) {
    const entry = checked ? null : { mode: 'off', allowlist: [] };
    setMcpAuth((prev) => {
      const tools = Object.assign({}, prev.tools);
      if (checked) delete tools[toolName];
      else tools[toolName] = entry;
      return Object.assign({}, prev, { tools });
    });
    saveMcpAuthorization({ tools: { [toolName]: entry } });
    setMcpAuthStatusMsg(checked ? 'tool override cleared' : 'tool override off');
  }

  async function saveAgentFiles(enabled, namesRaw) {
    const names = namesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    setAgentFilesStatusMsg('saving…');
    const patch = { agentFiles: enabled };
    if (names.length) patch.agentFileNames = names;
    else patch.unset = ['agentFileNames'];
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: dir() }, patch))
    });
    if (r.status === 200) {
      const nextProj = r.body.project || Object.assign({}, currentProject, patch);
      setCurrentProject(nextProj);
      setEditorText(JSON.stringify(nextProj, null, 2));
      setAgentFilesStatusMsg('saved');
    } else {
      setAgentFilesStatusMsg('HTTP ' + r.status);
    }
  }
  function onAgentFilesToggle(e) {
    const checked = e.target.checked;
    setAgentFilesOn(checked);
    saveAgentFiles(checked, agentFileNames);
  }

  function onSkillsToggle(e) {
    const checked = e.target.checked;
    setSkillsOn(checked);
    patchProject({ skills: checked }, setSkillsStatusMsg, 'saved');
  }

  function onAgentFilePicked(relPath) {
    if (!relPath) { setAgentFilePickerOpen(false); return; }
    const current = agentFileNames.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!current.includes(relPath)) current.push(relPath);
    const namesRaw = current.join('\n');
    setAgentFileNames(namesRaw);
    setAgentFilePickerOpen(false);
    saveAgentFiles(agentFilesOn, namesRaw);
  }

  const [debouncer] = useState(() => {
    let t = null;
    return (fn) => {
      if (t) clearTimeout(t);
      t = setTimeout(fn, 350);
    };
  });
  function onAgentFileNamesChange(e) {
    const v = e.target.value;
    setAgentFileNames(v);
    setAgentFilesStatusMsg('…');
    debouncer(() => saveAgentFiles(agentFilesOn, v));
  }

  async function saveRaw() {
    const d = dir();
    if (!d) { setEditorStatusMsg('no project'); return; }
    if (dbBacked) { setEditorStatusMsg('DB-backed — settings save automatically'); return; }
    let parsed;
    try { parsed = JSON.parse(editorText || '{}'); }
    catch (e) { setEditorStatusMsg('invalid JSON: ' + e.message); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEditorStatusMsg('must be a JSON object');
      return;
    }
    setSaveDisabled(true);
    const r = await fetchJson('/api/settings/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir: d }, parsed))
    });
    setSaveDisabled(false);
    if (r.status !== 200) { setEditorStatusMsg('HTTP ' + r.status); return; }
    setEditorStatusMsg('saved');
    await load(d);
  }

  function revertRaw() {
    setEditorText(JSON.stringify(currentProject, null, 2));
    setEditorStatusMsg('reverted');
  }
  async function onStorageToggle(e) {
    const want = !!e.target.checked;
    const d = dir();
    if (!d) { setStorageStatusMsg('no project'); return; }
    setStorageStatusMsg('saving…');
    try {
      const res = await setProjectStorage(d, want);
      setDbBacked(res.dbBacked);
      setProjectPath(res.path || d);
      setCurrentProject(res.project);
      setEditorText(JSON.stringify(res.project, null, 2));
      setStorageStatusMsg(res.dbBacked ? 'stored in app DB — project folder unchanged' : 'stored in .mouaif.json');
    } catch (err) {
      setStorageStatusMsg('save failed: ' + (err && err.message ? err.message : err));
    }
  }

  useEffect(() => {
    const seed = (initialDir && initialDir.trim())
      || (activeProject.value && activeProject.value.dir)
      || '';
    if (seed) load(seed).catch((err) => setGlobalStatus({ text: 'load failed: ' + err.message, state: 'error' }));
    else setGlobalStatus({ text: 'open this from a project card', state: 'error' });
  }, [initialDir]);

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
        // Leaves inherit tools.file until a leaf checkbox creates an
        // explicit per-tool override. The source marker keeps inherited
        // leaves synchronized when the family mode changes.
        tools: fileTools.map((t) => leaf(t, {
          checked: isOn((fileToolAuth[t.name] && fileToolAuth[t.name].mode) || fileAuth.mode)
        })),
        extra: fileStatusMsg ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, fileStatusMsg) : null
      });
    }

    const servers = (mcpServers || []).filter((s) => s && s.id);
    if (servers.length) {
    groups.push({
      id: 'mcp',
      name: 'MCP default',
      description: 'gate for MCP servers without an override',
      checked: (mcpAuth.mode || 'ask') !== 'off',
      hideCheckbox: true,
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
            setMcpAuth((prev) => Object.assign({}, prev, { mode, allowlist }));
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
        const serverTools = (toolsCatalog || []).filter((t) => t && t.kind === 'mcp' && t.source === slug);
        const toolCount = serverTools.length || (Array.isArray(server.tools) ? server.tools.length : 0);
        groups.push({
          // Key the group by the *slug* (canonical override key), not the
          // id. The checkbox toggle below (`toggleMcpServerAuth(groupId
          // .slice(4))`) writes the per-server override under this key, and
          // McpAuthSeg + effMode read it back from the same slug. Using the
          // id here (a hyphenated display id like `chrome-debug`) writes the
          // override under a different key than the underscore slug the rest
          // of the tree reads (`chrome_debug`), so a toggled-off checkbox
          // never reflected its off state.
          id: 'mcp-' + slug,
          name: server.name || server.id,
          description: (server.status || 'stopped') + (toolCount ? ' · ' + toolCount + (toolCount === 1 ? ' tool' : ' tools') : '')
            + (overridden ? ' · override: ' + segMode(effMode) : ' · default (' + segMode(effMode) + ')'),
          checked: effMode !== 'off',
          // MCP lifecycle state for the reload control (same fields the
          // chat tools card threads): a stopped-but-enabled server shows
          // the start button; a disabled (off) one never does.
          status: server.status || 'stopped',
          enabled: effMode !== 'off',
          serverId: server.id,
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
                setMcpAuth((prev) => Object.assign({}, prev, {
                  servers: Object.assign({}, prev.servers, { [key]: val })
                }));
                saveMcpAuthorization({ servers: { [key]: val } });
              }
            }
          }),
          tools: serverTools.map((tool) => {
            const entry = mcpAuth.tools && mcpAuth.tools[tool.name];
            const mode = entry && entry.mode ? entry.mode : effMode;
            const prefix = 'mcp__' + slug + '__';
            const displayName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
            return leaf(tool, { name: displayName, checked: mode !== 'off' });
          }),
          extra: null
        });
      }
    }

    return groups;
  }

  async function onReloadMcpServer(group) {
    const d = dir();
    const id = group && group.serverId;
    if (!d || !id) return;
    group.reloadBusy = true;
    setGlobalStatus({ text: 'starting server…', state: 'busy' });
    let ok = false;
    try {
      const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: d })
      });
      ok = r.status === 200;
    } catch { /* ok stays false */ }
    group.reloadBusy = false;
    setGlobalStatus(ok
      ? { text: 'server started', state: 'ok' }
      : { text: 'start failed — check Server command/URL', state: 'error' });
    load(d);
  }
  function toggleSettingsGroup(groupId, checked) {
    const mode = checked ? 'ask' : 'off';
    if (groupId === 'shell') pickShellMode(mode);
    else if (groupId === 'subagent') pickSubagentMode(mode);
    else if (groupId === 'task') pickTaskMode(mode);
    else if (groupId === 'report_progress') pickProgressMode(mode);
    else if (groupId === 'ask_user') pickAskUserMode(mode);
    else if (groupId === 'files') {
      const names = toolsCatalog
        .filter((tool) => tool && tool.kind === 'native' && tool.source === 'files')
        .map((tool) => tool.name);
      pickFileGroupMode(names, mode);
    }
    else if (groupId === 'mcp') pickMcpMode(mode);
    else if (groupId.startsWith('mcp-')) toggleMcpServerAuth(groupId.slice(4), checked);
  }

  function openAgentCreator() {
    setAgentCreateStatus('');
    setAgentCreating(true);
    setNewAgentNameVal('');
    setTimeout(() => { document.getElementById('sp-new-agent-name')?.focus(); }, 0);
  }

  async function addAgentPreset() {
    const name = newAgentNameVal.trim();
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
    if (created) nav('settings/agents/' + encodeURIComponent(created) + '?projectDir=' + encodeURIComponent(dir()));
  }

  // What the model receives for a representative file-tool result under the
  // selected { size, structure } pair. This mirrors src/toolFeedback.js for
  // ASCII text: structure first, then the byte cap, then 75/25 head-tail
  // truncation with the standard marker. The sample is deliberately larger
  // than every finite cap, so each size setting has a visible effect.
  function exampleFor(size, structure) {
    const SIZE_MULTIPLIER = { 'very-small': 0.25, average: 1, full: 4, extensive: Infinity };
    const BASE_MAX_BYTES = 64 * 1024;
    const MIN_MAX_BYTES = 4 * 1024;
    const utf8Len = (s) => new TextEncoder().encode(s).length;

    // A generic `list_files` result across many directories. This is the
    // compact format the file tools produce: one `# Listing`/`# Count`
    // header, then each directory printed once as a `# <dir>/` group header
    // with bare basenames indented under it. The model does not see a JSON
    // envelope for successful file-tool output.
    const dirCount = 72;
    const filesPerDir = 110;
    const lines = [
      '# Listing: **/*.js',
      '# Count: ' + (dirCount * filesPerDir),
      '# Skipped: 37',
      ''
    ];
    for (let d = 1; d <= dirCount; d++) {
      const dir = String(d).padStart(3, '0');
      lines.push('# packages/module-' + dir + '/src/');
      for (let f = 1; f <= filesPerDir; f++) {
        lines.push('  component-output-profile-example-' + String(f).padStart(3, '0') + '.js');
      }
    }
    const raw = lines.join('\n');

    // structure: `concise` collapses blank runs, strips leading indentation
    // and trailing whitespace (matches conciseLayout for non-JSON text).
    let body = raw;
    if (normalizeOutputStructure(structure) === 'concise') {
      body = raw
        .replace(/\n[ \t]*\n+/g, '\n')
        .replace(/^[ \t]+/gm, '')
        .replace(/\s+$/gm, '');
    }

    // size: byte-budget cap against the base 64 KiB. `extensive` never caps.
    const mult = SIZE_MULTIPLIER[normalizeOutputSize(size)];
    if (mult === Infinity) return body;
    const cap = Math.max(MIN_MAX_BYTES, Math.floor(BASE_MAX_BYTES * mult));
    const bytes = utf8Len(body);
    if (bytes <= cap) return body;

    // head/tail truncation with the standard marker (75% head, 25% tail).
    const marker = '\n\n...[tool feedback truncated; original ' + bytes + ' bytes]...\n\n';
    const payload = Math.max(0, cap - utf8Len(marker));
    const headBudget = Math.floor(payload * 0.75);
    const tailBudget = payload - headBudget;
    return body.slice(0, headBudget) + marker + body.slice(body.length - tailBudget);
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
        h('li', { class: 'settings-project__item' },
          h('div', { class: 'settings-project__item-main' },
            h('label', { class: 'settings-project__item-title', for: 'sp-output-size' }, 'Size cap'),
            h('div', { class: 'settings-project__item-note' }, 'How many bytes of each tool result the model can see.'),
            h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, outputStatusMsg)
          ),
          h('select', { class: 'input settings-project__select', id: 'sp-output-size', value: normalizeOutputSize(outputSize), onChange: onOutputSize },
            Object.entries(OUTPUT_SIZES).map(([value, meta]) => h('option', { value }, meta.label))
          )
        ),
        h('li', { class: 'settings-project__item' },
          h('div', { class: 'settings-project__item-main' },
            h('label', { class: 'settings-project__item-title', for: 'sp-output-structure' }, 'Layout'),
            h('div', { class: 'settings-project__item-note' }, 'Whether whitespace is preserved or compacted before the size cap.')
          ),
          h('select', { class: 'input settings-project__select', id: 'sp-output-structure', value: normalizeOutputStructure(outputStructure), onChange: onOutputStructure },
            Object.entries(OUTPUT_STRUCTURES).map(([value, meta]) => h('option', { value }, meta.label))
          )
        )
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Stored value'),
        h('p', { class: 'hint hint--compact' }, 'This is the exact ', h('code', null, 'toolOutput'), ' object written to ', h('code', null, '.mouaif.json'), ' when you change the profile.'),
        h('pre', { class: 'settings__out' }, JSON.stringify({ toolOutput: { size: outputSize, structure: outputStructure } }, null, 2))
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Example'),
        h('p', { class: 'hint hint--compact' }, 'What the model would receive for a sample ', h('code', null, 'list_files'), ' result spanning many directories — the compact file-tool format (each directory grouped once, no repeated path prefix, no JSON). The sample is intentionally large so finite size caps show the truncation marker:'),
        h('pre', { class: 'settings__out' }, exampleFor(outputSize, outputStructure))
      )
    )
  );

  if (page === 'technical') return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: chatId() ? ('#/chat/' + encodeURIComponent(chatId()) + '?projectDir=' + encodeURIComponent(dir() || initialDir || '')) : '#/settings/project?projectDir=' + encodeURIComponent(dir() || initialDir || ''), class: 'view-back', 'aria-label': chatId() ? 'Back to chat' : 'Back to project settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Technical details')
    ),
    h('section', { class: 'settings-project' },
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('files'),
          h('span', null, 'Project settings storage'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About project settings storage' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Keep this project’s settings in the app database instead of writing a ', h('code', null, '.mouaif.json'), ' file. The project folder stays untouched, so nothing shows up in git.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-row' },
              h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sp-db-backed' }, 'Store settings in app DB'),
                h('div', { class: 'settings-project__item-note' }, dbBacked ? 'Settings live in the app SQLite store. No .mouaif.json is written to the project.' : 'Settings live in .mouaif.json and can be committed with the project.'),
                h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, storageStatusMsg)
              ),
              h('label', { class: 'switch' },
                h('input', { id: 'sp-db-backed', type: 'checkbox', role: 'switch', checked: dbBacked, 'aria-checked': dbBacked ? 'true' : 'false', onChange: onStorageToggle }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
              )
            )
          )
        )
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Raw project file'),
        h('p', { class: 'hint hint--compact' }, dbBacked ? 'This project is DB-backed — the raw JSON below is shown read-only for reference.' : 'Hand-edit ', h('code', null, '.mouaif.json'), '. The main settings page writes the same file.'),
        h('textarea', {
          class: 'input settings-project__code',
          id: 'sp-project-editor',
          rows: 10,
          spellcheck: false,
          value: editorText,
          onInput: (e) => setEditorText(e.target.value),
          readOnly: dbBacked
        }),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn btn--primary', type: 'button', onClick: saveRaw, disabled: saveDisabled || dbBacked }, 'Save file'),
          h('button', { class: 'btn', type: 'button', onClick: revertRaw, disabled: revertDisabled }, 'Revert'),
          h('span', { class: 'status', 'aria-live': 'polite' }, editorStatusMsg)
        )
      ),
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title' }, 'Resolved settings'),
        h('p', { class: 'hint hint--compact' }, 'Defaults → app → project. Provider keys are redacted.'),
        h('pre', { class: 'settings__out' }, resolvedOutText)
      ),
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
            h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, chatTraceStatusMsg)
          ),
          h('label', { class: 'switch' },
            h('input', { id: 'sp-chat-trace', type: 'checkbox', role: 'switch', checked: chatTraceOn, 'aria-checked': chatTraceOn ? 'true' : 'false', onChange: onChatTraceChange }),
            h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
          )
        ),
        h('div', { class: 'settings-project__item-actions' },
          h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, exportTraceStatusMsg),
          h('button', { class: 'btn', type: 'button', onClick: exportTrace, disabled: !canExportTrace }, 'Export trace'),
          h('button', { class: 'btn btn--danger btn--sm', type: 'button', onClick: deleteChat }, 'Delete chat')
        )
      )
    )
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
          h('p', { class: 'settings-project__path' }, h('code', null, projectPath)),
          h('span', { class: 'status', 'aria-live': 'polite', 'data-state': globalStatus.state || undefined }, globalStatus.text)
        ),
        h('p', { class: 'settings-project__lede' }, 'Only for this project — everything saves automatically.')
      ),
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
              h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, promptSizeStatusMsg)
            ),
            h('select', { class: 'input settings-project__select', id: 'sp-prompt-size', value: promptSize, onChange: onPromptSize },
              h('option', { value: '' }, 'Inherit app default'),
              h('option', { value: 'very-small' }, 'Very small — tool names only, no schemas'),
              h('option', { value: 'average' }, 'Average — full tools, recommended'),
              h('option', { value: 'extensive' }, 'Extensive — full tools + best-practice guidance')
            )
          ),
          h('li', null,
            h('a', {
              class: 'group__row settings-project__link-row',
              'aria-label': 'Custom prompts',
              href: '#/settings/prompts?projectDir=' + encodeURIComponent(loadedDir || '')
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'Custom prompts'),
                h('span', { class: 'settings-project__link-sub' }, 'Reusable system and role prompts')
              ),
              h('span', { class: 'group__row-detail' }, promptsSummaryMsg),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          )
        )
      ),

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
                  if (groupId.startsWith('mcp-')) toggleMcpToolAuth(toolId, checked);
                  else if (groupId === 'files') pickFileToolMode(toolId, checked ? 'ask' : 'off');
                  else toggleSettingsGroup(groupId, checked);
                },
                // Groups with more than one nested tool start collapsed,
                // matching the chat tree. The ToolTree holds its own
                // collapse state, so a group the user expands stays open
                // across SettingsProject re-renders (checkbox / segment
                // changes only re-render this tree in place).
                collapsedByDefault: true,
                onReloadServer: onReloadMcpServer
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

      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('files'),
          h('span', null, 'Agent files'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About agent files' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Agent files are markdown files at the project root that get injected into the model’s context at the start of every chat. Use them for project conventions, architecture notes, or standing instructions. Turning this off locks them off for every chat; when it is on, a chat can still opt out individually.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-row' },
              h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sp-agent-files' }, 'Inject agent files into chats'),
                h('div', { class: 'settings-project__item-note' },
                  'Project-wide gate for instruction files at the project root (e.g. AGENTS.md, CLAUDE.md). Off locks them out of every chat; on lets each chat opt out. ',
                  h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, agentFilesStatusMsg)
                )
              ),
              h('label', { class: 'switch' },
                h('input', {
                  id: 'sp-agent-files',
                  type: 'checkbox',
                  role: 'switch',
                  checked: agentFilesOn,
                  'aria-checked': agentFilesOn ? 'true' : 'false',
                  onChange: onAgentFilesToggle
                }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
              )
            )
          ),
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-row' },
              h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sp-skills' }, 'Skills'),
                h('div', { class: 'settings-project__item-note' }, 'Inject .agents/skills/*/SKILL.md files. Disable the family here or in the chat Tools popup. ', h('span', { class: 'settings-project__item-status' }, skillsStatusMsg))
              ),
              h('label', { class: 'switch' },
                h('input', {
                  id: 'sp-skills',
                  type: 'checkbox',
                  role: 'switch',
                  checked: skillsOn,
                  onChange: onSkillsToggle
                }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
              )
            )
          ),
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-agent-file-names' }, 'File names to look for'),
              h('div', { class: 'settings-project__item-note' },
                'One file name per line, relative to the project root. Leave empty to use the defaults (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md).'
              )
            ),
            h('div', { class: 'settings-project__afn-row' },
              h('textarea', {
                class: 'input settings-project__mono settings-project__afn-text',
                id: 'sp-agent-file-names',
                rows: 3,
                spellcheck: false,
                placeholder: 'AGENTS.md\nCLAUDE.md\n.github/copilot-instructions.md',
                value: agentFileNames,
                onInput: onAgentFileNamesChange
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
                    id: 'sp-new-agent-name',
                    class: 'input',
                    placeholder: 'reviewer',
                    value: newAgentNameVal,
                    onInput: (e) => setNewAgentNameVal(e.target.value),
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

      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('more'),
          h('span', null, 'More settings')
        ),
        h('ul', { class: 'group__list' },
          h('li', null,
            h('a', {
              class: 'group__row settings-project__link-row',
              'aria-label': 'MCP servers',
              href: '#/settings/mcp?projectDir=' + encodeURIComponent(loadedDir || '')
            },
              h('span', { class: 'group__row-body' },
                h('span', { class: 'group__row-label' }, 'MCP servers'),
                h('span', { class: 'settings-project__link-sub' }, 'Connect external tool servers')
              ),
              h('span', { class: 'group__row-detail' }, mcpSummaryMsg),
              h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
            )
          ),
          h('li', null,
            h('a', {
              class: 'group__row settings-project__link-row',
              href: '#/settings/project/technical?projectDir=' + encodeURIComponent(dir()) + (chatId() ? '&chatId=' + encodeURIComponent(chatId()) : '')
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

      agentFilePickerOpen && h(AgentFilePicker, {
        projectDir: dir(),
        onPick: onAgentFilePicked,
        onClose: () => setAgentFilePickerOpen(false)
      })
    )
  );
}
