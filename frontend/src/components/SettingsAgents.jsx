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
import { useState, useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus, activeProject } from '../api.js';
import { nav } from '../router.js';
import { ToolTree, buildAgentToolGroups } from './ToolTree.jsx';

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
  const listEl = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    if (!projectDir) {
      if (listEl.current) listEl.current.innerHTML = '';
      setStatus(statusEl, 'open a chat to pick a project first', 'error');
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const list = r.body.agents || [];
    renderList(list);
    setStatus(statusEl, list.length + (list.length === 1 ? ' agent' : ' agents'), 'success');
  }

  function renderList(list) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'prompts__empty';
      li.textContent = 'No agents yet. Tap "Add agent" to create your first one.';
      listEl.current.appendChild(li);
      return;
    }
    for (const a of list) {
      const li = document.createElement('li');
      li.className = 'prompt-row';
      const main = document.createElement('a');
      main.className = 'prompt-row__main';
      main.href = '#/settings/agents/' + encodeURIComponent(a.name) + '?projectDir=' + encodeURIComponent(projectDir);
      const name = document.createElement('div');
      name.className = 'prompt-row__title';
      name.textContent = a.name;
      const meta = document.createElement('div');
      meta.className = 'prompt-row__meta';
      const bits = [];
      bits.push(Array.isArray(a.tools) && a.tools.length
        ? a.tools.length + (a.tools.length === 1 ? ' tool' : ' tools')
        : 'all tools');
      if (a.modelId) bits.push(a.modelId);
      const snippet = (a.content || '').trim().replace(/\s+/g, ' ');
      if (snippet) bits.push(snippet.length > 48 ? snippet.slice(0, 48) + '…' : snippet);
      meta.textContent = bits.join(' · ');
      main.appendChild(name);
      main.appendChild(meta);
      const chev = document.createElement('div');
      chev.className = 'prompt-row__chev';
      chev.textContent = '›';
      main.appendChild(chev);
      li.appendChild(main);
      listEl.current.appendChild(li);
    }
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
      h('a', { href: '#/settings/project?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Agents')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Subagent delegation personas, saved in the project\'s .mouaif.json. The subagent tool and @-mentions can delegate to them.'),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('ul', { ref: listEl, class: 'prompts__list', 'aria-label': 'Agents' }),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/agents/new?projectDir=' + encodeURIComponent(projectDir),
          class: 'btn btn--primary'
        }, '+ Add agent'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

