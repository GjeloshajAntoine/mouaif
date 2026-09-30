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
import { settingsLink } from './settings/projectNavigation.js';
import {
  presetToolSelection, applyToolToggle, presetBody, presetFromRecord, presetsEqual
} from './settings/presetTools.js';
import {
  PROFILE_PREFIX, readLaunchers, launcherSource, effectiveLauncher, withLauncher
} from './settings/profileLaunchers.js';
// Sentinel id used by the "new prompt" entry in the picker dropdown.
const NEW_PROMPT_ID = '__new__';

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

export function SettingsPromptsView(props) {
const rawProjectDir = resolveProjectDir(props);
const from = (props && typeof props.from === 'string') ? props.from : '';
const chatId = (props && typeof props.chatId === 'string') ? props.chatId : '';
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
  // Built-in prompt launchers (icon + project-card pin), per store.
  // See settings/profileLaunchers.js.
  const [launchers, setLaunchers] = useState({ app: {}, project: {} });
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
        // Every built-in profile is listed in the picker (Chat included —
        // its icon and project-card pin are editable). Only the ones with
        // text are offered by "Insert a default…" (see `insertProfiles`).
        setProfiles(r.body.profiles.filter((p) => p && p.id).map((p) => ({
          id: p.id,
          label: p.label || p.id,
          description: p.description || '',
          systemMessage: p.systemMessage || ''
        })));
      }
    } catch { /* ignore */ }
  }

  async function loadAppLaunchers() {
    try {
      const r = await fetchJson('/api/settings');
      if (r.status === 200 && r.body && r.body.app) {
        const app = readLaunchers(r.body.app.profileLaunchers);
        setLaunchers((prev) => ({ app, project: prev.project }));
        return app;
      }
    } catch { /* ignore */ }
    return null;
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
    setLaunchers((prev) => ({ app: prev.app, project: readLaunchers(projectBody.profileLaunchers) }));
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
    const nextPreset = p.preset ? presetFromRecord(p.preset) : null;
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

  // Preset editing. The editor state is `{ disabled: Set, agentFiles,
  // skills }` (null = nothing set); settings/presetTools.js owns the rules
  // and is exercised by scripts/test-preset-tools.js. Every tool starts
  // ticked; an unticked tool is saved in `disabledTools`.
  function updatePreset(fn) {
    setPreset((prev) => fn(prev || presetFromRecord(null)));
  }
  function setToolsSelected(names, checked) {
    updatePreset((base) => Object.assign({}, base, { disabled: applyToolToggle({ disabled: base.disabled, ids: names, checked }) }));
  }
  function setAgentFiles(checked) {
    updatePreset((base) => Object.assign({}, base, { agentFiles: !!checked }));
  }
  function setSkills(checked) {
    updatePreset((base) => Object.assign({}, base, { skills: !!checked }));
  }

  useEffect(() => { loadPrompts(); }, [projectDir]);
  useEffect(() => { loadProjectData(); }, [projectDir]);
  useEffect(() => { loadProfiles(); loadAppLaunchers(); }, []);
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
    if (nextId.startsWith(PROFILE_PREFIX)) {
      applyBuiltinToForm(profiles.find((x) => PROFILE_PREFIX + x.id === nextId));
      return;
    }
    const p = prompts.find((x) => x.id === nextId);
    applyPromptToForm(p || null);
  }

  // applyBuiltinToForm(profile) — load a built-in prompt-size profile.
  //
  // Its title and text are fixed server-side, so the editor shows them
  // read-only; only the launcher fields (icon + project-card pin) and the
  // store they are saved to (the Scope control) can change. No preset.
  function applyBuiltinToForm(profile, maps = launchers) {
    if (!profile) { applyPromptToForm(null); return; }
    const hasProject = !!projectDir;
    const eff = effectiveLauncher(maps, profile.id, hasProject);
    const scope = launcherSource(maps, profile.id, hasProject);
    const snap = {
      title: profile.label || profile.id,
      icon: eff.icon,
      showOnProjectCard: eff.showOnProjectCard,
      content: profile.systemMessage || '',
      preset: null,
      scope
    };
    setTitle(snap.title);
    setIcon(snap.icon);
    setShowOnProjectCard(snap.showOnProjectCard);
    setContent(snap.content);
    setPreset(null);
    setPromptScope(scope);
    setLoadedSnapshot(snap);
    dirtyRef.current = false;
  }

  // saveBuiltin() — write the launcher for the selected built-in profile
  // into the chosen store (app SQLite or the project's .mouaif.json).
  // Moving it between stores also removes the entry from the other one
  // on this screen, so the old value cannot keep winning.
  async function saveBuiltin() {
    const profileId = selectedId.slice(PROFILE_PREFIX.length);
    const entry = { icon, showOnProjectCard };
    const toProject = !!projectDir && promptScope === 'project';
    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });
    const put = (url, body) => fetchJson(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let r;
    try {
      if (toProject) {
        r = await put('/api/settings/project', { projectDir, profileLaunchers: withLauncher(launchers.project, profileId, entry) });
      } else {
        r = await put('/api/settings/app', { profileLaunchers: withLauncher(launchers.app, profileId, entry) });
        // Saving to the app store from a project screen: drop this
        // project's override so the app value is the one that applies.
        if (r.status === 200 && projectDir && Object.prototype.hasOwnProperty.call(launchers.project, profileId)) {
          const rest = Object.assign({}, launchers.project);
          delete rest[profileId];
          const r2 = await put('/api/settings/project', { projectDir, profileLaunchers: rest });
          if (r2.status !== 200) r = r2;
        }
      }
    } catch {
      setIsSaving(false);
      setStatusMsg({ text: 'network error', kind: 'error' });
      return;
    }
    setIsSaving(false);
    if (r.status !== 200) {
      setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' });
      return;
    }
    // Re-read both stores so the form reflects exactly what was persisted.
    const app = (await loadAppLaunchers()) || launchers.app;
    let project = launchers.project;
    if (projectDir) {
      try {
        const pr = await fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(projectDir));
        if (pr.status === 200 && pr.body) project = readLaunchers(pr.body.project && pr.body.project.profileLaunchers);
      } catch { /* keep the previous map */ }
    }
    const maps = { app, project };
    setLaunchers(maps);
    applyBuiltinToForm(profiles.find((x) => x.id === profileId), maps);
    setStatusMsg({ text: 'saved.', kind: 'success' });
  }

  async function save() {
    if (selectedId.startsWith(PROFILE_PREFIX)) { await saveBuiltin(); return; }
    const t = title.trim();
    const c = content.trim();
    if (!c) { setStatusMsg({ text: 'prompt content is required', kind: 'error' }); return; }

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

    // Unticked tools -> `disabledTools`; agent files / skills only when
    // ticked (a preset turns them on, never off). Nothing set -> null.
    body.preset = presetBody(preset);

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
  // Shallow copy is enough: every toggle replaces `tools` with a new Set
  // rather than mutating it, so the snapshot can share the reference.
  preset: preset ? { ...preset } : null,
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

  // buildPresetGroups() -> ToolTree groups
  //
  // The selection rule lives in settings/presetTools.js so it is
  // unit-tested; see scripts/test-preset-tools.js.
  function buildPresetGroups() {
    // Every tool is ticked unless the preset disables it. The row SET is
    // independent of the checked state, so enumerate ids with an all-on
    // pass first, then rebuild with the preset's selection.
    const allIds = [];
    for (const g of buildToolGroups(toolsCatalog, mcpServers, null, new Set())) {
      for (const t of (g.tools || [])) { if (t && t.id) allIds.push(t.id); }
    }
    const selected = presetToolSelection(preset && preset.disabled, allIds);
    const rawGroups = buildToolGroups(toolsCatalog, mcpServers, selected, new Set());

    const out = rawGroups.slice();

    if (agentFilesAvailable.length > 0) {
      const isLocked = agentFilesProjectLocked;
      const count = agentFilesAvailable.length;
      out.push({
        id: 'agent-files',
        // ToolTree renders `name` / `description`; the old `title` /
        // `subtitle` keys left this row nameless (just "off").
        name: 'Agent files',
        description: isLocked
          ? 'locked off by project settings'
          : count + (count === 1 ? ' file' : ' files') + ' · ' + agentFilesAvailable.join(', '),
        checked: !isLocked && !!(preset && preset.agentFiles),
        disabled: isLocked,
        tools: []
      });
    }

    if (skillsAvailable.length > 0) {
      const isLocked = skillsProjectLocked;
      const count = skillsAvailable.length;
      out.push({
        id: 'skills',
        name: 'Skills',
        description: isLocked
          ? 'locked off by project settings'
          : count + (count === 1 ? ' skill' : ' skills') + ' · ' + skillsAvailable.join(', '),
        checked: !isLocked && !!(preset && preset.skills),
        disabled: isLocked,
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
    setToolsSelected([toolId], checked);
  }

  const groups = useMemo(() => dataLoaded ? buildPresetGroups() : [], [
    dataLoaded, preset, toolsCatalog, mcpServers,
    agentFilesAvailable, agentFilesProjectLocked,
    skillsAvailable, skillsProjectLocked
  ]);

  const isNew = selectedId === NEW_PROMPT_ID;
  const isBuiltin = selectedId.startsWith(PROFILE_PREFIX);
  const currentBuiltin = isBuiltin ? profiles.find((p) => PROFILE_PREFIX + p.id === selectedId) : null;
  const dirty = isDirty();
  dirtyRef.current = dirty;
  const currentPrompt = !isNew && !isBuiltin ? prompts.find((p) => p.id === selectedId) : null;
  const pickerLabel = isNew
    ? (title.trim() ? title.trim() + ' (new)' : '+ New prompt')
    : isBuiltin
      ? ((currentBuiltin && currentBuiltin.label) || 'Built-in prompt')
      : ((currentPrompt && (currentPrompt.title || currentPrompt.id)) || 'Choose a prompt');
  const copyDisabled = !content;
  // A built-in has fixed (possibly empty — Chat) text, so it saves on any
  // launcher change; a custom prompt needs content.
  const hasContent = isBuiltin || !!content.trim();
  // "Insert a default…" only offers profiles that actually have text.
  const insertProfiles = profiles.filter((p) => p.systemMessage && p.systemMessage.trim());
  // Scope control: new custom prompts and built-ins (on a project screen).
  const showScopeSeg = !!projectDir && (isNew || isBuiltin);

  // On the App-defaults screen every prompt is app-scoped by definition, so the
  // per-option scope badge (["app"]) is redundant noise that reads as a weird
  // item in the dropdown. Only badge scope on the project screen, where prompts
  // may be project-owned or inherited from the app.
  const showScopeBadge = !!projectDir;

  // Project scope goes back to project settings (keeping the chat and the
  // origin); the App-defaults scope is the Settings root, never a project
  // page built from an unrelated active project.
  const backHref = projectDir ? settingsLink('settings/project', { projectDir, chatId, from }) : '#/settings';

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
profiles.length ? h('div', { class: 'prompts__picker-section', role: 'presentation' }, 'Built-in') : null,
profiles.map((p) => {
const id = PROFILE_PREFIX + p.id;
const selected = id === selectedId;
const eff = effectiveLauncher(launchers, p.id, !!projectDir);
return h('button', {
type: 'button',
key: id,
class: 'prompts__picker-option prompts__picker-option--profile' + (selected ? ' is-selected' : ''),
role: 'option',
'aria-selected': String(selected),
onClick: () => handleSelectPrompt(id)
},
h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
h('span', { class: 'prompts__picker-option-label' },
h(PromptIcon, { name: eff.icon, size: 17, class: 'prompts__picker-icon' }),
h('span', null, p.label),
h('span', { class: 'prompts__picker-preset' }, 'built-in'),
eff.showOnProjectCard ? h('span', { class: 'prompts__picker-preset' }, 'on card') : null
)
);
})
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
        dirty
        ? h('p', { class: 'hint prompts__dirty' },
        isNew ? 'Not created yet — tap Create below to keep it.' : 'Unsaved changes — tap Save below to keep them.')
        : null,
      isBuiltin
        ? h('p', { class: 'hint hint--compact prompts__builtin-note' },
            'Built-in prompt: its text is fixed. You can change its icon and pin it to the project card.')
        : null
      ),

      // ---- Scope selector (when creating a new prompt with an active project) ----
      showScopeSeg ? h('div', { class: 'row' },
        h('label', { class: 'label' }, isBuiltin ? 'Save icon settings to' : 'Scope'),
        h('div', { class: 'seg prompts__scope-seg', role: 'radiogroup', 'aria-label': 'Prompt scope' },
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
          isBuiltin ? 'Title' : 'Title (optional)'
        ),
        h('input', {
          value: title,
          onInput: (e) => setTitle(e.currentTarget.value),
          readOnly: isBuiltin,
          class: 'input' + (isBuiltin ? ' is-readonly' : ''),
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
          readOnly: isBuiltin,
          class: 'input prompts__textarea' + (isBuiltin ? ' is-readonly' : ''),
          id: 'spe-content',
          rows: 6,
          placeholder: isBuiltin ? '(empty — no system prompt)' : 'You are a helpful assistant specialized in…'
        }),
        isBuiltin ? null : h('div', { class: 'prompts__from-default' },
          h('button', {
          type: 'button',
          class: 'btn btn--small prompts__from-default-btn',
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
          }, showProfileCopy ? 'Hide defaults' : 'Insert a default…'),
          h('span', { class: 'prompts__from-default-hint' },
          'Replace the content with a built-in profile, then edit.'
          )
          ),
        !isBuiltin && showProfileCopy ? h('div', { class: 'prompts__profile-pick' },
          insertProfiles.length
            ? insertProfiles.map((p) =>
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
      // Always visible. Every tool starts ticked; an unticked tool starts
      // switched off in chats created from this prompt (the user can tick
      // it again there). Nothing changed saves "no preset".
      isBuiltin ? null : h('div', { class: 'row prompts__preset' },
        h('span', { class: 'label prompt-label' }, 'Chat preset'),
        h('p', { class: 'hint prompts__preset-hint' },
          'Unticked tools start off in new chats with this prompt. You can turn them back on in the chat.'),
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
      // Sticky so Save/Create stays reachable on a phone without scrolling
      // past the preset tree. Disabled until there is content to save.
      h('div', { class: 'row row--actions prompts__actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: save,
          disabled: isSaving || !hasContent || (!dirty && !isNew),
          title: hasContent ? undefined : 'Add prompt content first'
        }, isSaving ? 'Saving…' : (isNew ? 'Create' : 'Save')),
        h('button', {
          class: 'btn btn--danger',
          type: 'button',
          onClick: deletePrompt,
          hidden: isNew || isBuiltin,
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
