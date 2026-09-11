'use strict';

// Inspector pick-mode feedback and auto-disarm.
//
// Regression test for two shipped defects in tap-to-select:
//
//   1. Pick mode is armed from the Styles panel but performed on the
//      Preview panel's screenshot, and nothing on the preview said so —
//      so a tap either selected an element or clicked the page with no
//      visible difference. inspector.md even documented a pick-mode hint
//      "styled in the Preview header" that did not exist.
//   2. Pick mode stayed armed after a successful pick. The next tap then
//      silently selected another element instead of poking the page, which
//      reads as a broken preview.
//
// The disarm decision is a pure function (inspector/pickMode.js) so it can
// be asserted directly, and the banner is asserted by *rendering* the real
// PreviewPanel in a miniature hooks runtime (the technique
// scripts/test-inspector-overview-poll.js uses) — a source-regex check
// would not prove the banner actually appears.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
// The Inspector CSS is split into per-panel parts behind an @import entry
// (frontend/src/inspector.css); readInspectorCss() inlines them so these
// checks still see the whole cascade.
const { readInspectorCss } = require('./inspector-css.js');
const readSrc = (p) => (p === 'frontend/src/inspector.css'
  ? readInspectorCss()
  : fs.readFileSync(path.join(root, p), 'utf8'));
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const previewSource = strip(readSrc('frontend/src/components/inspector/PreviewPanel.jsx'));
const pickModeSource = strip(readSrc('frontend/src/components/inspector/pickMode.js'));
const inspectorSource = readSrc('frontend/src/components/Inspector.jsx');
const stylesSource = readSrc('frontend/src/components/inspector/StylesPanel.jsx');
const css = readSrc('frontend/src/inspector.css');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- A. settlePick: only a real selection disarms ----------------------

function loadPickMode() {
  const context = vm.createContext({});
  vm.runInContext(pickModeSource, context);
  return context;
}
const pickMode = loadPickMode();

check('settlePick is exported', typeof pickMode.settlePick === 'function');
check('pickBannerText is exported', typeof pickMode.pickBannerText === 'function');
check('banner names the gesture, not the feature',
  /^Pick: tap an element/.test(pickMode.pickBannerText()), pickMode.pickBannerText && pickMode.pickBannerText());

async function settleCases() {
  let armed = true;
  const disarm = () => { armed = false; };
  const miss = () => { armed = true; };

  // A synchronous true (a pick handler that already resolved) disarms.
  armed = true;
  pickMode.settlePick(true, disarm, miss);
  check('sync success disarms pick mode', armed === false);

  // A synchronous false (nothing selectable) keeps it armed so the user can
  // try again without re-arming.
  armed = true;
  pickMode.settlePick(false, disarm, miss);
  check('sync miss stays armed', armed === true);

  // undefined: no handler wired — nothing to disarm, no crash.
  armed = true;
  pickMode.settlePick(undefined, disarm, miss);
  check('undefined outcome stays armed', armed === true);

  // A promise resolving true (the real path: pickFromPoint is async).
  armed = true;
  await pickMode.settlePick(Promise.resolve(true), disarm, miss);
  check('resolved success disarms pick mode', armed === false);

  // A promise resolving false: the element at that point was not selectable.
  armed = true;
  await pickMode.settlePick(Promise.resolve(false), disarm, miss);
  check('resolved miss stays armed', armed === true);

  // A rejecting promise (CDP error): stays armed, and must not throw an
  // unhandled rejection out of the click handler.
  armed = true;
  await pickMode.settlePick(Promise.reject(new Error('CDP exploded')), disarm, miss);
  check('a failed pick stays armed', armed === true);

  // onMiss is optional.
  await pickMode.settlePick(Promise.resolve(false), disarm, undefined);
  check('onMiss is optional', true);

  check('settlePick returns the promise it waits on',
    typeof pickMode.settlePick(Promise.resolve(true), () => {}, () => {}) === 'object');
}

// ---- B. The banner actually renders ------------------------------------

