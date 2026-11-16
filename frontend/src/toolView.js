// mouaif web — the simplified tool view.
//
// A project can replace the chat's default tool groups (Shell, Chats, File
// tools, one per MCP server, …) with its own short list of categories, each
// naming the tools it shows. It is a display setting only: a tool left out of
// every category keeps its checkbox state and its Off / Ask / Allow mode — it
// is just not listed in the chat's Tools card and popup unless the user taps
// the "All (N)" view tab.
//
// Stored per project as `toolView`:
//   { enabled: boolean, categories: [{ name: string, tools: string[] }] }
//
// See docs/features/simplified-tool-view.md.

export const MAX_CATEGORIES = 24;
export const MAX_NAME_LENGTH = 40;

// Starter presets so turning on Simplified mode on an empty project takes one
// tap instead of building every category from scratch. Tools not present in a
// project's catalog are filtered out when the preset is applied or rendered.
export const TOOL_VIEW_PRESETS = [
  {
    id: 'coding',
    label: 'Coding essentials',
    description: 'Read & search, Edit files, and Run commands',
    categories: [
      { name: 'Read & search', tools: ['read_file', 'list_files', 'search_files', 'group_read'] },
      { name: 'Edit files', tools: ['edit_file', 'write_file', 'group_edit'] },
      { name: 'Run commands', tools: ['shell', 'group_cli'] }
    ]
  },
  {
    id: 'read-only',
    label: 'Read & inspect',
    description: 'Browse files and ask questions without editing or shell',
    categories: [
      { name: 'Inspect files', tools: ['read_file', 'list_files', 'search_files', 'group_read'] },
      { name: 'Workflow', tools: ['ask_user', 'task', 'report_progress'] }
    ]
  },
  {
    id: 'agentic',
    label: 'Full coding + subagents',
    description: 'Files, shell, and subagent delegation',
    categories: [
      { name: 'Files', tools: ['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'group_read', 'group_edit'] },
      { name: 'Shell', tools: ['shell', 'group_cli'] },
      { name: 'Delegate', tools: ['subagent', 'subagent_status', 'subagent_messages', 'subagent_send', 'subagent_stop'] }
    ]
  }
];

// normalizeToolView(raw) -> { enabled, categories }
//
// Tolerates a hand-edited value: anything that is not a category with a
// list of tool names is dropped, names are trimmed, duplicates removed.
export function normalizeToolView(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const categories = [];
  for (const entry of (Array.isArray(src.categories) ? src.categories : [])) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    const tools = Array.from(new Set(
      (Array.isArray(entry.tools) ? entry.tools : []).filter((t) => typeof t === 'string' && t)
    ));
    categories.push({ name, tools });
    if (categories.length >= MAX_CATEGORIES) break;
  }
  return { enabled: src.enabled === true, categories };
}

// isToolViewActive(view) -> boolean — on, and at least one category picks a tool.
export function isToolViewActive(view) {
  const v = normalizeToolView(view);
  return v.enabled && v.categories.some((c) => c.tools.length > 0);
}

// toolViewStats(groups, view) -> {
//   totalTools, shownTools, hiddenTools, activeCategories, totalCategories
// }
//
// Counts how many catalog tools the current simplified view shows vs. hides,
// so both the Settings editor and the chat Tools header can make the effect of
// Simplified mode explicit at a glance.
export function toolViewStats(groups, view) {
  const v = normalizeToolView(view);
  const catalogIds = new Set();
  for (const g of (groups || [])) {
    for (const t of (g.tools || [])) {
      if (t && t.id) catalogIds.add(t.id);
    }
  }
  const shownIds = new Set();
  let activeCategories = 0;
  for (const cat of v.categories) {
    let catHasAny = false;
    for (const name of cat.tools) {
      if (!catalogIds.size || catalogIds.has(name)) {
        shownIds.add(name);
        catHasAny = true;
      }
    }
    if (catHasAny) activeCategories++;
  }
  const totalTools = catalogIds.size;
  const shownTools = shownIds.size;
  const hiddenTools = totalTools > shownTools ? totalTools - shownTools : 0;
  return {
    totalTools,
    shownTools,
    hiddenTools,
    activeCategories,
    totalCategories: v.categories.length
  };
}

// applyToolView(groups, view) -> groups
//
// Regroup already-built ToolTree groups (leaves carrying their checked state
// and controls) into the project's categories. Leaves keep their ids — the
// model-facing function names — so the tree's toggle handlers work unchanged.
// A picked tool the catalog does not advertise (a removed MCP server, a tool
// switched off for the project) is skipped; a category left with no tool is
// not rendered. Returns the input untouched when the view is not active.
export function applyToolView(groups, view) {
  if (!isToolViewActive(view)) return groups;
  const byName = new Map();
  for (const g of (groups || [])) {
    for (const t of (g.tools || [])) {
      if (t && t.id && !byName.has(t.id)) byName.set(t.id, t);
    }
  }
  const out = [];
  normalizeToolView(view).categories.forEach((cat, index) => {
    const tools = cat.tools.map((name) => byName.get(name)).filter(Boolean);
    if (!tools.length) return;
    out.push({
      id: 'view-' + index,
      name: cat.name || 'Category ' + (index + 1),
      description: '',
      checked: tools.every((t) => t.checked),
      // A one-tool category still shows its tool row (the tree hides the
      // only child of a group otherwise).
      alwaysExpanded: tools.length === 1,
      tools
    });
  });
  return out;
}

// toolViewSummary(view) -> short label for the settings link row.
export function toolViewSummary(view) {
  const v = normalizeToolView(view);
  if (!v.enabled) return 'All tools';
  const active = v.categories.filter((c) => c.tools.length);
  if (!active.length) return 'No tools picked';
  const uniqueTools = new Set();
  for (const c of active) for (const t of c.tools) uniqueTools.add(t);
  const catLabel = active.length + (active.length === 1 ? ' category' : ' categories');
  return 'Simplified · ' + catLabel + ' (' + uniqueTools.size + ')';
}
