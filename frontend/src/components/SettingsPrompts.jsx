// mouaif web — SettingsPromptsView + SettingsPromptEditView
//
// Both views are project-scoped. The active project is resolved in
// this order:
//   1. The `projectDir` prop passed in from the router (used by
//      deep links and tests).
//   2. The `activeProject` signal (set when the user opened a chat).
// If neither resolves, the view shows a "pick a project" empty
// state and never calls the API.
//
// The prompt's optional **chat preset** (tools + agent files + skills)
// uses the SAME controls as the rest of the settings: the standard
// `ToolTree` (the same one the chat Tools card and Settings → Project
// use) and synthetic `agent-files` / `skills` groups that mirror the
// chat's ToolPopup. There is no bespoke checklist — a prompt preset is
// a per-chat allowlist, so it lists the same tools the chat can pick.
import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { nav } from '../router.js';
import { ToolTree, buildToolGroups } from './ToolTree.jsx';

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

export function SettingsPromptsView(props) {
  const projectDir = resolveProjectDir(props);
  const [prompts, setPrompts] = useState([]);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });

  function Copier({ text }) {
    const [status, setStatus] = useState('Copy');
    const doCopy = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(text);
      setStatus(ok ? 'Copied' : 'Copy failed');
      setTimeout(() => setStatus('Copy'), 1400);
    };
    return h('button', {
      type: 'button',
      class: 'prompt-row__copy' + (status === 'Copied' ? ' is-copied' : (status === 'Copy failed' ? ' is-error' : '')),
      'aria-label': 'Copy prompt to clipboard',
      onClick: doCopy
    }, status);
  }

  async function load() {
    if (!projectDir) {
      setPrompts([]);
      setStatusMsg({ text: 'open a chat to pick a project first', kind: 'error' });
      return;
    }
    setStatusMsg({ text: 'loading…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return; }
    const list = r.body.prompts || [];
    setPrompts(list);
    setStatusMsg({ text: list.length + (list.length === 1 ? ' prompt' : ' prompts'), kind: 'success' });
  }

  useEffect(() => { load(); }, [projectDir]);

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

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Custom prompts')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Per-project system prompts. Saved in the project\'s .mouaif.json alongside other settings.'),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('ul', { class: 'prompts__list', 'aria-label': 'Custom prompts' },
        prompts.length === 0
          ? h('li', { class: 'prompts__empty' }, 'No custom prompts yet. Tap "Add prompt" to create your first one.')
          : prompts.map(p => {
            let presetBadge = null;
            if (p.preset && Object.keys(p.preset).length) {
              const bits = [];
              const toolCount = Array.isArray(p.preset.tools) ? p.preset.tools.length : 0;
              if (toolCount) bits.push(toolCount + (toolCount === 1 ? ' tool' : ' tools'));
              if (p.preset.agentFiles === true) bits.push('agent files on');
              if (p.preset.skills === true) bits.push('skills on');
              presetBadge = h('div', { class: 'prompt-row__preset' }, 'preset: ' + (bits.length ? bits.join(' · ') : 'empty'));
            }
            return h('li', { key: p.id, class: 'prompt-row' },
              h('a', { class: 'prompt-row__main', href: '#/settings/prompts/' + encodeURIComponent(p.id) + '?projectDir=' + encodeURIComponent(projectDir) },
                h('div', { class: 'prompt-row__title' }, p.title || p.id),
                h('div', { class: 'prompt-row__meta' }, p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content),
                h('div', { class: 'prompt-row__chev' }, '›')
              ),
              presetBadge,
              h(Copier, { text: p.content })
            );
          })
      ),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/prompts/new?projectDir=' + encodeURIComponent(projectDir),
          class: 'btn btn--primary'
        }, '+ Add prompt'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      )
    )
  );
}

