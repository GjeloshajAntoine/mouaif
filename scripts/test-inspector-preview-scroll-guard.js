'use strict';
// Regression tests for the Inspector preview's tap handling.
//
// The preview frame is a scroll container holding a full-page capture, and it
// has two independent writers: the user's finger, and the panel's own capture
// loop (which swaps the <img> src on every tick and re-writes the offsets it
// read before the swap). `scroll` events therefore do not mean "the user
// panned", and the guard has to tell the two apart.
//
// Two behaviours are locked in here, both verifiable without a browser:
//
//   1. A `scroll` that leaves the frame where the finger found it is not a pan,
//      so the pending tap survives it. The guard used to drop the tap on *any*
//      scroll event, which silently swallowed taps — and in pick mode left the
//      mode armed and the Styles panel empty, with nothing reported.
//   2. A tap that cannot reach the page must be reported, not swallowed. The
//      clickAt call is a CDP round-trip that can fail; the failure used to be
//      dropped by an empty `.catch(() => {})`, which is indistinguishable from
//      "the tap did nothing".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

// renderPanel — run PreviewPanel in a vm with the same hook harness the
// coordinate-mapping test uses, and hand back the rendered frame node so its
// event handlers can be driven directly.
function renderPanel(overrides) {
  const frameTop = 120, frameLeft = 30, scrollTop = 600, scrollLeft = 0;
  const rectWidth = 360, natW = 360, natH = 3600;
  const imgRect = { top: frameTop - scrollTop, left: frameLeft, width: rectWidth, height: natH };
  const nodes = [];
  const hooks = [];
  let cursor = 0;
  const imageNode = {
    naturalWidth: natW, naturalHeight: natH,
    getBoundingClientRect: () => imgRect
  };
  const frameNode = { scrollTop, scrollLeft };
  const context = vm.createContext({
    Blob, Uint8Array, atob, Date,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    useRef: (initial) => {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { current: initial };
      return hooks[i];
    },
    useState: (initial) => {
      const i = cursor++;
      if (hooks[i] === undefined) hooks[i] = initial;
      return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
    },
    useEffect: () => {},
    useModal: () => ({ current: null }),
    Fragment: 'fragment', createPortal: (child) => child,
    h: (tag, attrs, ...children) => {
      const node = { tag, attrs, children };
      if (attrs && attrs.ref) {
        if (tag === 'img') attrs.ref.current = imageNode;
        else if (tag === 'div') attrs.ref.current = frameNode;
      }
      nodes.push(node);
      return node;
    }
  });
  vm.runInContext(source('PreviewPanel.jsx'), context);
  context.PreviewPanel(Object.assign({
    capture: async () => ({ data: 'iVBOR' }),
    clickAt: () => {},
    subscribe: null
  }, overrides));
  const frame = nodes.find((n) => n.attrs && n.attrs.class === 'inspector__preview-frame');
  assert.ok(frame, 'the preview frame rendered');
  // The handlers receive the frame as currentTarget, exactly as the DOM does
  // (the full-screen overlay and the in-panel frame both bind the same four
  // handlers, so the guard has to read the surface it is given).
  const on = (name, ev) => frame.attrs[name](Object.assign({ currentTarget: frameNode }, ev));
  return { frame, frameNode, on, imageNode, clickAt: overrides.clickAt };
}

async function main() {
  // --- 1. a scroll that does not move the frame must not drop the tap -------
  {
    const clicked = [];
    const { on } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    // The panel's own frame swap lands here: it fires `scroll` but restores the
    // offset the finger found, so the frame has not moved.
    on('onScroll', {});
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 1, 'a scroll that leaves the frame in place keeps the tap');
  }

  // --- 2. a real pan still drops the tap -----------------------------------
  {
    const clicked = [];
    const { on, frameNode } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    // A trackpad or a scrollbar drag starts a scroll with no pointermove on the
    // frame; the offset moves, which is the signal that this was a pan.
    frameNode.scrollTop = 660;
    on('onScroll', {});
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 0, 'a scroll that moved the frame drops the tap');
  }

  // --- 3. a horizontal pan drops it too ------------------------------------
  {
    const clicked = [];
    const { on, frameNode } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    frameNode.scrollLeft = 40;
    on('onScroll', {});
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 0, 'a horizontal pan drops the tap');
  }

  // --- 4. slop, pointercancel and a second finger still drop it ------------
  {
    const clicked = [];
    const { on } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onPointerMove', { clientX: clientX + 40, clientY });
    on('onClick', { clientX: clientX + 40, clientY });
    assert.equal(clicked.length, 0, 'a move past the slop drops the tap');
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onPointerCancel', {});
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 0, 'pointercancel drops the tap');
    on('onPointerDown', { button: 2, clientX, clientY });
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 0, 'a non-primary press is not a tap');
  }

  // --- 5. the next real tap still works ------------------------------------
  {
    const clicked = [];
    const { on } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onScroll', {});
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 1, 'a fresh tap after a cancelled one still reaches the page');
  }

  // --- 6. the guard resets per gesture, with no pointerup needed -----------
  {
    const clicked = [];
    const { on } = renderPanel({ clickAt: (x, y) => clicked.push({ x, y }) });
    const clientX = 30 + 180, clientY = 120 + 40;
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onPointerUp', { clientX: clientX + 90, clientY });
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 0, 'a moved pointer-up keeps the tap cancelled');
    on('onPointerDown', { button: 0, clientX, clientY });
    on('onClick', { clientX, clientY });
    assert.equal(clicked.length, 1, 'and the next gesture is armed again');
  }

  // --- 7. the app wires a failed tap into the status pill ------------------
  // The `.catch(() => {})` that swallowed the failure is the other half of "it
  // did nothing with no explanation": React/Preact never sees a rejection the
  // handler drops. Asserted at the source, because the failure only exists in a
  // live CDP session.
  const inspector = fs.readFileSync(path.join(__dirname, '../frontend/src/components/Inspector.jsx'), 'utf8');
  const clickBlock = inspector.slice(inspector.indexOf('clickAt: (x, y) => {'), inspector.indexOf('pickMode: stylesActive'));
  assert.match(clickBlock, /handlers\.clickAt\(x, y\)/, 'the preview tap still calls clickAt');
  assert.doesNotMatch(clickBlock, /\.catch\(\(\) => \{\}\)/, 'the failure is not swallowed by an empty catch');
  assert.match(clickBlock, /setStatus\(/, 'a failed tap is reported in the status pill');

  console.log('PASS preview taps: an in-place scroll keeps the tap, a real pan drops it, a failure is reported');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
