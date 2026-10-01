// The `mouaif` tool renders as TWO categories in every tools tree, each with its
// own actions as child rows.
//
// The tool is one model-facing spec and one authorization family, so the tree
// used to draw it as one row per half — and a one-child group in `ToolTree`
// hides its child, so those two rows were indistinguishable from `shell` or
// `Task`. A category has to look like a category: a chevron, child rows, and a
// count. This asserts the shape and the four things that shape could silently
// break:
//
//   * the children are the category's own actions (and every action appears);
//   * a child row still resolves to the single `mouaif` tool, so the chat filter
//     — which stores tool names — is written with `mouaif` and not `mouaif:list`;
//   * `off` unchecks the whole category and every child;
//   * a catalog without the tool renders neither row (no dead rows).
//
// Runs the real `buildToolGroups` from frontend/src/components/ToolTree.jsx,
// stripped of imports and evaluated like scripts/test-tool-popup-icon.mjs does.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('frontend/src/components/ToolTree.jsx', 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: new Set() }),
  h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(9).filter((c) => c != null && c !== false) })
});
vm.runInContext(source, context);
const { buildToolGroups } = context;
// `const` at the top level of a vm script does not become a property of the
// context object, so read the export the way the tree does — by evaluating it.
const MOUAIF_TOOL_GROUPS = vm.runInContext('MOUAIF_TOOL_GROUPS', context);
// Values built inside the VM realm have that realm's Array prototype, so
// `deepStrictEqual` would compare prototypes and fail on identical contents.
// Compare the serialized form instead — the shape is what this file asserts.
const same = (actual, expected, what) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what);

const catalog = [
  { name: 'shell', description: 'Run a shell command in the project directory.' },
  { name: 'mouaif', description: 'Manage mouaif itself: chats, settings, projects.' },
  { name: 'report_progress', description: 'Report real-time progress.' }
];

// --- 1) Two categories, each with its actions as children ------------------
const groups = buildToolGroups(catalog, [], null);
const categories = groups.filter((g) => g.id.startsWith('mouaif'));
assert.equal(categories.length, 2, 'one row per category');
same(categories.map((g) => g.name), ['Chats', 'mouaif'], 'two categories, named for what they cover');
same(categories[0].tools.map((t) => t.id), [
  'mouaif:list', 'mouaif:get', 'mouaif:create', 'mouaif:update',
  'mouaif:delete', 'mouaif:search', 'mouaif:attach', 'mouaif:list_attachments'
], 'the chats category lists its eight actions');
same(categories[1].tools.map((t) => t.id), [
  'mouaif-settings:settings_get', 'mouaif-settings:settings_update',
  'mouaif-settings:project_list', 'mouaif-settings:info'
], 'the settings category lists its four actions');
// More than one child is what gives the row its chevron and count in ToolTree.
assert.ok(categories.every((g) => g.tools.length > 1), 'a category is collapsible');
// The row no longer reads as a bare tool: no child is named `mouaif`.
assert.ok(categories.flatMap((g) => g.tools).every((t) => t.name !== 'mouaif'), 'children are labelled actions');
assert.ok(categories.flatMap((g) => g.tools).every((t) => t.name && t.name.trim()), 'every child has a label');
// A category never renders before the catalog advertises the tool.
const without = buildToolGroups([{ name: 'shell', description: 'x' }], [], null);
assert.equal(without.filter((g) => g.id.startsWith('mouaif')).length, 0, 'no catalog entry, no rows');

// --- 2) Every row still belongs to the single `mouaif` tool ----------------
// The chat filter stores tool NAMES; `mouaif:list` is only a tree key. Without
// `toolName` the card would write `mouaif:list` into the chat and the server
// would see a tool that does not exist.
assert.ok(categories.flatMap((g) => g.tools).every((t) => t.toolName === 'mouaif'), 'children resolve to the one tool');
const used = buildToolGroups(catalog, [], null, new Set(['mouaif']));
assert.ok(used.filter((g) => g.id.startsWith('mouaif')).flatMap((g) => g.tools).every((t) => t.used === true), 'the used dot marks the category');

// --- 3) Off unchecks the category and every child --------------------------
const off = buildToolGroups(catalog, [], ['shell', 'report_progress']);
for (const g of off.filter((x) => x.id.startsWith('mouaif'))) {
  assert.equal(g.checked, false, g.id + ' unchecked when off');
  assert.ok(g.tools.every((t) => t.checked === false), g.id + ' children unchecked when off');
}

const onlyList = buildToolGroups(catalog, [], ['mouaif:list']);
const independent = onlyList.filter((g) => g.id.startsWith('mouaif'));
assert.equal(independent.flatMap((g) => g.tools).filter((t) => t.checked).length, 1, 'checking one action never selects siblings');
assert.equal(independent[0].tools[0].checked, true);
assert.equal(independent[1].tools.some((t) => t.checked), false, 'the other category stays off');
const legacy = buildToolGroups(catalog, [], ['mouaif']);
assert.ok(legacy.filter((g) => g.id.startsWith('mouaif')).every((g) => g.checked), 'legacy family selection still enables every action');

// --- 4) A sibling single-child group is unchanged --------------------------
// `files` and the MCP groups keep their own shapes; only the mouaif rows split.
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
  ['mouaif', 'mouaif-settings'],
  'category ids match src/tools/mouaif.js GROUPS'
);
const actions = new Set(categories.flatMap((g) => g.tools.map((t) => t.title.match(/"([^"]+)"/)[1])));
assert.equal(actions.size, 12, 'twelve actions, each listed once');

console.log('mouaif tool categories: two categories with their actions as children passed');
