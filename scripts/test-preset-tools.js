'use strict';

// Regression test for the Custom prompts "Chat preset" tool selection.
//
// History:
//  - The original bug: switching the Chat preset ON seeded `tools: new Set()`,
//    and `buildPresetGroups()` handed that straight to `buildToolGroups` as an
//    explicit allowlist. ToolTree.jsx reads any ARRAY as "explicit list"
//    (`isOn = (name) => selected == null || selected.has(name)`), so an empty
//    array means every row UNCHECKED — the tree opened looking like the preset
//    granted no tools at all, even though a preset is additive and a chat with
//    no allowlist has every tool ON. The fix kept an explicit "grants nothing"
//    selection distinguishable from the all-on baseline: the baseline is
//    `tools: null` (which the tree reads as all-on).
//
//  - The current rule: a FRESH baseline is no longer literally "every id".
//    The grouped file operations (`group_read` / `group_edit`) are opt-in, so
//    a preset with no explicit selection renders those two rows UNCHECKED and
//    everything else checked. `presetDefaultSelection()` owns that set; a
//    `null` selection expands to it, a selection matching it collapses back to
//    `null`, and any other selection stays an explicit Set.
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
// presetTools.js is an ESM module. Rewrite its `export function` / `export
// const` lines into a CJS shape in memory so this stays a plain `node` script
// like the others in scripts/ (no ESM/loader juggling).
const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/settings/presetTools.js'), 'utf8');
const cjs = src.replace(/export function /g, 'function ').replace(/export const /g, 'const ')
  + '\nmodule.exports = { PRESET_DEFAULT_OFF_TOOLS, presetDefaultSelection, presetToolSelection, commitTools, applyToolToggle };\n';
const Module = require('node:module');
const m = new Module('presetTools', null);
m.filename = path.join(ROOT, 'frontend/src/components/settings/presetTools.js');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(cjs, m.filename);
const {
  PRESET_DEFAULT_OFF_TOOLS, presetDefaultSelection, presetToolSelection, commitTools, applyToolToggle
} = m.exports;

// The full rendered set, grouped tools included. The two grouped tools are
// the default-off family under test.
const DEFAULT_OFF = ['group_read', 'group_edit'];
const ALL = ['shell', 'subagent', 'report_progress', 'task', 'ask_user', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file', ...DEFAULT_OFF];
const SINGLES = ALL.filter((n) => !DEFAULT_OFF.includes(n));

// `isOn` is ToolTree's own rule, restated so the test asserts against the
// consumer's semantics rather than the helper's internal representation.
const isOn = (selection, name) => {
  const selected = Array.isArray(selection) ? new Set(selection) : null;
  return selected == null || selected.has(name);
};

// 1. The default-off rule: the grouped tools are the only ones the baseline
//    leaves unchecked.
check('the default-off family is exactly the grouped file tools', () => {
  assert.deepEqual(PRESET_DEFAULT_OFF_TOOLS, ['group_read', 'group_edit']);
});

check('the baseline excludes the grouped tools and includes everything else', () => {
  const baseline = presetDefaultSelection(ALL);
  assert.deepEqual(baseline.slice().sort(), SINGLES.slice().sort());
  for (const name of DEFAULT_OFF) assert.equal(baseline.includes(name), false, name + ' must be off');
});

// 2. A null selection expands to the baseline; with no catalog it stays null
//    (the tree's own all-on value) so the first paint is unchanged.
check('a null selection expands to the default-off baseline', () => {
  const sel = presetToolSelection(null, ALL);
  assert.equal(isOn(sel, 'shell'), true);
  for (const name of DEFAULT_OFF) assert.equal(isOn(sel, name), false, name + ' should start off');
});

check('a null selection with no catalog stays the tree all-on value', () => {
  assert.equal(presetToolSelection(null), null);
  assert.equal(presetToolSelection(undefined, []), null);
});

check('an explicit selection is passed through as an array', () => {
  assert.deepEqual(presetToolSelection(new Set(['shell']), ALL), ['shell']);
  assert.deepEqual(presetToolSelection(new Set(['shell', 'task']), ALL).sort(), ['shell', 'task']);
});

check('an explicitly empty selection stays empty (not silently all-on)', () => {
  const sel = presetToolSelection(new Set(), ALL);
  assert.deepEqual(sel, []);
  for (const name of ALL) assert.equal(isOn(sel, name), false, name + ' should be off');
});

// 3. First uncheck snapshots the baseline and drops just that row.
check('unchecking one row from the baseline hides only that row', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ['shell'], checked: false });
  assert.equal(next instanceof Set, true);
  assert.equal(next.has('shell'), false);
  for (const name of SINGLES) {
    if (name === 'shell') continue;
    assert.equal(next.has(name), true, name + ' should stay on');
  }
  for (const name of DEFAULT_OFF) assert.equal(next.has(name), false, name + ' stays off');
});

check('checking a row already in the baseline keeps the baseline', () => {
  assert.equal(applyToolToggle({ tools: null, allIds: ALL, ids: ['shell'], checked: true }), null);
});

// 4. Re-checking every single row is still the baseline (grouped tools stay
//    off), but turning a grouped tool on is a real change that persists.
check('a selection matching the baseline collapses back to the baseline', () => {
  assert.equal(commitTools(new Set(SINGLES), ALL), null);
});

check('re-adding the last missing row collapses back to the baseline', () => {
  const start = new Set(SINGLES.filter((n) => n !== 'shell'));
  assert.equal(applyToolToggle({ tools: start, allIds: ALL, ids: ['shell'], checked: true }), null);
});

check('checking a grouped tool on stays explicit (does not collapse)', () => {
  const next = applyToolToggle({ tools: null, allIds: ALL, ids: ['group_read'], checked: true });
  assert.equal(next instanceof Set, true, 'must stay explicit so the checked row survives reload');
  assert.equal(next.has('group_read'), true);
  assert.equal(next.has('group_edit'), false);
  for (const name of SINGLES) assert.equal(next.has(name), true, name);
});

check('a full set (baseline + grouped) does not collapse to the baseline', () => {
  assert.notEqual(commitTools(new Set(ALL), ALL), null);
});

// 5. Whole-group toggles (the group checkbox) behave the same way.
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
  assert.equal(presetToolSelection(next, ALL).length, 0);
});

// 6. An existing explicit selection round-trips.
check('an explicit selection toggles off from itself, not from the baseline', () => {
  const next = applyToolToggle({ tools: new Set(['shell', 'task']), allIds: ALL, ids: ['shell'], checked: false });
  assert.deepEqual(Array.from(next).sort(), ['task']);
});

// 7. The persisted round-trip: `runtime -> stored` must survive a reload.
//    This mirrors SettingsPrompts.applyPromptToForm exactly.
check('a baseline preset round-trips as tools: null with grouped tools off', () => {
  const runtime = { tools: null, agentFiles: true, skills: false };
  const storedTools = runtime.tools instanceof Set ? Array.from(runtime.tools) : undefined;
  const reloaded = { tools: Array.isArray(storedTools) ? new Set(storedTools) : null, agentFiles: true };
  assert.equal(reloaded.tools, null);
  const sel = presetToolSelection(reloaded.tools, ALL);
  for (const name of SINGLES) assert.equal(isOn(sel, name), true, name);
  for (const name of DEFAULT_OFF) assert.equal(isOn(sel, name), false, name + ' should reload off');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
