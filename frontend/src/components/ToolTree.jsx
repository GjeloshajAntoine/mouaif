// mouaif web — ToolTree: hierarchical tool list with inline controls
//
// One shared component for every place tools are listed:
//   1. Chat view (below the system prompt) — per-chat visibility
//      checkboxes; group rows toggle every child at once.
//   2. Project settings — the same tree, but each group row also
//      carries its authorization control (Off/Ask/Allow segment)
//      on the same line, replacing the old stacked permissions list.
//
// Row anatomy (single thin line):
//   [chevron] [checkbox] Name short desc…              [control?]
//
// Click discipline (by design):
//   - Only the checkbox toggles the tool/group.
//   - Only the chevron collapses/expands a group.
//   - Only the control (segment / switch) changes authorization.
//   The row text itself is inert — clicking it does nothing, so
//   there is no accidental toggling when scrolling on touch.
//
// Descriptions are clamped to one short line (see shortDesc); the
// full text survives in the row's title tooltip.
//
// Props:
//   groups: Array<{
//     id, name, description?, checked, disabled?, disabledReason?, title?,
//     control?: any,                 // right-aligned Preact node
//     tools: Array<{ id, name, description?, title?, checked,
//                    disabled?, disabledReason?, used? }>
//   }>
//   onToggleGroup: (groupId, checked) => void
//   onToggleTool: (groupId, toolId, checked) => void
//   collapsedByDefault?: boolean
//   initialCollapsed?: Set<string>  // collision-start set to seed `collapsed`
//   onCollapseChange?: (collapsed: Set<string>) => void  // fired each flip
//   alwaysExpanded?: boolean       // show children without collapse controls
//   class?: string

