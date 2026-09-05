'use strict';
// Lossless Inspector capture contract and its panel/full-screen/annotation consumers.
// No Chrome required: run the actual handlers and Preact capture effect with stubs.
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
  }
  console.log('PASS lossless captures, PDF viewport fallback, timeout, and cheap screencast signal');

  const hooks = [], effects = [], urls = [], revoked = [], timers = new Set();
  let cursor = 0, firstRender = true;
  const nodes = [];
  const refreshRef = {}, fullscreenRef = {}, draftCraftRef = {};
  let annotation = null;
  const props = {
    capture: async () => ({ data: png }), refreshRef, fullscreenRef, draftCraftRef,
    onDraftCraft: (image) => { annotation = image; }
  };
  const context = vm.createContext({
    Blob, Uint8Array, atob, Date,
    URL: {
      createObjectURL: (blob) => { urls.push(blob); return 'blob:preview-' + urls.length; },
      revokeObjectURL: (url) => revoked.push(url)
    },
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
        attrs.ref.current = { scrollTop: 0, scrollLeft: 0, naturalWidth: 375, naturalHeight: 1200 };
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
  assert.equal(urls.length, 1);
  assert.equal(urls[0].type, 'image/png');
  assert.deepEqual(Buffer.from(await urls[0].arrayBuffer()), Buffer.from(png, 'base64'));
  draftCraftRef.current();
  assert.equal(annotation.dataUrl, 'data:image/png;base64,' + png);
  fullscreenRef.current();
  cursor = 0;
  nodes.length = 0;
  context.PreviewPanel(props);
  const images = nodes.filter((node) => node.tag === 'img');
  assert.equal(images.length, 2, 'panel and full-screen images render');
  for (const image of images) assert.equal(image.attrs.src, 'blob:preview-1');
  for (const cleanup of cleanups) if (cleanup) cleanup();
  assert.deepEqual(revoked, ['blob:preview-1']);
  assert.equal(timers.size, 0);
  assert.equal(refreshRef.current, null);
  console.log('PASS PNG bytes/MIME, shared panel/full-screen image, annotation data URL, and cleanup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
