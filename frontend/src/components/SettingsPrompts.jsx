// mouaif web — SettingsPromptsView
//
// Single-screen custom-prompt editor. Replaces the old two-step
// list → edit flow with a dropdown-driven form: pick a prompt at
// the top (or "+ New prompt"), edit title / content / preset
// in-place, hit Save. Switching the dropdown to another prompt
// while the current one has unsaved changes asks for confirmation
// so the user does not silently lose work.
//
// The prompt's optional **chat preset** (tools + agent files + skills)
// uses the SAME controls as the rest of the settings: the standard
// `ToolTree` (the same one the chat Tools card and Settings → Project
// use) and synthetic `agent-files` / `skills` groups that mirror
// the chat's ToolPopup. There is no bespoke checklist — a prompt
// preset is a per-chat allowlist, so it lists the same tools the
// chat can pick.
import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { ToolTree, buildToolGroups } from './ToolTree.jsx';

// Sentinel id used by the "new prompt" entry in the picker dropdown.
const NEW_PROMPT_ID = '__new__';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
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
  if (view && view.projectDir) return view.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

// agentFileNameOf(entry) -> string
// Defensive accessor for agent-file entries (the /api/features payload
// uses { name, size } while the chat path also emits { name, relPath }).
function agentFileNameOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.name || entry.relPath || '';
}

// skillIdOf(entry) -> string
// Skill entries from the catalog carry `id` (the kebab-case skill name).
function skillIdOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.id || entry.name || '';
}

// Compare two presets for "saved state" equality. Returns true when
// the two presets would serialize to the same payload (so the dirty
// flag clears on Save). Both null is "equal" (both have no preset).
function presetsEqual(a, b) {
  const norm = (p) => {
    if (!p) return null;
    const tools = p.tools instanceof Set
      ? Array.from(p.tools).sort()
      : (Array.isArray(p.tools) ? p.tools.slice().sort() : []);
    const hasAny = tools.length || p.agentFiles || p.skills;
    if (!hasAny) return null;
    return { tools, agentFiles: !!p.agentFiles, skills: !!p.skills };
  };
  const A = norm(a);
  const B = norm(b);
  if (A === null && B === null) return true;
  if (!A || !B) return false;
  if (A.agentFiles !== B.agentFiles) return false;
  if (A.skills !== B.skills) return false;
  if (A.tools.length !== B.tools.length) return false;
  for (let i = 0; i < A.tools.length; i++) {
    if (A.tools[i] !== B.tools[i]) return false;
  }
  return true;
}

