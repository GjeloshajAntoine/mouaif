// Tests for the webpreview Live (iframe) mode:
//   - frontend helpers (frontend/src/components/chat/webpreviewFrame.js);
//   - the dock store accepts agent-published live payloads;
//   - the native tool's `mode: "live"` path (src/tools/webpreview.js) and
//     its spec, so the agent can open a live preview itself;
//   - the app CSP frames any URL, and the viewer/dock carry no sandbox.
// See docs/features/webpreview.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const f = await import(path.join(here, '../frontend/src/components/chat/webpreviewFrame.js'));
const store = await import(path.join(here, '../frontend/src/components/chat/webpreviewState.js'));
const wp = require('../src/tools/webpreview.js');

let fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}

await ok('isLivePayload needs mode live and a url', () => {
  assert.equal(f.isLivePayload({ mode: 'live', url: 'file:///tmp/a.html' }), true);
  assert.equal(f.isLivePayload({ mode: 'live', url: '' }), false);
  assert.equal(f.isLivePayload({ url: 'https://x', thumbnail: 'data:' }), false);
  assert.equal(f.isLivePayload(null), false);
});
await ok('frame delegates every powerful feature', () => {
  for (const feat of ['camera', 'microphone', 'geolocation', 'clipboard-write', 'fullscreen']) {
    assert.match(f.FRAME_ALLOW, new RegExp('\\b' + feat + '\\b'));
  }
});
const presets = [{ id: 'phone', width: 375, height: 667 }];
await ok('viewportDims resolves presets, WxH strings and falls back to the capture', () => {
  assert.deepEqual(f.viewportDims('phone', null, presets), { width: 375, height: 667 });
  assert.deepEqual(f.viewportDims('1280x800', null, presets), { width: 1280, height: 800 });
  assert.deepEqual(f.viewportDims('nope', { width: 500, height: 900 }, presets), { width: 500, height: 900 });
});
await ok('frameScale fits, never upscales, and is 1 before measuring', () => {
  assert.equal(f.frameScale({ width: 375, height: 667 }, { width: 0, height: 0 }), 1);
  assert.equal(f.frameScale({ width: 100, height: 100 }, { width: 1000, height: 1000 }), 1);
  assert.equal(f.frameScale({ width: 1280, height: 800 }, { width: 656, height: 1016 }, 16), 0.5);
});

await ok('dock store publishes a live payload with no thumbnail', () => {
  store.clearActive();
  store.publish({ mode: 'live', url: 'http://localhost:3000/', capturedAt: new Date().toISOString() });
  const active = store.getActivePayload();
  assert.ok(active && active.mode === 'live');
  store.publish({ url: 'http://x/' }); // neither thumbnail nor live: ignored
  assert.equal(store.getActivePayload().url, 'http://localhost:3000/');
  store.clearActive();
});

await ok('tool mode "live" returns a live payload without touching Chrome', async () => {
  const out = await wp.runWebpreview({ url: 'http://localhost:3000/app', mode: 'live', viewport: 'tablet' });
  assert.equal(out.ok, true);
  assert.equal(out.result.mode, 'live');
  assert.equal(out.result.url, 'http://localhost:3000/app');
  assert.equal(out.result.thumbnail, undefined);
  assert.equal(out.result.viewport.id, 'tablet');
  assert.equal(JSON.parse(out.content).mode, 'live');
});
await ok('live mode accepts any scheme', async () => {
  for (const u of ['file:///tmp/index.html', 'data:text/html,<h1>hi</h1>', 'about:blank', 'chrome://version']) {
    const out = await wp.runWebpreview({ url: u, mode: 'live' });
    assert.equal(out.ok, true, u);
    assert.equal(out.result.mode, 'live', u);
  }
});
await ok('resolveMode normalises and rejects junk', () => {
  assert.equal(wp.resolveMode(undefined), 'screenshot');
  assert.equal(wp.resolveMode('LIVE'), 'live');
  assert.equal(wp.resolveMode('iframe'), 'live');
  assert.throws(() => wp.resolveMode('video'), /mode must be/);
});
await ok('tool spec advertises mode to the agent', () => {
  const p = wp.SPEC.function.parameters.properties.mode;
  assert.ok(p, 'no mode property');
  assert.deepEqual(p.enum, ['screenshot', 'live']);
  assert.match(wp.SPEC.function.description, /live/);
});

await ok('app CSP frames any URL', () => {
  const { WEB_CSP } = require('../src/server-web-static.js');
  const d = String(WEB_CSP).split(';').map((x) => x.trim()).find((x) => x.startsWith('frame-src'));
  assert.ok(d, 'no frame-src');
  for (const src of ['*', 'data:', 'blob:', 'file:']) assert.ok(d.split(/\s+/).includes(src), src);
});
await ok('viewer and dock frames carry no sandbox or referrer restriction', () => {
  for (const file of ['WebpreviewModal.jsx', 'WebpreviewDock.jsx']) {
    const src = fs.readFileSync(path.join(here, '../frontend/src/components/chat', file), 'utf8');
    assert.doesNotMatch(src, /sandbox:/, file);
    assert.doesNotMatch(src, /referrerpolicy/i, file);
    assert.match(src, /allow: FRAME_ALLOW/, file);
  }
});

if (fail) { console.log(fail + ' failed'); process.exit(1); }
console.log('all passed');
