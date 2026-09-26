'use strict';

// Regression test for the Custom prompts "Chat preset" tool selection.
//
// The bug: switching the Chat preset ON seeded `tools: new Set()`, and
// `buildPresetGroups()` handed that straight to `buildToolGroups` as an
// explicit allowlist. ToolTree.jsx reads any ARRAY as "explicit list"
// (`isOn = (name) => selected == null || selected.has(name)`), so an empty
// array means every row UNCHECKED — the tree opened looking like the preset
// granted no tools at all, even though a preset is additive and a chat with
// no allowlist has every tool ON.
//
// The fix keeps an explicit "grants nothing" selection distinguishable from
// the all-on baseline: the baseline is `tools: null` (which the tree reads
// as all-on), and only an actual Set becomes an allowlist.
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
// presetTools.js is an ESM module. Rewrite its `export function` lines into
// a CJS shape in memory so this stays a plain `node` script like the others
// in scripts/ (no ESM/loader juggling).
const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/settings/presetTools.js'), 'utf8');
const cjs = src.replace(/export function /g, 'function ')
  + '\nmodule.exports = { presetToolSelection, commitTools, applyToolToggle };\n';
const Module = require('node:module');
const m = new Module('presetTools', null);
m.filename = path.join(ROOT, 'frontend/src/components/settings/presetTools.js');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(cjs, m.filename);
const { presetToolSelection, commitTools, applyToolToggle } = m.exports;

const ALL = ['shell', 'subagent', 'report_progress', 'task', 'ask_user', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file'];

// `isOn` is ToolTree's own rule, restated so the test asserts against the
// consumer's semantics rather than the helper's internal representation.
const isOn = (selection, name) => {
  const selected = Array.isArray(selection) ? new Set(selection) : null;
  return selected == null || selected.has(name);
};

// 1. The headline fix: a fresh preset ("Chat preset" just switched on) must
//    read as all-on, not all-off.
check('the all-on baseline (null/undefined) means every row on', () => {
  assert.equal(presetToolSelection(null), null);
  assert.equal(presetToolSelection(undefined), null);
  for (const name of ALL) assert.equal(isOn(presetToolSelection(null), name), true, name);
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

// 2. First uncheck snapshots the implicit full set and drops just that row.
check('unchecking one row from the baseline hides only that row', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ['shell'], checked: false });
  assert.equal(next instanceof Set, true);
  assert.equal(next.has('shell'), false);
  for (const name of ALL) {
    if (name === 'shell') continue;
    assert.equal(next.has(name), true, name + ' should stay on');
  }
});

check('checking a row while already all-on stays at the baseline', () => {
  assert.equal(applyToolToggle({ tools: null, allIds: ALL, ids: ['shell'], checked: true }), null);
});

// 3. Re-checking everything collapses back to the baseline, so a preset
//    never pins a stale full snapshot.
check('a selection covering every tool collapses back to the baseline', () => {
  assert.equal(commitTools(new Set(ALL), ALL), null);
});

check('re-adding the last missing row collapses back to the baseline', () => {
  const start = new Set(ALL.filter((n) => n !== 'shell'));
  assert.equal(applyToolToggle({ tools: start, allIds: ALL, ids: ['shell'], checked: true }), null);
});

// 4. Whole-group toggles (the group checkbox) behave the same way.
check('unchecking a whole group from the baseline drops exactly those ids', () => {
  const group = ['read_file', 'write_file'];
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: group, checked: false });
  assert.equal(next.has('read_file'), false);
  assert.equal(next.has('write_file'), false);
  assert.equal(next.has('shell'), true);
});

check('unchecking every tool leaves an explicit empty set (not the baseline)', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ALL, checked: false });
  assert.equal(next.size, 0);
  assert.equal(next instanceof Set, true, 'must stay distinguishable from null');
  assert.equal(presetToolSelection(next).length, 0);
});

// 5. An existing explicit selection round-trips.
check('an explicit selection toggles off from itself, not from the baseline', () => {
  const next = applyToolToggle({ tools: new Set(['shell', 'task']), allIds: ALL, ids: ['shell'], checked: false });
  assert.deepEqual(Array.from(next).sort(), ['task']);
});

// 6. The persisted round-trip: `runtime -> stored` must survive a reload.
//    This mirrors SettingsPrompts.applyPromptToForm exactly.
check('a baseline preset round-trips as tools: null', () => {
  const runtime = { tools: null, agentFiles: true, skills: false };
  const storedTools = runtime.tools instanceof Set ? Array.from(runtime.tools) : undefined;
  const reloaded = { tools: Array.isArray(storedTools) ? new Set(storedTools) : null, agentFiles: true };
  assert.equal(reloaded.tools, null);
  for (const name of ALL) assert.equal(isOn(presetToolSelection(reloaded.tools), name), true, name);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
