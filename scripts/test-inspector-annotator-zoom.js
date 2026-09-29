'use strict';
// Regression test for the Inspector Draft Craft annotator's zoom maths.
//
// Three separate zoom defects used to reach the user through this component:
//
//   1. The canvas frame was `flex: 1 1 auto` while the stage it holds grows
//      with the zoom, so zooming in grew the frame and shrank the tools panel
//      below it (measured 309 -> 174 -> 121 px while only the zoom changed).
//      The frame must have a zero flex-basis and the tools panel must not
//      shrink.
//   2. `fitZoomFor` returned the 10% safety floor when the frame could not be
//      measured. The annotator opens inside an animated overlay, so the first
//      read can be 0x0: the open-time fit then clamped the image to a 10%
//      thumbnail and the `Fit` gate (which compared 0.1 with 0.1) disabled the
//      only one-tap way back.
//   3. A zoom adjusted the scroll without accounting for the stage's
//      `margin: auto` centring, so the image moved under the finger/point by
//      the change in that lead.
//
// The pure helpers are exercised here so the maths is pinned without Chrome;
// the wiring (no direct `fitZoomFor` gate, the clamp using `minZoomFor`) is
// pinned against the source, the same way scripts/test-inspector-preview-zoom.js
// pins the Preview panel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const COMPONENT = path.join(__dirname, '../frontend/src/components/inspector/DraftCraftAnnotator.jsx');
const CSS = path.join(__dirname, '../frontend/src/draft-craft.css');
const source = fs.readFileSync(COMPONENT, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function context(extra = {}) {
  return vm.createContext(Object.assign({
    console,
    Math, Number, String, Object, Array, Map, Set, Date,
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    h: () => null,
    createPortal: (node) => node,
    requestAnimationFrame: () => 0,
    ResizeObserver: undefined
  }, extra));
}

function load(extra) {
  const ctx = context(extra);
  vm.runInContext(source, ctx);
  return ctx;
}

// ---- fitZoomFor: null while unmeasurable, a level once measured ----
const ctx = load();

assert.equal(ctx.fitZoomFor(null, null), null, 'no nodes means no fit level');
assert.equal(ctx.fitZoomFor({ clientWidth: 0, clientHeight: 0 }, { width: 375, height: 3000 }), null,
  'a 0x0 frame yields no fit level instead of the 10% floor');
assert.equal(ctx.fitZoomFor({ clientWidth: 375, clientHeight: 652 }, { width: 0, height: 0 }), null,
  'an undecoded image yields no fit level');
assert.equal(ctx.fitZoomFor({ clientWidth: 375, clientHeight: 652 }, { width: 375, height: 3000 }), 652 / 3000,
  'a tall page fits at frameHeight / (frameWidth * h/w)');
assert.equal(ctx.fitZoomFor({ clientWidth: 375, clientHeight: 652 }, { width: 375, height: 375 }), 1,
  'a short/wide page never fits past 1');
assert.equal(ctx.fitZoomFor({ clientWidth: 375, clientHeight: 10 }, { width: 375, height: 30000 }), 0.1,
  'a fit below the safety floor clamps to MIN_ZOOM');

// minZoomFor is the fit level when measurable and the floor when it is not, so
// a zoom cannot be clamped to a level that does not exist yet.
assert.equal(ctx.minZoomFor({ clientWidth: 375, clientHeight: 652 }, { width: 375, height: 3000 }), 652 / 3000,
  'the zoom floor is the fit level once measurable');
assert.equal(ctx.minZoomFor({ clientWidth: 0, clientHeight: 0 }, { width: 375, height: 3000 }), 0.1,
  'the zoom floor is the hard safety floor while unmeasurable');

// ---- centredLead: the margin:auto offset that the zoom must respect ----
assert.equal(ctx.centredLead(375, 375), 0, 'a stage as wide as the frame is not centred');
assert.equal(ctx.centredLead(375, 163), 106, 'a narrower stage is centred in the frame');
assert.equal(ctx.centredLead(375, 457), 0, 'an overflowing stage is pinned left');
assert.equal(ctx.centredLead(652, 1304), 0, 'an overflowing stage is pinned top');

// ---- zoomTargetScroll: keep the focused fraction under the same viewport spot ----
// Centred stage, no scrolling before or after: the content under the anchor is
// the centring lead plus the image fraction, so the scroll needed is the anchor
// minus that content offset.
const centred = { anchor: 300, fraction: 0.5, lead: 106, content: 163, maxScroll: 99999 };
assert.equal(ctx.zoomTargetScroll(centred), 300 - 106 - 0.5 * 163,
  'a centred stage scrolls by the anchor minus the centred image point');
// The same anchor with the image overflowing (no lead): the scroll must follow
// the point as it grows.
assert.equal(ctx.zoomTargetScroll({ anchor: 500, fraction: 0.5, lead: 0, content: 652, maxScroll: 99999 }), 500 - 326,
  'an overflowing stage scrolls to the point under the anchor');
assert.equal(ctx.zoomTargetScroll({ anchor: 10, fraction: 0.9, lead: 0, content: 652, maxScroll: 99999 }), 0,
  'a target above the content start clamps to 0');
assert.equal(ctx.zoomTargetScroll({ anchor: 9999, fraction: 0, lead: 0, content: 100, maxScroll: 250 }), 250,
  'a target past the last scrollable pixel clamps to maxScroll');
assert.equal(ctx.zoomTargetScroll({ anchor: 40, fraction: 0.5, lead: 0, content: 0, maxScroll: 99 }), 40,
  'a stage that has not laid out yet keeps the anchor');

// ---- wiring: the gates use the measurable-aware helpers ----
assert.equal(/disabled: zoom <= fitZoomFor\(/.test(source), false,
  'the zoom-out gate no longer compares against a level that may not exist');
assert.ok(/disabled: zoom <= minZoomFor\(wrapRef\.current, canvasRef\.current\) \+ 0\.005/.test(source),
  'the zoom-out gate uses minZoomFor');
assert.ok(/const fitLevel = fitZoomFor\(wrapRef\.current, canvasRef\.current\);\s*return fitLevel != null && Math\.abs\(zoom - fitLevel\) < 0\.005;/.test(source),
  'the Fit gate only disables when the fit level is real and already reached');
assert.ok(/const next = clampZoom\(value, minZoomFor\(wrap, canvas\)\)/.test(source),
  'applyZoom clamps to the measurable-aware minimum');
assert.ok(/if \(fitLevel == null\) return;/.test(source),
  'fit() refuses to set the 10% floor as a fit level');
assert.ok(/if \(lastFitZoomRef\.current == null\) \{ fit\(false\); return; \}/.test(source),
  'the resize observer takes the first real measurement when the open-time fit never landed');

// ---- CSS: the frame is sized by its flex basis, the tools panel never shrinks ----
const css = fs.readFileSync(CSS, 'utf8');
const block = (selector) => {
  const start = css.indexOf(selector + ' {');
  assert.notEqual(start, -1, selector + ' still exists');
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
};
const wrapRule = block('.draft-craft__canvas-wrap');
assert.ok(/flex:\s*1 1 0;/.test(wrapRule),
  'the canvas frame uses a zero flex-basis so a zoomed stage cannot grow it');
assert.equal(/flex:\s*1 1 auto/.test(wrapRule), false,
  'the content-sized flex-basis that shrank the tools panel is gone');
assert.ok(/min-height:\s*0;/.test(wrapRule), 'the frame keeps its min-height: 0');
assert.ok(/overflow:\s*auto;/.test(wrapRule), 'the stage still scrolls inside the frame');
const toolsRule = block('.draft-craft__annotator-tools');
assert.ok(/flex:\s*0 0 auto;/.test(toolsRule),
  'the tools panel does not shrink when the zoom makes the stage tall');
assert.ok(/max-height:\s*52dvh;/.test(toolsRule), 'the tools panel keeps its dvh ceiling');

console.log('PASS annotator zoom: measurable fit level, centring-aware zoom focus, non-shrinking frame and tools');
