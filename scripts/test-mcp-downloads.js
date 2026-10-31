'use strict';

// MCP store popularity: src/mcpDownloads.js asks npm and PyPI for weekly
// download counts with a fake fetch, and the frontend helpers format them.
// No network. See docs/features/mcp-registry-browser.md.

const assert = require('node:assert/strict');
const { weeklyDownloads, packagesOf, clearCache } = require('../src/mcpDownloads.js');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + (e && e.stack || e)); }
}

function entry(packages, remotes) {
  return { server: { name: 'x', packages, remotes } };
}

function fakeFetch(table, calls) {
  return async (url) => {
    calls.push(String(url));
    for (const [match, reply] of table) {
      if (String(url).includes(match)) {
        if (reply instanceof Error) throw reply;
        if (reply === 404) return { ok: false, status: 404, json: async () => ({}) };
        if (reply === 429) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => reply };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

(async () => {
  await check('packagesOf keeps npm and pypi, normalises PyPI names, dedupes', () => {
    const got = packagesOf(entry([
      { registryType: 'npm', identifier: '@scope/a' },
      { registryType: 'npm', identifier: '@scope/a' },
      { registryType: 'pypi', identifier: 'Mcp_Server.Git' },
      { registryType: 'oci', identifier: 'docker.io/x/y' },
      { registryType: 'npm', identifier: '' }
    ]));
    assert.deepEqual(got, [{ source: 'npm', name: '@scope/a' }, { source: 'pypi', name: 'mcp-server-git' }]);
  });

  await check('bulk npm, scoped npm and PyPI counts line up with entries', async () => {
    clearCache();
    const calls = [];
    const fetch = fakeFetch([
      ['last-week/a,b', { a: { downloads: 50 }, b: null }],
      ['last-week/@s%2Fc', { downloads: 7000 }],
      ['packages/p-q/recent', { data: { last_week: 1234 } }]
    ], calls);
    const entries = [
      entry([{ registryType: 'npm', identifier: 'a' }]),
      entry([{ registryType: 'npm', identifier: 'b' }]),
      entry([{ registryType: 'npm', identifier: '@s/c' }, { registryType: 'pypi', identifier: 'p_q' }]),
      entry([], [{ type: 'streamable-http', url: 'https://x' }])
    ];
    const got = await weeklyDownloads(entries, { fetch });
    assert.deepEqual(got, [
      { weekly: 50, source: 'npm', package: 'a' },
      null,
      { weekly: 7000, source: 'npm', package: '@s/c' },
      null
    ]);
    assert.equal(calls.length, 3);
  });

  await check('counts are cached; a repeat lookup does not refetch', async () => {
    const calls = [];
    const fetch = fakeFetch([], calls);
    const got = await weeklyDownloads([entry([{ registryType: 'npm', identifier: 'a' }])], { fetch });
    assert.equal(got[0].weekly, 50);
    assert.equal(calls.length, 0);
  });

  await check('a failed or rate-limited lookup gives no count, not an error', async () => {
    clearCache();
    const calls = [];
    const fetch = fakeFetch([['last-week/solo', new Error('timeout')], ['packages/py/recent', 429]], calls);
    const got = await weeklyDownloads([
      entry([{ registryType: 'npm', identifier: 'solo' }]),
      entry([{ registryType: 'pypi', identifier: 'py' }])
    ], { fetch });
    assert.deepEqual(got, [null, null]);
    // A single unscoped name uses the per-package form, not the bulk one.
    assert.ok(calls.some((u) => u.endsWith('/last-week/solo')));
  });

  const ui = await import('../frontend/src/components/settings/mcpRegistryInstall.js');
  await check('compactCount', () => {
    assert.equal(ui.compactCount(940), '940');
    assert.equal(ui.compactCount(1234), '1.2k');
    assert.equal(ui.compactCount(204887), '205k');
    assert.equal(ui.compactCount(3400000), '3.4M');
    assert.equal(ui.compactCount(999999), '1M');
  });
  await check('popularityLevel is a log scale', () => {
    assert.deepEqual([0, 5, 999, 1000, 9999, 10000, 100000].map(ui.popularityLevel), [0, 1, 1, 2, 2, 3, 4]);
  });
  await check('downloadsLabel and weeklyDownloads', () => {
    assert.equal(ui.downloadsLabel({ weekly: 204887, source: 'npm' }), '204,887 npm downloads last week');
    assert.equal(ui.downloadsLabel({ weekly: 1, source: 'pypi' }), '1 PyPI download last week');
    assert.equal(ui.weeklyDownloads({ downloads: null }), null);
    assert.equal(ui.weeklyDownloads({ downloads: { weekly: 3 } }).weekly, 3);
  });

  if (failed) { console.log(failed + ' failed'); process.exit(1); }
  console.log('all mcp download checks passed');
})();
