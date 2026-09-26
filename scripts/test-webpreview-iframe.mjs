// Unit test for the webpreview viewer's Live (iframe) mode helpers
// (frontend/src/components/chat/webpreviewFrame.js) plus a CSP guard: the
// app policy must allow http(s) frames or Live mode renders nothing.
// See docs/features/webpreview.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const f = await import(path.join(here, '../frontend/src/components/chat/webpreviewFrame.js'));

let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}

ok('http and https URLs can be framed', () => {
  assert.equal(f.canFrameUrl('https://example.com/'), true);
  assert.equal(f.canFrameUrl('http://localhost:3000/x'), true);
});
ok('file:, data:, about: and junk stay screenshot-only', () => {
  for (const u of ['file:///etc/hosts', 'data:text/html,hi', 'about:blank', 'javascript:alert(1)', '', 'not a url']) {
    assert.equal(f.canFrameUrl(u), false, u);
  }
});
ok('cross-origin page keeps its own origin', () => {
  const s = f.frameSandbox('https://example.com/', 'http://localhost:5732');
  assert.match(s, /allow-same-origin/);
  assert.match(s, /allow-scripts/);
});
ok('same-origin page never gets allow-same-origin', () => {
  const s = f.frameSandbox('http://localhost:5732/#/chats', 'http://localhost:5732');
  assert.doesNotMatch(s, /allow-same-origin/);
  assert.match(s, /allow-scripts/);
});
ok('sandbox never grants top navigation', () => {
  assert.doesNotMatch(f.frameSandbox('https://example.com/', 'http://localhost:5732'), /allow-top-navigation/);
});
const presets = [{ id: 'phone', width: 375, height: 667 }];
ok('viewportDims resolves presets, WxH strings and falls back to the capture', () => {
  assert.deepEqual(f.viewportDims('phone', null, presets), { width: 375, height: 667 });
  assert.deepEqual(f.viewportDims('1280x800', null, presets), { width: 1280, height: 800 });
  assert.deepEqual(f.viewportDims('nope', { width: 500, height: 900 }, presets), { width: 500, height: 900 });
});
ok('frameScale fits, never upscales, and is 1 before measuring', () => {
  assert.equal(f.frameScale({ width: 375, height: 667 }, { width: 0, height: 0 }), 1);
  assert.equal(f.frameScale({ width: 100, height: 100 }, { width: 1000, height: 1000 }), 1);
  assert.equal(f.frameScale({ width: 1280, height: 800 }, { width: 656, height: 1016 }, 16), 0.5);
});
ok("app CSP frame-src allows http(s) pages", () => {
  const { WEB_CSP } = require('../src/server-web-static.js');
  const fs = String(WEB_CSP).split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
  assert.ok(fs, 'no frame-src');
  assert.match(fs, /\bhttps:/);
  assert.match(fs, /\bhttp:/);
});

if (fail) { console.log(fail + ' failed'); process.exit(1); }
console.log('all passed');
