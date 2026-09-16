// mouaif web — SettingsAgentsView + SettingsAgentEditView
//
// Project agents (subagent delegation personas). Project-scoped, same
// resolution order as SettingsPrompts:
//   1. The `projectDir` prop passed in from the router (deep links).
//   2. The `activeProject` signal (set when the user opened a chat or
//      visited Settings → Project).
// The list view mirrors SettingsPrompts (rows link to the edit view);
// the edit view keeps the auto-save behavior agents always had — field
// edits PATCH on a short debounce, no Save button.
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { createAgentAutosave } from './settings/agentAutosave.js';
import { agentQuery, agentEditorPath, agentBackPath } from './settings/agentNavigation.js';
import { fetchJson, fetchLiveModels, activeProject } from '../api.js';
import { nav } from '../router.js';
import { ToolTree, buildAgentToolGroups } from './ToolTree.jsx';
import { ModelPickerField } from './ModelPickerField.jsx';
import { ThinkingSelectField } from './ThinkingSelectField.jsx';
import './settings/agents.css';

function resolveProjectDir(view) {
  if (view && view.projectDir) return view.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

// The tool allowlist choices shown on an agent's editor. Native tools
// plus one entry per configured MCP server (appended at runtime).
const NATIVE_TOOL_CHOICES = [
  { value: 'shell', label: 'shell' },
  { value: 'subagent', label: 'subagent' },
  { value: 'task', label: 'task' },
{ value: 'webpreview', label: 'webpreview' },
{ value: 'restart_app', label: 'restart_app' },
  { value: 'image_gen', label: 'image_gen' },
{ value: 'report_progress', label: 'report_progress' },

  { value: 'ask_user', label: 'ask_user' },
  { value: 'list_features', label: 'list_features' },
  { value: 'read_file', label: 'read_file' },
  { value: 'list_files', label: 'list_files' },
  { value: 'search_files', label: 'search_files' },
  { value: 'write_file', label: 'write_file' },
  { value: 'edit_file', label: 'edit_file' }
];

function toolChoicesWithMcp(servers) {
  return NATIVE_TOOL_CHOICES.concat(
    (servers || []).filter(s => s && s.id).map(s => ({
      value: 'mcp__' + (s.slug || s.id),
      label: 'MCP: ' + (s.name || s.id)
    }))
  );
}

// Apply a tool toggle to an agent allowlist, shared by the two
// editors. currentTools === undefined means "inherit everything".
// Returns { tools, send }: `tools` is the new state value
// (undefined = inherit), `send` is what to PATCH ([] = inherit).
function toggleToolInList(currentTools, toolId, checked, allChoices) {
  const all = allChoices.map((c) => c.value);
  const current = currentTools !== undefined ? currentTools.slice() : null;
  let next;
  if (current == null) {
    // Was inheriting all tools; unchecking one builds an explicit list.
    next = checked ? all.slice() : all.filter((t) => t !== toolId);
  } else {
    next = checked ? current.concat(toolId) : current.filter((t) => t !== toolId);
  }
  // De-dupe, and collapse back to "inherit" when everything is on.
  next = Array.from(new Set(next));
  const full = next.length === all.length && all.every((tool) => next.includes(tool));
  const send = full ? [] : next;
  return { tools: send.length ? send : undefined, send };
}

// Toggle every tool in a ToolTree group at once.
function toggleGroupInList(currentTools, group, checked, allChoices) {
  // MCP server groups are represented by their server slug in an agent
  // allowlist; selecting it grants every discovered tool, including tools
  // added by the server later.
  if (group.id.startsWith('mcp__')) {
    return toggleToolInList(currentTools, group.id, checked, allChoices);
  }
  let tools = currentTools;
  let send = currentTools === undefined ? [] : currentTools.slice();
  for (const tool of group.tools) {
    const r = toggleToolInList(tools, tool.id, checked, allChoices);
    tools = r.tools;
    send = r.send;
  }
  return { tools, send };
}

export { toggleToolInList, toggleGroupInList };

export function SettingsAgentsView(props) {
  const projectDir = resolveProjectDir(props);
  const context = { ...props, projectDir };
  const [agents, setAgents] = useState([]);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });

  async function load() {
    if (!projectDir) {
      setAgents([]);
      setStatusMsg({ text: 'open a chat to pick a project first', kind: 'error' });
      return;
    }
    setStatusMsg({ text: 'loading…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return; }
    const list = r.body.agents || [];
    setAgents(list);
    setStatusMsg({ text: list.length + (list.length === 1 ? ' agent' : ' agents'), kind: 'success' });
  }

  useEffect(() => { load(); }, [projectDir]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
        h('h2', { class: 'view-title' }, 'Agents')
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
      h('a', { href: '#/settings/project?' + agentQuery(context), class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Agents')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Subagent delegation personas, saved in the project\'s .mouaif.json. The subagent tool and @-mentions can delegate to them.'),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('ul', { class: 'prompts__list', 'aria-label': 'Agents' },
        agents.length === 0 ? h('li', { class: 'prompts__empty' }, 'No agents yet. Tap "Add agent" to create your first one.') : agents.map(a => {
          const bits = [];
          bits.push(Array.isArray(a.tools) && a.tools.length
            ? a.tools.length + (a.tools.length === 1 ? ' tool' : ' tools')
            : 'all tools');
          if (a.modelId) bits.push(a.modelId);
          const snippet = (a.content || '').trim().replace(/\s+/g, ' ');
          if (snippet) bits.push(snippet.length > 48 ? snippet.slice(0, 48) + '…' : snippet);
          return h('li', { key: a.name, class: 'prompt-row' },
            h('a', { class: 'prompt-row__main', href: '#/' + agentEditorPath(a.name, context) },
              h('div', { class: 'prompt-row__title' }, a.name),
              h('div', { class: 'prompt-row__meta' }, bits.join(' · ')),
              h('div', { class: 'prompt-row__chev' }, '›')
            )
          );
        })
      ),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/agents/new?' + agentQuery(context),
          class: 'btn btn--primary'
        }, '+ Add agent'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      )
    )
  );
}

