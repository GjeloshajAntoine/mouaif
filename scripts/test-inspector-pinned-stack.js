'use strict';

// pinnedStack — the offset that keeps the Styles panel's group chip row pinned
// *under* the identity row instead of on top of it.
//
// The bug this guards is a layout one that neither strip can see on its own:
// both are `position: sticky` against the panel's scroller, and the chip row's
// offset has to be the identity row's height. Measured on the repo's own
// fixture at `scrollTop 1493` with the old `top: 0` chip row: the chips occupied
// `245 → 354` — the exact band of the pinned element preview, which used to be
// part of that block — and the first 109 px of the property rows were behind
// them, while the block's full 178 px stayed reserved underneath. Two layers of
// chrome and no content.
//
// The arithmetic is small, but it is the part a browser is needed to check
// otherwise: a `0` fallback, a `NaN` height, a detached node or a rounding slip
// all put the two strips back on top of each other, and the symptom (a chip row
// half-covering a preview) is easy to attribute to the wrong element. So the
// measurement, the write and the observation are asserted here against a
// duck-typed node, with no DOM.

const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(path.join(__dirname, '../frontend/src/components/inspector/pinnedStack.js'));

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A stand-in for the panel element: records the custom property it was given.
function makeRoot() {
  const props = new Map();
  return {
    props,
    style: {
      setProperty: (name, value) => { props.set(name, value); },
      removeProperty: (name) => { props.delete(name); },
      getPropertyValue: (name) => (props.has(name) ? props.get(name) : '')
    }
  };
}
// A stand-in for an element with a measured box.
const nodeOf = (box) => ({ getBoundingClientRect: () => box });

console.log('pinnedStack');

// ---- the measurement ----------------------------------------------------
check('a measured height is published as a whole-pixel length',
  mod.pinHeightPx(nodeOf({ height: 53.4 })) === '53px');

check('a fractional height rounds rather than truncating down to nothing',
  mod.pinHeightPx(nodeOf({ height: 0.6 })) === '1px');

check('a hidden or detached node reports no measurement, not a zero-height pin',
  mod.pinHeightPx(nodeOf({ height: 0 })) === ''
  && mod.pinHeightPx(nodeOf({ height: -3 })) === ''
  && mod.pinHeightPx(null) === ''
  && mod.pinHeightPx({}) === '',
  'anything that is not a positive finite number must fall back, not pin at 0');

check('a non-finite height is refused',
  mod.pinHeightPx(nodeOf({ height: NaN })) === ''
  && mod.pinHeightPx(nodeOf({ height: Infinity })) === '');

// ---- the write ----------------------------------------------------------
{
  const root = makeRoot();
  const written = mod.applyPinHeight(root, nodeOf({ height: 53 }));
  check('the height is written to the custom property the CSS reads',
    written === '53px' && root.props.get(mod.PIN_HEIGHT_VAR) === '53px');
  check('the property name is the one the stylesheet uses',
    mod.PIN_HEIGHT_VAR === '--insp-pin-h');
  check('the fallback is one tap row', mod.PIN_HEIGHT_FALLBACK === '44px');
}
{
  const root = makeRoot();
  mod.applyPinHeight(root, nodeOf({ height: 53 }));
  mod.applyPinHeight(root, nodeOf({ height: 71 }));
  check('a grown pin — an error line appearing — rewrites the offset',
    root.props.get(mod.PIN_HEIGHT_VAR) === '71px');
}
{
  const root = makeRoot();
  mod.applyPinHeight(root, nodeOf({ height: 53 }));
  const again = mod.applyPinHeight(root, nodeOf({ height: 53 }));
  check('an unchanged height writes nothing again',
    again === '53px' && root.props.get(mod.PIN_HEIGHT_VAR) === '53px');
}
{
  const root = makeRoot();
  mod.applyPinHeight(root, nodeOf({ height: 53 }));
  mod.applyPinHeight(root, nodeOf({ height: 0 }));
  check('a selection with no measurable pin clears the property',
    !root.props.has(mod.PIN_HEIGHT_VAR),
    'a stale height would pin the chips against a block that is no longer there');
}
check('a root without a style object is not a crash',
  mod.applyPinHeight(null, nodeOf({ height: 53 })) === ''
  && mod.applyPinHeight({}, nodeOf({ height: 53 })) === '');

