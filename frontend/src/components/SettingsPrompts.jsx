// mouaif web — SettingsPromptsView
//
// Single-screen custom-prompt editor. Replaces the old two-step
// list → edit flow with a dropdown-driven form: pick a prompt at
// the top (or "+ New prompt"), edit title / content / preset
// in-place, hit Save. Switching the dropdown to another prompt
// while the current one has unsaved changes asks for confirmation
// so the user does not silently lose work.
//
// Supports two scopes:
//   - App-wide: stored globally in SQLite database.
//   - Project: stored in <projectDir>/.mouaif.json.
//
// The prompt's optional **chat preset** (tools + agent files + skills)
// uses the SAME controls as the rest of the settings: the standard
// `ToolTree` (the same one the chat Tools card and Settings → Project
// use) and synthetic `agent-files` / `skills` groups that mirror
// the chat's ToolPopup.
import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { ToolTree, buildToolGroups } from './ToolTree.jsx';
import { PromptIcon, PROMPT_ICONS } from './PromptIcon.jsx';
// Sentinel id used by the "new prompt" entry in the picker dropdown.
const NEW_PROMPT_ID = '__new__';

// Built-in prompt templates listed under "Start from a default", next to
// the prompt-size profiles. "Chat" is a plain conversation preset: no
// prompt text, a chat icon, and an exclusive preset with no tools, so a
// chat started from it gets no tools until the user turns some on.
const PROMPT_TEMPLATES = [
  {
    id: 'chat',
    label: 'Chat',
    icon: 'chat',
    content: '',
    preset: { tools: [], exclusive: true, agentFiles: false, skills: false }
  }
];