export function SettingsPromptsView(props) {
  const projectDir = resolveProjectDir(props);

  // List of prompts for the project (fetched once on mount / project change).
  const [prompts, setPrompts] = useState([]);

  // The id of the prompt currently being edited in the dropdown. The
  // sentinel NEW_PROMPT_ID represents an unsaved "new prompt" form.
  // `initialId` (from a legacy deep link) seeds the picker after the
  // list loads; until then we leave it as the sentinel so the form
  // is empty by default.
  const [selectedId, setSelectedId] = useState(NEW_PROMPT_ID);
  const initialId = (props && props.initialId) || '';

  // Editable fields.
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  // Preset state. `tools` is a Set<string> of model-facing tool names
  // (native family names + MCP slugs). `agentFiles` and `skills` are
  // booleans. The whole object is `null` when the preset is off.
  const [preset, setPreset] = useState(null);

  // Status + busy flags.
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [copyStatus, setCopyStatus] = useState('Copy');

  // Dirty tracking. The dropdown switcher consults this to decide
  // whether to confirm before discarding edits.
  const [loadedSnapshot, setLoadedSnapshot] = useState({ title: '', content: '', preset: null });

  // Catalog + locks for the ToolTree. Loaded from the project once,
  // then threaded into `buildToolGroups` every render so the
  // checkbox state reflects the latest preset edits.
  const [toolsCatalog, setToolsCatalog] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [agentFilesAvailable, setAgentFilesAvailable] = useState([]);
  const [agentFilesProjectLocked, setAgentFilesProjectLocked] = useState(false);
  const [skillsAvailable, setSkillsAvailable] = useState([]);
  const [skillsProjectLocked, setSkillsProjectLocked] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Refs to keep callbacks stable across renders so the dropdown
  // change handler can read the latest "dirty" state without being
  // recreated on every keystroke.
  const dirtyRef = useRef(false);
  const loadedRef = useRef(loadedSnapshot);
  loadedRef.current = loadedSnapshot;

  // -------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------

  async function loadPrompts() {
    if (!projectDir) {
      setPrompts([]);
      return;
    }
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { return; }
    if (r.status !== 200) return;
    const list = r.body.prompts || [];
    setPrompts(list);
  }

  async function loadProjectData() {
    if (!projectDir) return;
    setDataLoaded(false);
    // Catalog and MCP servers feed `buildToolGroups`. The agent-files
    // and skills discovery + project locks feed the synthetic groups.
    // Four parallel reads; any failure keeps the empty defaults so
    // the preset still saves — the user just won't see MCP tools in
    // the tree if the catalog failed.
    const [toolsRes, mcpRes, featuresRes, projectRes] = await Promise.all([
      fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir)).catch(() => ({ status: 0, body: {} })),
      fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)).catch(() => ({ status: 0, body: {} })),
      fetchJson('/api/features?projectDir=' + encodeURIComponent(projectDir)).catch(() => ({ status: 0, body: {} })),
      fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(projectDir)).catch(() => ({ status: 0, body: {} }))
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

  // Load the prompt currently selected in the dropdown into the form.
  // For NEW_PROMPT_ID, just clear the form.
  function applyPromptToForm(p) {
    if (!p) {
      const snap = { title: '', content: '', preset: null };
      setTitle(snap.title);
      setContent(snap.content);
      setPreset(snap.preset);
      setLoadedSnapshot(snap);
      dirtyRef.current = false;
      return;
    }
    const pp = p.preset;
    const nextPreset = (pp && (Array.isArray(pp.tools) || typeof pp.agentFiles === 'boolean' || typeof pp.skills === 'boolean'))
      ? {
          tools: new Set(Array.isArray(pp.tools) ? pp.tools : []),
          agentFiles: pp.agentFiles === true,
          skills: pp.skills === true
        }
      : null;
    const snap = { title: p.title || '', content: p.content || '', preset: nextPreset };
    setTitle(snap.title);
    setContent(snap.content);
    setPreset(nextPreset);
    setLoadedSnapshot(snap);
    dirtyRef.current = false;
  }

  // -------------------------------------------------------------------
  // Dirty tracking
  // -------------------------------------------------------------------

  function isDirty() {
    if (title !== loadedSnapshot.title) return true;
    if (content !== loadedSnapshot.content) return true;
    if (!presetsEqual(preset, loadedSnapshot.preset)) return true;
    return false;
  }

  // -------------------------------------------------------------------
  // Preset mutators (same logic the old edit view used)
  // -------------------------------------------------------------------

  function presetActive() { return !!preset; }
  function toolSelected(name) {
    return !!(preset && preset.tools && preset.tools.has(name));
  }
  function setToolSelected(name, checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), agentFiles: false, skills: false };
      const next = new Set(base.tools);
      if (checked) next.add(name); else next.delete(name);
      return { tools: next, agentFiles: !!base.agentFiles, skills: !!base.skills };
    });
  }
  function setToolsSelected(names, checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), agentFiles: false, skills: false };
      const next = new Set(base.tools);
      for (const n of names) {
        if (checked) next.add(n); else next.delete(n);
      }
      return { tools: next, agentFiles: !!base.agentFiles, skills: !!base.skills };
    });
  }
  function setAgentFiles(checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), agentFiles: false, skills: false };
      return { tools: new Set(base.tools), agentFiles: !!checked, skills: !!base.skills };
    });
  }
  function setSkills(checked) {
    setPreset((prev) => {
      const base = prev || { tools: new Set(), agentFiles: false, skills: false };
      return { tools: new Set(base.tools), agentFiles: !!base.agentFiles, skills: !!checked };
    });
  }
  function togglePresetOn(checked) {
    if (checked) {
      // Seed an empty preset so toggling on yields a non-null object
      // the UI can attach rows to. Saving normalizes an all-false
      // preset to null, so the user can flip the master switch back
      // off and the record stays clean.
      setPreset({ tools: new Set(), agentFiles: false, skills: false });
      return;
    }
    setPreset(null);
  }

  // -------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------

  useEffect(() => { loadPrompts(); }, [projectDir]);
  useEffect(() => { if (projectDir) loadProjectData(); }, [projectDir]);

  // Once the list loads, apply a legacy `initialId` (from the old
  // two-step URL `settings/prompts/:id`) by switching the picker to
  // that prompt. NEW_PROMPT_ID and the empty string are ignored.
  useEffect(() => {
    if (!initialId) return;
    if (selectedId !== NEW_PROMPT_ID) return; // already moved off the sentinel
    if (!prompts.length) return;
    const p = prompts.find((x) => x.id === initialId);
    if (!p) return;
    setSelectedId(p.id);
    applyPromptToForm(p);
    // We only want to honor initialId on the first load; further
    // edits in this session should follow the dropdown. eslint
    // would flag `applyPromptToForm` as a dep; it's stable enough
    // (it only calls setters) that omitting is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts, initialId]);

  // Keep dirtyRef in sync. Recomputed on every render — cheap.
  dirtyRef.current = isDirty();

  // -------------------------------------------------------------------
  // Dropdown change handler — confirm if dirty, then load the new prompt.
  // -------------------------------------------------------------------

  function onSelectPrompt(e) {
    const nextId = e.currentTarget.value;
    if (nextId === selectedId) return;
    if (dirtyRef.current) {
      const ok = confirm('Discard unsaved changes to this prompt?');
      if (!ok) {
        // Revert the <select> to the current value. We do that by
        // re-rendering with the original value via a forced update.
        e.currentTarget.value = selectedId;
        return;
      }
    }
    setSelectedId(nextId);
    if (nextId === NEW_PROMPT_ID) {
      applyPromptToForm(null);
      setStatusMsg({ text: '', kind: '' });
      return;
    }
    const p = prompts.find((x) => x.id === nextId);
    if (p) {
      applyPromptToForm(p);
      setStatusMsg({ text: 'loaded "' + (p.title || p.id) + '"', kind: 'success' });
    }
  }

  // -------------------------------------------------------------------
  // Save / delete / copy / new
  // -------------------------------------------------------------------

  async function save() {
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    const t = title.trim();
    const c = content.trim();
    if (!c) { setStatusMsg({ text: 'prompt content is required', kind: 'error' }); return; }
    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });
    const body = { projectDir, title: t, content: c };
    if (presetActive()) {
      // Normalize the local Set into an array for the wire payload.
      // Empty tools list + both toggles off collapses to null so the
      // stored preset is the canonical "no preset" shape.
      const p = preset;
      const hasAny = (p.tools && p.tools.size > 0) || p.agentFiles || p.skills;
      body.preset = hasAny ? {
        tools: Array.from(p.tools || []),
        agentFiles: p.agentFiles === true,
        skills: p.skills === true
      } : null;
    } else {
      body.preset = null;
    }
    const isNew = selectedId === NEW_PROMPT_ID;
    const url = isNew
      ? '/api/prompts'
      : '/api/prompts/' + encodeURIComponent(selectedId);
    const method = isNew ? 'POST' : 'PATCH';
    let r;
    try { r = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsSaving(false); return; }
    setIsSaving(false);
    if (r.status !== 200 && r.status !== 201) {
      setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' });
      return;
    }
    // Reload the list so the new / updated prompt is in the dropdown.
    await loadPrompts();
    // Switch to the saved prompt (or stay on the updated one).
    const saved = r.body.prompt;
    if (saved && saved.id) {
      setSelectedId(saved.id);
      applyPromptToForm(saved);
    } else {
      // Fallback: just re-snapshot the current form values.
      setLoadedSnapshot({ title: t, content: c, preset: preset ? { ...preset, tools: new Set(preset.tools) } : null });
      dirtyRef.current = false;
    }
    setStatusMsg({ text: 'saved.', kind: 'success' });
  }

  async function deletePrompt() {
    if (selectedId === NEW_PROMPT_ID) return;
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;
    setIsDeleting(true);
    setStatusMsg({ text: 'deleting…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(selectedId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); setIsDeleting(false); return; }
    await loadPrompts();
    // Jump to the "new prompt" entry so the form is empty and ready.
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
        // Always copy the SAVED content (not the in-flight edit), so
        // a user can grab a known-good prompt even mid-typing.
        text = p.content || '';
        label = p.title || p.id;
      }
    } else {
      // For a brand-new prompt, copy whatever's in the textarea.
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
    setSelectedId(NEW_PROMPT_ID);
    applyPromptToForm(null);
    setStatusMsg({ text: '', kind: '' });
  }

  // -------------------------------------------------------------------
  // Preset group building (same logic the old edit view used)
  // -------------------------------------------------------------------

  function buildPresetGroups() {
    const selected = preset ? Array.from(preset.tools) : [];
    const groups = buildToolGroups(toolsCatalog, mcpServers, selected, new Set());
    // Re-mark each row's `checked` from the preset's local Set so a
    // tool the user just picked shows checked even when the catalog
    // is empty / the group is `alwaysExpanded`.
    for (const g of groups) {
      const want = (g.id === 'agent-files')
        ? !!(preset && preset.agentFiles)
        : (g.id === 'skills')
          ? !!(preset && preset.skills)
          : (preset && preset.tools && preset.tools.has(g.id));
      g.checked = !!want;
      for (const t of (g.tools || [])) {
        t.checked = !!(preset && preset.tools && preset.tools.has(t.id));
      }
    }
    if (agentFilesAvailable.length) {
      groups.push({
        id: 'agent-files',
        name: 'Agent files',
        description: (preset && preset.agentFiles) ? 'on for chats using this prompt' : 'off',
        checked: !!(preset && preset.agentFiles),
        disabled: !!agentFilesProjectLocked,
        disabledReason: agentFilesProjectLocked ? 'Locked off by Settings → Project.' : '',
        alwaysExpanded: true,
        tools: agentFilesAvailable.map((f) => ({
          id: f, name: f, description: '',
          checked: !!(preset && preset.agentFiles),
          disabled: !!agentFilesProjectLocked
        }))
      });
    }
    if (skillsAvailable.length) {
      groups.push({
        id: 'skills',
        name: 'Skills',
        description: (preset && preset.skills) ? 'on for chats using this prompt' : 'off',
        checked: !!(preset && preset.skills),
        disabled: !!skillsProjectLocked,
        disabledReason: skillsProjectLocked ? 'Locked off by Settings → Project.' : '',
        alwaysExpanded: true,
        tools: skillsAvailable.map((s) => ({
          id: s, name: s, description: '',
          checked: !!(preset && preset.skills),
          disabled: !!skillsProjectLocked
        }))
      });
    }
    return groups;
  }

  function handlePresetToggleGroup(groupId, checked) {
    if (groupId === 'agent-files') { setAgentFiles(checked); return; }
    if (groupId === 'skills') { setSkills(checked); return; }
    const group = buildPresetGroups().find((g) => g.id === groupId);
    if (group) setToolsSelected((group.tools || []).map((t) => t.id), checked);
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

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
        h('h2', { class: 'view-title' }, 'Custom prompts')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  const isNew = selectedId === NEW_PROMPT_ID;
  const dirty = dirtyRef.current;
  const currentPrompt = !isNew ? prompts.find((p) => p.id === selectedId) : null;
  const copyDisabled = isNew && !content;

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Custom prompts')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' },
        'Per-project system prompts. Saved in the project\u2019s .mouaif.json alongside other settings.'
      ),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),

      // ---- Picker ----------------------------------------------------
      // Single dropdown: pick a prompt to edit, or "+ New prompt" for
      // a blank form. The Copy button next to it copies the selected
      // prompt's content (works for both saved prompts and the new
      // prompt draft). A "New" button is also exposed for users who
      // would rather click than change the dropdown.
      h('div', { class: 'row prompts__picker' },
        h('label', { class: 'label', for: 'sp-picker' }, 'Prompt'),
        h('div', { class: 'prompts__picker-row' },
          h('select', {
            class: 'input prompts__select',
            id: 'sp-picker',
            value: selectedId,
            onChange: onSelectPrompt
          },
            h('option', { value: NEW_PROMPT_ID }, '+ New prompt'),
            prompts.length === 0
              ? h('option', { value: '', disabled: true }, '(no saved prompts yet)')
              : prompts.map((p) =>
                h('option', { value: p.id, key: p.id },
                  (p.title || p.id) +
                  (p.preset && Object.keys(p.preset).length ? '  \u2022 preset' : '')
                )
              )
          ),
          h('button', {
            type: 'button',
            class: 'btn prompts__copy' + (copyStatus === 'Copied' ? ' is-copied' : (copyStatus === 'Copy failed' ? ' is-error' : '')),
            onClick: copyCurrent,
            disabled: copyDisabled,
            'aria-label': 'Copy current prompt to clipboard',
            title: 'Copy this prompt\u2019s content to the clipboard'
          }, copyStatus),
          h('button', {
            type: 'button',
            class: 'btn',
            onClick: startNewPrompt
          }, 'New')
        ),
        dirty ? h('p', { class: 'hint prompts__dirty' }, 'Unsaved changes — switch prompts to discard or hit Save.') : null
      ),

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
        h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', {
          value: content,
          onInput: (e) => setContent(e.currentTarget.value),
          class: 'input prompts__textarea',
          id: 'spe-content',
          rows: 6,
          placeholder: 'You are a helpful assistant specialized in\u2026'
        })
      ),

      // ---- Prompt preset --------------------------------------------
      // A preset is chat-default packaging: when a chat references
      // this prompt, its tool allowlist and agent-files / skills
      // toggles ride along. It only ADDS capability — a chat
      // already inheriting all tools keeps them, and the project's
      // off/ask/allow gate stays authoritative. The master switch
      // decides whether the prompt even carries a preset; the tool
      // tree and toggles underneath are inert while it is off.
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
          'Tools are additive — a chat that already has a tool keeps it, and the project\u2019s Off/Ask/Allow still wins. ',
          'Agent files inject AGENTS.md / CLAUDE.md. Skills inject .agents/skills/*/SKILL.md. ',
          'The project can lock any of these off; the preset cannot override that lock.'
        )
      ),
      !presetActive() ? null : h('div', { class: 'row prompts__preset-body' },
        dataLoaded
          ? h(ToolTree, {
            groups,
            onToggleGroup: handlePresetToggleGroup,
            onToggleTool: handlePresetToggleTool,
            collapsedByDefault: true,
            class: 'prompts__preset-tree'
          })
          : h('div', { class: 'prompts__preset-loading' }, 'loading tools\u2026')
      ),

      // ---- Actions ---------------------------------------------------
      h('div', { class: 'row row--actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: save,
          disabled: isSaving || (!dirty && !isNew)
        }, isSaving ? 'Saving\u2026' : (isNew ? 'Create' : 'Save')),
        h('button', {
          class: 'btn btn--danger',
          type: 'button',
          onClick: deletePrompt,
          hidden: isNew,
          disabled: isDeleting
        }, isDeleting ? 'Deleting\u2026' : 'Delete'),
        h('span', {
          class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''),
          'aria-live': 'polite'
        }, statusMsg.text)
      )
    )
  );
}
