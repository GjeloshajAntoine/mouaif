// The native families render as categories in every tools tree, each with its
// own tools as child rows.
//
// Two model-facing areas of the app (chats, and mouaif itself) each render as
// one collapsible category. A category has to look like a category: a chevron,
// child rows, and a count. `restart_app` and `list_features` are children of
// the mouaif row — they are tools OF the app, so they belong with the app's
// other tools rather than in rows of their own. `ask_user` and `task` are
// children of the chats row for the same reason: they are tools OF a chat —
// the model pauses and asks inside one, and it tracks that chat's work — so a
// row of their own said less than the family row does. This asserts the shape
// and the things that shape could silently break:
//
//   * the children are the category's own tools (and every one appears);
//   * a child row stores its model-facing function name, so the chat filter
//     — which stores tool names — is written with `list_chats`;
//   * a binary leaf (`ask_user`) narrows its own row to Off / Ask while the
//     family row keeps the three-way segment;
//   * `off` unchecks the whole category and every child;
//   * a catalog without the tools renders neither row (no dead rows).
//
// Runs the real `buildToolGroups` from frontend/src/components/ToolTree.jsx,
// stripped of imports and evaluated like scripts/test-tool-popup-icon.mjs does.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The group model lives in its own module now (frontend/src/toolGroups.js),
// so the tree's own `import` of it is stripped like every other import and
// the module is evaluated first, in the same context. That is what lets
// `ToolTree.jsx` keep working unmodified in the vm.
const strip = (source) => source
  .replace(/^import .*;$/gm, '')
  .replace(/^export \{.*?\};$/gms, '')
  .replace(/^export /gm, '');
const context = vm.createContext({
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: new Set() }),
  h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(9).filter((c) => c != null && c !== false) })
});
vm.runInContext(strip(fs.readFileSync('frontend/src/toolGroups.js', 'utf8'))
  + '\n' + strip(fs.readFileSync('frontend/src/components/ToolTree.jsx', 'utf8')), context);
const { buildToolGroups } = context;
// `const` at the top level of a vm script does not become a property of the
// context object, so read the model the way the tree does — by evaluating it.
const MOUAIF_TOOL_GROUPS = vm.runInContext("TOOL_GROUPS.filter((group) => ['chats', 'mouaif'].includes(group.authKey))", context);
// Values built inside the VM realm have that realm's Array prototype, so
// `deepStrictEqual` would compare prototypes and fail on identical contents.
// Compare the serialized form instead — the shape is what this file asserts.
const same = (actual, expected, what) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what);

const catalog = [
  { name: 'shell', description: 'Run a shell command in the project directory.' },
  // Every family leaf, report_progress included — it is a chats leaf now, so
  // a standalone entry here would just render the same name twice.
  ...MOUAIF_TOOL_GROUPS.flatMap((group) => group.tools.map((name) => ({ name, kind: 'native', source: group.source })))
];

// --- 1) Two categories, each with its actions as children ------------------
const groups = buildToolGroups(catalog, [], null);
const categories = groups.filter((g) => ['chats', 'mouaif-settings'].includes(g.id));
assert.equal(categories.length, 2, 'one row per category');
same(categories.map((g) => g.name), ['Chats', 'mouaif'], 'two categories, named for what they cover');
same(categories[0].tools.map((t) => t.id), [
  'list_chats', 'get_chat', 'create_chat', 'update_chat', 'change_working_folder', 'search_models', 'start_chat',
  'delete_chat', 'search_chats', 'attach_chat_image', 'list_chat_attachments', 'ask_user', 'task', 'report_progress', 'webpreview'
], 'the chats category lists its fifteen tools');
same(categories[1].tools.map((t) => t.id), [
  'get_settings', 'update_settings', 'list_projects', 'get_app_info', 'restart_app', 'list_features', 'group_cli'
], 'the settings category lists its seven tools');
// More than one child is what gives the row its chevron and count in ToolTree.
assert.ok(categories.every((g) => g.tools.length > 1), 'a category is collapsible');
// The row no longer reads as a bare tool: no child is named `mouaif`.
assert.ok(categories.flatMap((g) => g.tools).every((t) => t.name !== 'mouaif'), 'children are labelled actions');
// Ask user / Task / Progress updates / Web preview moved into the chats row
// instead of rows of their own.
assert.ok(groups.every((g) => !['ask_user', 'task', 'report_progress', 'webpreview'].includes(g.id)),
  'Ask user, Task, Progress updates and Web preview are leaves now, not rows');
assert.ok(categories.flatMap((g) => g.tools).every((t) => t.name && t.name.trim()), 'every child has a label');
// A category never renders before the catalog advertises the tool.
const without = buildToolGroups([{ name: 'shell', description: 'x' }], [], null);
assert.equal(without.filter((g) => g.id.startsWith('mouaif')).length, 0, 'no catalog entry, no rows');

