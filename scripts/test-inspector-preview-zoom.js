'use strict';
// Regression test for the Inspector preview fit-width / natural-size (zoom) toggle.
//
// Wide pages (e.g. the Laptop 1280px preset) are otherwise squashed to ~30% of
// the frame and become unreadable. The toggle switches the preview <img> between
// `fit` (width:100%, scroll vertically) and `size` (page CSS pixels, pan both
// axes) via the `inspector__preview-img--size` modifier class plus the inline
// width the panel derives from the capture (see previewNaturalWidth), and
// persists the choice in localStorage so reconnects keep it. The panel also
// auto-selects natural size on the first decode when a wide page would be
// unreadable in fit mode. This test locks in the toggle behaviour,
// persistence, bootstrapping from a stored choice, the auto-fit decision, and
// the retina-safe 100% width.
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
setItem: (k, v) => { stored[k] = String(v); },
removeItem: (k) => { delete stored[k]; }
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
    // The shared sheet hook (Escape, Tab cycle, focus restore) returns a ref;
    // it is exercised in scripts/test-modal-hook.js, not in this DOM harness.
    useModal: () => ({ current: null }),
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
    previewNaturalWidth: context.previewNaturalWidth,
    autoZoomDecision: context.autoZoomDecision,
    zoomStored: context.zoomStored,
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
  assert.equal(h1.stored['mouaif:inspector:previewZoom2'], 'size', 'an explicit toggle is persisted (v2 key)');

  h1.zoomBtn(nodes).attrs.onClick();
  nodes = h1.render();
  img = h1.zoomImg(nodes);
  assert.equal(img.attrs.class, 'inspector__preview-img', 'returns to fit on second toggle');
  assert.equal(h1.stored['mouaif:inspector:previewZoom2'], 'fit', 'the fit choice is persisted too');

  // Scenario 2: stored 'size' — boots straight into natural-size mode.
  const h2 = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom2': 'size' } });
  const nodes2 = h2.render();
  const img2 = h2.zoomImg(nodes2);
  assert.ok(img2, 'preview image rendered from stored size');
  assert.equal(img2.attrs.class, 'inspector__preview-img inspector__preview-img--size',
    'a stored "size" preference boots to natural-size mode');

  // Scenario 2b (regression): the v1 key was also written by the auto-fit path
