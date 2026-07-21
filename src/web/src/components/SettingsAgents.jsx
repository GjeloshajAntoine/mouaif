// mouaif web — Project agent config view
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';

function resolveProjectDir(props) {
  if (props && props.projectDir) return props.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

function AgentEditor({ agent, prompts, skills, onSaved }) {
  const initial = agent.config || {};
  const [promptId, setPromptId] = useState(initial.promptId || '');
  const [skillMode, setSkillMode] = useState(Array.isArray(initial.selectedSkills) ? 'selected' : 'all');
  const [selectedSkills, setSelectedSkills] = useState(Array.isArray(initial.selectedSkills) ? initial.selectedSkills : []);
  const [status, setStatus] = useState('');

  async function save(event) {
    event.preventDefault();
    setStatus('saving…');
    const r = await fetchJson('/api/agents/' + encodeURIComponent(agent.name) + '/config?projectDir=' + encodeURIComponent(agent.projectDir), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        promptId: promptId || null,
        selectedSkills: skillMode === 'all' ? null : selectedSkills
      })
    });
    if (r.status !== 200) { setStatus('save failed'); return; }
    setStatus('saved');
    onSaved(agent.name, r.body.config);
  }

  function toggleSkill(name, checked) {
    setSelectedSkills(current => checked
      ? Array.from(new Set(current.concat(name)))
      : current.filter(item => item !== name));
  }

  return h('form', { class: 'agent-editor', onSubmit: save },
    h('div', { class: 'agent-editor__head' },
      h('div', null,
        h('h3', { class: 'agent-editor__title' }, agent.title || agent.name),
        h('code', { class: 'agent-editor__id' }, agent.name)
      ),
      h('span', { class: 'status', 'aria-live': 'polite' }, status)
    ),
    h('label', { class: 'row' },
      h('span', { class: 'label' }, 'Prompt'),
      h('select', { class: 'input', onChange: event => setPromptId(event.currentTarget.value) },
        h('option', { value: '', selected: !promptId }, 'No custom prompt'),
        prompts.map(prompt => h('option', { key: prompt.id, value: prompt.id, selected: promptId === prompt.id }, prompt.title || prompt.id))
      )
    ),
    h('label', { class: 'row' },
      h('span', { class: 'label' }, 'Skills'),
      h('select', { class: 'input', onChange: event => setSkillMode(event.currentTarget.value) },
        h('option', { value: 'all', selected: skillMode === 'all' }, 'All discovered skills'),
        h('option', { value: 'selected', selected: skillMode === 'selected' }, 'Choose skills')
      )
    ),
    skillMode === 'selected' && h('div', { class: 'agent-editor__skills' },
      skills.length
        ? skills.map(skill => h('label', { key: skill.name, class: 'agent-editor__skill' },
            h('input', {
              class: 'checkbox',
              type: 'checkbox',
              checked: selectedSkills.includes(skill.name),
              onChange: event => toggleSkill(skill.name, event.currentTarget.checked)
            }),
            h('span', null, skill.title || skill.name)
          ))
        : h('p', { class: 'hint hint--compact' }, 'No skills discovered. An empty selection injects no skills.')
    ),
    h('div', { class: 'row row--actions agent-editor__actions' },
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save configuration')
    )
  );
}

export function SettingsAgentsView(props) {
  const projectDir = resolveProjectDir(props);
  const [agents, setAgents] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [skills, setSkills] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [status, setStatusText] = useState('');
  const [creator, setCreator] = useState(null);
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [createStatus, setCreateStatus] = useState('');

  async function load() {
    if (!projectDir) { setStatusText('open a chat to pick a project first'); return; }
    setStatusText('loading…');
    const [ar, pr, sr] = await Promise.all([
      fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/skills?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (ar.status === 200) {
      setAgents(Array.isArray(ar.body.agents) ? ar.body.agents.map(agent => Object.assign({}, agent, { projectDir })) : []);
      setDefaultAgentId(ar.body.defaultAgentId || '');
    }
    if (pr.status === 200) setPrompts(Array.isArray(pr.body.prompts) ? pr.body.prompts : []);
    if (sr.status === 200) setSkills(Array.isArray(sr.body.skills) ? sr.body.skills : []);
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

  function onAgentSaved(name, config) {
    setAgents(current => current.map(agent => agent.name === name ? Object.assign({}, agent, { config }) : agent));
  }

  function openCreator(kind) {
    setCreator(kind);
    setNewName('');
    setNewTitle('');
    setNewInstructions('');
    setCreateStatus('');
  }

  async function createDefinition(event) {
    event.preventDefault();
    const name = newName.trim();
    const instructions = newInstructions.trim();
    if (!name || !instructions) { setCreateStatus('Name and instructions are required.'); return; }
    const title = newTitle.trim() || name;
    const content = '# ' + title + '\n\n' + instructions;
    const endpoint = creator === 'skill' ? '/api/skills' : '/api/agents';
    setCreateStatus('creating…');
    const r = await fetchJson(endpoint + '?projectDir=' + encodeURIComponent(projectDir), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content })
    });
    if (r.status !== 201) {
      setCreateStatus(r.body && r.body.error ? r.body.error : 'Create failed: HTTP ' + r.status);
      return;
    }
    setCreator(null);
    await load();
    setStatusText(creator === 'skill' ? 'skill created' : 'agent created');
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
    h('p', { class: 'hint hint--compact settings-agents__intro' }, 'Choose the project default, then attach a prompt and skills to each persona. Chats can override the default.'),
    h('div', { class: 'settings-agents__create-actions' },
      h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openCreator('agent') }, '+ New agent'),
      h('button', { type: 'button', class: 'btn', onClick: () => openCreator('skill') }, '+ New skill')
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
          h('p', { class: 'hint hint--compact' }, 'An agent is a reusable project persona. Add its instructions here, then attach prompts and skills without editing JSON or folders manually.'),
          h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openCreator('agent') }, 'Create agent')
        )
      : h('div', { class: 'settings-agents__list' }, agents.map(agent =>
          h(AgentEditor, { key: agent.name, agent, prompts, skills, onSaved: onAgentSaved })
        )),
    creator && h('div', { class: 'settings-agents__overlay', role: 'presentation', onClick: event => { if (event.target === event.currentTarget) setCreator(null); } },
      h('form', { class: 'settings-agents__sheet', onSubmit: createDefinition },
        h('div', { class: 'settings-agents__sheet-head' },
          h('h3', null, creator === 'skill' ? 'New skill' : 'New agent'),
          h('button', { type: 'button', class: 'btn btn--ghost settings-agents__close', onClick: () => setCreator(null), 'aria-label': 'Close' }, '×')
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Name'),
          h('input', { class: 'input', value: newName, onInput: event => setNewName(event.currentTarget.value), placeholder: creator === 'skill' ? 'testing' : 'reviewer', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' })
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Display title'),
          h('input', { class: 'input', value: newTitle, onInput: event => setNewTitle(event.currentTarget.value), placeholder: creator === 'skill' ? 'Testing' : 'Code reviewer' })
        ),
        h('label', { class: 'row' },
          h('span', { class: 'label' }, 'Instructions'),
          h('textarea', { class: 'input settings-agents__instructions', value: newInstructions, onInput: event => setNewInstructions(event.currentTarget.value), placeholder: creator === 'skill' ? 'Explain when and how the model should apply this skill.' : 'Describe the persona, priorities, constraints, and expected response style.', required: true })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { type: 'button', class: 'btn', onClick: () => setCreator(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn--primary' }, 'Create'),
          h('span', { class: 'status', 'aria-live': 'polite' }, createStatus)
        )
      )
    )
  );
}