// Miniature hooks runtime: state slots survive a re-render, effects are
// collected (not run, so no capture loop is started), refs are plain boxes.
function createHarness() {
  const nodes = [];
  const states = [];
  let cursor = 0;
  const context = vm.createContext({
    Fragment: 'fragment',
    // The full-screen branch calls createPortal(child, document.body).
    document: { body: {} },
    createPortal: (child) => ({ type: 'portal', props: {}, children: [child] }),
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useState: (initial) => {
      const slot = cursor++;
      if (states[slot] === undefined) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    },
    useEffect: () => {},
    // The shared sheet hook (Escape, Tab cycle, focus restore) returns a ref;
    // it is exercised in scripts/test-modal-hook.js, not in this DOM harness.
    useModal: () => ({ current: null }),
    h: (type, attrs, ...children) => {
      const node = { type, props: attrs || {}, children };
      nodes.push(node);
      return node;
    },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: () => 0
  });
  vm.runInContext(pickModeSource, context);
  vm.runInContext(previewSource, context);
  return {
    context,
    states,
    render(props) { cursor = 0; return context.PreviewPanel(props); }
  };
}

// Walk a vnode tree (h() returns a node with children) and collect it.
function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  (node.children || []).forEach((child) => walk(child, out));
  return out;
}
const classOf = (node) => String((node.props && node.props.class) || '');
const findByClass = (tree, cls) => walk(tree).filter((n) => classOf(n).split(/\s+/).includes(cls));
const textOf = (node) => walk(node).map((n) => typeof n === 'object' ? '' : String(n)).join('')
  + walk(node).filter((n) => typeof n.children?.[0] === 'string').map((n) => n.children.join('')).join(' ');

const baseProps = {
  capture: () => Promise.resolve({}),
  clickAt: () => {},
  subscribe: () => () => {},
  ackFrame: () => {},
  sizePresets: [{ id: 'auto', label: 'Auto' }],
  sizeId: 'auto',
  onSizeChange: () => {}
};

{
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseProps));
  check('no banner when pick mode is off', findByClass(tree, 'inspector__pickban').length === 0,
    'found ' + findByClass(tree, 'inspector__pickban').length);
  check('the preview column is not marked as picking',
    findByClass(tree, 'inspector__preview').every((n) => !classOf(n).includes('is-picking')));
}

{
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseProps, { pickMode: true, onPickCancel: () => {} }));
  const banners = findByClass(tree, 'inspector__pickban');
  check('banner renders while pick mode is on', banners.length === 1, 'found ' + banners.length);
  check('the preview column is marked as picking',
    findByClass(tree, 'inspector__preview').some((n) => classOf(n).includes('is-picking')));
  check('the banner states the gesture', /Pick: tap an element/.test(textOf(tree)), textOf(tree).slice(0, 80));
  check('the banner carries a Cancel that disarms', findByClass(tree, 'inspector__pickban-cancel').length === 1);
  check('the banner is announced (role=status)',
    banners.length === 1 && banners[0].props.role === 'status');
}

{
  // Without onPickCancel there is nothing to cancel with, so the button is
  // omitted rather than rendered dead.
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseProps, { pickMode: true }));
  check('no Cancel button when no cancel handler is wired',
    findByClass(tree, 'inspector__pickban-cancel').length === 0);
}

{
  // A custom hint (the parent passes one) wins over the default.
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseProps, { pickMode: true, pickHint: 'Pick: custom hint' }));
  check('an explicit pickHint is used', /Pick: custom hint/.test(textOf(tree)));
}

{
  // Full-screen overlay: same state, same contract. `fullscreen` is the 3rd
  // useState slot in the component (typeValue, typePending, fullscreen).
  // The panel stays mounted behind the overlay (that is what keeps the
  // capture loop alive), so both surfaces carry a banner: the in-panel one
  // and the overlay one.
  const harness = createHarness();
  harness.states[2] = true;
  const tree = harness.render(Object.assign({}, baseProps, { pickMode: true, onPickCancel: () => {} }));
  check('both the panel and the full-screen overlay show a banner',
    findByClass(tree, 'inspector__pickban').length === 2,
    'found ' + findByClass(tree, 'inspector__pickban').length);
  check('full-screen frame is marked as picking',
    findByClass(tree, 'inspector__preview-fs-frame').some((n) => classOf(n).includes('is-picking')));
  check('the overlay banner is the sticky variant',
    findByClass(tree, 'inspector__pickban--fs').length === 1);
}

