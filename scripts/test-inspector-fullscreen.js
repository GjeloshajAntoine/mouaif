'use strict';

// Inspector panel full screen — the header button, the surface, and the exit.
//
// The header of every panel card used to print the panel's *name*
// (`inspector__panel-label`), and on Preview alone that slot held a full-screen
// button instead. Two things were wrong with that split, and both are asserted
// here:
//
//   1. the name is the chip's job (the pinned switcher above the cards labels
//      every panel in words), so the header should spend its one wide slot on
//      the action — the same button on all five cards;
//   2. a panel body is 32–54 dvh on a phone, which is under half the viewport, so
//      "make this one bigger" is the action those bodies need — and stretching
//      the card *in place* cannot deliver it, because the in-flow card is capped
//      by `.app__main` (the region is the box with the dead space in it). The
//      surface is therefore a separate node at the document root.
//
// The render harness is the one scripts/test-inspector-pick-mode.js uses: it
// executes the real component source in a miniature hooks runtime, so these
// assertions are about the markup that actually renders rather than about a
// regex that could pass on a comment.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// The Inspector CSS is split behind an @import entry; readInspectorCss() inlines
// the parts so these checks see the whole cascade.
const { readInspectorCss } = require('./inspector-css.js');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const inspectorSource = read('frontend/src/components/Inspector.jsx');
const css = readInspectorCss();
// Comment-blind CSS: several of these files explain a removed declaration in
// prose, and an unanchored regex would pass on the explanation.
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBody = (selector) => {
  const at = cssNoComments.indexOf(selector + ' {');
  if (at < 0) return null;
  const open = cssNoComments.indexOf('{', at);
  const close = cssNoComments.indexOf('}', open);
  return open < 0 || close < 0 ? null : cssNoComments.slice(open + 1, close);
};

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- A. The header button -------------------------------------------------

// Miniature hooks runtime for PanelCard. Effects are collected (and their
// cleanups returned), refs are plain boxes, and `h` records every node so the
// tree can be walked. `document.addEventListener` is captured rather than
// ignored, because EscapeToExit's handler is one of the things under test.
function createHarness() {
  const nodes = [];
  const effects = [];
  let cursor = 0;
  const listeners = { removed: 0 };
  const context = vm.createContext({
  Fragment: 'fragment',
  document: {
  body: {},
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  removeEventListener: (type, fn) => {
  const list = listeners[type] || [];
  const at = list.indexOf(fn);
  if (at >= 0) { list.splice(at, 1); listeners.removed++; }
  }
  },
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => { effects.push(fn); },
    useModal: () => ({ current: null }),
    h: (type, attrs, ...children) => {
    // Invoke function components the way Preact would, so a child's own hooks
    // (EscapeToExit's keydown listener) run in this harness too. A `type` of
    // 'fragment' or a tag string is left as a node.
    if (typeof type === 'function') {
      const rendered = type(Object.assign({}, attrs, { children }));
      nodes.push(rendered);
      return rendered;
    }
    const node = { type, props: attrs || {}, children };
    nodes.push(node);
    return node;
  }
});
vm.runInContext(strip(inspectorSource), context);
return {
  nodes,
  listeners,
  context,
  render(props) {
    cursor = 0;
    nodes.length = 0;
    return context.PanelCard(props);
  },
  runEffects() { return effects.map((fn) => fn()); }
  };
}

function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  (node.children || []).forEach((child) => walk(child, out));
  return out;
}
const classOf = (node) => String((node.props && node.props.class) || '');
const findByClass = (tree, cls) => walk(tree).filter((n) => classOf(n).split(/\s+/).includes(cls));

const baseCardProps = {
  id: 'styles',
  label: 'Styles',
  isVisible: true,
  onToggle: () => {},
  onFullscreen: () => {}
};

{
  const harness = createHarness();
  const tree = harness.render(baseCardProps);
  check('the header no longer prints the panel name',
    findByClass(tree, 'inspector__panel-label').length === 0);
  check('the header carries the full-screen button in that slot',
    findByClass(tree, 'inspector__panel-fs').length === 1);
  check('the button is a real button', findByClass(tree, 'inspector__panel-fs')[0].type === 'button');
  const button = findByClass(tree, 'inspector__panel-fs')[0];
  check('the button names the panel it expands',
    /Open Styles full screen/.test(button.props['aria-label'])
    && /Open Styles full screen/.test(button.props.title),
    button.props['aria-label']);
  check('an unfocused card is not marked full screen',
    findByClass(tree, 'inspector__panel--fullscreen').length === 0);
}

