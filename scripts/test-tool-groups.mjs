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
  // through the ordinary authorization machinery as family leaves (chats and
  // mouaif respectively). A name that is not advertised anywhere would be
  // the real bug.
  const noPrompt = [...require('../src/ai-stream.js').NO_PROMPT_TOOLS].sort();
  same(noPrompt, ['list_features', 'report_progress'], 'the read-only tools are the only ones');
  const authz = require('../src/tools/authorization.js');
  for (const name of noPrompt) {
    assert.ok(listed.includes(name), name + ' must be listed in a group');
    assert.ok(authz.NATIVE_TOOLS.has(name) || authz.FAMILY_TOOLS.has(name), name + ' must resolve through a gate');
  }
  assert.equal(model.FAMILY_OF.list_features, 'mouaif', 'the feature report is a mouaif leaf, not its own gate');
  assert.equal(model.FAMILY_OF.report_progress, 'chats', 'the progress report is a chats leaf');
  // The four tools the model uses inside a chat sit in the Chats row now.
  for (const leaf of ['ask_user', 'task', 'report_progress', 'webpreview']) {
    assert.equal(model.FAMILY_OF[leaf], 'chats', leaf + ' is a chats leaf');
    assert.ok(model.TOOL_GROUPS.every((group) => group.id !== leaf), leaf + ' has no row of its own');
  }
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

// ---- 5. The docs match the model -----------------------------------------
//
// The group model is guarded at three points already (this file, the generated
// mirror, the auth module). The DOCS were the one surface nothing checked, and
// they drifted: `webpreview` moved into the Chats family (commit 9c5be6fe) and
// `docs/features/tool-groups.md` kept a "Web preview" row of its own for the
// next six commits, while `docs/features/mouaif-tool.md` still listed 11 Chats
// leaves instead of 15.
//
// So the two tables that enumerate tools are parsed here and compared against
// the source of truth. A tool added to the model, moved between groups, or
// dropped from a family fails this check until its doc row is updated with it.
//
// Only the TOOLS cell of each row is read. A note cell names tools in prose
// (the Chats row explains `ask_user`, `task`, …), and counting those would
// make the check pass on a row whose tool list is empty.

// backtickedNames(cell) -> string[] — the `code` spans of one table cell.
function backtickedNames(cell) {
  return (String(cell).match(/`([^`]+)`/g) || []).map((s) => s.slice(1, -1));
}

// tableRows(text, caption) -> [{ label, tools }] for a `| Label | tools |` table.
function tableRows(text, startsWith) {
  const rows = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) { inTable = false; continue; }
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    // The first row after a blank line is the header; skip it and its rule.
    if (/^-{2,}$/.test(cells[0].replace(/[\s:]/g, '-')) || /^:?-+:?$/.test(cells[0])) continue;
    if (!inTable) { inTable = true; continue; }
    if (!startsWith.test(cells[0])) continue;
    rows.push({ label: cells[0], tools: backtickedNames(cells[1]) });
  }
  return rows;
}

const DOC_GROUPS = path.join(ROOT, 'docs', 'features', 'tool-groups.md');
const DOC_APP_TOOLS = path.join(ROOT, 'docs', 'features', 'mouaif-tool.md');

check('tool-groups.md lists every group, in tree order, with no stale row', () => {
  const text = fs.readFileSync(DOC_GROUPS, 'utf8');
  const rows = tableRows(text, /^\*\*/);
  const documented = rows.map((row) => row.label.replace(/\*\*/g, '').trim());
  const actual = model.TOOL_GROUPS.map((group) => group.name);
  same(documented, actual, 'the doc table must name the model\'s rows in model order');
  // A stale row names a group that no longer exists — the exact `Web preview`
  // failure this check was written for.
  const stale = rows.filter((row) => !actual.includes(row.label.replace(/\*\*/g, '').trim()));
  same(stale.map((r) => r.label), [], 'no doc row describes a group the model dropped');
  // Per row, the tool list itself: order and membership both matter, because
  // a reorder in the model is a reorder on every surface.
  for (let i = 0; i < model.TOOL_GROUPS.length; i++) {
    same(rows[i].tools, model.TOOL_GROUPS[i].tools, rows[i].label + ' tool list');
  }
});

check('tool-groups.md states the real native tool count', () => {
  const text = fs.readFileSync(DOC_GROUPS, 'utf8');
  const listed = model.TOOL_GROUPS.flatMap((group) => group.tools);
  const claimed = text.match(/\*\*(\d+) native tools\*\*/);
  assert.ok(claimed, 'the doc says how many native tools there are');
  assert.equal(Number(claimed[1]), listed.length, 'the stated count matches the model');
  // And the conditional tools are named, since they are advertised without a
  // row — a reader who counts the table alone would miss them.
  for (const name of ['activate_skill', 'mcp__']) {
    assert.ok(text.includes(name), 'the doc names the conditional tool ' + name);
  }
});

check('mouaif-tool.md family table matches the server families', () => {
  const authz = require('../src/tools/authorization.js');
  const text = fs.readFileSync(DOC_APP_TOOLS, 'utf8');
  const rows = tableRows(text, /^\*\*/);
  const byFamily = new Map();
  for (const row of rows) {
    // The label carries the gate in parentheses: **Chats** (`tools.chats`)
    const gate = (row.label.match(/`tools\.([a-z_]+)`/) || [])[1];
    if (gate) byFamily.set(gate, row.tools);
  }
  assert.ok(byFamily.size >= 2, 'the doc documents the Chats and mouaif families');
  for (const [gate, tools] of byFamily) {
    same(tools, authz.TOOL_FAMILIES[gate], 'docs/features/mouaif-tool.md ' + gate + ' family leaves');
  }
  // This file documents the chat and app families only — File tools has its
  // own doc — so the check is that it invents no family and misses no leaf of
  // the ones it does cover. Full family coverage is asserted against
  // tool-groups.md above, which lists every group.
  const known = Object.keys(authz.TOOL_FAMILIES);
  for (const gate of byFamily.keys()) {
    assert.ok(known.includes(gate), 'the doc names a family the server does not have: ' + gate);
  }
});

console.log('tool groups: ' + passed + ' checks passed');