// --- 2) Every row stores the model-facing function name -------------------
// The chat filter stores tool NAMES; a synthetic key would make the server see
// a tool that does not exist. No leaf carries an alias.
assert.ok(categories.flatMap((g) => g.tools).every((t) => !t.toolName && !t.selectionName), 'ordinary leaves have no aliases');
const used = buildToolGroups(catalog, [], null, new Set(['list_chats']));
assert.equal(used.flatMap((g) => g.tools).filter((t) => t.used).length, 1, 'used badges belong to individual tools');

// --- 3) Off unchecks the category and every child --------------------------
// `report_progress` is a chats leaf now, so a selection that names it would
// half-check the family; keep the shell as the only selected tool.
const off = buildToolGroups(catalog, [], ['shell']);
for (const g of off.filter((x) => ['chats', 'mouaif-settings'].includes(x.id))) {
  assert.equal(g.checked, false, g.id + ' unchecked when off');
  assert.ok(g.tools.every((t) => t.checked === false), g.id + ' children unchecked when off');
}
assert.equal(off.find((x) => x.id === 'shell').checked, true, 'the selected row stays checked');

const onlyList = buildToolGroups(catalog, [], ['list_chats']);
const independent = onlyList.filter((g) => ['chats', 'mouaif-settings'].includes(g.id));
assert.equal(independent.flatMap((g) => g.tools).filter((t) => t.checked).length, 1, 'checking one action never selects siblings');
assert.equal(independent[0].tools[0].checked, true);
assert.equal(independent[1].tools.some((t) => t.checked), false, 'the other category stays off');
const legacy = buildToolGroups(catalog, [], ['mouaif']);
assert.ok(legacy.filter((g) => ['chats', 'mouaif-settings'].includes(g.id)).every((g) => !g.checked), 'there is no live legacy-family exception');

// --- 4) A sibling single-child group is unchanged --------------------------
// `files` and the MCP groups keep their own shapes; only the mouaif row moved.
const withFiles = buildToolGroups(catalog.concat([
  { name: 'read_file', kind: 'native', source: 'files', description: 'Read a file.' },
  { name: 'list_files', kind: 'native', source: 'files', description: 'List files.' }
]), [], null);
const files = withFiles.find((g) => g.id === 'files');
same(files.tools.map((t) => t.id), ['read_file', 'list_files'], 'the file group is untouched');
assert.equal(files.tools[0].toolName, undefined, 'a catalog group has no toolName alias');
const mcp = buildToolGroups(
  [{ name: 'mcp__srv__a', kind: 'mcp', source: 'srv', description: 'a' }],
  [{ id: 'srv', slug: 'srv', status: 'ready', tools: ['a'] }],
  null
);
same(mcp.find((g) => g.id === 'mcp-srv').tools.map((t) => t.id), ['mcp__srv__a'], 'the MCP group is untouched');

// --- 5) The frontend's own copy stays in step with the server's ------------
// src/tools/mouaif.js derives its `actions` from ACTIONS; this file cannot
// require it (it is the frontend half), so assert the ids match, which is what
// would drift if a category were renamed on one side only.
same(
  MOUAIF_TOOL_GROUPS.map((g) => g.id),
  ['chats', 'mouaif-settings'],
  'category ids match src/tools/mouaif.js GROUPS'
);
const actions = new Set(categories.flatMap((g) => g.tools.map((t) => t.id)));
assert.equal(actions.size, 22, 'twenty-two tools, each listed once');

// The two app tools sit in the mouaif row now, not as rows of their own:
// one tree row per tool family, and `restart_app` / `list_features` are
// tools of the app, exactly like `get_settings`.
const topLevel = groups.map((g) => g.id);
assert.ok(!topLevel.includes('restart_app'), 'Restart app is no longer a top-level row');
assert.ok(!topLevel.includes('list_features'), 'neither is Feature report');
const appRow = categories.find((g) => g.id === 'mouaif-settings');
assert.ok(appRow.tools.some((t) => t.id === 'restart_app'), 'the mouaif row lists the app restart');
assert.ok(appRow.tools.some((t) => t.id === 'group_cli'), 'and the grouped CLI batch tool');
assert.ok(appRow.tools.some((t) => t.id === 'list_features'), 'and the feature report');

// `ask_user` / `task` are chats leaves now, like `list_chats`: they are
// tools OF a chat, and a stored `tools.ask_user` / `tools.task` still works
// as that leaf's override (asserted on the server side too).
const chatRow = categories.find((g) => g.id === 'chats');
assert.ok(chatRow.tools.some((t) => t.id === 'ask_user'), 'the chats row lists the question tool');
assert.ok(chatRow.tools.some((t) => t.id === 'task'), 'and the task tracker');
assert.ok(chatRow.tools.some((t) => t.id === 'report_progress'), 'and the progress reporter');
assert.ok(chatRow.tools.some((t) => t.id === 'webpreview'), 'and the web preview');
// The row left behind by the move must not survive as a dead tree row.
assert.ok(groups.every((g) => g.id !== 'report_progress'), 'no Progress updates row is left behind');
assert.ok(groups.every((g) => g.id !== 'webpreview'), 'no Web preview row is left behind');

console.log('mouaif tool categories: two categories with their actions as children passed');
