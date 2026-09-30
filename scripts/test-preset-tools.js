'use strict';

// Regression test for the Custom prompts "Chat preset" tool selection.
//
// The preset is RESTRICTIVE: the tree starts with every tool ticked, and
// each unticked tool is saved in `preset.disabledTools`. A chat attached to
// the prompt starts with those tools off (the user can tick them again in
// the chat). Agent files / skills are only saved when ticked, because a
// preset can turn them on but never off.
//
// History: the tree used to be an additive allowlist whose unticked rows
// were meaningless (a preset could not restrict anything), whose file-tool
// ids were dropped by the server, and whose untouched Agent files / Skills
// boxes were saved as `false` and switched those features OFF.
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
  + '\nmodule.exports = { presetToolSelection, applyToolToggle, presetBody, presetFromRecord, presetsEqual };\n';
const Module = require('node:module');
const m = new Module('presetTools', null);
m.filename = path.join(ROOT, 'frontend/src/components/settings/presetTools.js');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(cjs, m.filename);
const { presetToolSelection, applyToolToggle, presetBody, presetFromRecord, presetsEqual } = m.exports;

const ALL = ['shell', 'subagent', 'report_progress', 'task', 'ask_user', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit', 'mcp__fs__read'];

// ToolTree's own rule, restated so the test asserts against the consumer.
const isOn = (selection, name) => {
  const selected = Array.isArray(selection) ? new Set(selection) : null;
  return selected == null || selected.has(name);
};

check('a fresh preset ticks every tool, grouped tools included', () => {
  const sel = presetToolSelection(presetFromRecord(null).disabled, ALL);
  assert.equal(sel, null);
  for (const name of ALL) assert.equal(isOn(sel, name), true, name);
});

check('unticking a row shows only that row off', () => {
  const disabled = applyToolToggle({ disabled: new Set(), ids: ['group_edit'], checked: false });
  const sel = presetToolSelection(disabled, ALL);
  assert.equal(isOn(sel, 'group_edit'), false);
  for (const name of ALL) if (name !== 'group_edit') assert.equal(isOn(sel, name), true, name);
});

check('ticking a row again clears it from the disabled set', () => {
  const disabled = applyToolToggle({ disabled: new Set(['shell', 'task']), ids: ['shell'], checked: true });
  assert.deepEqual(Array.from(disabled), ['task']);
});

check('a whole-group toggle disables exactly those ids', () => {
  const disabled = applyToolToggle({ disabled: new Set(), ids: ['read_file', 'write_file'], checked: false });
  assert.deepEqual(Array.from(disabled).sort(), ['read_file', 'write_file']);
});

check('unticking every tool renders every row off', () => {
  const disabled = applyToolToggle({ disabled: new Set(), ids: ALL, checked: false });
  const sel = presetToolSelection(disabled, ALL);
  for (const name of ALL) assert.equal(isOn(sel, name), false, name);
});

check('the saved body lists unticked tools as disabledTools (file tools kept by name)', () => {
  const body = presetBody({ disabled: new Set(['group_edit', 'read_file']), agentFiles: false, skills: false });
  assert.deepEqual(body, { disabledTools: ['group_edit', 'read_file'] });
});

check('untouched Agent files / Skills are never saved as false', () => {
  const body = presetBody({ disabled: new Set(['shell']), agentFiles: false, skills: false });
  assert.equal('agentFiles' in body, false);
  assert.equal('skills' in body, false);
});

check('ticked Agent files / Skills are saved as true', () => {
  assert.deepEqual(presetBody({ disabled: new Set(), agentFiles: true, skills: true }), { agentFiles: true, skills: true });
});

check('nothing selected saves no preset', () => {
  assert.equal(presetBody(null), null);
  assert.equal(presetBody(presetFromRecord(null)), null);
});

check('a saved preset round-trips through the editor state', () => {
  const stored = { disabledTools: ['shell', 'group_read'], skills: true };
  const state = presetFromRecord(stored);
  assert.deepEqual(presetBody(state), { disabledTools: ['group_read', 'shell'], skills: true });
  const sel = presetToolSelection(state.disabled, ALL);
  assert.equal(isOn(sel, 'shell'), false);
  assert.equal(isOn(sel, 'group_read'), false);
  assert.equal(isOn(sel, 'group_edit'), true);
});

check('a legacy additive preset loads as nothing disabled', () => {
  const state = presetFromRecord({ tools: ['shell'], agentFiles: false });
  assert.equal(state.disabled.size, 0);
  assert.equal(state.agentFiles, false);
});

check('presetsEqual compares the saved shapes', () => {
  assert.equal(presetsEqual(null, presetFromRecord(null)), true);
  assert.equal(presetsEqual(null, { disabled: new Set(), agentFiles: false, skills: false }), true);
  assert.equal(presetsEqual(null, { disabled: new Set(['shell']) }), false);
  assert.equal(presetsEqual({ disabled: new Set(['a', 'b']) }, { disabled: new Set(['b', 'a']) }), true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
