'use strict';

// Regression test for settings resolution (defaults → app → project).
//
// `deepMerge` copied only the top level (`{ ...base }`) and recursed into keys
// the override happened to contain, so every key the override did NOT mention
// was carried over by reference. `getResolved(dir).toolOutput` was literally
// `DEFAULTS.toolOutput`, which made the in-code defaults mutable through the
// resolved object: one downstream `resolved.notifications.status = false`
// poisoned the floor for every project until the server restarted.
//
// This pins both halves: the merge order/semantics AND the no-aliasing rule.
//
// Run: node scripts/test-settings-resolution.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-resolve-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-resolve-project-'));
const writeProject = (obj) => {
  fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify(obj, null, 2) + '\n');
};

check('defaults-only resolution returns the floor values', () => {
  writeProject({});
  const resolved = settings.getResolved(projDir);
  assert.equal(resolved.promptSize, settings.DEFAULTS.promptSize);
  assert.equal(resolved.enterForNewline, true);
  assert.deepEqual(resolved.toolOutput, settings.DEFAULTS.toolOutput);
  assert.deepEqual(resolved.models, []);
  assert.deepEqual(resolved.projects, []);
});

check('app overrides defaults', () => {
  writeProject({});
  settings.setApp({ promptSize: 'extensive' });
  assert.equal(settings.getResolved(projDir).promptSize, 'extensive');
  settings.setApp({ promptSize: 'average' });
});

check('project overrides app', () => {
  writeProject({ promptSize: 'very-small' });
  settings.setApp({ promptSize: 'extensive' });
  assert.equal(settings.getResolved(projDir).promptSize, 'very-small');
});

check('nested objects merge key by key instead of replacing', () => {
  settings.setApp({ toolOutput: { size: 'full' } });
  writeProject({ promptSize: 'average' });
  const resolved = settings.getResolved(projDir);
  assert.equal(resolved.toolOutput.size, 'full', 'app value applies');
  assert.equal(resolved.toolOutput.structure, settings.DEFAULTS.toolOutput.structure, 'floor key survives');
});

check('arrays are replaced, not concatenated', () => {
  settings.setApp({ providers: [{ id: 'ollama' }] });
  writeProject({ providers: [{ id: 'gemini' }] });
  const resolved = settings.getResolved(projDir);
  assert.deepEqual(resolved.providers, [{ id: 'gemini' }]);
  settings.setApp({ providers: [] });
});

// ---- the regression itself ------------------------------------------------

check('resolved values never alias DEFAULTS (the poisoning bug)', () => {
  writeProject({});
  settings.setApp({});
  const resolved = settings.getResolved(projDir);
  assert.notEqual(resolved.toolOutput, settings.DEFAULTS.toolOutput);
  assert.notEqual(resolved.notifications, settings.DEFAULTS.notifications);
  const beforeDefaults = settings.DEFAULTS.toolOutput.size;
  const beforeResolve = settings.getResolved(projDir).toolOutput.size;
  resolved.toolOutput.size = 'POISONED';
  resolved.notifications.status = false;
  assert.equal(settings.DEFAULTS.toolOutput.size, beforeDefaults, 'DEFAULTS.toolOutput unchanged');
  assert.equal(settings.DEFAULTS.notifications.status, true, 'DEFAULTS.notifications unchanged');
  assert.equal(settings.getResolved(projDir).toolOutput.size, beforeResolve, 'a later resolve is unaffected');
});

check('resolved values never alias the stored app object', () => {
  settings.setApp({ toolOutput: { size: 'full' } });
  writeProject({});
  const resolved = settings.getResolved(projDir);
  resolved.toolOutput.size = 'MUTATED';
  assert.equal(settings.getApp().toolOutput.size, 'full', 'stored app settings unchanged');
  assert.equal(settings.getResolved(projDir).toolOutput.size, 'full');
  settings.setApp({ toolOutput: { size: 'average' } });
});

check('resolved values never alias the project object', () => {
  writeProject({ toolOutput: { size: 'very-small' } });
  const resolved = settings.getResolved(projDir);
  resolved.toolOutput.size = 'MUTATED';
  assert.equal(settings.getProject(projDir).toolOutput.size, 'very-small', 'project file unchanged');
});

check('arrays in the resolved tree are copies too', () => {
  settings.setApp({ models: [{ id: 'm1', provider: 'ollama' }] });
  writeProject({});
  const resolved = settings.getResolved(projDir);
  assert.notEqual(resolved.models, settings.getApp().models);
  resolved.models.push({ id: 'injected' });
  resolved.models[0].id = 'renamed';
  assert.equal(settings.getApp().models.length, 1, 'app array unchanged');
  assert.equal(settings.getApp().models[0].id, 'm1', 'app array entries unchanged');
  settings.setApp({ models: [] });
});

check('a second resolve is a distinct tree', () => {
  writeProject({ name: 'x' });
  assert.notEqual(settings.getResolved(projDir), settings.getResolved(projDir));
});

check('DEFAULTS is still the frozen floor', () => {
  assert.throws(() => { settings.DEFAULTS.promptSize = 'nope'; }, TypeError);
  assert.equal(settings.DEFAULTS.promptSize, 'average');
});

check('project-less resolution (null dir) still works', () => {
  const resolved = settings.getResolved(null);
  assert.equal(typeof resolved.promptSize, 'string');
  assert.equal(resolved.name, undefined);
});

settings.close();
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
