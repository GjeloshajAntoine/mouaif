// mouaif web — ToolSettingCard & generic tool authorization components
// Harmonizes native tools (shell, files, subagent, progress, tasks, ask_user)
// and MCP tools into a unified, reusable setting surface.

import { h } from 'preact';
import { toolModeSegs, TOOL_MODE_CHOICES, ASK_USER_MODE_CHOICES } from './toolAuth.js';

export function ToolAuthField({
  id,
  name,
  mode = 'ask',
  modes = TOOL_MODE_CHOICES,
  statusMsg = '',
  onChangeMode
}) {
  return h('div', { class: 'sp-field sp-field--seg' },
    h('div', { class: 'sp-field__label-group' },
      h('label', { class: 'label' }, name || id),
      statusMsg ? h('span', { class: 'status' }, statusMsg) : null
    ),
    toolModeSegs(id, mode, onChangeMode, modes)
  );
}

export function ToolAllowlistTextarea({
  id,
  label = 'Auto-approve patterns',
  description = 'One glob pattern per line. Commands/paths matching any pattern run without prompting.',
  placeholder = 'e.g. *.js\nsrc/**',
  value = '',
  onInput,
  rows = 4
}) {
  return h('div', { class: 'sp-field' },
    h('label', { class: 'label', for: `sp-${id}-allowlist` }, label),
    h('p', { class: 'hint' }, description),
    h('textarea', {
      id: `sp-${id}-allowlist`,
      class: 'input mono',
      rows,
      placeholder,
      value,
      onInput: (e) => onInput && onInput(e.target.value)
    })
  );
}

export function ToolSettingCard({
  id,
  title,
  description,
  mode,
  modes = TOOL_MODE_CHOICES,
  statusMsg = '',
  allowlistText = '',
  allowlistPlaceholder,
  allowlistHint,
  supportsAllowlist = false,
  onChangeMode,
  onAllowlistChange,
  extraChildren = null
}) {
  const isBinary = modes.length === 2;

  return h('div', { class: 'card', id: `card-tool-${id}` },
    h('h3', null, title),
    description ? h('p', { class: 'hint' }, description) : null,
    h(ToolAuthField, {
      id,
      name: 'Permission mode',
      mode,
      modes,
      statusMsg,
      onChangeMode
    }),
    supportsAllowlist && mode !== 'allow' && mode !== 'off'
      ? h(ToolAllowlistTextarea, {
          id,
          placeholder: allowlistPlaceholder,
          description: allowlistHint,
          value: allowlistText,
          onInput: onAllowlistChange
        })
      : null,
    extraChildren
  );
}