export function SettingsAgentEditView(props) {
  // 'new' = create flow (POST then redirect to the real edit URL).
  const agentName = (props && props.id && props.id !== 'new') ? props.id : '';
  const isNew = !!(props && props.id === 'new');
  const projectDir = resolveProjectDir(props);
  const nameRef = useRef(null);
  const contentRef = useRef(null);
  const modelRef = useRef(null);
  const statusEl = useRef(null);
  const deleteBtn = useRef(null);
  const [projectModels, setProjectModels] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  // The loaded agent in state so the tools checklist re-renders when a
  // checkbox toggles between "inherit all" and an explicit allowlist.
  const [agent, setAgent] = useState(null);
  const saveTimer = useRef(null);

  async function load() {
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    try {
      const [mr, sr] = await Promise.all([
        fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
        fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir))
      ]);
      if (mr.status === 200 && Array.isArray(mr.body.models)) setProjectModels(mr.body.models);
      if (sr.status === 200 && Array.isArray(sr.body.servers)) setMcpServers(sr.body.servers);
    } catch { /* pickers stay empty */ }
    if (isNew) {
      setAgent({ name: '', content: '', modelId: undefined, tools: undefined });
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/agents/' + encodeURIComponent(agentName) + '?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    setAgent(r.body.agent);
    setStatus(statusEl, '', '');
  }

  useEffect(() => { load(); }, [projectDir, agentName]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Debounced auto-save for the instructions textarea.
  function saveSoon(patch) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setStatus(statusEl, '…', 'busy');
    saveTimer.current = setTimeout(() => saveNow(patch), 350);
  }

  async function saveNow(patch) {
    if (!projectDir || !agentName) return;
    setStatus(statusEl, 'saving…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/agents/' + encodeURIComponent(agentName), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ projectDir }, patch))
      });
    } catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) {
      setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error');
      return;
    }
    if (r.body.agent) setAgent(r.body.agent);
    // If the name changed, update agentName and navigate to the new URL
    if (r.body.agent && r.body.agent.name && r.body.agent.name !== agentName) {
      const newName = r.body.agent.name;
      // The component will re-render with new props via navigation
      nav('settings/agents/' + encodeURIComponent(newName) + '?projectDir=' + encodeURIComponent(projectDir));
      return;
    }
    setStatus(statusEl, 'saved', 'success');
  }

  function onNameInput(value) {
    setAgent(a => Object.assign({}, a, { name: value }));
    saveSoon({ name: value });
  }

  function onContentInput(value) {
    setAgent(a => Object.assign({}, a, { content: value }));
    saveSoon({ content: value });
  }

  function onModelChange(value) {
    const modelId = value || '';
    setAgent(a => Object.assign({}, a, { modelId: modelId || undefined }));
    saveNow({ modelId });
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
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    const name = ((nameRef.current && nameRef.current.value) || '').trim();
    if (!name) { setStatus(statusEl, 'name is required', 'error'); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      setStatus(statusEl, 'letters, digits, . _ - only; must start with a letter or digit', 'error');
      return;
    }
    setStatus(statusEl, 'creating…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectDir, name,
          content: (contentRef.current && contentRef.current.value) || ''
        })
      });
    } catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 201) {
      setStatus(statusEl, (r.body && r.body.error) || ('HTTP ' + r.status), 'error');
      return;
    }
    nav('settings/agents/' + encodeURIComponent(r.body.agent.name) + '?projectDir=' + encodeURIComponent(projectDir));
  }

  async function deleteAgent() {
    if (!agentName) return;
    if (!confirm('Delete agent "' + agentName + '"?')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try { r = await fetchJson('/api/agents/' + encodeURIComponent(agentName) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/agents?projectDir=' + encodeURIComponent(projectDir));
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
        h('a', { href: '#/settings/agents?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to agents' }, '←'),
        h('h2', { class: 'view-title' }, isNew ? 'Add agent' : 'Edit agent')
      ),
      h('section', null, h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' }, 'loading…'))
    );
  }

  const restricted = agent.tools !== undefined;
  const toolChoices = toolChoicesWithMcp(mcpServers);
  // Same group structure as the chat tools card and the project
  // Tools section: one group per native tool, "File tools", one
  // group per MCP server — minus the authorization controls.
  const agentToolGroups = buildAgentToolGroups({
    choices: toolChoices,
    restricted,
    selected: (v) => agent.tools.includes(v),
    mcpServers
  });

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/agents?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to agents' }, '←'),
      h('h2', { class: 'view-title' }, isNew ? 'Add agent' : agent.name)
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sae-name' }, 'Name'),
        h('input', {
          ref: nameRef, class: 'input', id: 'sae-name', type: 'text',
          value: agent.name || '', placeholder: 'reviewer',
          onInput: e => onNameInput(e.target.value)
        }),
        h('p', { class: 'hint hint--compact' }, 'Letters, digits, . _ - only; must start with a letter or digit.')
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sae-content' }, 'Instructions'),
        h('textarea', {
          ref: contentRef, class: 'input prompts__textarea', id: 'sae-content', rows: 6,
          value: agent.content || '',
          onInput: isNew ? null : (e => onContentInput(e.target.value)),
          placeholder: 'You are an assistant who…'
        }),
        !isNew && h('p', { class: 'hint hint--compact' }, 'Saved automatically as you type.')
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sae-model' }, 'Model'),
        h('select', {
          ref: modelRef, class: 'input', id: 'sae-model',
          value: agent.modelId || '',
          disabled: isNew,
          onChange: e => onModelChange(e.target.value)
        },
          h('option', { value: '' }, 'Inherit chat model'),
          projectModels.map(m => h('option', { key: m.id, value: m.id }, (m.label || m.id) + (m.provider ? ' (' + m.provider + ')' : '')))
        )
      ),
      h('div', { class: 'row', hidden: isNew },
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
        isNew && h('button', { class: 'btn btn--primary', type: 'button', onClick: create }, 'Create'),
        !isNew && h('button', { ref: deleteBtn, class: 'btn btn--danger', type: 'button', onClick: deleteAgent }, 'Delete'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}
