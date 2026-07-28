// SettingsProject — Agent presets editor (subagent delegation personas)
import { h } from 'preact';
import { ToolTree, buildAgentToolGroups } from '../ToolTree.jsx';

export const AGENT_TOOL_CHOICES = [
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

// AgentPresetRow — one collapsible agent editor row.
//
// Props:
// agent — { name, content, tools?, modelId? }
// opened / setOpened — collapse state lifted to the parent
// onContentInput — (name, value) => void
// onToolToggle — (name, tool, checked) => void
// onGroupToggle — (name, groupId, checked) => void
// onDelete — (name) => void
// mcpServers — for MCP tool suggestions
export function AgentPresetRow({ agent, opened, setOpened, onContentInput, onToolToggle, onDelete, mcpServers, onGroupToggle }) {
  const restricted = agent.tools !== undefined;
  const toolChoices = AGENT_TOOL_CHOICES.concat(
    (mcpServers || []).filter(s => s && s.id).map(s => ({
      value: 'mcp__' + (s.slug || s.id),
      label: 'MCP: ' + (s.name || s.id)
    }))
  );
  const groups = buildAgentToolGroups({
    choices: toolChoices,
    restricted,
    selected: (v) => agent.tools.includes(v),
    mcpServers
  });

  return h('li', { class: 'settings-project__agent-row' },
    h('div', { class: 'settings-project__agent-head' },
      h('button', {
        type: 'button',
        class: 'settings-project__agent-chev' + (opened ? ' is-open' : ''),
        onClick: () => setOpened(!opened),
        'aria-label': opened ? 'Collapse' : 'Expand',
        'aria-expanded': String(opened)
      }, '›'),
      h('span', { class: 'settings-project__agent-name' }, agent.name),
      restricted
        ? h('span', { class: 'settings-project__agent-tools-badge' }, agent.tools.length + (agent.tools.length === 1 ? ' tool' : ' tools'))
        : h('span', { class: 'settings-project__agent-tools-badge' }, 'all tools'),
      h('button', {
        type: 'button',
        class: 'btn btn--danger btn--sm settings-project__agent-del',
        onClick: () => onDelete(agent.name),
        'aria-label': 'Delete'
      }, '×')
    ),
    opened && h('div', { class: 'settings-project__agent-body' },
      h('label', { class: 'row settings-project__agent-field' },
        h('span', { class: 'label' }, 'Name'),
        h('input', { class: 'input', value: agent.name, disabled: true, 'aria-readonly': 'true' })
      ),
      h('label', { class: 'row settings-project__agent-field' },
        h('span', { class: 'label' }, 'Instructions ' + (agent.content ? agent.content.length + ' chars' : '')),
        h('textarea', {
          class: 'input settings-project__mono',
          rows: 4,
          value: agent.content || '',
          onInput: e => onContentInput(agent.name, e.target.value),
          placeholder: 'You are an assistant who…'
        })
      ),
      h('div', { class: 'settings-project__agent-field' },
        h('span', { class: 'label' }, 'Tools'),
        h(ToolTree, {
          groups,
          collapsedByDefault: true,
          onToggleGroup: (groupId, checked) => { if (onGroupToggle) onGroupToggle(agent.name, groupId, checked); },
          onToggleTool: (groupId, toolId, checked) => onToolToggle(agent.name, toolId, checked)
        })
      ),
      h('div', { class: 'row row--actions' },
        h('span', { 'data-agent-status': agent.name, class: 'status' })
      )
    )
  );
}
