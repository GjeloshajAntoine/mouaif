// The app-wide tool-group model — one list decides which tool belongs to
// which group, for the chat tools card, the composer popup, project settings,
// the preset tree and the agent editor.
//
// What this pins, beyond the shape:
//
//   * every native tool the server advertises is listed exactly once, so a
//     new tool cannot be added to the model and forgotten by the trees (or
//     listed twice and rendered as two rows);
//   * the model's membership matches what the server actually serves — the
//     generated mirror (frontend/build/toolGroups.json) and the auth module's
//     tool set are both derived from it, so a rename on one side fails here
//     instead of at runtime;
//   * the helpers the surfaces share (`groupAuthKey`, `isBinaryTool`,
//     `categoryMode`, `toolGroupId`) keep their contracts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = await import('../frontend/src/toolGroups.js');

const ROOT = path.join(import.meta.dirname, '..');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}
const same = (actual, expected, what) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what);

// ---- 1. Membership is complete and unique --------------------------------
const listed = model.TOOL_GROUPS.flatMap((group) => group.tools);
check('no tool is listed twice', () => {
  assert.equal(new Set(listed).size, listed.length, 'a tool may only sit in one group');
});
check('every group id is unique', () => {
  const ids = model.TOOL_GROUPS.map((group) => group.id);
  assert.equal(new Set(ids).size, ids.length);
});
check('every group has a name and at least one tool', () => {
  for (const group of model.TOOL_GROUPS) {
    assert.ok(group.name && group.name.trim(), group.id + ' needs a row name');
    assert.ok(group.tools.length > 0, group.id + ' lists no tools');
  }
});
check('a category has no gate, a family has one', () => {
  for (const group of model.TOOL_GROUPS) {
    // The un-gated tool is the deliberate exception: it renders as a row, but
    // there is no mode for it to write.
    if (group.gated === false) continue;
    if (group.kind === 'category') assert.ok(!group.authKey, group.id + ' is a category and must not carry a gate');
    else assert.ok(group.authKey, group.id + ' is a family and needs its authorization key');
  }
});
check('the feature report is the only un-gated tool', () => {
  const unGated = model.TOOL_GROUPS.filter((group) => group.gated === false).map((group) => group.id);
  same(unGated, ['list_features'], 'the server answers list_features without a prompt');
});

// ---- 2. The model matches what the server serves -------------------------
check('the server catalog and the model agree', () => {
  const { listNativeTools } = require('../src/server-handlers-tools.js');
  const catalog = listNativeTools().map((tool) => tool.name).sort();
  same([...listed].sort(), catalog.filter((name) => listed.includes(name)).sort(), 'listed tools are a subset of the catalog');
  const unlisted = catalog.filter((name) => !listed.includes(name));
  same(unlisted, [], 'every native tool the server advertises is in a group');
});
check('the native authorization keys still cover every gated tool', () => {
  const authz = require('../src/tools/authorization.js');
  for (const group of model.TOOL_GROUPS) {
    if (group.gated === false) continue;
    const keys = group.kind === 'category' ? group.tools : [group.authKey];
    for (const key of keys) {
      assert.ok(authz.NATIVE_TOOLS.has(key) || authz.FILE_FAMILY_TOOLS.has(key), key + ' has no authorization gate');
    }
  }
});

// ---- 3. The generated mirror is current ----------------------------------
check('the server mirror matches the model', () => {
  const file = path.join(ROOT, 'frontend', 'build', 'toolGroups.json');
  assert.ok(fs.existsSync(file), 'frontend/build/toolGroups.json is generated — run scripts/build-tool-groups.js');
  const mirror = JSON.parse(fs.readFileSync(file, 'utf8'));
  same(mirror.map((group) => group.id), model.TOOL_GROUPS.map((group) => group.id), 'run: node scripts/build-tool-groups.js');
  same(mirror, JSON.parse(JSON.stringify(model.TOOL_GROUPS)), 'the mirror must be a byte-for-byte copy of the model');
});
check('the feature summary prints one line per category', () => {
  const { listNativeTools } = require('../src/server-handlers-tools.js');
  const lines = require('../src/toolGroups.js').summaryLines(listNativeTools());
  same(lines.map((line) => line.split(']')[0] + ']'), ['[Chats]', '[mouaif]'], 'categorized tools report under their row name');
  assert.ok(lines[0].includes('list_chats') && lines[1].includes('get_app_info'));
});

// ---- 4. The shared helpers ------------------------------------------------
check('groupAuthKey resolves a family and refuses a category', () => {
  assert.equal(model.groupAuthKey('shell'), 'shell');
  assert.equal(model.groupAuthKey('files'), 'file');
  assert.equal(model.groupAuthKey('chats'), null);
  assert.equal(model.groupAuthKey('nope'), null);
  // A family with more than one leaf must not list its own gate as one of
  // them: the gate is a family key (`file`), not a tool name, and a row that
  // wrote it would double-write the family on every tap. A single-tool family
  // (`shell`) legitimately has its tool name as the key.
  for (const group of model.TOOL_GROUPS) {
    if (!group.authKey || group.tools.length < 2) continue;
    assert.ok(!group.tools.includes(group.authKey), group.id + ' must not list its family gate as a leaf');
  }
});
check('isBinaryTool narrows ask_user only', () => {
  assert.equal(model.isBinaryTool('ask_user'), true);
  assert.equal(model.isBinaryTool('shell'), false);
  assert.equal(model.isBinaryTool('chats'), false);
});
check('isFileLeaf recognizes the file family leaves', () => {
  same(model.FILE_TOOL_NAMES, ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit']);
  for (const name of model.FILE_TOOL_NAMES) assert.equal(model.isFileLeaf(name), true, name);
  assert.equal(model.isFileLeaf('shell'), false);
});
check('toolGroupId maps a tool back to its row', () => {
  assert.equal(model.toolGroupId('list_chats'), 'chats');
  assert.equal(model.toolGroupId('get_app_info'), 'mouaif-settings');
  assert.equal(model.toolGroupId('group_edit'), 'files');
  assert.equal(model.toolGroupId('restart_app'), 'restart_app');
  assert.equal(model.toolGroupId('mcp__x__y'), null, 'MCP rows live outside the native model');
});
check('categoryMode shows a mode only when every child agrees', () => {
  same([
    model.categoryMode(['off', 'off']), model.categoryMode(['allow', 'allow']),
    model.categoryMode(['allow', 'off']), model.categoryMode(['ask', 'ask']),
    model.categoryMode([]), model.categoryMode([undefined, null])
  ], ['off', 'allow', 'ask', 'ask', 'ask', 'ask']);
});

console.log('tool groups: ' + passed + ' checks passed');