{
  // The tap. `onFullscreen` is the card's own handler, supplied by the Inspector
  // (the overlay mode for four panels, the Preview overlay for the fifth).
  let calls = 0;
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseCardProps, { onFullscreen: () => { calls++; } }));
  findByClass(tree, 'inspector__panel-fs')[0].props.onClick({ stopPropagation: () => {} });
  check('tapping the button asks the card to expand', calls === 1);
}

{
  // Focused: the same button is the way back out, and it says so.
  const harness = createHarness();
  const tree = harness.render(Object.assign({}, baseCardProps, { focused: true }));
  const button = findByClass(tree, 'inspector__panel-fs')[0];
  check('a focused card is marked full screen',
    findByClass(tree, 'inspector__panel--fullscreen').length === 1);
  check('the button then offers the exit',
    /Exit full screen/.test(button.props['aria-label'])
    && /Exit full screen/.test(button.props.title),
    button.props['aria-label']);
  check('the button shows the focused state', classOf(button).includes('is-on'));
}

{
  // Escape. Not useModal (the surface is not a modal sheet), so the handler is
  // registered on `document` in the bubble phase. EscapeToExit is asserted on
  // its own because that is where the listener lives; the surface's single mount
  // of it is asserted below, and "exactly one" is the point — two listeners
  // would call the toggle twice and leave the mode exactly as it was.
  let exits = 0;
  const harness = createHarness();
  const tree = harness.render(baseCardProps);
  check('the card itself registers no key handler', (harness.listeners.keydown || []).length === 0);
  const escapeNode = harness.context.EscapeToExit({ onExit: () => { exits++; } });
  check('EscapeToExit renders nothing', escapeNode === null);
  const cleanups = harness.runEffects();
  check('one document keydown listener is registered', (harness.listeners.keydown || []).length === 1);
  const [onKeyDown] = harness.listeners.keydown || [];
  if (onKeyDown) {
    onKeyDown({ key: 'a' });
    check('another key does not leave full screen', exits === 0);
    onKeyDown({ key: 'Escape' });
    check('Escape leaves full screen', exits === 1);
    // A sheet opened from inside the surface handles the key first; it stops it
    // there, and the surface must not close under the sheet.
    onKeyDown({ key: 'Escape', defaultPrevented: true });
    check('an Escape a sheet has already handled is left alone', exits === 1);
  }
  cleanups.forEach((fn) => { if (typeof fn === 'function') fn(); });
  check('the key listener is removed on unmount', (harness.listeners.removed || 0) === 1);
}

// ---- B. The wiring in InspectorView --------------------------------------

check('the Inspector holds the focused panel id',
  /const \[focusPanelId, setFocusPanelId\] = useState\(''\)/.test(inspectorSource));
check('the header button toggles the card mode for four panels',
  /onFullscreen: id === 'preview'[\s\S]{0,220}: \(\) => togglePanelFullscreen\(id\)/.test(inspectorSource));
check('Preview keeps its own viewport-spanning overlay',
  /if \(previewFullscreenRef\.current\) previewFullscreenRef\.current\(\)/.test(inspectorSource)
  && /onFullscreen: id === 'preview'/.test(inspectorSource));
