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
    agents.length > 0 && h('label', { class: 'row settings-agents__default' },
      h('span', { class: 'label' }, 'Project default agent'),
      h('select', { class: 'input', onChange: event => saveDefault(event.currentTarget.value) },
        h('option', { value: '', selected: !defaultAgentId }, 'No default agent'),
        agents.map(agent => h('option', { key: agent.name, value: agent.name, selected: defaultAgentId === agent.name }, agent.title || agent.name))
      )
    ),
    !agents.length
      ? h('p', { class: 'hint' }, 'No agents found. Add .agents/agents/<name>/AGENT.md to this project.')
      : h('div', { class: 'settings-agents__list' }, agents.map(agent =>
          h(AgentEditor, { key: agent.name, agent, prompts, skills, onSaved: onAgentSaved })
        ))
  );
}
