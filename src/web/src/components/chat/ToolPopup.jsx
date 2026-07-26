// mouaif web — Tool popup: floating popover to toggle available tools
//
// A small trigger button in the composer toolbar that opens a popup
// with the same hierarchical tool tree shown in the transcript's
// tools card. Changes are persisted immediately via the existing
// toggleTool / toggleToolGroup / toggleMcpServer / toggleAgentFiles
// callbacks. The popup re-uses the Preact ToolTree component and
// mirrors the state from the chat's tools/agentFiles/mcpServers
// objects.

import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { ToolTree, buildToolGroups } from '../ToolTree.jsx';

// Segment control for Off / Ask / Allow, same model as cards.js.
function AuthSegment({ toolName, current, onSave }) {
  const active = current && current.mode;
  if (!active) return null;
  const modes = toolName === 'ask_user'
    ? [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }]
    : [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }];
  return h('div', {
    class: 'seg',
    role: 'radiogroup',
    'aria-label': toolName + ' authorization'
  },
    modes.map((m) =>
      h('label', {
        key: m.value,
        class: 'seg__item' + (active === m.value ? ' seg__item--on' : '')
      },
        h('input', {
          type: 'radio',
          name: 'popup-auth-' + toolName,
          value: m.value,
          checked: active === m.value,
          onChange: () => {
            if (onSave) {
              onSave(toolName, m.value);
            }
          }
        }),
        h('span', { class: 'seg__pill' }, m.label)
      )
    )
  );
}

export function ToolPopup(props) {
  const {
    tools,
    mcpServers,
    usedTools,
    agentFiles,
    toolAuth,
    onToggleTool,
    onToggleToolGroup,
    onToggleMcpServer,
    onToggleAgentFiles,
    onSaveToolAuth
  } = props;

  const [open, setOpen] = useState(false);
  const popupRef = useRef(null);
  const triggerRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target) &&
          triggerRef.current && !triggerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Build the groups for the tool tree. Same logic as cards.js.
  const catalog = (tools && tools.catalog) || [];
  const filter = tools && tools.filter;
  const used = usedTools || new Set();
  const servers = mcpServers || [];
  const groups = buildToolGroups(catalog, servers, filter, used);

  // Inject auth segments on known groups
  const auth = toolAuth || {};
  function segMode(m) { return m === 'allowlist' ? 'ask' : m; }
  const segNames = {
    shell: 'shell',
    subagent: 'subagent',
    ask_user: 'ask_user',
    report_progress: 'report_progress',
    task: 'task',
    files: 'file'
  };
  for (const g of groups) {
    const authName = segNames[g.id];
    if (authName) {
      const cur = auth[authName] || { mode: 'ask' };
      g.control = h(AuthSegment, {
        toolName: authName,
        current: { mode: segMode(cur.mode) },
        onSave: onSaveToolAuth
      });
    }
  }

  function handleToggleGroup(groupId, checked) {
    if (groupId === 'agent-files') {
      if (onToggleAgentFiles) onToggleAgentFiles(checked);
      return;
    }
    if (groupId.startsWith('mcp-')) {
      if (onToggleMcpServer) onToggleMcpServer(groupId.slice(4), checked);
      return;
    }
    if (onToggleToolGroup) {
      const group = groups.find((g) => g.id === groupId);
      if (group) onToggleToolGroup(group.tools.map((t) => t.id), checked);
    }
  }

  function handleToggleTool(groupId, toolId, checked) {
    if (onToggleTool) onToggleTool(toolId, checked);
  }

  // If agent files are available, add a synthetic group for them
  const af = agentFiles || { files: [], enabled: true, projectLocked: false };
  if (af.files.length) {
    groups.push({
      id: 'agent-files',
      name: 'Agent files',
      description: af.files.join(', '),
      checked: af.enabled,
      disabled: !!af.projectLocked,
      tools: af.files.map((f) => ({
        id: f,
        name: f,
        description: '',
        checked: af.enabled,
        disabled: !!af.projectLocked
      }))
    });
  }

  return h('div', { class: 'tool-popup' },
    h('button', {
      ref: triggerRef,
      class: 'chat-view__toolbar-btn tool-popup__trigger',
      type: 'button',
      onClick: () => setOpen(!open),
      'aria-label': 'Toggle available tools',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      title: 'Tool settings'
    },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true', fill: 'currentColor' },
        h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' })
      )
    ),
    open && h('div', {
      ref: popupRef,
      class: 'tool-popup__popup',
      role: 'dialog',
      'aria-label': 'Tool settings'
    },
      h('div', { class: 'tool-popup__head' },
        h('span', { class: 'tool-popup__title' }, 'Tools'),
        h('button', {
          class: 'tool-popup__close',
          type: 'button',
          onClick: () => setOpen(false),
          'aria-label': 'Close'
        }, '\u00D7')
      ),
      h('div', { class: 'tool-popup__body' },
        h(ToolTree, {
          groups,
          onToggleGroup: handleToggleGroup,
          onToggleTool: handleToggleTool,
          collapsedByDefault: true,
          class: 'tool-popup__tree'
        })
      ),
      h('div', { class: 'tool-popup__foot' },
        h('span', { class: 'tool-popup__foot-note' },
          'Tools marked \u25CF have been used in this chat.'
        )
      )
    )
  );
}
