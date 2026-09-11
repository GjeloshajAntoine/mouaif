'use strict';
// Lossless Inspector capture contract and its panel/full-screen/annotation consumers.
// No Chrome required: run the actual handlers and Preact capture effect with stubs.
// Also pins the preview's cost model: the capture reaches the <img> as a data
// URL (no JS base64 copy, no object URL) and a capture that has not changed is
// dropped before it can re-decode, re-lay out, or move the scroll position.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function main() {
  const calls = [];
  const events = vm.createContext({});
  vm.runInContext(source('events.js'), events);
  for (const captureBeyondViewport of [undefined, true, false]) {
    const handlers = events.createEventHandlers({
      captureBeyondViewport,
      cdpSend: async (method, params, timeout) => {
        calls.push({ method, params, timeout });
        return { data: png };
      }
    });
    assert.equal((await handlers.captureScreenshot()).data, png);
    const shot = calls.at(-1);
    assert.equal(shot.method, 'Page.captureScreenshot');
    assert.equal(shot.params.format, 'png');
    assert.equal('quality' in shot.params, false, 'PNG must not carry a JPEG quality option');
    assert.equal(shot.params.captureBeyondViewport, captureBeyondViewport !== false);
    assert.equal(shot.timeout, 8000, 'retain timeout for unresponsive targets');
    await handlers.startPreviewStream();
    const signal = calls.at(-1);
    assert.equal(signal.params.format, 'jpeg');
    assert.equal(signal.params.quality, 20);
    assert.equal(signal.params.maxWidth, 320);
    assert.equal(signal.params.maxHeight, 320);
    await handlers.ackPreviewFrame(42);
    assert.equal(calls.at(-1).params.sessionId, 42);
    // setViewportSize must forward the preset's deviceScaleFactor (not default
    // it to 1) so the phone presets capture at 2x and stay sharp on a real
    // retina phone instead of being upscaled and blurry.
    await handlers.setViewportSize({ width: 375, height: 667, mobile: true, deviceScaleFactor: 2 });
    const vm2 = calls.at(-1);
    assert.equal(vm2.method, 'Emulation.setDeviceMetricsOverride');
    assert.equal(vm2.params.deviceScaleFactor, 2, 'phone preset forwards retina deviceScaleFactor');
    assert.equal(vm2.params.mobile, true);
    await handlers.setViewportSize(null);
    assert.equal(calls.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
  }
  console.log('PASS lossless captures, PDF viewport fallback, timeout, and cheap screencast signal');

  const hooks = [], effects = [], srcWrites = [], timers = new Set();
  let cursor = 0, firstRender = true;
  const nodes = [];
  const refreshRef = {}, fullscreenRef = {}, draftCraftRef = {};
  let annotation = null;
  let srcValue = '';
  // The preview <img>, with `src` recorded. The capture must reach the DOM as
  // a data URL (no JS base64 copy and no object URL), and a capture that did
  // not change must not reach the DOM at all.
  const imgNode = {
    scrollTop: 0, scrollLeft: 0, naturalWidth: 375, naturalHeight: 1200,
    get src() { return srcValue; },
    set src(value) { srcValue = value; srcWrites.push(value); }
  };
  const props = {
    capture: async () => ({ data: png }), refreshRef, fullscreenRef, draftCraftRef,
    onDraftCraft: (image) => { annotation = image; }
  };
  // Note the missing Blob / atob / URL / Uint8Array: the panel no longer
  // copies the capture through JS, so referencing them would throw here.
  const context = vm.createContext({
    Date,
    setTimeout: (fn) => { timers.add(fn); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    useRef: (initial) => {
      const index = cursor++;
      if (firstRender) hooks[index] = { current: initial };
      return hooks[index];
    },
    useState: (initial) => {
      const index = cursor++;
      if (firstRender) hooks[index] = initial;
      return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useEffect: (fn) => { if (firstRender) effects.push(fn); },
    Fragment: 'fragment', createPortal: (child) => child,
    h: (tag, attrs, ...children) => {
      if (attrs && attrs.ref && !attrs.ref.current) {
        attrs.ref.current = tag === 'img'
          ? imgNode
          : { scrollTop: 0, scrollLeft: 0, naturalWidth: 375, naturalHeight: 1200 };
      }
      const node = { tag, attrs, children };
      nodes.push(node);
      return node;
    }
  });
  vm.runInContext(source('PreviewPanel.jsx'), context);
  context.PreviewPanel(props);
  firstRender = false;
  const cleanups = effects.map((fn) => fn());
  await new Promise(setImmediate);
  const dataUrl = 'data:image/png;base64,' + png;
  assert.deepEqual(srcWrites, [dataUrl], 'the capture reaches the <img> as a data URL, with no object URL');
  assert.deepEqual(Buffer.from(srcWrites[0].split(',')[1], 'base64'), Buffer.from(png, 'base64'),
    'the inspected page PNG bytes survive to the <img>');
  // A second capture of an unchanged page (safety poll / manual refresh)
  // returns the identical payload. Swapping it in anyway re-decodes the
  // capture, re-lays out the frame, and rewrites the scroll offsets on every
  // tick, so the panel must drop it before touching the DOM.
  refreshRef.current();
  await new Promise(setImmediate);
  assert.equal(srcWrites.length, 1, 'an identical capture is dropped before the DOM swap');
  draftCraftRef.current();
  assert.equal(annotation.dataUrl, dataUrl);
  fullscreenRef.current();
  cursor = 0;
  nodes.length = 0;
  context.PreviewPanel(props);
  const images = nodes.filter((node) => node.tag === 'img');
  assert.equal(images.length, 2, 'panel and full-screen images render');
  for (const image of images) assert.equal(image.attrs.src, dataUrl);
  for (const cleanup of cleanups) if (cleanup) cleanup();
  assert.equal(timers.size, 0);
  assert.equal(refreshRef.current, null);
  console.log('PASS data-URL PNG capture, unchanged-capture skip, shared panel/full-screen image, annotation data URL, and cleanup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