// while the Touch stylesheet was collapsing the preview frame, which pinned a
// derived, not a chosen, `size`. It must be dropped rather than honoured, so a
// user whose preview was stuck in panned natural-size mode lands back on fit.
const h2b = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom': 'size' } });
const nodes2b = h2b.render();
const img2b = h2b.zoomImg(nodes2b);
assert.equal(img2b.attrs.class, 'inspector__preview-img',
'a legacy v1 "size" is dropped instead of pinning the preview to natural size');
assert.equal('mouaif:inspector:previewZoom' in h2b.stored, false,
'the legacy key is cleared so it cannot poison a later session');
// Scenario 3: auto-fit decision (pure helper). A wide page (1280px) in a
  // 366px frame has a fit-scale ~0.29 (< 0.6) -> natural size, so text is
  // readable instead of squashed to a thumbnail. The default is now dpr 1,
  // which keeps these single-source dpr=1 assertions intact.
  assert.equal(h1.previewZoomForWidth(1280, 366), 'size',
    'a wide page selects natural size (fit-scale < 0.6)');
  assert.equal(h1.previewZoomForWidth(375, 366), 'fit',
    'a narrow page stays in fit mode (fit-scale >= 0.6)');
  assert.equal(h1.previewZoomForWidth(768, 366), 'size',
    'a tablet page selects natural size in a phone frame');
  assert.equal(h1.previewZoomForWidth(366, 366), 'fit',
    'a page that fits the frame stays in fit mode');

  // Scenario 4 (regression): the retina Phone preset captures at
  // deviceScaleFactor 2, so the image's naturalWidth is 2x the page's CSS
  // width. Auto-fit must compare the frame against the page's CSS width
  // (naturalWidth / dpr), NOT against the device-pixel width. A narrow phone
  // page (375 CSS px -> 750 device px) fits the frame at ~94%, so it must stay
  // in fit mode — the old code read 351/750 (~47%) and wrongly forced natural
  // size (pan), which is the opposite of the intended fit-to-width default.
  assert.equal(h1.previewZoomForWidth(750, 351, 2), 'fit',
    'a retina phone page stays fit (fit-scale ~0.94 of CSS width)');
  assert.equal(h1.previewZoomForWidth(750, 366, 2), 'fit',
    'a retina phone page from a wider frame also stays fit');
  assert.equal(h1.previewZoomForWidth(2560, 351, 2), 'size',
    'a truly wide retina page still selects natural size');

  // Scenario 5: natural-size ("100%") rendering width. The capture's own
  // width is in *device* pixels, so painting a 2x-retina capture at that
  // width would show the page at double size — wrong proportions, a soft
  // upscale, and four times the panning area. 100% is the page's own CSS
  // width, i.e. the capture divided by the preset's scale factor.
  assert.equal(h1.previewNaturalWidth(750, 2), 375,
    'a 2x-retina phone capture paints at its 375 CSS px page width');
  assert.equal(h1.previewNaturalWidth(828, 2), 414,
    'a 2x-retina Phone+ capture paints at its 414 CSS px page width');
  assert.equal(h1.previewNaturalWidth(1280, 1), 1280,
    'a dpr 1 capture keeps its intrinsic width');
  assert.equal(h1.previewNaturalWidth(1960, 2), 980,
    'a retina capture of a wide page paints at its CSS content width');
  assert.equal(h1.previewNaturalWidth(0, 2), 0,
    'nothing decoded yet yields no pinned width');

  // Scenario 6 (regression): a remount must not re-decide a mode the user
  // already chose. The one-shot auto-fit gate lives in a ref, so it resets on
  // every mount — and the Preview panel remounts whenever its chip is toggled
  // or its full-screen overlay round-trips. With a wide preset selected and
  // `Fit` chosen by hand, the old code re-ran the heuristic on remount and
  // snapped the preview back to natural size (panning, and losing the frame's
  // scroll position): the preview appeared to blink between two framings on
  // every panel switch. The decision helper now refuses whenever the mode is
  // the user's, whether that came from storage or a tap.
  const decision = h1.autoZoomDecision;
  assert.ok(typeof decision === 'function', 'the auto-fit decision is exported for testing');
  assert.equal(decision({ decided: false, chosen: true, naturalWidth: 1280, frameWidth: 366, deviceScaleFactor: 1 }),
    false, 'a user-chosen zoom is never overridden by the auto-fit');
  assert.equal(decision({ decided: false, chosen: false, naturalWidth: 1280, frameWidth: 366, deviceScaleFactor: 1 }),
    true, 'an unchosen, too-wide page is still auto-switched to natural size');
  assert.equal(decision({ decided: false, chosen: false, naturalWidth: 375, frameWidth: 366, deviceScaleFactor: 1 }),
    false, 'an unchosen page that fits stays in fit mode');
  assert.equal(decision({ decided: true, chosen: false, naturalWidth: 1280, frameWidth: 366, deviceScaleFactor: 1 }),
    false, 'the one-shot gate fires once per mount');
  assert.equal(decision({ decided: false, chosen: true, naturalWidth: 750, frameWidth: 351, deviceScaleFactor: 2 }),
    false, 'a chosen fit survives a retina preset too');

  // zoomStored — the "the user has decided" mark. toggleZoom writes the key on
  // *every* toggle, including `fit` (which is also the default), so the
  // presence of the key is what marks a decision; the initial read alone cannot
  // tell a stored `fit` from the default.
  const stored = h1.zoomStored;
  assert.ok(typeof stored === 'function', 'the stored-preference probe is exported');
  // A fresh harness, because h1 has already toggled twice above and therefore
  // does hold a stored decision by now.
  const h0 = newHarness({});
  assert.equal(h0.zoomStored(), false, 'no key means the user has not decided');
  const h6 = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom2': 'fit' } });
  assert.equal(h6.zoomStored(), true, 'a stored fit counts as a decision');
  const h7 = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom2': 'size' } });
  assert.equal(h7.zoomStored(), true, 'a stored size counts as a decision');
  const h8 = newHarness({ storedSeed: { 'mouaif:inspector:previewZoom': 'size' } });
  h8.render();
  assert.equal(h8.zoomStored(), false, 'the discarded legacy v1 key is not a decision');

  console.log('PASS preview fit/natural-size toggle, persistence, bootstrap, auto-fit, and 100% width');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
