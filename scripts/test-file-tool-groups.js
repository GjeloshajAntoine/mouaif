'use strict';

// The Read tools / Edit tools split (frontend/src/components/settings/
// fileToolGroups.js).
//
// The five native file operations used to render as ONE "File tools" group.
// They now split by effect: read/list/search inspect, write/edit mutate.
//
// What this test pins down:
//   1. Every file tool is classified exactly once, into the right half.
//   2. `partitionFileTools` handles both shapes the tree builders feed it —
//      catalog rows (`.name`) and agent choices (`.value`).
//   3. An UNKNOWN file tool lands in `edit`, not `read`. A future tool that
//      mutates the tree must never be silently filed as safe.
//   4. The two group ids stay distinct and stable — every surface keys its
//      collapse state and (in Settings) its authorization write on them.
//
// Pure module, no DOM: load the ESM source through a CJS shim like
// scripts/test-preset-tools.js does.
//
// Run: node scripts/test-file-tool-groups.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/settings/fileToolGroups.js'), 'utf8');
const cjs = src.replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ')
  + '\nmodule.exports = { READ_GROUP_ID, EDIT_GROUP_ID, READ_TOOL_NAMES, EDIT_TOOL_NAMES, FILE_TOOL_NAMES, isFileToolName, partitionFileTools, groupMeta };\n';
const Module = require('node:module');
const m = new Module('fileToolGroups', null);
m.filename = path.join(ROOT, 'frontend/src/components/settings/fileToolGroups.js');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(cjs, m.filename);
const {
  READ_GROUP_ID, EDIT_GROUP_ID, READ_TOOL_NAMES, EDIT_TOOL_NAMES,
  FILE_TOOL_NAMES, isFileToolName, partitionFileTools, groupMeta
} = m.exports;

// 1. Classification.
check('the two halves are disjoint and cover every file tool exactly once', () => {
  const union = new Set([...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES]);
  assert.equal(union.size, READ_TOOL_NAMES.length + EDIT_TOOL_NAMES.length, 'no duplicate across halves');
  assert.deepEqual(Array.from(union).sort(), [...FILE_TOOL_NAMES].sort(), 'halves cover FILE_TOOL_NAMES');
});

check('read half is the inspecting operations only', () => {
  assert.deepEqual(READ_TOOL_NAMES, ['read_file', 'list_files', 'search_files']);
});

check('edit half is the mutating operations only', () => {
  assert.deepEqual(EDIT_TOOL_NAMES, ['write_file', 'edit_file']);
});

check('isFileToolName recognises every file tool', () => {
  for (const name of FILE_TOOL_NAMES) assert.equal(isFileToolName(name), true, name);
  for (const name of ['shell', 'subagent', 'edit_file2', 'read']) assert.equal(isFileToolName(name), false, name);
});

// 2. Both input shapes the tree builders use.
check('partition handles catalog rows (`.name`)', () => {
  const catalog = FILE_TOOL_NAMES.map((name) => ({ name, kind: 'native', source: 'files' }));
  const { read, edit } = partitionFileTools(catalog);
  assert.deepEqual(read.map((t) => t.name), READ_TOOL_NAMES);
  assert.deepEqual(edit.map((t) => t.name), EDIT_TOOL_NAMES);
});

check('partition handles agent choices (`.value`)', () => {
  const choices = FILE_TOOL_NAMES.map((value) => ({ value, label: value }));
  const { read, edit } = partitionFileTools(choices);
  assert.deepEqual(read.map((t) => t.value), READ_TOOL_NAMES);
  assert.deepEqual(edit.map((t) => t.value), EDIT_TOOL_NAMES);
});

check('partition drops null entries instead of crashing', () => {
  const { read, edit } = partitionFileTools([null, { name: 'read_file' }, undefined, { name: 'write_file' }]);
  assert.deepEqual(read.map((t) => t.name), ['read_file']);
  assert.deepEqual(edit.map((t) => t.name), ['write_file']);
});

check('partition of an empty / missing list yields two empty halves', () => {
  for (const input of [[], null, undefined]) {
    const { read, edit } = partitionFileTools(input);
    assert.deepEqual(read, []);
    assert.deepEqual(edit, []);
  }
});

// 3. The safe default.
check('an unknown file tool is filed under Edit, never Read', () => {
  const { read, edit } = partitionFileTools([{ name: 'chmod_file' }]);
  assert.deepEqual(read, []);
  assert.deepEqual(edit.map((t) => t.name), ['chmod_file']);
});

// 4. Ids and labels.
check('the group ids are distinct and stable', () => {
  assert.equal(READ_GROUP_ID, 'files-read');
  assert.equal(EDIT_GROUP_ID, 'files-edit');
  assert.notEqual(READ_GROUP_ID, EDIT_GROUP_ID);
});

check('groupMeta labels each half', () => {
  assert.deepEqual(groupMeta('read'), { id: READ_GROUP_ID, name: 'Read tools', description: 'read, list, search' });
  assert.deepEqual(groupMeta('edit'), { id: EDIT_GROUP_ID, name: 'Edit tools', description: 'write, edit' });
  // Anything that is not 'read' is the edit half (the safe default again).
  assert.equal(groupMeta(undefined).id, EDIT_GROUP_ID);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