import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export function ToolTree({ groups = [], onToggleGroup, onToggleTool, collapsedByDefault = false, initialCollapsed, onCollapseChange, alwaysExpanded = false, class: className = '' }) {
  const [collapsed, setCollapsed] = useState(() => {
    // An explicit seed wins over the default so an imperative caller
    // (e.g. the chat tools card, which rebuilds the tree in place on
    // every toggle) can preserve the user's expanded groups across a
    // rebuild instead of snapping the section shut again.
    if (initialCollapsed instanceof Set) return new Set(initialCollapsed);
    if (!collapsedByDefault) return new Set();
    return new Set(groups.filter((g) => (g.tools || []).length > 1).map((g) => g.id));
  });

  // Groups can arrive after the collapse set is seeded above — MCP server
  // groups load asynchronously behind the native groups in project
  // settings, so their ids are not present on first mount and would
  // otherwise render expanded. Seed late-arriving collapsible groups too,
  // but never collapse a group the user has explicitly expanded (saved in
  // `touched` by `flip`). The chat card rebuilds the tree in place and
  // passes `initialCollapsed`, which already seeds every group at mount,
  // so we skip the effect there.
  const touched = useRef(new Set());
  useEffect(() => {
    if (initialCollapsed instanceof Set) return;
    let changed = false;
    const next = new Set(collapsed);
    for (const g of groups) {
      const id = g.id;
      const collapsible = (g.tools || []).length > 1 && !alwaysExpanded;
      if (!collapsedByDefault || !collapsible || touched.current.has(id)) continue;
      if (!next.has(id)) { next.add(id); changed = true; }
    }
    if (changed) setCollapsed(next);
  });

  function flip(groupId) {
    touched.current.add(groupId);
    const next = new Set(collapsed);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setCollapsed(next);
    if (onCollapseChange) onCollapseChange(next);
  }

  const cls = className ? 'tool-tree ' + className : 'tool-tree';
  if (!groups.length) return h('div', { class: cls + ' tool-tree--empty' }, 'No tools available');

  return h('ul', { class: cls, role: 'tree', 'aria-label': 'Tools' },
    groups.map((group) => {
      const kids = group.tools || [];
      const hasChildren = kids.length > 1;
      const collapsible = hasChildren && !alwaysExpanded;
      const isCollapsed = collapsible && collapsed.has(group.id);
      const onCount = kids.filter((t) => t.checked).length;
      // Half-check the group when some (but not all) of its tools are on.
      // `indeterminate` is a DOM-only property, not an attribute. It is
      // passed as a vnode prop: Preact sets it as a DOM property on every
      // render (it is on the HTMLInputElement prototype), which keeps the
      // visual in sync without fighting Preact's commit order or leaving a
      // stale half-check behind after every child becomes fully on.
      const halfChecked = kids.length > 0 && onCount > 0 && onCount < kids.length;

      return h('li', { key: group.id, class: 'tool-tree__group', role: 'treeitem', 'aria-expanded': collapsible ? String(!isCollapsed) : undefined },
        h('div', { class: 'tool-tree__row' + (group.disabled ? ' is-disabled' : ''), title: group.title || (group.disabled && group.disabledReason ? group.disabledReason : undefined) },
          collapsible
            ? h('button', {
                type: 'button',
                class: 'tool-tree__chev' + (isCollapsed ? ' is-collapsed' : ''),
                onClick: () => flip(group.id),
                'aria-label': (isCollapsed ? 'Expand ' : 'Collapse ') + group.name,
                'aria-expanded': String(!isCollapsed)
              },
                h('svg', { viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': 'true' },
                  h('path', { d: 'M4 6 L8 10 L12 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
                )
              )
            : h('span', { class: 'tool-tree__chew', 'aria-hidden': 'true' }),
          // The checkbox is its own click target — the row is NOT a
          // <label>, so tapping the name text does not flip anything.
          // A disabled group is a hard lock (server off, project
          // locked, …): the checkbox is inert and the row explains why.
          h('input', {
            type: 'checkbox',
            class: 'checkbox checkbox--sm',
            checked: !!group.checked,
            disabled: !!group.disabled,
            // `indeterminate` is a DOM-only property; passing it as a vnode
            // prop lets Preact set `el.indeterminate` on every render (it is
            // a property on HTMLInputElement, so Preact's prop diff applies
            // it as `n[l] = value`). Preact only rewrites `checked` when it
            // actually changes, so a toggled child never clobbers the
            // half-check, and once every child is on the prop sends `false`
            // so the half-check clears instead of sticking.
            indeterminate: halfChecked,
            'aria-checked': halfChecked ? 'mixed' : undefined,
            onChange: (e) => onToggleGroup && onToggleGroup(group.id, e.target.checked),
            'aria-label': group.name
          }),
          h('span', { class: 'tool-tree__name tool-tree__name--group' }, group.name),

          group.description ? h('span', { class: 'tool-tree__desc' }, group.description) : null,
          kids.length > 1 ? h('span', { class: 'tool-tree__count' }, onCount + '/' + kids.length) : null,
          group.control ? h('span', { class: 'tool-tree__control' }, group.control) : null
        ),
        // Below-row extra content. A disabled row explains itself
        // here — a dead grey checkbox without a reason helps nobody.
        group.disabled && group.disabledReason
          ? h('div', { class: 'tool-tree__reason' }, group.disabledReason)
          : null,
        hasChildren && !isCollapsed
          ? h('ul', { class: 'tool-tree__children', role: 'group' },
              kids.map((tool) =>
                h('li', { key: tool.id, class: 'tool-tree__item', role: 'treeitem' },
                  h('div', { class: 'tool-tree__row tool-tree__row--leaf' + (tool.used ? ' is-used' : '') + (tool.disabled ? ' is-disabled' : ''), title: tool.title || (tool.disabled && tool.disabledReason ? tool.disabledReason : undefined) },
                    h('input', {
                      type: 'checkbox',
                      class: 'checkbox checkbox--sm',
                      checked: !!tool.checked,
                      disabled: !!tool.disabled || !!group.disabled,
                      onChange: (e) => onToggleTool && onToggleTool(group.id, tool.id, e.target.checked),
                      'aria-label': tool.name
                    }),
                    h('span', { class: 'tool-tree__name' }, tool.name),
                    tool.description ? h('span', { class: 'tool-tree__desc' }, tool.description) : null,
                    tool.used ? h('span', { class: 'tool-tree__used', title: 'Used in this chat' }, '●') : null,
                    tool.disabled && tool.disabledReason
                      ? h('span', { class: 'tool-tree__leaf-reason' }, tool.disabledReason)
                      : null
                  )
                )
              )
            )
          : null,
        // Below-row extras (e.g. the allowlist disclosure in
        // settings). Rendered only when the group supplies them.
        group.extra || null
      );
    })
  );
}

// buildAgentToolGroups({ choices, restricted, selected, mcpServers }) -> groups
//
// Agent-editor flavour: one group per native tool, a "File tools"
// group, and one group per configured MCP server — the same shape
// as the chat tools card and the project Tools section, minus the
// authorization controls (an agent allowlist has no auth meaning).
//
//   choices   — [{ value, label }] (native tools + 'mcp__<slug>' entries)
//   restricted — agent has an explicit allowlist (tools !== undefined)
//   selected   — (value) => bool: is this tool in the allowlist
//                (only consulted when restricted; inherit = all on)
// The group checkbox means "all tools in this group allowed":
// checking a fully-off group enables all its tools; unchecking a
// fully-on group disables all of them. A single on/off pair inside
// a group never collapses the agent back to inherit — only every
// tool on does (handled by the caller).
export function buildAgentToolGroups({ choices, restricted, selected, mcpServers = [] }) {
  const isOn = (value) => !restricted || selected(value);
  const groups = [];
  const natives = choices.filter((c) => !c.value.startsWith('mcp__'));
  const files = natives.filter((c) => ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(c.value));
  for (const c of natives) {
    if (files.includes(c)) continue;
    groups.push({
      id: c.value,
      name: c.label,
      checked: isOn(c.value),
      tools: [{ id: c.value, name: c.label, checked: isOn(c.value) }]
    });
  }
  if (files.length) {
    groups.push({
      id: 'files',
      name: 'File tools',
      description: 'read, list, search, write, edit',
      checked: files.every((c) => isOn(c.value)),
      tools: files.map((c) => ({ id: c.value, name: c.label, checked: isOn(c.value) }))
    });
  }
  for (const c of choices) {
    if (!c.value.startsWith('mcp__')) continue;
    const slug = c.value.slice('mcp__'.length);
    const server = mcpServers.find((s) => s && (s.slug || s.id) === slug);
    const label = c.label.replace(/^MCP:\s*/, '');
    const prefix = c.value + '__';
    const tools = server && Array.isArray(server.tools) ? server.tools.map((tool) => {
      const rawName = typeof tool === 'string' ? tool : tool && tool.name;
      if (!rawName) return null;
      const name = rawName.startsWith(prefix) ? rawName.slice(prefix.length) : rawName;
      const id = rawName.startsWith('mcp__') ? rawName : prefix + rawName;
      return {
        id,
        name,
        description: shortDesc(tool && tool.description),
        title: (tool && tool.description) || '',
        checked: isOn(c.value) || isOn(id)
      };
    }).filter(Boolean) : [];
    groups.push({
      id: c.value, // Agent allowlists may select the whole server.
      name: label,
      description: (server && server.status ? server.status : 'MCP server') + (tools.length ? '' : ' · no tools discovered'),
      checked: isOn(c.value),
      tools: tools.length ? tools : [{ id: c.value, name: label, checked: isOn(c.value) }]
    });
  }
  return groups;
}

// shortDesc(text, max) -> string
//
// Clamp a tool description to one short line. Catalog descriptions
// are full sentences (often 100+ chars); the tree only has room for
// ~40. The full text survives in the row's title tooltip.
export function shortDesc(text, max = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const dot = s.indexOf('. ');
  const head = dot > 0 ? s.slice(0, dot) : s;
  if (head.length <= max) return head;
  return head.slice(0, max - 1).trimEnd() + '…';
}

// buildToolGroups(catalog, mcpServers, filter, usedTools) -> groups
//
// Chat-view flavour: checked state comes from the per-chat tools
// filter (null = all on). MCP groups are always on — there is no
// separate "enabled" server switch — and their checkbox flips the
// per-chat tool filter for the whole server. Used tools get the
// dot badge.
export function buildToolGroups(catalog, mcpServers, filter, usedTools = new Set()) {
  const groups = [];
  const selected = Array.isArray(filter) ? new Set(filter) : null;
  const isOn = (name) => selected == null || selected.has(name);
  const allToolsOn = (tools) => tools.length > 0 && tools.every((t) => t && isOn(t.name));
  const leaf = (t, extra) => Object.assign({
    id: t.name,
    name: t.name,
    description: shortDesc(t.description),
    title: t.description || '',
    checked: isOn(t.name),
    used: usedTools.has(t.name)
  }, extra || {});

  for (const name of ['shell', 'subagent', 'ask_user', 'task']) {
    const t = catalog.find((x) => x && x.name === name);
    if (!t) continue;
    groups.push({
      id: name,
      name,
      description: shortDesc(t.description),
      title: t.description || '',
      checked: isOn(name),
      tools: [leaf(t)]
    });
  }

  const progressTool = catalog.find((x) => x && x.name === 'report_progress');
  if (progressTool) {
    groups.push({
      id: 'report_progress',
      name: 'Progress updates',
      description: shortDesc(progressTool.description),
      title: progressTool.description || '',
      checked: isOn('report_progress'),
      tools: [leaf(progressTool)]
    });
  }

  const fileTools = catalog.filter((t) => t && t.kind === 'native' && t.source === 'files');
  if (fileTools.length) {
    groups.push({
      id: 'files',
      name: 'File tools',
      description: 'read, list, search, write, edit',
      checked: allToolsOn(fileTools),
      tools: fileTools.map((t) => leaf(t))
    });
  }

  for (const server of (mcpServers || [])) {
    if (!server || !server.id) continue;
    const slug = server.slug || server.id;
    const prefix = 'mcp__' + slug + '__';
    let serverTools = catalog.filter((t) => t && t.kind === 'mcp' && t.source === slug);
    // Stopped servers contribute no live catalog entries — fall
    // back to the cached tool list on the server record so the
    // group never disappears from the tree.
    if (!serverTools.length && Array.isArray(server.tools)) {
      serverTools = server.tools.map((t) => {
        const name = typeof t === 'string' ? t : (t && t.name);
        if (!name) return null;
        return {
          name: name.startsWith(prefix) ? name : prefix + name,
          kind: 'mcp',
          source: slug,
          description: (t && t.description) || ''
        };
      }).filter(Boolean);
    }
    groups.push({
      // Keep the row key aligned with the model-facing slug. Project
      // settings already use this key for MCP auth overrides; the chat
      // picker uses it to find the matching server without id/slug drift.
      id: 'mcp-' + slug,
      name: server.name || server.id,
      description: (server.status || 'stopped') + (serverTools.length ? '' : ' · no tools'),
      checked: allToolsOn(serverTools),
      tools: serverTools.map((t) => {
        const short = t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name;
        return leaf(t, { name: short });
      })
    });
  }

  return groups;
}
