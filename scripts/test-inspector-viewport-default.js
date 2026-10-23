'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/src/components/Inspector.jsx', 'utf8');
const init = source.match(/const \[viewportId, setViewportId\] = useState\(\(\) => \{([\s\S]*?)\n  \}\);/);
assert.ok(init, 'viewport initializer exists');
function initial(width, saved, blocked = false) {
  return vm.runInNewContext(`(function () {${init[1]}})()`, {
    window: { innerWidth: width },
    VIEWPORT_STATE_KEY: 'viewport',
    VIEWPORT_PRESETS: ['auto', 'phone', 'phone+', 'tablet', 'laptop'].map(id => ({ id })),
    localStorage: { getItem() { if (blocked) throw new Error('blocked'); return saved; } }
  });
}
for (const width of [360, 390, 430]) {
  assert.equal(initial(width, null), 'phone');
  assert.equal(initial(width, null, true), 'phone');
  assert.equal(initial(width, 'unknown'), 'phone');
  for (const saved of ['auto', 'phone+', 'tablet', 'laptop']) assert.equal(initial(width, saved), saved);
}
assert.equal(initial(431, null), 'auto');
assert.equal(initial(1280, null), 'auto');
assert.equal(initial(1280, 'phone'), 'phone');
console.log('PASS Inspector mobile viewport defaults and saved choices');