check('the mode is a single state write, not a scroll choreography',
  /function togglePanelFullscreen\(id\) \{\s*\n\s*setFocusPanelId\(\(prev\) => \(prev === id \? '' : id\)\)/.test(inspectorSource));
check('the focused card is handed the leftover height',
  /focused: focusPanelId === id/.test(inspectorSource)
  && /grow: idx === 0/.test(inspectorSource));

// The surface. It has to be a *second* mount at the document root: the in-flow
// panel bodies own scrollers and scroll offsets that cannot be moved between two
// places, and the same panel is meant to be untouched underneath.
check('the surface is portalled to the document root',
  /createPortal\(/.test(inspectorSource) && /class: 'inspector__fs'/.test(inspectorSource));
check('the surface renders a second card for the focused panel',
  /key: 'fs-' \+ focusPanelId/.test(inspectorSource));
check('the surface is a dialog and is announced as one',
  /role: 'dialog'/.test(inspectorSource) && /'aria-modal': 'true'/.test(inspectorSource));

// Leaving. Every path that ends the session it belongs to has to drop the mode,
// or the next render carries a full-screen panel into a screen it does not
// belong to.
check('hiding the focused panel ends full screen',
  /if \(focusPanelId === id\) setFocusPanelId\(''\)/.test(inspectorSource));
check('detaching the target ends full screen',
  /if \(focusPanelId\) exitPanelFullscreen\(\)/.test(inspectorSource));
check('a hidden panel can never stay the focused one',
  /if \(focusPanelId && !visiblePanels\.has\(focusPanelId\)\) setFocusPanelId\(''\)/.test(inspectorSource));
check('the Preview overlay takes over from the card mode',
  /fullscreenOverlayRef\.current\.open && focusPanelId/.test(inspectorSource));
check('the card mode is deliberately not persisted',
  !/localStorage[\s\S]{0,80}focusPanelId/.test(inspectorSource)
  && !/focusPanelId[\s\S]{0,80}localStorage/.test(inspectorSource));

// The Preview panel publishes whether *its* overlay is open. Without it the card
// mode cannot know that the overlay has taken over the screen.
const previewSource = strip(read('frontend/src/components/inspector/PreviewPanel.jsx'));
check('the Preview panel publishes its overlay state',
  /props\.fullscreenOpenRef\.current\.open = fullscreen/.test(previewSource));
check('the Inspector reads that ref',
  /const fullscreenOverlayRef = useRef\(\{ open: false \}\)/.test(inspectorSource)
  && /fullscreenOpenRef: fullscreenOverlayRef/.test(inspectorSource));

// The overlay header's identity. The panel seeds `liveUrl`/`liveTitle` from
// CDP navigation events, which never fire for a page that is *already loaded*
// when the Inspector attaches — so a connect to a running tab used to leave the
// header on its raw-URL fallback (the title slot printed `https://…`, not the
// page's `document.title`) with an empty host subtitle. The attached target
// already carries both values, so the Inspector passes them down and the panel
// seeds from them once.
check('the Inspector passes the attached page identity to the Preview panel',
  /pageUrl: currentTarget && currentTarget\.url/.test(inspectorSource)
  && /pageTitle: currentTarget && currentTarget\.title/.test(inspectorSource));
check('the Preview panel seeds its header identity from those props once',
  /seededIdentityRef\.current/.test(previewSource)
  && /props\.pageUrl/.test(previewSource)
  && /setLiveTitle\(title\)/.test(previewSource));
check('the seed cannot stomp a fresher navigation-reported URL',
  /if \(url && url !== liveUrlRef\.current\)/.test(previewSource));
// The title read races the new document on Page.frameNavigated (which Chrome
// emits before the document is ready), so the load-complete event re-reads it.
check('a load-complete capture re-reads document.title',
  /Page\.frameStoppedLoading[\s\S]{0,500}refreshPageTitle\(liveUrlRef\.current\)/
  .test(previewSource));

// ---- C. The CSS contract --------------------------------------------------

check('the full-screen part is imported last',
  /@import '\.\/inspector-styles\.css';\s*\n@import '\.\/inspector-fullscreen\.css';/
  .test(fs.readFileSync(path.join(root, 'frontend/src/inspector.css'), 'utf8')));

const surface = ruleBody('.inspector__fs');
check('the surface rule is found', !!surface);
check('the surface covers the viewport',
  /position:\s*fixed/.test(surface || '') && /inset:\s*0/.test(surface || ''));
check('the surface sits at the app\'s top modal band',
  /z-index:\s*90/.test(surface || ''));
check('the surface pads the safe-area insets itself',
  /padding:\s*var\(--safe-top/.test(surface || ''));

// Fill mode: the panel bodies are `flex: 0 0 auto` with a dvh height in the
// stacked layout, and none of those may win here or the surface is no bigger
// than the card it replaced.
check('the panel bodies fill the surface instead of keeping their dvh height',
  /\.inspector__fs \.inspector__panel-body \.inspector__scroller,/.test(cssNoComments)
  && /\.inspector__fs \.inspector__panel-body \.inspector__styles \{/.test(cssNoComments));
const fillRule = /\.inspector__fs \.inspector__panel-body \.inspector__scroller,[\s\S]*?\{([^}]*)\}/.exec(cssNoComments);
check('the fill rule drops the fixed height',
  !!fillRule && /flex:\s*1 1 auto/.test(fillRule[1]) && /height:\s*auto/.test(fillRule[1]),
  fillRule && fillRule[1]);
check('the Styles scroller\'s own ceiling is lifted inside the surface',
  /\.inspector__fs \.inspector__panel--grow \.inspector__panel-body \.inspector__styles \{\s*\n?max-height:\s*none/.test(cssNoComments));

// The header button is a full tap target, like every other control in that row.
const fsButton = ruleBody('.inspector__panel-fs');
check('the header button rule is found', !!fsButton);
check('the header button keeps the 44 px tap minimum',
  /min-width:\s*var\(--tap\)/.test(fsButton || '') && /min-height:\s*var\(--tap\)/.test(fsButton || ''));
check('the header button is disabled rather than tappable when the panel is hidden',
  /disabled: !isVisible/.test(inspectorSource));
check('the header button is glyph-only with an accessible name',
  /'aria-label': props\.focused/.test(inspectorSource) && /title: props\.focused/.test(inspectorSource));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' full-screen assertion(s) failed');
