'use strict';

// Shared collection operations (src/content/collection.js): list, get, put,
// remove and replace over any declared collection, in both scopes and both
// project storage modes, with change lists and the merge rules.
//
// Run: node scripts/test-content-collection.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-collection-home-'));
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const collection = require(path.join(ROOT, 'src/content/collection.js'));
const service = require(path.join(ROOT, 'src/content/service.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-collection-project-'));

for (const mode of ['file', 'db']) {
  check(mode + ': put adds, then replaces in place by id', () => {
    settings.setDbBacked(proj, mode === 'db');
    settings.setProject(proj, { agents: [] });
    let r = collection.put('agents', 'project', proj, { name: 'a', content: 'one' });
    assert.deepStrictEqual(r.changes.map((c) => [c.op, c.id]), [['added', 'a']]);
    collection.put('agents', 'project', proj, { name: 'b', content: 'two' });
    r = collection.put('agents', 'project', proj, { name: 'a', content: 'uno' });
    assert.deepStrictEqual(r.changes.map((c) => [c.op, c.id]), [['changed', 'a']]);
    assert.deepStrictEqual(collection.list('agents', 'project', proj).map((e) => e.id), ['a', 'b']);
    assert.equal(collection.get('agents', 'project', proj, 'a').content, 'uno');
  });
  check(mode + ': remove returns the removed item; a missing id changes nothing', () => {
    const r = collection.remove('agents', 'project', proj, 'b');
    assert.equal(r.removed.content, 'two');
    assert.deepStrictEqual(r.changes.map((c) => [c.op, c.id]), [['removed', 'b']]);
    const none = collection.remove('agents', 'project', proj, 'zzz');
    assert.equal(none.removed, null);
    assert.deepStrictEqual(none.changes, []);
  });
  check(mode + ': map collections set and remove by key', () => {
    collection.putAt('tags', 'project', proj, 'src/a.js', { tags: ['x'] });
    collection.putAt('tags', 'project', proj, 'src/b.js', { tags: ['y'] });
    collection.remove('tags', 'project', proj, 'src/a.js');
    assert.deepStrictEqual(collection.read('tags', 'project', proj), { 'src/b.js': { tags: ['y'] } });
  });
}
settings.setDbBacked(proj, false);

check('a nested collection (toolWording.sets) keeps its sibling keys', () => {
  settings.setProject(proj, { toolWording: { active: 'short', sets: {} } });
  collection.putAt('toolWording.sets', 'project', proj, 'short', { name: 'Short', tools: {} });
  assert.deepStrictEqual(settings.getProject(proj).toolWording, { active: 'short', sets: { short: { name: 'Short', tools: {} } } });
});

check('replace can drop a legacy key in the same write', () => {
  settings.setProject(proj, { agentPresets: [{ name: 'legacy' }] });
  collection.replace('agents', 'project', proj, [{ name: 'c' }], { unset: ['agentPresets'] });
  const p = settings.getProject(proj);
  assert.equal('agentPresets' in p, false);
  assert.deepStrictEqual(p.agents, [{ name: 'c' }]);
});

check('app scope collections write the app store', () => {
  collection.put('prompts', 'app', undefined, { id: 'p1', title: 'App one', content: 'x' });
  assert.deepStrictEqual(settings.getApp().prompts.map((p) => p.id), ['p1']);
});

check('merge rules: override, concat, replace', () => {
  collection.put('prompts', 'app', undefined, { id: 'p2', title: 'App two', content: 'y' });
  collection.replace('prompts', 'project', proj, [{ id: 'p1', title: 'Project one', content: 'z' }]);
  const merged = collection.listMerged('prompts', proj);
  assert.deepStrictEqual(merged.map((e) => [e.id, e.scope]), [['p1', 'project'], ['p2', 'app']]);
  assert.deepStrictEqual(collection.listMerged('agents', proj).map((e) => e.id), ['c']);
});

check('a hidden field (timestamp) is left out of the change list', () => {
  collection.replace('agents', 'project', proj, [{ name: 'c', updatedAt: '1' }]);
  const r = collection.put('agents', 'project', proj, { name: 'c', updatedAt: '2' });
  assert.deepStrictEqual(r.changes, []);
});

check('content written by its own tool needs that tool or its route', () => {
  assert.throws(() => collection.replace('hooks', 'project', proj, []), /only through hook_create/);
  collection.replace('hooks', 'project', proj, [], { via: 'hook_create' });
  collection.replace('hooks', 'project', proj, [], { via: 'route' });
});

check('a type is only written in its declared scopes', () => {
  assert.throws(() => collection.replace('agents', 'app', undefined, []), /no app scope/);
});

check('writes publish content_changed with the type', () => {
  const seen = [];
  const on = (e) => seen.push(e);
  service.events.on('content_changed', on);
  collection.put('customActions', 'project', proj, { id: 'go', label: 'Go', kind: 'cli', command: 'ls' });
  service.events.off('content_changed', on);
  assert.equal(seen.length, 1);
  assert.deepStrictEqual(seen[0].types, ['customActions']);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
