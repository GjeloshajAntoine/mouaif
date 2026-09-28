// mouaif web — File tools: the Read / Edit split
//
// The five native file tools used to render as ONE "File tools" group in
// every tool tree. That read as a single blob: a user who wants the model
// to inspect the project but never modify it had to expand the group and
// uncheck `write_file` / `edit_file` one by one, and a glance at the
// collapsed row could not tell read-only from read-write.
//
// They now split into two groups by *effect*:
//   - **Read tools**  — `read_file`, `list_files`, `search_files`.
//     Pure inspection: they never change a file.
//   - **Edit tools**  — `write_file`, `edit_file`.
//     They mutate the working tree, so they are the half a cautious user
//     wants to keep off while still letting the model look around.
//
// The split is a *presentation* change only. Authorization stays exactly as
// it was — one project `tools.file` family gate plus optional per-leaf
// `tools.<name>` overrides (src/tools/authorization.js) — so every group
// here still reports and edits the same `file` mode, and a leaf checkbox
// still pins its own per-tool override. Nothing in the server changed.
//
// Shared by the three tree builders that list file tools:
//   - `buildToolGroups`      (chat tools card, composer popup, chat preset)
//   - `buildSettingsToolGroups` (Settings → Project)
//   - `buildAgentToolGroups` (agent editor allowlist)

// Group ids. Kept as stable strings because every surface keys its
// toggle handler, collapse state, and (in Settings) its authorization
// write on the id.
export const READ_GROUP_ID = 'files-read';
export const EDIT_GROUP_ID = 'files-edit';

// The model-facing names, in the order the tools were declared.
export const READ_TOOL_NAMES = ['read_file', 'list_files', 'search_files'];
export const EDIT_TOOL_NAMES = ['write_file', 'edit_file'];

export const FILE_TOOL_NAMES = [...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES];

const READ_SET = new Set(READ_TOOL_NAMES);
const EDIT_SET = new Set(EDIT_TOOL_NAMES);

// isFileToolName(name) -> bool
export function isFileToolName(name) {
  return READ_SET.has(name) || EDIT_SET.has(name);
}

// partitionFileTools(tools) -> { read, edit }
//
// Split a list of file-tool entries (catalog rows, `{ value }` choices, or
// anything else carrying a `name` / `value`) into the two groups. Unknown
// names fall into `edit` — a future file tool is assumed to mutate the
// tree until it is explicitly classified above, which is the safe default
// for a read-only intent.
export function partitionFileTools(tools) {
  const read = [];
  const edit = [];
  for (const t of (tools || [])) {
    if (!t) continue;
    const name = t.name || t.value;
    if (READ_SET.has(name)) read.push(t);
    else edit.push(t);
  }
  return { read, edit };
}

// groupMeta(kind) -> { id, name, description }
//
// The shared label for each group, so the chat card, the settings tree,
// and the agent editor read identically.
export function groupMeta(kind) {
  if (kind === 'read') {
    return { id: READ_GROUP_ID, name: 'Read tools', description: 'read, list, search' };
  }
  return { id: EDIT_GROUP_ID, name: 'Edit tools', description: 'write, edit' };
}
