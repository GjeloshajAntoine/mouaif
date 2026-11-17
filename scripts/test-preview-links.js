'use strict';
// previewLinks: newest first, one entry per URL, capped, junk dropped.
const assert = require('assert');
const p = require('../src/previewLinks.js');
let l = p.withLink([], { url: 'https://a.test/', title: 'A' });
l = p.withLink(l, { url: 'http://localhost:5173/', mode: 'live', viewport: 'tablet' });
l = p.withLink(l, { url: 'https://a.test/', title: 'A2' });
assert.deepStrictEqual(l.map(e => e.url), ['https://a.test/', 'http://localhost:5173/']);
assert.strictEqual(l[0].title, 'A2');
assert.strictEqual(l[1].mode, 'live');
assert.deepStrictEqual(p.normalizeLinks([null, { url: 5 }, 'x']), []);
let big = [];
for (let i = 0; i < 80; i++) big = p.withLink(big, { url: 'https://x.test/' + i });
assert.strictEqual(big.length, p.MAX_LINKS);
assert.strictEqual(big[0].url, 'https://x.test/79');
assert.strictEqual(p.recordFromResult('', { ok: true, result: { url: 'x' } }), false);
assert.strictEqual(p.recordFromResult('/tmp', { ok: false }), false);
console.log('preview links: ok');

// webpreview mode "link": saves only — no capture, nothing for the dock.
(async () => {
  const wp = require('../src/tools/webpreview.js');
  assert.strictEqual(wp.resolveMode('link'), 'link');
  const out = await wp.runWebpreview({ url: 'https://docs.test/a', mode: 'link', title: 'Docs' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result.mode, 'link');
  assert.strictEqual(out.result.title, 'Docs');
  assert.ok(!out.result.thumbnail);
  assert.ok(wp.SPEC.function.parameters.properties.mode.enum.includes('link'));
  console.log('preview links (link mode): ok');
})().catch((e) => { console.error(e); process.exit(1); });