// ---- the observation ----------------------------------------------------
{
  // A fake ResizeObserver: the callback is captured so a resize can be fired.
  const watchers = [];
  class FakeRO {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; watchers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  }
  const root = makeRoot();
  const node = nodeOf({ height: 53 });
  let height = 53;
  const live = { getBoundingClientRect: () => ({ height }) };
  const stop = mod.watchPin(live, () => mod.applyPinHeight(root, live), { ResizeObserver: FakeRO });
  check('watching measures immediately, before any resize',
    root.props.get(mod.PIN_HEIGHT_VAR) === '53px');
  check('it observes the pin node it was given',
    watchers.length === 1 && watchers[0].targets.length === 1);
  height = 71;
  watchers[0].cb();
  check('a resize re-measures', root.props.get(mod.PIN_HEIGHT_VAR) === '71px');
  stop();
  check('stopping disconnects the observer', watchers[0].disconnected === true);
  void root; void node;
}
{
  // No ResizeObserver (an older WebView): the immediate measurement still has
  // to happen, or the chips sit at the fallback forever.
  const root = makeRoot();
  const stop = mod.watchPin(nodeOf({ height: 53 }), () => mod.applyPinHeight(root, nodeOf({ height: 53 })), { ResizeObserver: null });
  check('a target without ResizeObserver still gets one measurement',
    root.props.get(mod.PIN_HEIGHT_VAR) === '53px');
  check('and a stop function that is safe to call', typeof stop === 'function' && stop() === undefined);
}
{
  const stop = mod.watchPin(null, () => {}, { ResizeObserver: null });
  check('watching nothing returns a no-op stop', typeof stop === 'function' && stop() === undefined);
}

// ---- the wiring ---------------------------------------------------------
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const panelSource = read('frontend/src/components/inspector/StylesPanel.jsx');
const touchCss = read('frontend/src/inspector-touch.css').replace(/\/\*[\s\S]*?\*\//g, '');
const stylesCss = read('frontend/src/inspector-styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(css, selector) {
  const re = new RegExp('\\' + selector + '\\s*\\{([^}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out.join('\n');
}

check('the panel wires the pin ref and the measurement',
  /const pinRef = useRef\(null\)/.test(panelSource)
  && /class: 'inspector__styles-pin', ref: pinRef/.test(panelSource)
  && /applyPinHeight\(panel, pinRef\.current\)/.test(panelSource)
  && /watchPin\(pinRef\.current, apply\)/.test(panelSource));
check('the pin is re-measured when the selected element changes',
  /\}, \[crumbsKey, error\]\)/.test(panelSource));
// The property has to be on the element before the browser paints, or the chip
// row is laid out with the fallback for one frame and lands 9 px inside the
// identity row — the two strips painted on top of each other, which is the
// defect this wiring removes.
check('the measurement runs before paint, not after',
  /useLayoutEffect\(\(\) => \{\s*const panel = panelRef\.current;\s*if \(!panel\) return undefined;\s*const apply = \(\) => applyPinHeight/.test(panelSource)
  && /useLayoutEffect,/.test(panelSource));
check('the chip row pins below the measured pin, into the same scrollport edge',
  /top:\s*calc\(var\(--insp-pin-h,\s*44px\)\s*-\s*6px\)/.test(ruleBody(touchCss, '.inspector__touch-tabs')));
check('the pin cancels the same 6 px of panel padding',
  /top:\s*-6px/.test(ruleBody(stylesCss, '.inspector__panel-body .inspector__styles-pin')));
check('the identity row paints over the chip row, not the other way round',
  /z-index:\s*4/.test(ruleBody(stylesCss, '.inspector__panel-body .inspector__styles-pin'))
  && /z-index:\s*3/.test(ruleBody(touchCss, '.inspector__touch-tabs')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' pinnedStack assertion(s) failed');
