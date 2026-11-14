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

// ---- Hooks and themes through the write path ------------------------------

const projectHooks = require(path.join(ROOT, 'src/projectHooks.js'));
const hooks = require(path.join(ROOT, 'src/hooks.js'));
const hookProj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-collection-hooks-'));
const hook = (id) => ({ id, event: 'prompt.submit', handler: { kind: 'command', command: 'true' } });

check('a project hook added to an empty list is trusted; changes are returned', () => {
  const r = projectHooks.append(hookProj, hook('one'));
  assert.equal(r.trusted, true);
  assert.deepStrictEqual(r.changes.map((c) => [c.type, c.op, c.id]), [['hooks', 'added', 'one']]);
  assert.equal(projectHooks.status(hookProj).trusted, true);
});

check('a hand-added hook stays inert, and a later append cannot trust it', () => {
  const file = path.join(hookProj, '.mouaif.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.hooks.push(hook('sneaky'));
  fs.writeFileSync(file, JSON.stringify(p));
  assert.equal(projectHooks.status(hookProj).trusted, false);
  assert.deepStrictEqual(projectHooks.active(hookProj), []);
  const r = projectHooks.append(hookProj, hook('two'));
  assert.equal(r.trusted, false);
  assert.equal(projectHooks.status(hookProj).trusted, false);
  assert.deepStrictEqual(projectHooks.active(hookProj), []);
});

check('update_settings and the settings routes still cannot write hooks', () => {
  assert.throws(() => service.applyPatch({ scope: 'project', projectDir: hookProj, patch: { hooks: [] }, actor: 'tool' }), /hook_create/);
  assert.throws(() => service.applyPatch({ scope: 'project', projectDir: hookProj, patch: { hooks: [] }, actor: 'ui' }), /Hooks/);
});

check('a shared project\'s caller cannot promote a chat hook; the chat keeps it', () => {
  const chatHooks = require(path.join(ROOT, 'src/chatHooks.js'));
  const gate = require(path.join(ROOT, 'src/share-gate.js'));
  const added = chatHooks.add(hookProj, 'share-chat', hook('mine'), 'user');
  const appBefore = hooks.getConfig().list.length;
  const projectBefore = projectHooks.status(hookProj).hooks.length;
  for (const scope of ['app', 'project']) {
    assert.throws(() => gate.runAsCaller({ id: 'remote', access: 'full' }, () => chatHooks.promote(hookProj, 'share-chat', added.hook.id, scope)),
      (e) => e.status === 403 && e.code === 'ESHARE_ROUTE', scope);
    assert.ok(chatHooks.get(hookProj, 'share-chat', added.hook.id), scope + ': the chat hook is still there');
  }
  assert.equal(hooks.getConfig().list.length, appBefore, 'no app hook added');
  assert.equal(projectHooks.status(hookProj).hooks.length, projectBefore, 'no project hook added');
});

check('app hooks: list and switch in one write, with changes', () => {
  const r = hooks.writeConfig({ enabled: false, list: [hook('app-one')] });
  assert.deepStrictEqual(r.changes.map((c) => [c.type, c.op, c.id || c.key]), [['appHooks', 'added', 'app-one'], ['hooks.enabled', 'set', 'hooks.enabled']]);
  assert.deepStrictEqual(Object.keys(settings.getApp().hooks).sort(), ['enabled', 'list']);
  assert.equal(hooks.getConfig().enabled, false);
});

check('themes: one write, script and CSS shown as sizes', () => {
  const r = service.writeMany({ scope: 'app', entries: [
    { type: 'themes', value: [{ id: 'mine', name: 'Mine', base: 'dark', vars: {}, css: 'a{}', js: 'console.log(1)' }] },
    { type: 'themes.active', value: 'mine' }
  ] });
  const added = r.changes.find((c) => c.type === 'themes');
  assert.equal(added.op, 'added');
  assert.deepStrictEqual(added.fields.find((f) => f.key === 'js'), { key: 'js', label: 'Script', large: true, beforeSize: 0, afterSize: 14 });
  assert.equal(r.changes.find((c) => c.type === 'themes.active').after, 'mine');
  assert.deepStrictEqual(settings.getApp().themes, { custom: [{ id: 'mine', name: 'Mine', base: 'dark', vars: {}, css: 'a{}', js: 'console.log(1)' }], active: 'mine' });
});

check('themes: the first save reports no active theme change', () => {
  service.writeMany({ scope: 'app', entries: [{ type: 'themes', value: undefined }, { type: 'themes.active', value: undefined }] });
  const themes = require(path.join(ROOT, 'src/themes.js'));
  const writeMany = service.writeMany;
  const seen = [];
  service.writeMany = (opts) => { const r = writeMany(opts); seen.push(r.changes); return r; };
  try {
    const theme = themes.create({ name: 'First', base: 'dark' });
    assert.deepStrictEqual(seen[0].map((c) => c.type), ['themes']);
    assert.equal(Object.prototype.hasOwnProperty.call(settings.getApp().themes, 'active'), false);
    themes.setActive(theme.id);
    themes.remove(theme.id);
    assert.deepStrictEqual(seen[2].find((c) => c.type === 'themes.active').after, '');
    assert.equal(settings.getApp().themes.active, '');
  } finally {
    service.writeMany = writeMany;
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
