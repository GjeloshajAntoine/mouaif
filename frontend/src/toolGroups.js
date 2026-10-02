// mouaif web — the app-wide tool-group model.
//
// One list decides which tools belong to which group, for every surface
// that lists tools: the chat tools card, the composer tools popup, project
// settings, the Custom prompts preset tree, and the agent editor. A tool
// moves between groups by editing `tools` here — nothing else.
//
// Entry shape:
//   id          group id (also the tree row key)
//   name        row label
//   source      the catalog `source` the tools advertise (documentation +
//               the server's own grouping; membership below is authoritative)
//   tools       the model-facing function names in this group
//   kind        'category' for a group of independent functions, omitted
//               for a family that shares one authorization gate
//   authKey     the authorization key an un-gated member writes, and the one
//               the group row's segment edits. A family sets it; a category
//               has no key of its own, so its segment writes every child.
//   description fallback row description when the catalog has none
//   gated       false for a tool with no project authorization gate at all
//               (see list_features) — it still lists, but cannot be turned
//               off from Settings → Project.
//   binary      true for a tool whose only modes are Off / Ask (the answer to
//               `ask_user` cannot be predicted, so Allow makes no sense).
//
// A member name not listed here is not rendered by any tree (the MCP rows
// are built from the server registry instead), so this file is also the
// complete inventory of the native tools the UI knows about.

export const TOOL_GROUPS = Object.freeze([
  // ---- Chat and app tools, grouped so they read as categories ----------
  {
    id: 'chats',
    name: 'Chats',
    kind: 'category',
    source: 'chats',
    tools: ['list_chats', 'get_chat', 'create_chat', 'update_chat', 'delete_chat', 'search_chats', 'attach_chat_image', 'list_chat_attachments']
  },
  {
    id: 'mouaif-settings',
    name: 'mouaif',
    kind: 'category',
    source: 'mouaif',
    tools: ['get_settings', 'update_settings', 'list_projects', 'get_app_info']
  },

  // ---- One row per tool family ----------------------------------------
  // A family is one tool with one authorization gate, so the group row and
  // its only child carry the same mode.
  { id: 'shell', name: 'Shell', source: 'shell', authKey: 'shell', tools: ['shell'] },
  { id: 'subagent', name: 'Subagent', source: 'subagent', authKey: 'subagent', tools: ['subagent'] },
  { id: 'task', name: 'Task', source: 'task', authKey: 'task', tools: ['task'] },
  { id: 'ask_user', name: 'Ask user', source: 'ask_user', authKey: 'ask_user', tools: ['ask_user'], binary: true },
  { id: 'webpreview', name: 'Web preview', source: 'webpreview', authKey: 'webpreview', tools: ['webpreview'] },
  { id: 'restart_app', name: 'Restart app', source: 'restart', authKey: 'restart_app', tools: ['restart_app'] },
  { id: 'report_progress', name: 'Progress updates', source: 'progress', authKey: 'report_progress', tools: ['report_progress'] },
  {
    id: 'files',
    name: 'File tools',
    source: 'files',
    authKey: 'file',
    description: 'read, list, search, write, edit · batches',
    tools: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit']
  },
  // The feature report is a read-only metadata tool: the server serves it
  // without passing through the authorization gate, so it has no Off /
  // Ask / Allow in project settings (the row explains that instead of
  // showing a control that would not do anything).
  { id: 'list_features', name: 'Feature report', source: 'features', tools: ['list_features'], gated: false }
]);

// GROUP_BY_ID — id -> entry, so a surface holding only a group id (a tap
// handler, a filter callback) can resolve what it means without carrying
// its own copy of the literal.
export const GROUP_BY_ID = Object.freeze(
  Object.fromEntries(TOOL_GROUPS.map((group) => [group.id, group]))
);

// The category rows (a group of independent functions, no shared gate).
export const CATEGORY_GROUPS = Object.freeze(
  TOOL_GROUPS.filter((group) => group.kind === 'category')
);

export const CATEGORY_GROUP_IDS = Object.freeze(CATEGORY_GROUPS.map((group) => group.id));

// APP_TOOL_NAMES — every function listed under a category row. The names
// are ordinary per-tool authorization keys (there is no category-level
// permission), which is why the surfaces resolve a category child by name.
export const CATEGORY_TOOL_NAMES = Object.freeze(CATEGORY_GROUPS.flatMap((group) => group.tools));

// The single-tool families, in tree order.
export const FAMILY_GROUPS = Object.freeze(
  TOOL_GROUPS.filter((group) => group.kind !== 'category' && !group.authKey)
);

// Every name the model renders. Used to keep the agent allowlist choices
// and the catalog → group join from drifting apart.
export const GROUPED_TOOL_NAMES = Object.freeze(TOOL_GROUPS.flatMap((group) => group.tools));

// isCategoryGroup(groupId) -> boolean
export function isCategoryGroup(groupId) {
  return CATEGORY_GROUP_IDS.includes(groupId);
}

// groupAuthKey(groupId) -> string | null
//
// The authorization key a group row's segment edits: the family's own key
// (`shell`, `file`, the file family's key for the file group, …), or null
// for a category, whose pick writes every child instead.
export function groupAuthKey(groupId) {
  const group = GROUP_BY_ID[groupId];
  return (group && group.authKey) || null;
}

// groupTools(groupId) -> string[]
export function groupTools(groupId) {
  const group = GROUP_BY_ID[groupId];
  return group ? group.tools.slice() : [];
}

// toolGroupId(name) -> string | null — which group row lists this tool.
export function toolGroupId(name) {
  for (const group of TOOL_GROUPS) {
    if (group.tools.includes(name)) return group.id;
  }
  return null;
}

// isBinaryTool(groupId) -> boolean — the group's tool only supports Off / Ask
// (`ask_user`: the model cannot predict the answer, so Allow means nothing).
export function isBinaryTool(groupId) {
  const group = GROUP_BY_ID[groupId];
  return !!(group && group.binary);
}

// isGatedTool(name) -> boolean — false only for a tool the server serves
// without an authorization gate, so a settings row must not offer a mode
// it cannot honor.
export function isGatedTool(name) {
  const groupId = toolGroupId(name);
  const group = groupId ? GROUP_BY_ID[groupId] : null;
  return !group || group.gated !== false;
}

// FILE_TOOL_NAMES — the leaves of the File tools family. Their authorization
// resolves through the `file` gate plus a per-leaf override, so a status line
// for a leaf edit belongs on the `file` row.
export const FILE_TOOL_NAMES = Object.freeze(
  (GROUP_BY_ID.files && GROUP_BY_ID.files.tools) || []
);

// isFileLeaf(name) -> boolean
export function isFileLeaf(name) {
  return FILE_TOOL_NAMES.includes(name);
}

// categoryMode(modes) -> 'off' | 'ask' | 'allow'
//
// What a category row's segment shows: the one mode every child agrees on,
// else 'ask'. A category is not a fourth permission level — its segment is
// a shortcut that writes every child, the way the group checkbox is a
// shortcut for the chat filter. A child with no stored mode is `ask`, the
// native default, not a fourth unknown value; an empty list reads `ask` too.
export function categoryMode(modes) {
  const list = (modes || []).map((mode) => (mode === 'off' || mode === 'allow' || mode === 'allowlist' ? mode : 'ask'));
  if (!list.length) return 'ask';
  if (list.every((mode) => mode === 'off')) return 'off';
  if (list.every((mode) => mode === 'allow')) return 'allow';
  return 'ask';
}
