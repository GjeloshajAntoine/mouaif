// MCP store search and sort rules (frontend/src/components/settings/mcpStoreSort.js).
// The Registry API cannot sort and rejects searches under 3 characters, so
// the store sorts loaded servers itself. See docs/features/mcp-registry-browser.md.
import assert from 'node:assert/strict';
import { searchTerm, sortKeys, compareKeys, blockOf, orderRows } from '../frontend/src/components/settings/mcpStoreSort.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + (e && e.stack || e)); }
}

const META = 'io.modelcontextprotocol.registry/official';
function entry(name, { weekly, updated = '2026-01-01T00:00:00Z' } = {}) {
  return {
    server: { name: 'io.x/' + name, title: name },
    _meta: { [META]: { updatedAt: updated } },
    downloads: weekly == null ? null : { weekly, source: 'npm', package: name }
  };
}
function rowsOf(list, supported = () => true) {
  return list.map((e, index) => ({ entry: e, index, keys: sortKeys(e, { supported: supported(e) }) }));
}
const names = (rows) => rows.map((r) => r.entry.server.title);

check('searchTerm sends nothing under 3 characters (Registry answers 422)', () => {
  assert.equal(searchTerm(''), '');
  assert.equal(searchTerm('g'), '');
  assert.equal(searchTerm('  gi  '), '');
  assert.equal(searchTerm(' git '), 'git');
  assert.equal(searchTerm('日本'), '');
  assert.equal(searchTerm('日本語'), '日本語');
});

check('popularity: downloads first, then installable, then newest', () => {
  const list = [
    entry('hosted-old', { updated: '2026-01-01T00:00:00Z' }),
    entry('small', { weekly: 10 }),
    entry('manual', { updated: '2026-10-01T00:00:00Z' }),
    entry('big', { weekly: 90000 }),
    entry('hosted-new', { updated: '2026-10-30T00:00:00Z' })
  ];
  const got = orderRows(rowsOf(list, (e) => e.server.title !== 'manual'), 'popularity', [0]);
  assert.deepEqual(names(got), ['big', 'small', 'hosted-new', 'hosted-old', 'manual']);
});

check('updatedAt and name sorts', () => {
  const list = [entry('b', { updated: '2026-02-01T00:00:00Z' }), entry('a10', { updated: '2026-03-01T00:00:00Z' }), entry('a9', { updated: '2026-01-01T00:00:00Z' })];
  assert.deepEqual(names(orderRows(rowsOf(list), 'updatedAt', [0])), ['a10', 'b', 'a9']);
  assert.deepEqual(names(orderRows(rowsOf(list), 'name', [0])), ['a9', 'a10', 'b']);
});

check('Load more pages stay below: each block sorts on its own', () => {
  const list = [entry('p1-low', { weekly: 5 }), entry('p1-high', { weekly: 50 }), entry('p2-huge', { weekly: 99999 }), entry('p2-mid', { weekly: 20 })];
  assert.deepEqual(names(orderRows(rowsOf(list), 'popularity', [0, 2])), ['p1-high', 'p1-low', 'p2-huge', 'p2-mid']);
  // "Sort all" collapses the blocks into one ranking.
  assert.deepEqual(names(orderRows(rowsOf(list), 'popularity', [0])), ['p2-huge', 'p1-high', 'p2-mid', 'p1-low']);
});

check('blockOf', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => blockOf(i, [0, 2, 4])), [0, 0, 1, 1, 2]);
  assert.equal(blockOf(7, [0]), 0);
});

check('ties keep load order (stable)', () => {
  const list = [entry('x', { weekly: 1 }), entry('y', { weekly: 1 }), entry('z', { weekly: 1 })];
  assert.deepEqual(names(orderRows(rowsOf(list), 'popularity', [0])), ['x', 'y', 'z']);
  assert.equal(compareKeys('popularity')(sortKeys(list[0], {}), sortKeys(list[1], {})), 0);
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all mcp store sort checks passed');
