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
//     `toolPermission`, `toolGroupId`) keep their contracts.

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
check('every gated group has a family gate', () => {
  for (const group of model.TOOL_GROUPS) {
    // A group may declare `gated: false` to say "no mode control here".
    // No group does today (list_features became a mouaif leaf), but the
    // escape hatch stays: such a row lists without a control.
    if (group.gated === false) continue;
    assert.ok(group.authKey, group.id + ' needs its authorization key');
    assert.equal(group.kind, undefined, group.id + ': there is no second group kind');
  }
});
check('no un-gated group is left behind', () => {
  const unGated = model.TOOL_GROUPS.filter((group) => group.gated === false).map((group) => group.id);
  same(unGated, [], 'every native row offers the mode it honors');
});
check('the no-prompt tools are still listed and still gated', () => {
  // `report_progress` and `list_features` are answered without an approval
  // card, but they are not ungated: an `off` hides them, and they resolve
  // through the ordinary authorization machinery (a family leaf in
  // list_features' case). A name that is not advertised anywhere would be
  // the real bug.
  const noPrompt = [...require('../src/ai-stream.js').NO_PROMPT_TOOLS].sort();
  same(noPrompt, ['list_features', 'report_progress'], 'the read-only tools are the only ones');
  const authz = require('../src/tools/authorization.js');
  for (const name of noPrompt) {
    assert.ok(listed.includes(name), name + ' must be listed in a group');
    assert.ok(authz.NATIVE_TOOLS.has(name) || authz.FAMILY_TOOLS.has(name), name + ' must resolve through a gate');
  }
  assert.equal(model.FAMILY_OF.list_features, 'mouaif', 'the feature report is a mouaif leaf, not its own gate');
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
    assert.ok(authz.NATIVE_TOOLS.has(group.authKey), group.authKey + ' has no authorization gate');
    // A multi-tool family on screen is a multi-tool family on the server:
    // same gate key, same leaves.
    if (group.tools.length > 1) same(authz.TOOL_FAMILIES[group.authKey], group.tools, group.id + ' leaves match the server family');
  }
  same(Object.keys(authz.TOOL_FAMILIES).sort(),
    model.TOOL_GROUPS.filter((group) => group.tools.length > 1).map((group) => group.authKey).sort(),
    'the server has no family the UI does not render');
});

// ---- 3. The generated mirror is current ----------------------------------
check('the server mirror matches the model', () => {
  const file = path.join(ROOT, 'frontend', 'build', 'toolGroups.json');
  assert.ok(fs.existsSync(file), 'frontend/build/toolGroups.json is generated — run scripts/build-tool-groups.js');
  const mirror = JSON.parse(fs.readFileSync(file, 'utf8'));
  same(mirror.map((group) => group.id), model.TOOL_GROUPS.map((group) => group.id), 'run: node scripts/build-tool-groups.js');
  same(mirror, JSON.parse(JSON.stringify(model.TOOL_GROUPS)), 'the mirror must be a byte-for-byte copy of the model');
});
check('the feature summary prints one line per family gate', () => {
  const { listNativeTools } = require('../src/server-handlers-tools.js');
  const groups = require('../src/toolGroups.js');
  const lines = groups.summaryLines(listNativeTools(), { chats: { mode: 'ask' }, mouaif: { mode: 'allow' } }, new Set(['file']));
  same(lines.map((line) => line.split(']')[0] + ']'), ['[Chats]', '[mouaif]'], 'families report under their row name');
  assert.ok(lines[0].includes('→ ask') && lines[0].includes('list_chats'));
  assert.ok(lines[1].includes('→ allow') && lines[1].includes('get_app_info'));
  // restart_app was a line of its own before it joined the family; it must
  // appear (under the mouaif label) rather than only inside the tool list.
  assert.ok(lines[1].includes('restart_app'), 'the app restart is named by its family line');
  assert.ok(lines[1].includes('list_features'), 'and so is the feature report');
  const off = groups.summaryLines(listNativeTools(), { chats: { mode: 'off' }, get_app_info: { mode: 'off' } }, new Set(['file']));
  same(off.map((line) => line.split(']')[0] + ']'), ['[mouaif]'], 'a family gate Off drops its line');
  assert.ok(!off[0].includes('get_app_info'), 'a leaf Off drops out of its family line');
  const familyOff = groups.summaryLines(listNativeTools(), { chats: { mode: 'ask' }, mouaif: { mode: 'off' } }, new Set(['file']));
  same(familyOff.map((line) => line.split(']')[0] + ']'), ['[Chats]'], 'a mouaif Off drops the whole family line');
});

// ---- 4. The shared helpers ------------------------------------------------
check('groupAuthKey resolves a family and refuses a category', () => {
  assert.equal(model.groupAuthKey('shell'), 'shell');
  assert.equal(model.groupAuthKey('files'), 'file');
  assert.equal(model.groupAuthKey('chats'), 'chats');
  assert.equal(model.groupAuthKey('mouaif-settings'), 'mouaif');
  assert.equal(model.groupAuthKey('list_features'), null, 'a tool is not a group row');
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
check('isFamilyLeaf recognizes every multi-tool family leaf', () => {
  for (const name of ['read_file', 'group_edit', 'list_chats', 'get_app_info', 'restart_app', 'list_features']) assert.equal(model.isFamilyLeaf(name), true, name);
  assert.equal(model.isFamilyLeaf('shell'), false);
  assert.equal(model.FAMILY_OF.delete_chat, 'chats');
  assert.equal(model.FAMILY_OF.list_projects, 'mouaif');
  assert.equal(model.FAMILY_OF.restart_app, 'mouaif');
  assert.equal(model.FAMILY_OF.list_features, 'mouaif');
  assert.equal(model.FAMILY_OF.edit_file, 'file');
});
check('toolPermission resolves leaves through their family gate', () => {
  for (const [leaf, gate] of [['read_file', 'file'], ['list_chats', 'chats'], ['get_settings', 'mouaif']]) {
    assert.equal(model.toolPermission(leaf, { [gate]: { mode: 'off' }, [leaf]: { mode: 'allow' } }).mode, 'off', leaf + ': gate Off wins');
    assert.equal(model.toolPermission(leaf, { [gate]: { mode: 'allow' }, [leaf]: { mode: 'off' } }).mode, 'off', leaf + ': leaf Off tightens');
    assert.equal(model.toolPermission(leaf, { [gate]: { mode: 'allow' } }).mode, 'allow', leaf + ': inherits the gate');
  }
});
check('toolGroupId maps a tool back to its row', () => {
  assert.equal(model.toolGroupId('list_chats'), 'chats');
  assert.equal(model.toolGroupId('get_app_info'), 'mouaif-settings');
  assert.equal(model.toolGroupId('group_edit'), 'files');
  assert.equal(model.toolGroupId('restart_app'), 'mouaif-settings', 'the app restart sits in the mouaif row');
  assert.equal(model.toolGroupId('list_features'), 'mouaif-settings', 'and so does the feature report');
  assert.equal(model.toolGroupId('mcp__x__y'), null, 'MCP rows live outside the native model');
});
console.log('tool groups: ' + passed + ' checks passed');
