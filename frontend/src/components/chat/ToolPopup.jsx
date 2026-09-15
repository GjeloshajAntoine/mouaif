// mouaif web — Tool popup: floating popover to toggle available tools
//
// A small trigger button in the chat top bar that opens a popup
// with the same hierarchical tool tree shown in the transcript's
// tools card. Changes are persisted immediately via the existing
// toggleTool / toggleToolGroup / toggleAgentFiles / toggleSkill
// callbacks. The popup re-uses the Preact ToolTree component and
// mirrors the state from the chat's tools/agentFiles/mcpServers
// objects.

import { h } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { ToolTree, buildToolGroups } from '../ToolTree.jsx';
import { McpAuthSeg, ToolAuthSeg, TOOL_MODE_CHOICES, ASK_USER_MODE_CHOICES } from '../settings/toolAuth.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useVisualViewport } from '../../hooks/useVisualViewport.js';

// Segment control for Off / Ask / Allow, same model as cards.js.
// Picking Allow clears any allowlist; any other mode keeps it, so an
// ask→off→ask round-trip never loses the patterns. The control itself
// is the shared ToolAuthSeg (../settings/toolAuth.js) — the same
// component the chat tools card and project settings render, so every
// tool row (subagent included) is built by one code path.
function AuthSegment({ toolName, current, onSave }) {
if (!current || !current.mode) return null;
return h(ToolAuthSeg, {
tool: toolName,
name: toolName,
mode: current.mode,
allowlist: Array.isArray(current.allowlist) ? current.allowlist : [],
modes: toolName === 'ask_user' ? ASK_USER_MODE_CHOICES : TOOL_MODE_CHOICES,
namePrefix: 'popup-auth',
// Same contract as the transcript tools card: the popup's pick is a
// per-chat override, so the reset drops this chat's stored value first
// and the chat falls back to the project's mode (decisions §17).
onClear: () => { if (onSave) onSave(toolName, null, []); },
onPick: (mode, allowlist) => { if (onSave) onSave(toolName, mode, allowlist); }
});
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
    onToggleAgentFiles,
    onToggleSkills,
    onToggleSkill,
    onSaveToolAuth,
    onSaveMcpAuth,
    onReloadMcpServer,
    mcpStartBusy,
    autoRetry,
    onToggleAutoRetry
  } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef(null);
  const triggerRef = useRef(null);
  useClickOutside([popupRef, triggerRef], () => setOpen(false), open);

  // Anchor the fixed popover below the complete, wrapping chat header. Using
  // only the trigger bottom makes the top-bar variant overlap the model row.
  const [popupStyle, setPopupStyle] = useState({});
  const syncAvailableHeight = useCallback(() => {
    if (!triggerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const header = triggerRef.current.closest('.chat-view__head');
    const headerRect = header && header.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportHeight = viewport ? viewport.height : window.innerHeight;
    const viewportBottom = (viewport ? viewport.offsetTop : 0) + viewportHeight;
    const anchorBottom = Math.max(triggerRect.bottom, headerRect ? headerRect.bottom : 0);
    const available = Math.max(0, Math.floor(viewportBottom - anchorBottom - 10));
    const maxHeight = Math.min(400, Math.floor(viewportHeight * 0.6), available);
    setPopupStyle({
      top: Math.floor(anchorBottom + 4) + 'px',
      right: Math.max(10, Math.floor(window.innerWidth - triggerRect.right)) + 'px',
      maxHeight: maxHeight + 'px'
    });
  }, []);
  useVisualViewport(syncAvailableHeight, open);

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
webpreview: 'webpreview',
restart_app: 'restart_app',
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
  // the project settings tree: one Off/Ask/Allow segment per MCP server
  // group (the per-server override, showing the effective mode). Writes
  // go through onSaveMcpAuth so the card and settings page stay in sync.
  const mcpAuthState = mcpAuth || { mode: 'ask', allowlist: [], servers: {}, tools: {} };
  for (const g of groups) {
    if (!g.id.startsWith('mcp-')) continue;
    const slug = g.id.slice(4);
    g.control = h(McpAuthSeg, {
    name: g.name,
    slug,
    servers: mcpAuthState.servers,
    shared: mcpAuthState,
    namePrefix: 'popup-mcp',
    onClear: () => { if (onSaveMcpAuth) onSaveMcpAuth({ servers: { [slug]: null } }); },
    onSave: (patch) => onSaveMcpAuth && onSaveMcpAuth(patch)
    });
    // Busy marker for the row's "…" start control. Without it the button
    // looked dead for the whole multi-second MCP cold start.
    if (g.serverId && g.serverId === mcpStartBusy) g.reloadBusy = true;
  }

  // Start a stopped-but-enabled MCP server on demand, exactly like the
  // transcript tools card does — the popup used to render ToolTree
  // without any handler, so its "…" control silently did nothing.
  function handleReloadServer(group) {
    const id = group && group.serverId;
    if (!id || !onReloadMcpServer) return;
    onReloadMcpServer(id);
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
  if (onToggleToolGroup) {
      const group = groups.find((g) => g.id === groupId);
      if (group) onToggleToolGroup(group.tools.map((t) => t.id), checked);
    }
  }

  function handleToggleTool(groupId, toolId, checked) {
    if (groupId === 'agent-files') {
      if (onToggleAgentFiles) onToggleAgentFiles(checked);
      return;
    }
    if (groupId === 'skills') {
      // A row switch stays on its row; the group checkbox above is
      // the all-on / all-off shortcut (handleToggleGroup).
      if (onToggleSkill) onToggleSkill(toolId, checked);
      return;
    }
    if (onToggleTool) onToggleTool(toolId, checked);
  }

  // If agent files are available, add a synthetic group for them
  const af = agentFiles || { files: [], enabled: true, projectLocked: false };
  if (af.files.length) {
    groups.push({
      id: 'agent-files',
      name: 'Agent files',
      description: af.enabled ? 'all selected' : 'off',
      checked: af.enabled,
      disabled: !!af.projectLocked,
      disabledReason: af.projectLocked ? 'Locked off by Settings → Project.' : '',
      alwaysExpanded: true,
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
    // Group checkbox follows the ToolTree convention (see buildToolGroups):
    // `checked` means every child is on, so a partial selection renders as an
    // indeterminate dash whose next tap turns the whole family ON. With
    // `checked: sk.enabled` a half-selected group showed a dash but flipped
    // everything OFF on tap — the opposite of what the dash promises.
    const selectable = sk.items.filter((s) => !s.disabled);
    const allOn = selectable.length > 0 && selectable.every((s) => !s.chatDisabled);
    groups.push({
      id: 'skills',
      name: 'Skills',
      description: sk.enabled ? 'available metadata' : 'off',
      checked: !!sk.enabled && allOn,
      disabled: !!sk.projectLocked,
      disabledReason: sk.projectLocked ? 'Locked off by Settings → Project.' : '',
      alwaysExpanded: true,
      tools: sk.items.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description || '',
        checked: sk.enabled && !s.disabled && !s.chatDisabled,
        disabled: !!sk.projectLocked || !!s.disabled,
        disabledReason: s.disabled ? 'Disabled in Settings → Project' : ''
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
      class: 'tool-popup__layer',
      'aria-label': 'Tool settings'
    },
      h('div', {
        class: 'tool-popup__popup',
        role: 'dialog',
        'aria-label': 'Tool settings',
        style: popupStyle
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
            onReloadServer: handleReloadServer,
            collapsedByDefault: true,
            class: 'tool-popup__tree'
          })
        ),
        h('div', { class: 'tool-popup__foot' },
h('label', { class: 'switch switch--sm' },
h('input', {
type: 'checkbox',
role: 'switch',
'aria-checked': String(!!autoRetry),
checked: !!autoRetry,
onChange: () => onToggleAutoRetry && onToggleAutoRetry()
}),
h('span', { class: 'switch__track', 'aria-hidden': 'true' },
h('span', { class: 'switch__thumb' })
),
h('span', { class: 'tool-popup__foot-label' }, 'Auto-retry failed sends')
),
h('span', { class: 'tool-popup__foot-note' },
'Actions run immediately. Off / Ask / Allow here applies to this chat only; project-wide modes live in Settings → Project. Tools marked \u25CF have been used in this chat.'
)
)
      )
    )
  );
}