export function SettingsAgentEditView(props) {
  // `edit=1` disambiguates an existing agent literally named "new".
  const isNew = props.isNew ?? (props.id === 'new');
  const agentName = isNew ? '' : (props.id || '');
  const projectDir = resolveProjectDir(props);
  const context = { ...props, projectDir };
  const backPath = agentBackPath(context);
  const backLabel = props.returnTo === 'project' ? 'Back to project settings' : 'Back to agents';
  const mounted = useRef(false);
  const leaving = useRef(false);
  const mutationBusy = useRef(false);
  const [projectModels, setProjectModels] = useState([]);
  const [modelProviders, setModelProviders] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  // Tool catalog from GET /api/tools/list — supplies each native tool's
  // description so the Tools tree matches the chat view.
  const [toolsCatalog, setToolsCatalog] = useState([]);
  // The loaded agent in state so the tools checklist re-renders when a
  // checkbox toggles between "inherit all" and an explicit allowlist.
  const [agent, setAgent] = useState(null);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

    // Catalog requests must not block the name/instructions form.
  useEffect(() => {
    let cancelled = false;
    async function loadAgent() {
      setAgent(null);
      if (!projectDir) return;
      if (isNew) { setAgent({ name: '', content: '' }); return; }
      setStatusMsg({ text: 'loading…', kind: 'busy' });
      try {
        const r = await fetchJson('/api/agents/' + encodeURIComponent(agentName) + '?projectDir=' + encodeURIComponent(projectDir));
        if (cancelled) return;
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        setAgent(r.body.agent);
        setStatusMsg({ text: '', kind: '' });
      } catch (error) {
        if (!cancelled) setStatusMsg({ text: error.message || 'network error', kind: 'error' });
      }
    }
    loadAgent();
    return () => { cancelled = true; };
  }, [projectDir, agentName, isNew]);

  useEffect(() => {
    let cancelled = false;
    async function loadCatalogs() {
      if (!projectDir) return;
      try {
        const [mr, pr, sr, tr] = await Promise.all([
        fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
        fetchJson('/api/ai/models/providers'),
        fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
        fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir))
        ]);
        const saved = mr.status === 200 && Array.isArray(mr.body.models) ? mr.body.models : [];
        const providers = pr.status === 200 && Array.isArray(pr.body.providers)
        ? pr.body.providers.map((p) => p && p.id).filter(Boolean)
        : [];
        if (cancelled) return;
        setProjectModels(saved);
        setModelProviders(providers);
        if (sr.status === 200 && Array.isArray(sr.body.servers)) setMcpServers(sr.body.servers);
        // The tool catalog carries each native tool's description, so the
        // agent editor's tool rows read the same as the chat tools card
        // and the project Tools section.
        if (tr.status === 200 && Array.isArray(tr.body.tools)) setToolsCatalog(tr.body.tools);
        const live = await Promise.all(providers.map((provider) =>
          fetchLiveModels(provider)
            .then((result) => ({ provider, models: result.models || [] }))
            .catch(() => ({ provider, models: [] }))
        ));
        const union = new Map();
        for (const m of saved) {
          if (m && m.id && m.provider) union.set(m.provider + '\u0000' + m.id, m);
        }
        for (const group of live) {
          for (const m of group.models) {
            if (!m || !m.id) continue;
            const key = group.provider + '\u0000' + m.id;
            if (!union.has(key)) union.set(key, Object.assign({}, m, { provider: group.provider }));
          }
        }
        if (!cancelled) setProjectModels(Array.from(union.values()));
      } catch { /* the form remains usable without catalog data */ }
    }
    loadCatalogs();
    return () => { cancelled = true; };
  }, [projectDir]);

  const [autosave] = useState(() => createAgentAutosave({
    name: agentName,
    save: async (name, patch) => {
      const r = await fetchJson('/api/agents/' + encodeURIComponent(name), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, ...patch })
      });
      if (r.status !== 200) throw new Error((r.body && r.body.error) || ('HTTP ' + r.status));
      return r.body.agent;
    },
    onStatus: (status) => { if (mounted.current) setStatusMsg(status); },
    onSaved: (saved) => {
      if (!mounted.current) return;
      setAgent(saved);
      // Replace the URL without remounting the form or adding rename entries
      // to browser history. Future queued saves use the server's current name.
      if (!leaving.current) {
        window.history.replaceState(null, '', '#/' + agentEditorPath(saved.name, context));
      }
    }
  }));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A route change must not cancel the last keystrokes. Don't retry errors
      // silently on unmount; the visible Back action waits and offers Retry.
      if (!isNew && !autosave.failed) autosave.flush();
    };
  }, [autosave, isNew]);
  function saveSoon(patch) { if (!isNew) autosave.enqueue(patch); }
  function saveNow(patch) { if (!isNew) autosave.enqueue(patch, true); }
  async function onBack(event) {
    if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (mutationBusy.current) return;
    leaving.current = true;
    if (!isNew && !await autosave.flush()) { leaving.current = false; return; }
    if (mounted.current) nav(backPath);
  }

  function onNameInput(value) {
    setAgent(a => Object.assign({}, a, { name: value }));
    saveSoon({ name: value });
  }

  function onContentInput(value) {
    setAgent(a => Object.assign({}, a, { content: value }));
    saveSoon({ content: value });
  }

  function onModelChange(sel) {
    const modelId = (sel && sel.modelId) || '';
    const providerId = (sel && sel.providerId) || '';
    setAgent(a => Object.assign({}, a, {
      modelId: modelId || undefined,
      providerId: providerId || undefined
    }));
    saveNow({ modelId, providerId });
  }
  function onThinkingLevelChange(value) {
    setAgent(a => Object.assign({}, a, { thinkingLevel: value || undefined }));
    saveNow({ thinkingLevel: value || '' });
  }

  function onToolToggle(tool, checked) {
    const r = toggleToolInList(agent && agent.tools, tool, checked, toolChoices);
    setAgent(a => Object.assign({}, a, { tools: r.tools }));
    saveNow({ tools: r.send });
  }

  function onToolGroupToggle(groupId, checked) {
    const group = agentToolGroups.find(g => g.id === groupId);
    if (!group) return;
    const r = toggleGroupInList(agent && agent.tools, group, checked, toolChoices);
    setAgent(a => Object.assign({}, a, { tools: r.tools }));
    saveNow({ tools: r.send });
  }

  async function create() {
    if (mutationBusy.current) return;
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    const name = (agent && agent.name || '').trim();
    if (!name) { setStatusMsg({ text: 'name is required', kind: 'error' }); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      setStatusMsg({ text: 'letters, digits, . _ - only; must start with a letter or digit', kind: 'error' });
      return;
    }
    mutationBusy.current = true;
    setIsCreating(true);
    setStatusMsg({ text: 'creating…', kind: 'busy' });
    let r;
    try {
      r = await fetchJson('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, ...agent, name, content: agent.content || '' })
      });
    } catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    finally { mutationBusy.current = false; setIsCreating(false); }
    if (!mounted.current) return;
    if (r.status !== 201) {
      setStatusMsg({ text: (r.body && r.body.error) || ('HTTP ' + r.status), kind: 'error' });
      return;
    }
    // Replace the creation page so browser Back doesn't reopen a blank form.
    window.location.replace('#/' + agentEditorPath(r.body.agent.name, context));
  }

  async function deleteAgent() {
    if (!agentName || mutationBusy.current) return;
    if (!confirm('Delete agent "' + autosave.name + '"?')) return;
    mutationBusy.current = true;
    setIsDeleting(true);
    try {
      if (!await autosave.flush()) return;
      setStatusMsg({ text: 'deleting…', kind: 'busy' });
      const r = await fetchJson('/api/agents/' + encodeURIComponent(autosave.name) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      if (mounted.current) nav(backPath);
    } catch (error) { setStatusMsg({ text: error.message || 'network error', kind: 'error' }); }
    finally { mutationBusy.current = false; setIsDeleting(false); }
  }

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back' }, '←'),
        h('h2', { class: 'view-title' }, isNew ? 'Add agent' : 'Edit agent')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  if (!agent) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/' + backPath, onClick: onBack, class: 'view-back', 'aria-label': backLabel }, '←'),
        h('h2', { class: 'view-title' }, isNew ? 'Add agent' : 'Edit agent')
      ),
      h('section', null, h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text || 'loading…'))
    );
  }

  const restricted = agent.tools !== undefined;
