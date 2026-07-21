// mouaif web — Project agent selection view
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';

function resolveProjectDir(props) {
  if (props && props.projectDir) return props.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

export function SettingsAgentsView(props) {
  const projectDir = resolveProjectDir(props);
  const [agents, setAgents] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [status, setStatusText] = useState('');
  const [creator, setCreator] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [createStatus, setCreateStatus] = useState('');

  async function load() {
    if (!projectDir) { setStatusText('open a chat to pick a project first'); return; }
    setStatusText('loading…');
    const ar = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir));
    if (ar.status === 200) {
      setAgents(Array.isArray(ar.body.agents) ? ar.body.agents : []);
      setDefaultAgentId(ar.body.defaultAgentId || '');
    }
    setStatusText(ar.status === 200 ? 'loaded' : 'agents HTTP ' + ar.status);
  }

  async function saveDefault(agentId) {
    setDefaultAgentId(agentId);
    setStatusText('saving default…');
    const r = await fetchJson('/api/agents/default?projectDir=' + encodeURIComponent(projectDir), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId || null })
    });
    if (r.status !== 200) { setStatusText('save failed'); await load(); return; }
    setDefaultAgentId(r.body.defaultAgentId || '');
    setStatusText('default saved');
  }

  function openCreator() {
    setCreator(true);
    setNewName('');
    setNewTitle('');
    setNewInstructions('');
    setCreateStatus('');
  }

  async function createAgent(event) {
    event.preventDefault();
    const name = newName.trim();
    const instructions = newInstructions.trim();
    if (!name || !instructions) { setCreateStatus('Name and instructions are required.'); return; }
    const title = newTitle.trim() || name;
    const content = '# ' + title + '\n\n' + instructions;
    setCreateStatus('creating…');
    const r = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content })
    });
    if (r.status !== 201) {
      setCreateStatus(r.body && r.body.error ? r.body.error : 'Create failed: HTTP ' + r.status);
      return;
    }
    setCreator(false);
    await load();
    setStatusText('agent created');
  }

  useEffect(() => { load().catch(() => setStatusText('load failed')); }, [projectDir]);

  if (!projectDir) {
    return h('section', null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
        h('h2', { class: 'view-title' }, 'Agents')
      ),
      h('p', { class: 'hint' }, 'No project selected. Open a chat first.')
    );
  }

  return h('section', { class: 'settings-agents' },
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Agents'),
      h('span', { class: 'status', 'aria-live': 'polite' }, status)
    ),
    h('p', { class: 'hint hint--compact settings-agents__intro' }, 'Choose the project default persona. Chats can override the default.'),
    h('div', { class: 'settings-agents__create-actions' },
      h('button', { type: 'button', class: 'btn btn--primary', onClick: openCreator }, '+ New agent')
    ),
    agents.length > 0 && h('label', { class: 'row settings-agents__default' },
      h('span', { class: 'label' }, 'Project default agent'),
      h('select', { class: 'input', onChange: event => saveDefault(event.currentTarget.value) },
        h('option', { value: '', selected: !defaultAgentId }, 'No default agent'),
        agents.map(agent => h('option', { key: agent.name, value: agent.name, selected: defaultAgentId === agent.name }, agent.title || agent.name))
      )
    ),
    !agents.length
      ? h('div', { class: 'settings-agents__empty' },
          h('h3', null, 'Create the first agent'),
          h('p', { class: 'hint hint--compact' }, 'An agent is a reusable project persona. Add its instructions here without editing folders manually.'),
          h('button', { type: 'button', class: 'btn btn--primary', onClick: openCreator }, 'Create agent')
        )
      : h('ul', { class: 'settings-agents__list' }, agents.map(agent =>
          h('li', { key: agent.name, class: 'settings-agents__item' },
            h('span', { class: 'settings-agents__name' }, agent.title || agent.name),
            h('code', { class: 'settings-agents__id' }, agent.name)
          )
        )),
    creator && h('div', { class: 'settings-agents__overlay', role: 'presentation', onClick: event => { if (event.target === event.currentTarget) setCreator(false); } },
      h('form', { class: 'settings-agents__sheet', onSubmit: createAgent },
        h('div', { class: 'settings-agents__sheet-head' },
          h('h3', null, 'New agent'),
          h('button', { type: 'button', class: 'btn btn--ghost settings-agents__close', onClick: () => setCreator(false), 'aria-label': 'Close' }, '×')
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Name'),
          h('input', { class: 'input', value: newName, onInput: event => setNewName(event.currentTarget.value), placeholder: 'reviewer', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' })
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Display title'),
          h('input', { class: 'input', value: newTitle, onInput: event => setNewTitle(event.currentTarget.value), placeholder: 'Code reviewer' })
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Instructions'),
          h('textarea', { class: 'input settings-agents__instructions', value: newInstructions, onInput: event => setNewInstructions(event.currentTarget.value), placeholder: 'Describe the persona, priorities, constraints, and expected response style.', required: true })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { type: 'button', class: 'btn', onClick: () => setCreator(false) }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn--primary' }, 'Create'),
          h('span', { class: 'status', 'aria-live': 'polite' }, createStatus)
        )
      )
    )
  );
}
