// SettingsProject — Agent presets editor (subagent delegation personas)
import { h, Fragment } from 'preact';

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
  { value: 'write_file', label: 'write_file' }
];

// Render an agent preset editor row.
// agent — { name, content, tools }
// opened — boolean (expanded/collapsed)
// setOpened — toggle fn
// onContentInput — (name, value) => void
// onToolToggle — (name, tool, checked) => void
// onDelete — (name) => void
// mcpServers — for MCP tool suggestions
export function AgentPresetRow({ agent, opened, setOpened, onContentInput, onToolToggle, onDelete, mcpServers }) {
  const restricted = Array.isArray(agent.tools) && agent.tools.length > 0;
  const toolChoices = AGENT_TOOL_CHOICES.concat(
    (mcpServers || []).filter(s => s && s.id).map(s => ({
      value: 'mcp__' + (s.slug || s.id),
      label: 'MCP: ' + (s.name || s.id)
    }))
  );

  return h('li', { key: agent.name, class: 'settings-project__agent-row' },
    h('div', { class: 'settings-project__agent-head' },
      h('button', {
        type: 'button', class: 'settings-project__agent-chev' + (opened ? ' is-open' : ''),
        onClick: () => setOpened(agent.name, !opened),
        'aria-label': opened ? 'Collapse' : 'Expand',
        'aria-expanded': String(opened)
      }, '›'),
      h('span', { class: 'settings-project__agent-title' }, agent.name),
      restricted
        ? h('span', { class: 'settings-project__agent-tools-badge' }, agent.tools.length + (agent.tools.length === 1 ? ' tool' : ' tools'))
        : h('span', { class: 'settings-project__agent-tools-badge' }, 'all tools'),
      h('button', {
        type: 'button', class: 'btn btn--danger btn--sm settings-project__agent-del',
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
          class: 'input settings-project__mono', rows: 4,
          value: agent.content || '',
          onInput: e => onContentInput(agent.name, e.target.value),
          placeholder: 'You are an assistant who…'
        })
      ),
      h('div', { class: 'settings-project__agent-field' },
        h('span', { class: 'label' }, 'Tools'),
        h('div', { class: 'settings-project__agent-tools' },
          toolChoices.map(choice =>
            h('label', { key: choice.value, class: 'checkbox-row' },
              h('input', {
                type: 'checkbox', class: 'checkbox',
                checked: !restricted || agent.tools.includes(choice.value),
                onChange: e => onToolToggle(agent.name, choice.value, e.target.checked)
              }),
              ' ' + choice.label
            )
          )
        )
      ),
      h('div', { class: 'row row--actions' },
        h('span', { 'data-agent-status': agent.name, class: 'status' })
      )
    )
  );
}

// Create new agent form.
export function AgentCreatorForm({ newAgentNameRef, onCancel, onCreate, status }) {
  return h('div', { class: 'settings-project__agent-create' },
    h('label', { class: 'row settings-project__agent-field' },
      h('span', { class: 'label' }, 'Name'),
      h('input', {
        ref: newAgentNameRef,
        class: 'input',
        placeholder: 'reviewer',
        onKeyDown: (e) => { if (e.key === 'Enter') onCreate(); if (e.key === 'Escape') onCancel(); }
      })
    ),
    h('div', { class: 'row row--actions' },
      h('button', { type: 'button', class: 'btn', onClick: onCancel }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: onCreate }, 'Create'),
      h('span', { class: 'status', 'aria-live': 'polite' }, status)
    )
  );
}