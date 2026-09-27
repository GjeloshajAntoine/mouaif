// Unit tests for frontend/src/components/settings/profileLaunchers.js —
// icon + project-card pin for the built-in prompt-size profiles.
import assert from 'node:assert/strict';
import {
  normalizeLauncher, readLaunchers, launcherSource, effectiveLauncher, withLauncher, pinnedProfiles
} from '../frontend/src/components/settings/profileLaunchers.js';

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + '\n    ' + e.message); }
}

t('normalizeLauncher falls back to sparkles / not pinned', () => {
  assert.deepEqual(normalizeLauncher(null), { icon: 'sparkles', showOnProjectCard: false });
  assert.deepEqual(normalizeLauncher({ icon: 'nope', showOnProjectCard: 'yes' }), { icon: 'sparkles', showOnProjectCard: false });
  assert.deepEqual(normalizeLauncher({ icon: 'bug', showOnProjectCard: true }), { icon: 'bug', showOnProjectCard: true });
});

t('readLaunchers drops junk entries', () => {
  assert.deepEqual(readLaunchers([1, 2]), {});
  assert.deepEqual(readLaunchers({ chat: 'x', average: { icon: 'code' } }), { average: { icon: 'code', showOnProjectCard: false } });
});

t('project override wins over app on a project screen', () => {
  const maps = { app: { chat: { icon: 'book', showOnProjectCard: true } }, project: { chat: { icon: 'pencil' } } };
  assert.deepEqual(effectiveLauncher(maps, 'chat', true), { icon: 'pencil', showOnProjectCard: false });
  assert.equal(launcherSource(maps, 'chat', true), 'project');
  assert.deepEqual(effectiveLauncher(maps, 'chat', false), { icon: 'book', showOnProjectCard: true });
  assert.equal(launcherSource(maps, 'chat', false), 'app');
});

t('launcherSource defaults: project on a project screen, app otherwise', () => {
  assert.equal(launcherSource({ app: {}, project: {} }, 'average', true), 'project');
  assert.equal(launcherSource({ app: {}, project: {} }, 'average', false), 'app');
  assert.equal(launcherSource({ app: { average: {} }, project: {} }, 'average', true), 'app');
});

t('withLauncher does not mutate the input map', () => {
  const map = { chat: { icon: 'bug', showOnProjectCard: false } };
  const next = withLauncher(map, 'average', { icon: 'code', showOnProjectCard: true });
  assert.equal(map.average, undefined);
  assert.deepEqual(next.average, { icon: 'code', showOnProjectCard: true });
  assert.deepEqual(next.chat, { icon: 'bug', showOnProjectCard: false });
});

t('pinnedProfiles keeps profile order and only pinned rows', () => {
  const profiles = [{ id: 'very-small', label: 'Very small' }, { id: 'average', label: 'Average' }, { id: 'chat', label: 'Chat' }];
  const out = pinnedProfiles(profiles, { chat: { icon: 'pencil', showOnProjectCard: true }, average: { icon: 'code' } });
  assert.deepEqual(out, [{ id: 'chat', label: 'Chat', icon: 'pencil' }]);
  assert.deepEqual(pinnedProfiles(null, null), []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