const toolChoices = toolChoicesWithMcp(mcpServers);
// Same group structure AND row content as the chat tools card and
// the project Tools section: one group per native tool (each with
// its catalog description), "File tools", one group per MCP server
// — minus the authorization controls, which are a project-level
// setting and have no meaning in an agent allowlist.
const agentToolGroups = buildAgentToolGroups({
choices: toolChoices,
restricted,
selected: (v) => agent.tools.includes(v),
mcpServers,
catalog: toolsCatalog
});

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/' + backPath, onClick: onBack, class: 'view-back', 'aria-label': backLabel }, '←'),
      h('h2', { class: 'view-title' }, isNew ? 'Add agent' : agent.name)
    ),
    h('section', { class: 'agent-editor' },
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('fieldset', { class: 'agent-editor__fields', disabled: isCreating || isDeleting },
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'sae-name' }, 'Name'),
          h('input', {
            class: 'input', id: 'sae-name', type: 'text',
            value: agent.name || '', placeholder: 'reviewer', maxLength: 64, autoCapitalize: 'none', spellcheck: false,
            onInput: e => onNameInput(e.target.value)
          }),
          h('p', { class: 'hint hint--compact' }, 'Letters, digits, . _ - only; must start with a letter or digit.')
        ),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'sae-content' }, 'Instructions'),
          h('textarea', {
            class: 'input prompts__textarea', id: 'sae-content', rows: 6,
            value: agent.content || '',
            onInput: e => onContentInput(e.target.value),
            placeholder: 'You are an assistant who…'
          }),
          !isNew && h('p', { class: 'hint hint--compact' }, 'Saved automatically as you type.')
        ),
        h('div', { class: 'row' },
          h('span', { class: 'label' }, 'Model'),
          h(ModelPickerField, {
            models: projectModels,
            value: agent.modelId
              ? {
                providerId: agent.providerId || (projectModels.find(m => m.id === agent.modelId) || {}).provider || '',
                modelId: agent.modelId
              }
              : null,
            variant: 'sheet',
            extraProviders: modelProviders,
            allowClear: true,
            clearLabel: 'Inherit chat model',
            placeholder: 'Pick a model',
            disabled: isCreating || isDeleting,
            ariaLabel: 'Model for this agent',
            onChange: onModelChange
          })
        ),
        h('div', { class: 'row' },
          h('span', { class: 'label' }, 'Thinking'),
          h(ThinkingSelectField, {
            value: agent.thinkingLevel || '',
            descriptor: (projectModels.find(m => m.id === agent.modelId && (!agent.providerId || m.provider === agent.providerId)) || {}).thinking,
            inheritLabel: 'Inherit chat thinking',
            disabled: isCreating || isDeleting,
            ariaLabel: 'Thinking level for this agent',
            onChange: onThinkingLevelChange
          }),
          h('p', { class: 'hint hint--compact' }, 'How much reasoning this agent does before answering. "Inherit chat thinking" follows the chat\'s current model.')
        ),
        h('div', { class: 'row' },
          h('span', { class: 'label' }, 'Tools'),
          h(ToolTree, {
            groups: agentToolGroups,
            collapsedByDefault: true,
            onToggleGroup: onToolGroupToggle,
            onToggleTool: (groupId, toolId, checked) => onToolToggle(toolId, checked)
          }),
          h('p', { class: 'hint hint--compact' }, 'All checked = the agent inherits the chat\'s full tool surface. Uncheck to build an explicit allowlist.')
        ),
        h('div', { class: 'row row--actions' },
          isNew && h('button', { class: 'btn btn--primary', type: 'button', onClick: create, disabled: isCreating }, 'Create'),
          !isNew && h('button', { class: 'btn btn--danger', type: 'button', onClick: deleteAgent, disabled: isDeleting }, 'Delete'),
          !isNew && statusMsg.kind === 'error' && h('button', { class: 'btn', type: 'button', onClick: () => autosave.flush() }, 'Retry save'),
          h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
        )
      )
    )
  );
}
