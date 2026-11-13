// Unit test: the projects page counts shared projects
// (docs/features/share-project.md). The page bar's count and the card list
// come from the same helper, so "0 projects" can never sit above a shared
// project's card.
'use strict';
const assert = require('node:assert/strict');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok   - ' + name);
}

(async () => {
  const { sharedProjectCards, projectCards, projectCountText } = await import('../frontend/src/sharedProjects.js');
  const share = {
    incoming: [
      { id: 'a1', status: 'active', projectDir: '/home/alice/site', projectName: 'Site', machine: 'alice', online: true },
      { id: 'b2', status: 'active', projectDir: '/srv/api/', machine: 'bob', online: false },
      { id: 'c3', status: 'revoked', projectDir: '/srv/old', machine: 'carol' }
    ],
    outgoing: [{ id: 'z9', projectDir: '/mine/one' }]
  };

  test('only active incoming shares become cards, named and keyed apart from local ids', () => {
    const cards = sharedProjectCards(share);
    assert.deepEqual(cards.map((c) => [c.id, c.name, c.path]), [['share-a1', 'Site', '/home/alice/site'], ['share-b2', 'api', '/srv/api/']]);
    assert.equal(cards[1].shared.online, false);
  });

  test('no projects of its own, one shared project: the count says 1 project', () => {
    const one = { incoming: [share.incoming[0]] };
    const cards = projectCards([], one);
    assert.equal(cards.length, 1);
    assert.equal(projectCountText(cards), '1 project');
  });

  test('local and shared projects are counted together, local first', () => {
    const cards = projectCards([{ id: 'p1', path: '/mine/one' }], share);
    assert.deepEqual(cards.map((c) => c.id), ['p1', 'share-a1', 'share-b2']);
    assert.equal(projectCountText(cards), '3 projects');
  });

  test('nothing at all, or no share state yet, reads 0 projects', () => {
    assert.equal(projectCountText(projectCards([], { incoming: [] })), '0 projects');
    assert.equal(projectCountText(projectCards([], null)), '0 projects');
    assert.equal(projectCountText(projectCards(undefined, undefined)), '0 projects');
  });

  console.log('share project count: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
