'use strict';

// Regression test for the Custom prompts "Chat preset" tool selection.
//
// History:
//  - Switching the Chat preset ON once seeded `tools: new Set()`, which the
//    tree read as an explicit, empty allowlist: every row unchecked. The fix
//    kept the all-on baseline (`tools: null`) apart from an explicit "no
//    tools" selection.
//  - The grouped tools (`group_read` / `group_edit` / `group_cli`) used to
//    render unchecked on a fresh preset, but that state saved as "no preset",
//    so chats still got them. The baseline is now literally every tool,
//    matching what a chat created from the prompt receives.
//
// Run: node scripts/test-preset-tools.js
//
// The helpers are pure, so this imports the module directly (no DOM).

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

// ---- load the ESM helper from a CJS test --------------------------------
// presetTools.js is an ESM module. Rewrite its `export function` lines into a
// CJS shape in memory so this stays a plain `node` script like the others in
// scripts/ (no ESM/loader juggling).
const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/settings/presetTools.js'), 'utf8');
const cjs = src.replace(/export function /g, 'function ')
  + '\nmodule.exports = { presetToolSelection, commitTools, applyToolToggle };\n';
const Module = require('node:module');
const m = new Module('presetTools', null);
m.filename = path.join(ROOT, 'frontend/src/components/settings/presetTools.js');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(cjs, m.filename);
const { presetToolSelection, commitTools, applyToolToggle } = m.exports;

const ALL = ['shell', 'subagent', 'report_progress', 'task', 'ask_user', 'read_file', 'list_files', 'search_files',
  'write_file', 'edit_file', 'group_read', 'group_edit', 'group_cli', 'mcp__gh__*'];

// `isOn` is ToolTree's own rule, restated so the test asserts against the
// consumer's semantics rather than the helper's internal representation.
const isOn = (selection, name) => {
  const selected = Array.isArray(selection) ? new Set(selection) : null;
  return selected == null || selected.has(name);
};

// 1. The baseline is every tool, grouped tools included.
check('a null selection renders every row checked', () => {
  const sel = presetToolSelection(null);
  assert.equal(sel, null);
  for (const name of ALL) assert.equal(isOn(sel, name), true, name);
});

check('an explicit selection is passed through as an array', () => {
  assert.deepEqual(presetToolSelection(new Set(['shell'])), ['shell']);
  assert.deepEqual(presetToolSelection(new Set(['shell', 'task'])).sort(), ['shell', 'task']);
});

check('an explicitly empty selection stays empty (not silently all-on)', () => {
  const sel = presetToolSelection(new Set());
  assert.deepEqual(sel, []);
  for (const name of ALL) assert.equal(isOn(sel, name), false, name + ' should be off');
});

// 2. First uncheck snapshots the baseline and drops just that row.
check('unchecking one row from the baseline hides only that row', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ['group_cli'], checked: false });
  assert.equal(next instanceof Set, true);
  assert.equal(next.has('group_cli'), false);
  for (const name of ALL) {
    if (name !== 'group_cli') assert.equal(next.has(name), true, name + ' should stay on');
  }
});

check('checking a row while on the baseline keeps the baseline', () => {
  assert.equal(applyToolToggle({ tools: null, allIds: ALL, ids: ['shell'], checked: true }), null);
});

// 3. A selection that covers every row collapses back to the baseline, so a
//    preset never pins a stale full list that would hide tools added later.
check('a selection covering every row collapses back to the baseline', () => {
  assert.equal(commitTools(new Set(ALL), ALL), null);
});

check('re-adding the last missing row collapses back to the baseline', () => {
  const start = new Set(ALL.filter((n) => n !== 'shell'));
  assert.equal(applyToolToggle({ tools: start, allIds: ALL, ids: ['shell'], checked: true }), null);
});

// 4. Whole-group toggles (the group checkbox) behave the same way.
check('unchecking a whole group from the baseline drops exactly those ids', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ['read_file', 'write_file'], checked: false });
  assert.equal(next.has('read_file'), false);
  assert.equal(next.has('write_file'), false);
  assert.equal(next.has('shell'), true);
});

check('unchecking every tool leaves an explicit empty set (not the baseline)', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ALL, checked: false });
  assert.equal(next instanceof Set, true, 'must stay distinguishable from null');
  assert.equal(next.size, 0);
  assert.deepEqual(presetToolSelection(next), []);
});

// 5. An existing explicit selection toggles from itself.
check('an explicit selection toggles off from itself, not from the baseline', () => {
  const next = applyToolToggle({ tools: new Set(['shell', 'task']), allIds: ALL, ids: ['shell'], checked: false });
  assert.deepEqual(Array.from(next).sort(), ['task']);
});

// 6. The persisted round-trip mirrors SettingsPrompts.applyPromptToForm.
check('a baseline preset round-trips as tools: null with every row on', () => {
  const runtime = { tools: null, agentFiles: true, skills: false };
  const storedTools = runtime.tools instanceof Set ? Array.from(runtime.tools) : undefined;
  const reloaded = { tools: Array.isArray(storedTools) ? new Set(storedTools) : null };
  const sel = presetToolSelection(reloaded.tools);
  for (const name of ALL) assert.equal(isOn(sel, name), true, name);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
