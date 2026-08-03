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
import { McpAuthSeg } from '../settings/toolAuth.js';

// Segment control for Off / Ask / Allow, same model as cards.js.
// Picking Allow clears any allowlist; any other mode keeps it, so an
// ask→off→ask round-trip never loses the patterns.
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
              const allowlist = m.value === 'allow' ? [] : (Array.isArray(current.allowlist) ? current.allowlist : []);
              onSave(toolName, m.value, allowlist);
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
    skills,
    toolAuth,
    mcpAuth,
    onToggleTool,
    onToggleToolGroup,
    onToggleMcpServer,
    onToggleAgentFiles,
    onToggleSkills,
    onSaveToolAuth,
    onSaveMcpAuth
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

  // Keep the mobile bottom sheet flush with the visible viewport.
  // Uses the same visual-viewport technique as the model picker:
  // --tool-popup-viewport-top / --tool-popup-viewport-height track
  // vv.offsetTop / vv.height so the sheet ends exactly on the visible
  // bottom edge and never intrudes into the status bar or behind the
  // on-screen keyboard (which is an overlay on iOS and would not move
  // the 100dvh box).
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    function sync() {
      const h = Math.max(0, vv.height - (vv.offsetTop || 0));
      document.documentElement.style.setProperty('--tool-popup-viewport-top', (vv.offsetTop || 0) + 'px');
      document.documentElement.style.setProperty('--tool-popup-viewport-height', h + 'px');
    }
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      document.documentElement.style.removeProperty('--tool-popup-viewport-top');
      document.documentElement.style.removeProperty('--tool-popup-viewport-height');
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
        current: { mode: segMode(cur.mode), allowlist: Array.isArray(cur.allowlist) ? cur.allowlist : [] },
        onSave: onSaveToolAuth
      });
    }
  }

  // MCP authorization — same layered model as the chat Tools card and
  // the project settings tree: an "MCP default" gate row (the project's
  // shared fallback) plus one Off/Ask/Allow segment per MCP server group
  // (the per-server override; shows the effective mode and gains a ↺
  // reset when an override is set). Writes go through onSaveMcpAuth so
  // the card and the settings page pick the change up too.
  const mcpAuthState = mcpAuth || { mode: 'ask', allowlist: [], servers: {}, tools: {} };
  const firstMcp = groups.findIndex((g) => g.id.startsWith('mcp-'));
  if (firstMcp >= 0) {
    const onSaveMcp = (patch) => onSaveMcpAuth && onSaveMcpAuth(patch);
    groups.splice(firstMcp, 0, {
      id: 'mcp',
      name: 'MCP default',
      description: 'gate for servers without an override',
      checked: (mcpAuthState.mode || 'ask') !== 'off',
      control: h(McpAuthSeg, {
        name: 'MCP default',
        slug: null,
        servers: mcpAuthState.servers,
        shared: mcpAuthState,
        namePrefix: 'popup-mcp',
        onSave: onSaveMcp
      }),
      tools: []
    });
    for (const g of groups) {
      if (!g.id.startsWith('mcp-')) continue;
      const server = mcpServers.find((s) => s && s.id === g.id.slice(4));
      const slug = (server && (server.slug || server.id)) || g.id.slice(4);
      g.control = h(McpAuthSeg, {
        name: g.name,
        slug,
        servers: mcpAuthState.servers,
        shared: mcpAuthState,
        namePrefix: 'popup-mcp',
        onSave: onSaveMcp
      });
    }
  }

  function handleToggleGroup(groupId, checked) {
    if (groupId === 'agent-files') {
      if (onToggleAgentFiles) onToggleAgentFiles(checked);
      return;
    }
    if (groupId === 'skills') {
      if (onToggleSkills) onToggleSkills(checked);
      return;
    }
    // MCP default gate: the group checkbox is a quick Off ↔ Ask for the
    // project's shared MCP fallback (same shortcut as the chat card).
    if (groupId === 'mcp') {
      if (onSaveMcpAuth) onSaveMcpAuth({ mode: checked ? 'ask' : 'off' });
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

  const sk = skills || { items: [], enabled: true, projectLocked: false };
  if (sk.items.length) {
    groups.push({
      id: 'skills',
      name: 'Skills',
      description: sk.items.filter((s) => s.enabled).map((s) => s.name).join(', '),
      checked: sk.enabled,
      disabled: !!sk.projectLocked,
      tools: sk.items.map((s) => ({ id: s.id, name: s.name, description: '', checked: sk.enabled && s.enabled, disabled: true }))
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
      class: 'tool-popup__layer',
      'aria-label': 'Tool settings'
    },
      h('div', {
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
    )
  );
}