// ---- C. The wiring -----------------------------------------------------

check('Inspector passes pickMode to the preview',
  /pickMode: stylesActive/.test(inspectorSource));
check('Inspector passes a pick hint to the preview',
  /pickHint: pickBannerText\(\)/.test(inspectorSource));
check('Inspector passes a cancel handler to the preview',
  /onPickCancel: \(\) => \{ setStylesActive\(false\)/.test(inspectorSource));
check('Inspector settles the pick outcome through settlePick',
  /settlePick\(stylesPickRef\.current\(x, y\)/.test(inspectorSource));
check('a dispatcher taps the page when pick mode is off',
  /if \(handlers\) handlers\.clickAt\(x, y\)\.catch/.test(inspectorSource));
check('pickFromPoint reports success so the parent can disarm',
  /if \(m\) \{ applyModel\(m\); return true; \}/.test(stylesSource));
check('pickFromPoint reports a miss',
  /setError\('Nothing selectable at that point\.'\);\s*return false;/.test(stylesSource));
check('pickFromPoint reports a failed pick',
  /setError\(\(e && e\.message\) \|\| 'Inspect failed'\);\s*return false;/.test(stylesSource));
check('the Styles panel still owns the arm action',
  /function togglePickMode\(\)/.test(stylesSource) && /onPickModeChange/.test(stylesSource));

// ---- D. The tap target and the cursor ---------------------------------

const bannerRule = /\.inspector__pickban \{([\s\S]*?)\}/.exec(css);
check('banner styles exist', !!bannerRule);
if (bannerRule) {
  check('the banner is at least a 44 px tap target', /min-height:\s*var\(--tap\)/.test(bannerRule[1]));
  check('the banner sits over the screenshot', /position:\s*absolute/.test(bannerRule[1]));
  check('the banner is above the screenshot image', /z-index:\s*[1-9]/.test(bannerRule[1]));
}
check('pick mode changes the cursor to crosshair',
  /is-picking[\s\S]{0,240}cursor:\s*crosshair/.test(css));
check('pick mode outlines the tap surface',
  /\.inspector__preview\.is-picking \.inspector__preview-frame[\s\S]{0,160}border-color:\s*var\(--accent\)/.test(css));
check('the cancel button is at least a 44 px tap target',
/\.inspector__pickban-cancel \{[\s\S]{0,120}min-height:\s*var\(--tap\)/.test(css));
// ---- E. The wrapped close button sits inside its own band ----------------
// Regression guard for a shipped defect. At ≤ 430 px the preview header
// wraps and the close ✕ is absolutely positioned. It used to be offset
// `top: calc(var(--safe-top) + 8px)`, but the overlay already applies
// `padding: var(--safe-top) 0 var(--safe-bottom)`, so the head is the ✕'s
// containing block and already starts below the status bar — the inset was
// applied twice. On a notched phone (safe-top 47px) the ✕ landed at
// y 102..146 while the size <select> occupied y 104..148, so its transparent
// 44 px square covered the right end of the dropdown: a tap there resolved to
// the close button and dismissed the overlay instead of opening the size
// picker. Re-measured in Chrome at 360 px, the same taps now hit the <select>.
// The two headers that share this pattern (`.wp__close` in chat-composer.css
// and `.inspector__preview-fs-close` here) must both measure from the head.
const narrow = css.slice(css.indexOf('@media (max-width: 430px)'));
check('the preview overlay pads out the status bar itself',
/inspector__preview-fs \{[\s\S]{0,400}?padding:\s*var\(--safe-top/.test(css));
check('the wrapped close button is offset from the head, not the viewport',
/\.inspector__preview-fs-close \{[\s\S]{0,400}?top:\s*8px/.test(narrow));
check('the wrapped close button never re-adds the safe-area inset',
!/\.inspector__preview-fs-close \{[\s\S]{0,200}?top:\s*calc\(var\(--safe-top/.test(narrow));
check('the mobile header still reserves the close-button band',
/\.inspector__preview-fs-text \{[\s\S]{0,200}?flex:\s*0 0 calc\(100% - 52px\)/.test(narrow));

// ---- Summary -----------------------------------------------------------

settleCases().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  assert.equal(failed, 0, failed + ' pick-mode assertion(s) failed');
});
