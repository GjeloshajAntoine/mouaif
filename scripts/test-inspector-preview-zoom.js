'use strict';
// Regression test for the Inspector preview fit-width / natural-size (zoom) toggle.
//
// Wide pages (e.g. the Laptop 1280px preset) are otherwise squashed to ~30% of
// the frame and become unreadable. The toggle switches the preview <img> between
// `fit` (width:100%, scroll vertically) and `size` (natural size, pan both axes)
// via the `inspector__preview-img--size` modifier class, and persists the choice
// in localStorage so reconnects keep it. The panel also auto-selects natural
// size on the first decode when a wide page would be unreadable in fit mode.
// This test locks in the toggle behaviour, persistence, bootstrapping from a
// stored choice, and the auto-fit decision.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function newHarness({ storedSeed = {}, naturalWidth = 1280, frameW = 366 } = {}) {
  const stored = Object.assign({}, storedSeed);
  const hooks = [];
  let cursor = 0;
  let nodes = [];
  // Distinct image and frame nodes so the auto-fit path can read a real
  // frame clientWidth and fire the image onload, mirroring the live DOM.
  const imgNode = { naturalWidth, naturalHeight: 1191, onload: null };
  const frameNode = { clientWidth: frameW, offsetWidth: frameW, scrollTop: 0, scrollLeft: 0 };
  const context = vm.createContext({
    Blob, Uint8Array, atob, Date,
    URL: { createObjectURL: () => { throw new Error('not expected'); }, revokeObjectURL: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (k in stored ? stored[k] : null),
      setItem: (k, v) => { stored[k] = String(v); }
    },
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    useRef: (initial) => {
      const i = cursor++;
      if (hooks.length <= i) hooks[i] = { current: initial };
      return hooks[i];
    },
    useState: (initial) => {
      const i = cursor++;
      if (hooks.length <= i) hooks[i] = { v: initial };
      return [hooks[i].v, (value) => { hooks[i].v = typeof value === 'function' ? value(hooks[i].v) : value; }];
    },
    useEffect: () => {},
    Fragment: 'fragment', createPortal: (child) => child,
    h: (tag, attrs, ...children) => {
      if (attrs && attrs.ref) {
        // Assign the image ref to imgNode and the preview frame div ref to
        // frameNode so the auto-fit path reads the right geometry.
        if (tag === 'img') attrs.ref.current = imgNode;
        else if (attrs.class === 'inspector__preview-frame') attrs.ref.current = frameNode;
        else if (!attrs.ref.current) attrs.ref.current = {};
      }
      const node = { tag, attrs, children };
      nodes.push(node);
      return node;
    }
  });
  const props = {
    capture: async () => ({ data: 'iVBOR' }),
    clickAt: () => {},
    subscribe: null,
    sizePresets: [{ id: 'auto', label: 'Auto' }],
    sizeId: 'auto',
    onSizeChange: () => {}
  };
  vm.runInContext(source('PreviewPanel.jsx'), context);
  return {
    stored, imgNode, frameNode,
    previewZoomForWidth: context.previewZoomForWidth,
    render: () => { nodes = []; cursor = 0; context.PreviewPanel(props); return nodes; },
    zoomImg: (nodes) => nodes.find((n) => n.tag === 'img' && /preview-img/.test(n.attrs.class)),
    zoomBtn: (nodes) => nodes.find((n) => n.tag === 'button' && /^inspector__zoom/.test(n.attrs.class))
  };
}

async function main() {
  // Scenario 1: no stored preference — boots to fit, toggling to size then back.
  const h1 = newHarness({});
  let nodes = h1.render();
  let img = h1.zoomImg(nodes);
  assert.ok(img, 'preview image rendered');
  assert.equal(img.attrs.class, 'inspector__preview-img', 'defaults to fit (no --size modifier)');

  assert.ok(h1.zoomBtn(nodes), 'zoom toggle button rendered');
  h1.zoomBtn(nodes).attrs.onClick();
  nodes = h1.render();
  img = h1.zoomImg(nodes);
  assert.equal(img.attrs.class, 'inspector__preview-img inspector__preview-img--size',
    'toggling to natural size adds the --size modifier');
  assert.equal(h1.stored['mouaif:inspector:previewZoom'], 'size', 'zoom preference persisted');

  h1.zoomBtn(nodes).attrs.onClick();
  nodes = h1.render();
  img = h1.zoomImg(nodes);
  assert.equal(img.attrs.class, 'inspector__preview-img', 'returns to fit on second toggle');
  assert.equal(h1.stored['mouaif:inspector:previewZoom'], 'fit', 'fit preference persisted');

  // Scenario 2: stored 'size' — boots straight into natural-size mode.
  const h2 = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom': 'size' } });
  const nodes2 = h2.render();
  const img2 = h2.zoomImg(nodes2);
  assert.ok(img2, 'preview image rendered from stored size');
  assert.equal(img2.attrs.class, 'inspector__preview-img inspector__preview-img--size',
    'a stored "size" preference boots to natural-size mode');

  // Scenario 3: auto-fit decision (pure helper). A wide page (1280px) in a
  // 366px frame has a fit-scale ~0.29 (< 0.6) -> natural size, so text is
  // readable instead of squashed to a thumbnail.
  assert.equal(h1.previewZoomForWidth(1280, 366), 'size',
    'a wide page selects natural size (fit-scale < 0.6)');
  assert.equal(h1.previewZoomForWidth(375, 366), 'fit',
    'a narrow page stays in fit mode (fit-scale >= 0.6)');
  assert.equal(h1.previewZoomForWidth(768, 366), 'size',
    'a tablet page selects natural size in a phone frame');
  assert.equal(h1.previewZoomForWidth(366, 366), 'fit',
    'a page that fits the frame stays in fit mode');

  console.log('PASS preview fit/natural-size toggle, persistence, bootstrap, and auto-fit');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
