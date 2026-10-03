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
//   authKey     the authorization gate the group row's segment edits. A
//               single-tool family uses the tool name; a multi-tool family
//               (File tools, Chats, mouaif) has its own gate key that covers
//               every leaf, and each leaf may carry its own override.
//   description fallback row description when the catalog has none
//   binary      true for a tool whose only modes are Off / Ask (the answer to
//               `ask_user` cannot be predicted, so Allow makes no sense).
//
// A member name not listed here is not rendered by any tree (the MCP rows
// are built from the server registry instead), so this file is also the
// complete inventory of the native tools the UI knows about.

export const TOOL_GROUPS = Object.freeze([
  // Row order is the tree order every surface renders: the single-tool
  // families first, the Chats / mouaif families next, then progress updates
  // and the File tools family.
  { id: 'shell', name: 'Shell', source: 'shell', authKey: 'shell', tools: ['shell'] },
  { id: 'subagent', name: 'Subagent', source: 'subagent', authKey: 'subagent', tools: ['subagent'] },
  { id: 'ask_user', name: 'Ask user', source: 'ask_user', authKey: 'ask_user', tools: ['ask_user'], binary: true },
  { id: 'task', name: 'Task', source: 'task', authKey: 'task', tools: ['task'] },
  { id: 'webpreview', name: 'Web preview', source: 'webpreview', authKey: 'webpreview', tools: ['webpreview'] },

  // ---- Chat and app tools: two multi-tool families ---------------------
  // Same shape as File tools: one gate (`tools.chats` / `tools.mouaif`)
  // covers every function, and each function can override it.
  {
    id: 'chats',
    name: 'Chats',
    source: 'chats',
    authKey: 'chats',
    tools: ['list_chats', 'get_chat', 'create_chat', 'update_chat', 'change_working_folder', 'search_models', 'start_chat', 'delete_chat', 'search_chats', 'attach_chat_image', 'list_chat_attachments']
  },
  // The mouaif family covers the app's own data model AND the two tools
  // that act on the app itself: `restart_app` (relaunch the worker) and
  // `list_features` (the feature report). They used to be their own
  // top-level rows; they are leaves here like `get_settings`, so the row
  // that "is mouaif" lists everything that touches mouaif.
  //
  // `list_features` is read-only metadata: it honors `off` (the family's
  // or its own) but the server answers it without an approval card, like
  // `report_progress`. `restart_app` uses the ordinary gate, so a family
  // or leaf `allow` lets the assistant relaunch without asking.
  {
    id: 'mouaif-settings',
    name: 'mouaif',
    source: 'mouaif',
    authKey: 'mouaif',
    tools: ['get_settings', 'update_settings', 'list_projects', 'get_app_info', 'restart_app', 'list_features']
  },

  { id: 'report_progress', name: 'Progress updates', source: 'progress', authKey: 'report_progress', tools: ['report_progress'] },
  {
    id: 'files',
    name: 'File tools',
    source: 'files',
    authKey: 'file',
    description: 'read, list, search, write, edit · batches',
    tools: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit']
  }
]);

// GROUP_BY_ID — id -> entry, so a surface holding only a group id (a tap
// handler, a filter callback) can resolve what it means without carrying
// its own copy of the literal.
export const GROUP_BY_ID = Object.freeze(
  Object.fromEntries(TOOL_GROUPS.map((group) => [group.id, group]))
);

// FAMILY_OF — leaf name -> gate key, for every multi-tool family (File
// tools, Chats, mouaif). A leaf resolves through that gate plus its own
// optional override, the same rule the server applies.
export const FAMILY_OF = Object.freeze(Object.fromEntries(
  TOOL_GROUPS.filter((group) => group.authKey && group.tools.length > 1)
    .flatMap((group) => group.tools.map((name) => [name, group.authKey]))
));

// Every leaf of a multi-tool family.
export const FAMILY_LEAF_NAMES = Object.freeze(Object.keys(FAMILY_OF));

// Every name the model renders. Used to keep the agent allowlist choices
// and the catalog → group join from drifting apart.
export const GROUPED_TOOL_NAMES = Object.freeze(TOOL_GROUPS.flatMap((group) => group.tools));

// groupAuthKey(groupId) -> string | null
//
// The authorization gate a group row's segment edits (`shell`, `file`,
// `chats`, `mouaif`, …), or null for a row with no gate.
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

// isGatedTool(name) -> boolean — every tool has an authorization gate.
//
// A group may still opt out of rendering a control with `gated: false`,
// but no group does today: the one such tool (`list_features`) became a
// `mouaif` leaf and takes the ordinary family gate.
export function isGatedTool(name) {
  const groupId = toolGroupId(name);
  const group = groupId ? GROUP_BY_ID[groupId] : null;
  return !group || group.gated !== false;
}

// isFamilyLeaf(name) -> boolean — the tool is one leaf of a multi-tool
// family, so it can carry an override of its own next to the family gate.
export function isFamilyLeaf(name) {
  return Object.prototype.hasOwnProperty.call(FAMILY_OF, name);
}

// toolPermission(name, native, mcp) -> { mode, allowlist }
//
// The effective mode a tree row shows for one tool, from the chat or
// project authorization view. A family `off` hides every leaf; otherwise a
// leaf's own entry wins, then its family gate. MCP tools resolve per tool,
// then per server, then the shared gate.
export function toolPermission(name, native = {}, mcp = {}) {
  if (name.startsWith('mcp__')) {
    const slug = name.slice(5).split('__')[0];
    return (mcp.tools && mcp.tools[name]) || (mcp.servers && mcp.servers[slug]) || mcp;
  }
  const gate = FAMILY_OF[name];
  if (gate && native[gate] && native[gate].mode === 'off') return native[gate];
  return native[name] || (gate ? native[gate] : null) || {};
}