function presetFromRecord(pp) {
  if (!pp || !(Array.isArray(pp.tools) || typeof pp.agentFiles === 'boolean' || typeof pp.skills === 'boolean' || pp.exclusive === true)) return null;
  return {
    tools: new Set(Array.isArray(pp.tools) ? pp.tools : []),
    exclusive: pp.exclusive === true,
    agentFiles: pp.agentFiles === true,
    skills: pp.skills === true
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text || '';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

function resolveProjectDir(view) {
  if (view && typeof view.projectDir === 'string') return view.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

function agentFileNameOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.name || entry.relPath || '';
}

function skillIdOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.id || entry.name || '';
}

function presetsEqual(a, b) {
  const norm = (p) => {
    if (!p) return null;
    const tools = p.tools instanceof Set
      ? Array.from(p.tools).sort()
      : (Array.isArray(p.tools) ? p.tools.slice().sort() : []);
    const hasAny = tools.length || p.agentFiles || p.skills || p.exclusive;
    if (!hasAny) return null;
    return { tools, exclusive: !!p.exclusive, agentFiles: !!p.agentFiles, skills: !!p.skills };
  };
  const A = norm(a);
  const B = norm(b);
  if (A === null && B === null) return true;
  if (!A || !B) return false;
  if (A.exclusive !== B.exclusive) return false;
  if (A.agentFiles !== B.agentFiles) return false;
  if (A.skills !== B.skills) return false;
  if (A.tools.length !== B.tools.length) return false;
  for (let i = 0; i < A.tools.length; i++) {
    if (A.tools[i] !== B.tools[i]) return false;
  }
  return true;
}

export function SettingsPromptsView(props) {
const rawProjectDir = resolveProjectDir(props);
const from = (props && typeof props.from === 'string') ? props.from : '';
  // If explicitly opened from Settings -> App defaults (via route or props.scope === 'app'),
  // or if there is no projectDir, target scope is app.
  const isAppScopedRoute = (props && props.scope === 'app') || !rawProjectDir;
  const projectDir = isAppScopedRoute ? '' : rawProjectDir;

  const [prompts, setPrompts] = useState([]);
  const [selectedId, setSelectedId] = useState(NEW_PROMPT_ID);
  const initialId = (props && props.initialId) || '';

  // Scope for the prompt currently being created/edited: 'project' or 'app'
  const [promptScope, setPromptScope] = useState(projectDir ? 'project' : 'app');

  // Editable fields.
  const [title, setTitle] = useState('');
const [icon, setIcon] = useState('sparkles');
const [showOnProjectCard, setShowOnProjectCard] = useState(false);
const [content, setContent] = useState('');
const [preset, setPreset] = useState(null);

  // Status + busy flags.
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [copyStatus, setCopyStatus] = useState('Copy');

  const [profiles, setProfiles] = useState([]);
  const [showProfileCopy, setShowProfileCopy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [loadedSnapshot, setLoadedSnapshot] = useState({ title: '', icon: 'sparkles', showOnProjectCard: false, content: '', preset: null, scope: projectDir ? 'project' : 'app' });

  // ToolTree data
  const [toolsCatalog, setToolsCatalog] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [agentFilesAvailable, setAgentFilesAvailable] = useState([]);
  const [agentFilesProjectLocked, setAgentFilesProjectLocked] = useState(false);
  const [skillsAvailable, setSkillsAvailable] = useState([]);
  const [skillsProjectLocked, setSkillsProjectLocked] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  const dirtyRef = useRef(false);
  const pickerRef = useRef(null);
  // Tracks whether the user has explicitly chosen a prompt (via the picker,
  // "New", or delete) as opposed to the auto-select done on first load. Once
  // true, the auto-select effect stops trying to move the picker again.
  const userPickedRef = useRef(false);
  const loadedRef = useRef(loadedSnapshot);
  loadedRef.current = loadedSnapshot;
  async function loadPrompts() {
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try { r = await fetchJson('/api/prompts' + qs); }
    catch { return; }
    if (r.status !== 200) return;
    const list = r.body.prompts || [];
    setPrompts(list);
  }

  async function loadProfiles() {
    try {
      const r = await fetchJson('/api/prompt-profiles');
      if (r.status === 200 && Array.isArray(r.body.profiles)) {
        setProfiles(r.body.profiles.map((p) => ({
          id: p.id,
          label: p.label || p.id,
          description: p.description || '',
          systemMessage: p.systemMessage || ''
        })));
      }
    } catch { /* ignore */ }
  }

  async function loadProjectData() {
    setDataLoaded(false);
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    const [toolsRes, mcpRes, featuresRes, projectRes] = await Promise.all([
      fetchJson('/api/tools/list' + qs).catch(() => ({ status: 0, body: {} })),
      fetchJson('/api/mcp/servers' + qs).catch(() => ({ status: 0, body: {} })),
      projectDir ? fetchJson('/api/features' + qs).catch(() => ({ status: 0, body: {} })) : Promise.resolve({ status: 200, body: {} }),
      projectDir ? fetchJson('/api/settings/project' + qs).catch(() => ({ status: 0, body: {} })) : Promise.resolve({ status: 200, body: {} })
    ]);

    if (toolsRes.status === 200 && Array.isArray(toolsRes.body.tools)) {
      setToolsCatalog(toolsRes.body.tools);
    }
    if (mcpRes.status === 200 && Array.isArray(mcpRes.body.servers)) {
      setMcpServers(mcpRes.body.servers);
    }
    const features = (featuresRes.status === 200 && featuresRes.body && featuresRes.body.features) || {};
    const af = features.agentFiles || {};
    setAgentFilesAvailable(Array.isArray(af.discovered) ? af.discovered.map(agentFileNameOf).filter(Boolean) : []);
    const sk = features.skills || {};
    setSkillsAvailable(Array.isArray(sk.items) ? sk.items.map(skillIdOf).filter(Boolean) : []);
    const projectBody = (projectRes.status === 200 && projectRes.body && projectRes.body.project) || {};
    setAgentFilesProjectLocked(projectBody.agentFiles === false);
    setSkillsProjectLocked(projectBody.skills === false);
    setDataLoaded(true);
  }

  function applyPromptToForm(p) {
    if (!p) {
      const defaultScope = projectDir ? 'project' : 'app';
      const snap = { title: '', icon: 'sparkles', showOnProjectCard: false, content: '', preset: null, scope: defaultScope };
setTitle(snap.title);
setIcon(snap.icon);
setShowOnProjectCard(snap.showOnProjectCard);
setContent(snap.content);
setPreset(snap.preset);
      setPromptScope(defaultScope);
      setLoadedSnapshot(snap);
      dirtyRef.current = false;
      return;
    }
    const nextPreset = presetFromRecord(p.preset);
    const itemScope = p.scope || (projectDir ? 'project' : 'app');
const snap = {
title: p.title || '',
icon: p.icon || 'sparkles',
showOnProjectCard: p.showOnProjectCard === true,
content: p.content || '',
preset: nextPreset,
scope: itemScope
};
setTitle(snap.title);
setIcon(snap.icon);
setShowOnProjectCard(snap.showOnProjectCard);
setContent(snap.content);
setPreset(nextPreset);
    setPromptScope(itemScope);
    setLoadedSnapshot(snap);
    dirtyRef.current = false;
  }

  function isDirty() {
if (title !== loadedSnapshot.title) return true;
if (icon !== loadedSnapshot.icon) return true;
if (showOnProjectCard !== loadedSnapshot.showOnProjectCard) return true;
if (content !== loadedSnapshot.content) return true;
    if (promptScope !== loadedSnapshot.scope) return true;
    if (!presetsEqual(preset, loadedSnapshot.preset)) return true;
    return false;
  }

  function presetActive() { return !!preset; }
  function setToolSelected(name, checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), exclusive: false, agentFiles: false, skills: false };
      const next = new Set(base.tools);
      if (checked) next.add(name); else next.delete(name);
      return { tools: next, exclusive: !!base.exclusive, agentFiles: !!base.agentFiles, skills: !!base.skills };
    });
  }
  function setToolsSelected(names, checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), exclusive: false, agentFiles: false, skills: false };
      const next = new Set(base.tools);
      for (const n of names) {
        if (checked) next.add(n); else next.delete(n);
      }
      return { tools: next, exclusive: !!base.exclusive, agentFiles: !!base.agentFiles, skills: !!base.skills };
    });
  }
  function setAgentFiles(checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), exclusive: false, agentFiles: false, skills: false };
      return { tools: new Set(base.tools), exclusive: !!base.exclusive, agentFiles: !!checked, skills: !!base.skills };
    });
  }
  function setSkills(checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), exclusive: false, agentFiles: false, skills: false };
      return { tools: new Set(base.tools), exclusive: !!base.exclusive, agentFiles: !!base.agentFiles, skills: !!checked };
    });
  }
  function setExclusive(checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), exclusive: false, agentFiles: false, skills: false };
      return { tools: new Set(base.tools), exclusive: !!checked, agentFiles: !!base.agentFiles, skills: !!base.skills };
    });
  }
  function togglePresetOn(checked) {
    if (checked) {
      setPreset({ tools: new Set(), exclusive: false, agentFiles: false, skills: false });
      return;
    }
    setPreset(null);
  }

  useEffect(() => { loadPrompts(); }, [projectDir]);
  useEffect(() => { loadProjectData(); }, [projectDir]);
  useEffect(() => { loadProfiles(); }, []);
  useEffect(() => {
    if (!pickerOpen) return undefined;
    function onPointerDown(event) {
      if (pickerRef.current && !pickerRef.current.contains(event.target)) setPickerOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setPickerOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);
  // The routes render <SettingsPromptsView> with no `key`, so navigating
  // between an app-scoped and a project-scoped prompts page reuses the same
  // component instance and its refs/state persist. Reset the picker whenever
  // the scope changes so the auto-select effect below re-runs for the freshly
  // loaded prompt list (instead of keeping the previous scope's selection).
  // Declared BEFORE that effect so it runs first.
  useEffect(() => {
    userPickedRef.current = false;
    setPrompts([]);
    setSelectedId(NEW_PROMPT_ID);
    applyPromptToForm(null);
  }, [projectDir]);
  useEffect(() => {
    // Default the picker to an existing prompt (when one is saved) instead
    // of always landing on the blank "+ New prompt" form. This only runs on
    // first load (before the user has made any explicit picker choice) so it
    // never fights the "New" / delete / dropdown interactions. A legacy deep
    // link (`initialId`) wins; otherwise pick the first saved prompt.
    if (userPickedRef.current) return;
    if (selectedId !== NEW_PROMPT_ID) return;
    if (initialId) {
      const p = prompts.find((x) => x.id === initialId);
      if (!p) return;
      setSelectedId(p.id);
      applyPromptToForm(p);
      return;
    }
    if (!prompts.length) return;
    const p = prompts[0];
    setSelectedId(p.id);
    applyPromptToForm(p);
  }, [prompts, initialId, selectedId]);

  function handleSelectPrompt(nextId) {
    setPickerOpen(false);
    if (nextId === selectedId) return;
    if (dirtyRef.current) {
      const ok = confirm('Discard unsaved changes to this prompt?');
      if (!ok) return;
    }
    userPickedRef.current = true;
    setSelectedId(nextId);
    setStatusMsg({ text: '', kind: '' });
    setShowProfileCopy(false);
    if (nextId === NEW_PROMPT_ID) {
      applyPromptToForm(null);
      return;
    }
    const p = prompts.find((x) => x.id === nextId);
    applyPromptToForm(p || null);
  }

  async function save() {
    const t = title.trim();
    const c = content.trim();
    if (!c && !presetActive()) { setStatusMsg({ text: 'prompt content is required (or turn on a chat preset)', kind: 'error' }); return; }

    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });

    const isNew = selectedId === NEW_PROMPT_ID;
    const effectiveScope = isNew ? promptScope : (loadedSnapshot.scope || 'project');
    const targetDir = effectiveScope === 'app' ? '' : (projectDir || '');

    const body = {
      projectDir: targetDir,
scope: effectiveScope,
title: t,
icon,
showOnProjectCard,
content: c
};

    if (presetActive()) {
      const p = preset;
      const hasAny = (p.tools && p.tools.size > 0) || p.agentFiles || p.skills || p.exclusive;
      body.preset = hasAny ? {
        tools: Array.from(p.tools || []),
        exclusive: p.exclusive === true,
        agentFiles: p.agentFiles === true,
        skills: p.skills === true
      } : null;
    } else {
      body.preset = null;
    }

    const url = isNew
      ? '/api/prompts'
      : '/api/prompts/' + encodeURIComponent(selectedId);
    const method = isNew ? 'POST' : 'PATCH';

    let r;
    try {
      r = await fetchJson(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch {
      setStatusMsg({ text: 'network error', kind: 'error' });
      setIsSaving(false);
      return;
    }
    setIsSaving(false);

    if (r.status !== 200 && r.status !== 201) {
      setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' });
      return;
    }

    await loadPrompts();

    const saved = r.body.prompt;
    if (saved && saved.id) {
      setSelectedId(saved.id);
      applyPromptToForm(saved);
    } else {
setLoadedSnapshot({
title: t,
icon,
showOnProjectCard,
content: c,
preset: preset ? { ...preset, tools: new Set(preset.tools) } : null,
scope: effectiveScope
});
      dirtyRef.current = false;
    }
    setStatusMsg({ text: 'saved.', kind: 'success' });
  }

  async function deletePrompt() {
    if (selectedId === NEW_PROMPT_ID) return;
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;

    setIsDeleting(true);
    setStatusMsg({ text: 'deleting…', kind: 'busy' });

    const currentP = prompts.find((x) => x.id === selectedId);
    const itemScope = (currentP && currentP.scope) || loadedSnapshot.scope || (projectDir ? 'project' : 'app');
    const targetDir = itemScope === 'app' ? '' : (projectDir || '');
    const qs = targetDir ? '?projectDir=' + encodeURIComponent(targetDir) : '?scope=app';

    let r;
    try {
      r = await fetchJson('/api/prompts/' + encodeURIComponent(selectedId) + qs, { method: 'DELETE' });
    } catch {
      setStatusMsg({ text: 'network error', kind: 'error' });
      setIsDeleting(false);
      return;
    }
    if (r.status !== 200) {
      setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' });
      setIsDeleting(false);
      return;
    }

    await loadPrompts();
    userPickedRef.current = true;
    // After a delete, move the picker to the next remaining prompt (or the
    // blank "+ New prompt" form when none are left) instead of leaving a
    // dangling selection that no longer exists in the list.
    setSelectedId(NEW_PROMPT_ID);
    applyPromptToForm(null);
    setIsDeleting(false);
    setStatusMsg({ text: 'deleted.', kind: 'success' });
  }

  async function copyCurrent() {
    let text = content;
    let label = 'prompt';
    if (selectedId !== NEW_PROMPT_ID) {
      const p = prompts.find((x) => x.id === selectedId);
      if (p) {
        text = p.content || '';
        label = p.title || p.id;
      }
    } else {
      text = content;
    }
    const ok = await copyText(text);
    setCopyStatus(ok ? 'Copied' : 'Copy failed');
    setTimeout(() => setCopyStatus('Copy'), 1400);
    if (ok) setStatusMsg({ text: 'copied "' + label + '"', kind: 'success' });
  }

  function startNewPrompt() {
    if (dirtyRef.current) {
      const ok = confirm('Discard unsaved changes to this prompt?');
      if (!ok) return;
    }
    userPickedRef.current = true;
    setSelectedId(NEW_PROMPT_ID);
    applyPromptToForm(null);
    setStatusMsg({ text: '', kind: '' });
    setShowProfileCopy(false);
  }

  function startFromProfile(profile) {
    // Start a fresh (unsaved) prompt pre-filled from a built-in
    // prompt-size profile. Chosen from the picker dropdown so the
    // list never looks empty even before the user has saved anything.
    if (!profile) return;
    setPickerOpen(false);
    if (dirtyRef.current) {
      const ok = confirm('Discard unsaved changes to this prompt?');
      if (!ok) return;
    }
    userPickedRef.current = true;
    setSelectedId(NEW_PROMPT_ID);
    const defaultScope = projectDir ? 'project' : 'app';
const snap = { title: '', icon: 'sparkles', showOnProjectCard: false, content: '', preset: null, scope: defaultScope };
setTitle(profile.label || '');
setIcon('sparkles');
setShowOnProjectCard(false);
setContent(profile.systemMessage || '');
setPreset(null);
    setPromptScope(defaultScope);
    // Snapshot stays blank so the pre-filled fields register as dirty and
    // the Create button is enabled immediately.
    setLoadedSnapshot(snap);
    dirtyRef.current = true;
    setShowProfileCopy(false);
    setStatusMsg({ text: 'started from ' + (profile.label || profile.id) + ' profile', kind: 'success' });
  }

  function startFromTemplate(template) {
    // Start a fresh (unsaved) prompt from a built-in template such as
    // "Chat" (no text, chat icon, no tools).
    if (!template) return;
    setPickerOpen(false);
    if (dirtyRef.current) {
      const ok = confirm('Discard unsaved changes to this prompt?');
      if (!ok) return;
    }
    userPickedRef.current = true;
    setSelectedId(NEW_PROMPT_ID);
    const defaultScope = projectDir ? 'project' : 'app';
    const snap = { title: '', icon: 'sparkles', showOnProjectCard: false, content: '', preset: null, scope: defaultScope };
    setTitle(template.label || '');
    setIcon(template.icon || 'sparkles');
    setShowOnProjectCard(false);
    setContent(template.content || '');
    setPreset(presetFromRecord(template.preset));
    setPromptScope(defaultScope);
    setLoadedSnapshot(snap);
    dirtyRef.current = true;
    setShowProfileCopy(false);
    setStatusMsg({ text: 'started from ' + (template.label || template.id) + ' template', kind: 'success' });
  }

  function copyProfileIntoContent(profile) {
    if (!profile) return;
    if (content.trim()) {
      const ok = confirm('Replace the current prompt content with the "' + (profile.label || profile.id) + '" default?');
      if (!ok) return;
    }
    setContent(profile.systemMessage || '');
    setShowProfileCopy(false);
    setStatusMsg({ text: 'loaded ' + (profile.label || profile.id) + ' profile', kind: 'success' });
  }

  function buildPresetGroups() {
    // `buildToolGroups` takes a Set/array of selected tool names (or null
    // for "everything on"). Feed it the preset's selected tool names so the
    // group and leaf checkboxes reflect the saved preset, not a hardcoded
    // all-on state.
    const selected = preset && preset.tools ? Array.from(preset.tools) : [];
    const rawGroups = buildToolGroups(toolsCatalog, mcpServers, selected, new Set());

    const out = rawGroups.slice();

    if (agentFilesAvailable.length > 0) {
      const isLocked = agentFilesProjectLocked;
      const count = agentFilesAvailable.length;
      out.push({
        id: 'agent-files',
        title: 'Agent files',
        subtitle: count + (count === 1 ? ' file' : ' files') + ' · ' + agentFilesAvailable.join(', '),
        checked: !isLocked && !!(preset && preset.agentFiles),
        disabled: isLocked,
        description: isLocked
          ? 'Locked off by project settings'
          : ((preset && preset.agentFiles) ? 'on for chats using this prompt' : 'off'),
        tools: []
      });
    }

    if (skillsAvailable.length > 0) {
      const isLocked = skillsProjectLocked;
      const count = skillsAvailable.length;
      out.push({
        id: 'skills',
        title: 'Skills',
        subtitle: count + (count === 1 ? ' skill' : ' skills') + ' · ' + skillsAvailable.join(', '),
        checked: !isLocked && !!(preset && preset.skills),
        disabled: isLocked,
        description: isLocked
          ? 'Locked off by project settings'
          : ((preset && preset.skills) ? 'on for chats using this prompt' : 'off'),
        tools: []
      });
    }

    return out;
  }

  function handlePresetToggleGroup(groupId, checked) {
    if (groupId === 'agent-files') { setAgentFiles(checked); return; }
    if (groupId === 'skills') { setSkills(checked); return; }
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const names = (group.tools || []).map((t) => t.id).filter(Boolean);
    if (names.length) setToolsSelected(names, checked);
  }

  function handlePresetToggleTool(groupId, toolId, checked) {
    if (groupId === 'agent-files') { setAgentFiles(checked); return; }
    if (groupId === 'skills') { setSkills(checked); return; }
    setToolSelected(toolId, checked);
  }

  const groups = useMemo(() => dataLoaded ? buildPresetGroups() : [], [
    dataLoaded, preset, toolsCatalog, mcpServers,
    agentFilesAvailable, agentFilesProjectLocked,
    skillsAvailable, skillsProjectLocked
  ]);

  const isNew = selectedId === NEW_PROMPT_ID;
  const dirty = isDirty();
  dirtyRef.current = dirty;
  const currentPrompt = !isNew ? prompts.find((p) => p.id === selectedId) : null;
  const pickerLabel = isNew ? '+ New prompt' : ((currentPrompt && (currentPrompt.title || currentPrompt.id)) || 'Choose a prompt');
  const copyDisabled = isNew && !content;

  // On the App-defaults screen every prompt is app-scoped by definition, so the
  // per-option scope badge (["app"]) is redundant noise that reads as a weird
  // item in the dropdown. Only badge scope on the project screen, where prompts
  // may be project-owned or inherited from the app.
  const showScopeBadge = !!projectDir;

  const backHref = projectDir
? ('#/settings/project?projectDir=' + encodeURIComponent(projectDir) + (from ? '&from=' + encodeURIComponent(from) : ''))
: '#/settings';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back' }, '←'),
      h('h2', { class: 'view-title' }, projectDir ? 'Custom prompts · this project' : 'Custom prompts · app defaults')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' },
        projectDir
          ? 'System prompts for this project. Shows project prompts (committed to .mouaif.json) plus app-wide prompts from the SQLite store.'
          : 'App-wide system prompts available in every project. Stored in the app SQLite database.'
      ),
      projectDir ? h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)) : null,

      // ---- Picker ----------------------------------------------------
      h('div', { class: 'row prompts__picker' },
        h('span', { class: 'label', id: 'sp-picker-label' }, 'Prompt'),
h('div', { class: 'prompts__picker-row' },
h('div', { class: 'prompts__picker-control', ref: pickerRef },
h('button', {
type: 'button',
class: 'input prompts__select',
id: 'sp-picker',
'aria-labelledby': 'sp-picker-label sp-picker',
'aria-haspopup': 'listbox',
'aria-expanded': String(pickerOpen),
onClick: () => setPickerOpen((open) => {
  const next = !open;
  if (next && !profiles.length) loadProfiles();
  return next;
})
},
h('span', { class: 'prompts__select-label' }, pickerLabel),
h('span', { class: 'prompts__select-caret', 'aria-hidden': 'true' }, '⌄')
),
pickerOpen ? h('div', {
class: 'prompts__picker-menu',
role: 'listbox',
'aria-labelledby': 'sp-picker-label'
},
h('button', {
type: 'button',
class: 'prompts__picker-option' + (isNew ? ' is-selected' : ''),
role: 'option',
'aria-selected': String(isNew),
onClick: () => handleSelectPrompt(NEW_PROMPT_ID)
},
h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, isNew ? '✓' : ''),
h('span', null, '+ New prompt')
),
prompts.length === 0
? null
: prompts.map((p) => {
const selected = p.id === selectedId;
return h('button', {
type: 'button',
key: p.id,
class: 'prompts__picker-option' + (selected ? ' is-selected' : ''),
role: 'option',
'aria-selected': String(selected),
onClick: () => handleSelectPrompt(p.id)
},
h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
h('span', { class: 'prompts__picker-option-label' },
h(PromptIcon, { name: p.icon, size: 17, class: 'prompts__picker-icon' }),
h('span', null, p.title || p.id),
showScopeBadge && p.scope ? h('span', { class: 'mcp__scope mcp__scope--' + p.scope }, p.scope) : null,
p.preset ? h('span', { class: 'prompts__picker-preset' }, 'preset') : null
)
);
}),
h('div', { class: 'prompts__picker-section', role: 'presentation' }, 'Start from a default'),
PROMPT_TEMPLATES.map((tpl) => h('button', {
type: 'button',
key: 'template:' + tpl.id,
class: 'prompts__picker-option prompts__picker-option--profile',
role: 'option',
'aria-selected': 'false',
onClick: () => startFromTemplate(tpl)
},
h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, ''),
h('span', { class: 'prompts__picker-option-label' },
h(PromptIcon, { name: tpl.icon, size: 17, class: 'prompts__picker-icon' }),
h('span', null, tpl.label),
h('span', { class: 'prompts__picker-preset' }, 'default')
)
)),
profiles.map((p) => h('button', {
type: 'button',
key: 'profile:' + p.id,
class: 'prompts__picker-option prompts__picker-option--profile',
role: 'option',
'aria-selected': 'false',
onClick: () => startFromProfile(p)
},
h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, ''),
h('span', { class: 'prompts__picker-option-label' },
h('span', null, p.label),
h('span', { class: 'prompts__picker-preset' }, 'default')
)
))
) : null
),
          h('button', {
            type: 'button',
            class: 'btn prompts__copy' + (copyStatus === 'Copied' ? ' is-copied' : (copyStatus === 'Copy failed' ? ' is-error' : '')),
            disabled: copyDisabled,
            onClick: copyCurrent,
            'aria-label': 'Copy current prompt to clipboard',
            title: 'Copy this prompt’s content to the clipboard'
          }, copyStatus),
          h('button', {
            type: 'button',
            class: 'btn',
            onClick: startNewPrompt
          }, 'New')
        ),
        dirty ? h('p', { class: 'hint prompts__dirty' }, 'Unsaved changes — switch prompts to discard or hit Save.') : null
      ),

      // ---- Scope selector (when creating a new prompt with an active project) ----
      isNew && projectDir ? h('div', { class: 'row' },
        h('label', { class: 'label' }, 'Scope'),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Prompt scope' },
          [
            { value: 'project', label: 'This project' },
            { value: 'app', label: 'App default' }
          ].map((m) =>
            h('label', { key: m.value, class: 'seg__item' + (promptScope === m.value ? ' seg__item--on' : '') },
              h('input', {
                type: 'radio',
                name: 'sp-prompt-scope',
                value: m.value,
                checked: promptScope === m.value,
                onChange: () => setPromptScope(m.value)
              }),
              h('span', { class: 'seg__pill' }, m.label)
            )
          )
        )
      ) : (!isNew && currentPrompt ? h('div', { class: 'row' },
        h('span', { class: 'hint hint--compact' },
          'Scope: ',
          h('span', { class: 'mcp__scope mcp__scope--' + (currentPrompt.scope === 'app' ? 'app' : 'project') },
            currentPrompt.scope === 'app' ? 'app' : 'project'
          )
        )
      ) : null),

      // ---- Editor ----------------------------------------------------
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-title' },
          isNew ? 'Title (optional until saved)' : 'Title'
        ),
        h('input', {
          value: title,
          onInput: (e) => setTitle(e.currentTarget.value),
          class: 'input',
          id: 'spe-title',
          type: 'text',
          placeholder: 'My custom prompt'
        })
      ),

      h('div', { class: 'row' },
h('span', { class: 'label', id: 'spe-icon-label' }, 'Icon'),
h('div', { class: 'prompts__icons', role: 'radiogroup', 'aria-labelledby': 'spe-icon-label' },
PROMPT_ICONS.map((item) => h('label', {
key: item.id,
class: 'prompts__icon-choice' + (icon === item.id ? ' is-selected' : ''),
title: item.label
},
h('input', {
type: 'radio',
name: 'spe-icon',
value: item.id,
checked: icon === item.id,
'aria-label': item.label,
onChange: () => setIcon(item.id)
}),
h(PromptIcon, { name: item.id, size: 21 })
))
),
h('label', { class: 'prompts__quick-launch' },
h('span', { class: 'switch' },
h('input', {
type: 'checkbox',
role: 'switch',
checked: showOnProjectCard,
'aria-checked': String(showOnProjectCard),
onChange: (e) => setShowOnProjectCard(e.currentTarget.checked)
}),
h('span', { class: 'switch__track', 'aria-hidden': 'true' },
h('span', { class: 'switch__thumb' })
)
),
h('span', null,
h('span', { class: 'prompts__quick-launch-title' }, 'Add to project card'),
h('span', { class: 'prompts__quick-launch-desc' }, 'Use this icon as a one-tap button that starts a new chat with this prompt.')
)
)
),
h('div', { class: 'row' },
h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', {
          value: content,
          onInput: (e) => setContent(e.currentTarget.value),
          class: 'input prompts__textarea',
          id: 'spe-content',
          rows: 6,
          placeholder: presetActive()
            ? 'Optional with a chat preset — leave empty for no system prompt'
            : 'You are a helpful assistant specialized in…'
        }),
        h('div', { class: 'prompts__from-default' },
          h('button', {
            type: 'button',
            class: 'btn btn--ghost',
            onClick: () => {
              const next = !showProfileCopy;
              setShowProfileCopy(next);
              // Reload the built-in prompt-size profiles each time the
              // "Copy from default" section is opened. The initial mount
              // fetch (useEffect on []) can race or fail once and leave
              // the list empty with no retry; refetching on open makes
              // the profiles reliably appear.
              if (next) loadProfiles();
            },
            'aria-expanded': String(showProfileCopy)
          }, 'Copy from default'),
          h('span', { class: 'hint hint--compact' },
            'Start from a built-in prompt-size profile, then edit.'
          )
        ),
        showProfileCopy ? h('div', { class: 'prompts__profile-pick' },
          profiles.length
            ? profiles.map((p) =>
                h('button', {
                  type: 'button',
                  class: 'btn btn--ghost prompts__profile-option',
                  key: p.id,
                  onClick: () => copyProfileIntoContent(p)
                },
                  h('span', { class: 'prompts__profile-name' }, p.label),
                  h('span', { class: 'prompts__profile-desc' }, p.description)
                )
              )
            : h('p', { class: 'hint' }, 'profiles unavailable')
        ) : null
      ),

      // ---- Prompt preset --------------------------------------------
      h('div', { class: 'row prompts__preset' },
        h('label', { class: 'prompts__preset-head' },
          h('span', { class: 'label prompt-label' }, 'Chat preset'),
          h('span', { class: 'prompts__preset-main' },
            h('label', { class: 'switch' },
              h('input', {
                id: 'spe-preset-on',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': String(!!presetActive()),
                checked: !!presetActive(),
                onChange: (e) => togglePresetOn(e.currentTarget.checked)
              }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' },
                h('span', { class: 'switch__thumb' })
              )
            ),
            h('span', { class: 'prompts__preset-desc' },
              'Tools, agent files, and skills a chat gets when it uses this prompt.'
            )
          )
        ),
        h('p', { class: 'hint hint--compact prompts__preset-note' },
          'Tools are additive unless “Only these tools” is on — then new chats start with just the checked tools. The project’s Off/Ask/Allow always wins. ',
          'Agent files inject AGENTS.md / CLAUDE.md. Skills inject .agents/skills/*/SKILL.md. ',
          'The project can lock any of these off; the preset cannot override that lock.'
        )
      ),

      !presetActive() ? null : h('div', { class: 'row prompts__preset-body' },
        h('label', { class: 'prompts__quick-launch' },
          h('span', { class: 'switch' },
            h('input', {
              id: 'spe-preset-exclusive',
              type: 'checkbox',
              role: 'switch',
              checked: !!(preset && preset.exclusive),
              'aria-checked': String(!!(preset && preset.exclusive)),
              onChange: (e) => setExclusive(e.currentTarget.checked)
            }),
            h('span', { class: 'switch__track', 'aria-hidden': 'true' },
              h('span', { class: 'switch__thumb' })
            )
          ),
          h('span', null,
            h('span', { class: 'prompts__quick-launch-title' }, 'Only these tools'),
            h('span', { class: 'prompts__quick-launch-desc' },
              'New chats start with just the tools checked below — none checked means no tools. The chat’s Tools card can still turn more on.'
            )
          )
        ),
        dataLoaded
          ? h(ToolTree, {
              groups,
              onToggleGroup: handlePresetToggleGroup,
              onToggleTool: handlePresetToggleTool,
              collapsedByDefault: true,
              class: 'prompts__preset-tree'
            })
          : h('div', { class: 'prompts__preset-loading' }, 'loading tools…')
      ),

      // ---- Actions ---------------------------------------------------
      h('div', { class: 'row row--actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: save,
          disabled: isSaving || (!dirty && !isNew)
        }, isSaving ? 'Saving…' : (isNew ? 'Create' : 'Save')),
        h('button', {
          class: 'btn btn--danger',
          type: 'button',
          onClick: deletePrompt,
          hidden: isNew,
          disabled: isDeleting
        }, isDeleting ? 'Deleting…' : 'Delete'),
        h('span', {
          class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''),
          'aria-live': 'polite'
        }, statusMsg.text)
      )
    )
  );
}