// ---- Edit view ----------------------------------------------------------
//
// Local state shape (mirrors the saved preset):
//   preset = null | { tools: Set<string>, agentFiles: bool, skills: bool }
//
// `null` means the chat-preset is OFF (the master switch is off). Any
// non-null object means the preset is on; the Save path normalizes an
// object with all three fields false into `null` so the persisted record
// stays tidy.
export function SettingsPromptEditView(props) {
  const promptId = (props && props.id) || '';
  const projectDir = resolveProjectDir(props);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Preset state. `tools` is a Set<string> of model-facing tool names
  // (native family names + MCP slugs). `agentFiles` and `skills` are
  // booleans. The whole object is `null` when the preset is off.
  const [preset, setPreset] = useState(null);
  // Catalog + locks for the ToolTree. Loaded from the project once, then
  // threaded into `buildToolGroups` every render so the checkbox state
  // reflects the latest preset edits.
  const [toolsCatalog, setToolsCatalog] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [agentFilesAvailable, setAgentFilesAvailable] = useState([]);
  const [agentFilesProjectLocked, setAgentFilesProjectLocked] = useState(false);
  const [skillsAvailable, setSkillsAvailable] = useState([]);
  const [skillsProjectLocked, setSkillsProjectLocked] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  function presetActive() {
    return !!preset;
  }

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

  async function load() {
    if (!projectDir) {
      setStatusMsg({ text: 'no project selected', kind: 'error' });
      return;
    }
    if (!promptId) {
      setTitle('');
      setContent('');
      setPreset(null);
      setStatusMsg({ text: '', kind: '' });
      return;
    }
    setStatusMsg({ text: 'loading…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return; }
    const p = r.body.prompt;
    setTitle(p.title || '');
    setContent(p.content || '');
    const pp = p.preset;
    if (pp && (Array.isArray(pp.tools) || typeof pp.agentFiles === 'boolean' || typeof pp.skills === 'boolean')) {
      setPreset({
        tools: new Set(Array.isArray(pp.tools) ? pp.tools : []),
        agentFiles: pp.agentFiles === true,
        skills: pp.skills === true
      });
    } else {
      setPreset(null);
    }
    setStatusMsg({ text: 'loaded', kind: 'success' });
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
    // The /api/features payload uses an `enabled` field (the chat-effective
    // default) plus a project-level lock we read from /api/settings/project
    // below. For the synthetic group's `projectLocked` we want the
    // project's master switch, not the default-on chat-effective value.
    setSkillsAvailable(Array.isArray(sk.items) ? sk.items.map(skillIdOf).filter(Boolean) : []);
    const projectBody = (projectRes.status === 200 && projectRes.body && projectRes.body.project) || {};
    setAgentFilesProjectLocked(projectBody.agentFiles === false);
    setSkillsProjectLocked(projectBody.skills === false);
    setDataLoaded(true);
  }

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
      // stored preset is the canonical "no preset" shape and the
      // getter's `p.preset ? p.preset : null` check stays simple.
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
    const url = promptId ? '/api/prompts/' + encodeURIComponent(promptId) : '/api/prompts';
    const method = promptId ? 'PATCH' : 'POST';
    let r;
    try { r = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsSaving(false); return; }
    setIsSaving(false);
    if (r.status !== 200 && r.status !== 201) {
      setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setStatusMsg({ text: 'saved.', kind: 'success' });
    if (!promptId && r.status === 201) {
      nav('settings/prompts/' + encodeURIComponent(r.body.prompt.id) + '?projectDir=' + encodeURIComponent(projectDir));
    }
  }

  async function deletePrompt() {
    if (!promptId) return;
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;
    setIsDeleting(true);
    setStatusMsg({ text: 'deleting…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); setIsDeleting(false); return; }
    nav('settings/prompts?projectDir=' + encodeURIComponent(projectDir));
  }

  useEffect(() => { load(); }, [projectDir, promptId]);
  useEffect(() => { if (projectDir) loadProjectData(); }, [projectDir]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back' }, '←'),
        h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  // buildPresetGroups() — the ToolTree input for the preset section.
  //
  // The same `buildToolGroups(catalog, mcpServers, filter, usedTools)`
  // the chat Tools card uses, plus two synthetic groups at the end:
  // `agent-files` (mirroring the chat popup) and `skills` (also
  // mirroring the chat popup). Project-level `agentFiles === false` /
  // `skills === false` lock the group; the preset cannot override the
  // project's authorization gate.
  //
  // The `filter` argument is the `chat.tools` allowlist semantics:
  // null = all on, Set = only those. The preset adds tools, so the
  // "checked" state is `toolSelected(id) || (filter is null)`. But
  // for the preset UI we want to show the user's selection, not the
  // project's, so we hand `buildToolGroups` the preset's tool list
  // — the picker UX is "is this tool in the preset", not "would it
  // pass the chat's allowlist". The full chat resolution is done
  // server-side in prompts.effectivePresetConfig.
  function buildPresetGroups() {
    const selected = preset ? Array.from(preset.tools) : [];
    const groups = buildToolGroups(toolsCatalog, mcpServers, selected, new Set());
    // Re-mark each row's `checked` from the preset's local Set so a
    // tool the user just picked shows checked even when the catalog
    // is empty / the group is `alwaysExpanded`. `buildToolGroups`
    // already seeds `checked` from the filter, so this is a
    // belt-and-braces override.
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
    // Synthetic agent-files group. Same shape as ToolPopup's so the
    // visual matches the rest of the settings.
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

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/prompts?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to prompts' }, '←'),
      h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-title' }, 'Title'),
        h('input', { value: title, onInput: e => setTitle(e.target.value), class: 'input', id: 'spe-title', type: 'text', placeholder: 'My custom prompt' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', { value: content, onInput: e => setContent(e.target.value), class: 'input prompts__textarea', id: 'spe-content', rows: 6, placeholder: 'You are a helpful assistant specialized in…' })
      ),
      // ---- Prompt preset ---------------------------------------------
      // A preset is chat-default packaging: when a chat references this
      // prompt, its tool allowlist and agent-files / skills toggles ride
      // along. It only ADDS capability — a chat already inheriting all
      // tools keeps them, and the project's off/ask/allow gate stays
      // authoritative. The master switch decides whether the prompt even
      // carries a preset; the tool tree and toggles underneath are inert
      // while it is off.
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
              h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
            ),
            h('span', { class: 'prompts__preset-desc' }, 'Tools, agent files, and skills a chat gets when it uses this prompt.')
          )
        ),
        h('p', { class: 'hint hint--compact prompts__preset-note' },
          'Tools are additive — a chat that already has a tool keeps it, and the project’s Off/Ask/Allow still wins. ',
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
          : h('div', { class: 'prompts__preset-loading' }, 'loading tools…')
      ),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, promptId ? 'Save' : 'Create'),
        h('button', { class: 'btn btn--danger', type: 'button', onClick: deletePrompt, hidden: !promptId, disabled: isDeleting }, 'Delete'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      )
    )
  );
}
