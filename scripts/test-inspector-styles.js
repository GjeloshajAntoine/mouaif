'use strict';
// Test for the Inspector Styles panel CDP wiring in events.js.
//
// The Styles panel inspects an element via Runtime (elementFromPoint /
// querySelector + callFunctionOn) and edits its inline style via
// Runtime.callFunctionOn. These are live CDP round-trips; we can't drive a
// real Chrome here, so we mock cdpSend (the CDP command dispatcher) and assert
// that the helper functions issue the exact commands the Styles panel depends
// on. This is a regression guard: a renamed domain method or a wrong arguments
// shape would silently break tap-to-select or live CSS editing on a device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/events.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
// events.js imports the pure matched-rules normalizer. Its import line is
// stripped above, so load the module into the same vm context first — the
// same way the panel composes the two files at runtime.
const matchedRulesSource = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/matchedRules.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

// A mock cdpSend that records each (method, params) call and returns canned
// responses per method. `respond` lets the test drive command output.
function makeState() {
  const calls = [];
  const respond = new Map();
  const state = {
    consoleEntries: { current: [] },
    networkEntries: { current: [] },
    reqMap: new Map(),
    consoleVL: { current: null },
    networkVL: { current: null },
    consoleCountRef: { current: null },
    networkCountRef: { current: null },
    rerender: () => {},
    cdpSend: (method, params) => {
      calls.push({ method, params });
      if (respond.has(method)) return respond.get(method)(params);
      return Promise.resolve({});
    }
  };
  return { calls, respond, state };
}

// The model read back from Runtime.callFunctionOn for a single element. Kept
// as a function so callFunctionOn returns the same model regardless of which
// element was selected.
function modelValue() {
  return {
    tag: 'DIV', id: 'hero', className: 'card',
    inline: [['color', 'red'], ['font-size', '16px']],
    computed: [['color', 'rgb(255,0,0)'], ['margin', '0px']],
    width: 373.5, height: 40
  };
}

async function main() {
  const { calls, respond, state } = makeState();

  respond.set('Runtime.evaluate', (p) => {
    // elementFromPoint is the tap-to-select path; querySelector is the
    // selector path. Both return an object (returnByValue: false).
    return Promise.resolve({ result: { type: 'object', subtype: 'node', objectId: 'obj-1', description: 'div#hero.card' } });
  });
  respond.set('Runtime.callFunctionOn', (p) => {
  // The model builder reads the element; the edit helpers call setProperty /
  // removeProperty. Return the model for reads and an ok result for edits.
  if (/setProperty|removeProperty/.test(p.functionDeclaration)) return Promise.resolve({ result: { value: { ok: true } } });
  // The pinned-preview read centres the element and reports its box.
  if (/scrollIntoView/.test(p.functionDeclaration)) {
  return Promise.resolve({ result: { value: { x: 20, y: 480, width: 200, height: 100, sx: 0, sy: 400, dpr: 1 } } });
  }
  return Promise.resolve({ result: { value: modelValue() } });
  });
  // DOM.requestNode may or may not yield a usable nodeId; here it does.
  respond.set('DOM.requestNode', () => Promise.resolve({ nodeId: 17 }));
  respond.set('Overlay.highlightNode', () => Promise.resolve({}));
  // Page.captureScreenshot is used by the pinned element preview: the clip
  // must be a padded box around the element and the response data is what the
  // panel renders.
  respond.set('Page.captureScreenshot', (p) => Promise.resolve({ data: 'BASE64PNG' }));

  const context = vm.createContext({ state, console: null });
  vm.runInContext(matchedRulesSource, context);
  vm.runInContext(source, context);
  const handlers = context.createEventHandlers(state);

  // pickNodeAt — viewportCoords evaluate + elementFromPoint + model build.
  const model = await handlers.pickNodeAt(100, 200);
  assert.ok(model, 'pickNodeAt returns a model');
  assert.strictEqual(model.objectId, 'obj-1');
  assert.strictEqual(model.inlineProps.length, 2);
  assert.strictEqual(model.inlineProps[0].prop, 'color');
  assert.strictEqual(model.inlineProps[0].value, 'red');
  assert.strictEqual(model.computed.length, 2);
  assert.strictEqual(model.computed[1].prop, 'margin');
  assert.ok(model.box, 'box model present');
  assert.strictEqual(model.box.width, 373.5);

  // Confirm the command sequence: viewportCoords evaluate, elementFromPoint
  // evaluate, model callFunctionOn, requestNode + highlight.
  assert.ok(calls.some((c) => c.method === 'Runtime.evaluate' && /elementFromPoint/.test(c.params.expression)),
    'elementFromPoint evaluated for tap-to-select');
  assert.ok(calls.some((c) => c.method === 'Runtime.callFunctionOn' && c.params.objectId === 'obj-1'),
    'model built via callFunctionOn on the element objectId');
  assert.ok(calls.some((c) => c.method === 'DOM.requestNode' && c.params.objectId === 'obj-1'),
    'requestNode called to resolve a nodeId for highlight');
  assert.ok(calls.some((c) => c.method === 'Overlay.highlightNode' && c.params.nodeId === 17),
    'highlight applied to the resolved node');

  // setInlineStyleProperty issues Runtime.callFunctionOn with the prop/value args.
  const before = calls.length;
  await handlers.setInlineStyleProperty('obj-1', 'background-color', '#0af');
  const setCall = calls.slice(before).find((c) => c.method === 'Runtime.callFunctionOn' && /setProperty/.test(c.params.functionDeclaration));
  assert.ok(setCall, 'setInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(setCall.params.arguments.map((a) => a.value)), ['background-color', '#0af']);

  // removeInlineStyleProperty passes only the property name.
  const beforeRm = calls.length;
  await handlers.removeInlineStyleProperty('obj-1', 'background-color');
  const rmCall = calls.slice(beforeRm).find((c) => c.method === 'Runtime.callFunctionOn' && /removeProperty/.test(c.params.functionDeclaration));
  assert.ok(rmCall, 'removeInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(rmCall.params.arguments.map((a) => a.value)), ['background-color']);

  // selectBySelector uses Runtime.evaluate + querySelector, then model build.
  const selModel = await handlers.selectBySelector('.hero');
  assert.ok(selModel, 'selectBySelector returns a model');
  assert.strictEqual(selModel.objectId, 'obj-1');
  assert.ok(calls.some((c) => c.method === 'Runtime.evaluate' && /querySelector/.test(c.params.expression)),
    'querySelector evaluated for the selector path');

  // captureElementShot — the pinned element preview. It reads a padded box
  // around the (re-centred) element and asks Page.captureScreenshot for that
  // region only, so the panel never downloads a full-page PNG just to show
  // one card.
  const beforeShot = calls.length;
  const shot = await handlers.captureElementShot('obj-1');
  assert.ok(shot, 'captureElementShot returns a shot');
  assert.strictEqual(shot.data, 'BASE64PNG');
  const shotCalls = calls.slice(beforeShot);
  assert.ok(shotCalls.some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(c.params.functionDeclaration)),
    'captureElementShot centres the element before capturing');
  const capCall = shotCalls.find((c) => c.method === 'Page.captureScreenshot');
  assert.ok(capCall, 'captureElementShot dispatches Page.captureScreenshot');
  assert.ok(capCall.params.clip, 'the capture is clipped to the element box');
  assert.strictEqual(capCall.params.clip.x, 4, 'clip is padded from the element box');
  // 480 (viewport y) + 400 (page scrollY) - 16 (padding): the clip is in
  // document coordinates because captureBeyondViewport is on.
  assert.strictEqual(capCall.params.clip.y, 864, 'clip uses document coordinates plus padding');
  assert.strictEqual(capCall.params.clip.width, 232, 'clip width is the box plus padding');
  assert.strictEqual(capCall.params.clip.height, 132, 'clip height is the box plus padding');
  assert.ok(capCall.params.clip.scale > 0, 'clip carries a positive scale');
  // The full-page capture path stays unclipped.
  const beforePlain = calls.length;
  await handlers.captureScreenshot();
  const plainCall = calls.slice(beforePlain).find((c) => c.method === 'Page.captureScreenshot');
  assert.ok(plainCall, 'captureScreenshot still dispatches a capture');
  assert.strictEqual(plainCall.params.clip, undefined, 'the plain capture stays unclipped');
  // An element larger than the context window is captured as a centred
  // window instead of its whole (potentially huge) box.
  respond.set('Runtime.callFunctionOn', (p) => {
    if (/scrollIntoView/.test(p.functionDeclaration)) return Promise.resolve({ result: { value: { x: 0, y: 0, width: 2000, height: 3000, sx: 0, sy: 0, dpr: 1 } } });
    return Promise.resolve({ result: { value: modelValue() } });
  });
  const beforeWindow = calls.length;
  const windowed = await handlers.captureElementShot('obj-1');
  const windowClip = calls.slice(beforeWindow).find((c) => c.method === 'Page.captureScreenshot').params.clip;
  assert.strictEqual(windowClip.width, 520, 'a large element is clipped to the context window');
  assert.strictEqual(windowClip.height, 360, 'a large element is clipped to the context window');
  assert.strictEqual(windowClip.x, 740, 'the context window is centred on the element');
  assert.strictEqual(windowClip.y, 1320, 'the context window is centred on the element');
  assert.ok(windowed.width <= 1040, 'the captured image stays small');
  // readElementStyles — the post-edit sync. It returns the element's own
  // inline properties AND their resolved values in one round-trip, so the
  // panel can refresh a hoisted "changed" row with the value just applied
  // (a highlighted row showing the previous value would be worse than none).
  respond.set('Runtime.callFunctionOn', (p) => {
    if (/style\.item\(i\)/.test(p.functionDeclaration)) {
      return Promise.resolve({ result: { value: {
        inline: { 'margin-left': '60px' },
        computed: { 'margin-left': '60px', 'padding-top': '14px' }
      } } });
    }
    return Promise.resolve({ result: { value: modelValue() } });
  });
  const styles = await handlers.readElementStyles('obj-1');
  assert.ok(styles, 'readElementStyles returns a snapshot');
  assert.strictEqual(styles.inline['margin-left'], '60px', 'the inline value is reported');
  assert.strictEqual(styles.computed['padding-top'], '14px', 'the resolved values are reported');
  const readCall = calls.slice(-3).find((c) => c.method === 'Runtime.callFunctionOn' && /style\.item\(i\)/.test(c.params.functionDeclaration));
  assert.ok(readCall, 'readElementStyles dispatches one callFunctionOn');
  assert.strictEqual(readCall.params.objectId, 'obj-1', 'the read targets the selected element');
  assert.strictEqual(await handlers.readElementStyles(null), null, 'no objectId yields no snapshot');

  // A degenerate box (display:none / detached) must not produce a capture.
  respond.set('Runtime.callFunctionOn', (p) => {
    if (/scrollIntoView/.test(p.functionDeclaration)) return Promise.resolve({ result: { value: { x: 0, y: 0, width: 0, height: 0 } } });
    return Promise.resolve({ result: { value: modelValue() } });
  });
  const empty = await handlers.captureElementShot('obj-1');
  assert.strictEqual(empty, null, 'a zero-size element yields no shot');

  // Element tree navigation — readElementTree / selectAncestorNode /
  // selectChildNode. Walking the DOM from the selected element is what makes
  // the Styles panel usable on a phone: re-picking on the live preview for
  // every parent or child is the slowest possible way to move one level, and
  // overlapping elements make it unreliable. The guards here are that the
  // ancestor read reports real parent-hop counts (the panel hands one back to
  // move up), that the caps are applied, and that a step returns a complete
  // node model — not a bare objectId — so the panel adopts it exactly like a
  // fresh pick.
  respond.set('Runtime.callFunctionOn', (p) => {
    if (/return \{ ancestors: anc/.test(p.functionDeclaration)) {
      return Promise.resolve({ result: { value: {
        ancestors: [{ label: 'main#app', levels: 1 }, { label: 'body', levels: 2 }],
        children: [{ label: 'span.count' }, { label: 'a' }],
        childCount: 5,
        label: 'div#hero.card'
      } } });
    }
    if (/e=e\.parentElement/.test(p.functionDeclaration)) return Promise.resolve({ result: { objectId: 'obj-parent' } });
    if (/k\[i\] \|\| null/.test(p.functionDeclaration)) return Promise.resolve({ result: { objectId: 'obj-kid' } });
    return Promise.resolve({ result: { value: modelValue() } });
  });

  const tree = await handlers.readElementTree('obj-1');
  assert.ok(tree, 'readElementTree returns a tree');
  assert.strictEqual(tree.ancestors.length, 2, 'ancestors are reported nearest-first');
  assert.strictEqual(tree.ancestors[0].label, 'main#app', 'each ancestor carries a tag#id.class label');
  assert.strictEqual(tree.ancestors[1].levels, 2, 'each ancestor carries the parent hops needed to reach it');
  assert.strictEqual(tree.children.length, 2, 'direct children are reported for the child chips');
  assert.strictEqual(tree.childCount, 5, 'the real child count is reported so the panel can show what was left off');
  const treeCall = calls.slice(-1).find((c) => /return \{ ancestors: anc/.test(c.params.functionDeclaration));
  assert.ok(treeCall, 'readElementTree dispatches one callFunctionOn');
  assert.strictEqual(treeCall.params.objectId, 'obj-1', 'the tree read targets the selected element');
  assert.strictEqual(treeCall.params.returnByValue, true, 'the tree read is by value — no objectId is leaked for a label');
  // The caps are inlined into the in-page function, and they are the reason a
  // wide subtree cannot flood the panel. Children are capped tighter than
  // ancestors because the child chips wrap instead of scrolling sideways, so N
  // children are N/wrapped lines of chips rather than a hidden strip.
  assert.match(treeCall.params.functionDeclaration, /lv<=8/, 'ancestors are capped at 8 in the in-page read');
  assert.match(treeCall.params.functionDeclaration, /i<6/, 'children are capped at 6 in the in-page read');
  assert.ok(/var anc=\[\],n=this\.parentElement/.test(treeCall.params.functionDeclaration),
    'the read walks up from the element and counts hops for each ancestor');
  assert.strictEqual(await handlers.readElementTree(null), null, 'no objectId yields no tree');

  const beforeUp = calls.length;
  const up = await handlers.selectAncestorNode('obj-1', 2);
  assert.ok(up, 'selectAncestorNode returns a model');
  assert.strictEqual(up.objectId, 'obj-parent', 'the step up is described as a full node model');
  assert.strictEqual(up.inlineProps.length, 2, 'the stepped-to element gets the same model as a pick');
  const hopCall = calls.slice(beforeUp).find((c) => /e=e\.parentElement/.test(c.params.functionDeclaration));
  assert.ok(hopCall, 'selectAncestorNode dispatches one callFunctionOn');
  assert.deepStrictEqual(Array.from(hopCall.params.arguments.map((a) => a.value)), [2], 'the hop count is passed as an argument');
  assert.strictEqual(hopCall.params.returnByValue, false, 'the step up resolves a real element objectId');
  const beforeClamp = calls.length;
  await handlers.selectAncestorNode('obj-1', 99);
  const clampCall = calls.slice(beforeClamp).find((c) => /e=e\.parentElement/.test(c.params.functionDeclaration));
  assert.deepStrictEqual(Array.from(clampCall.params.arguments.map((a) => a.value)), [8], 'the hop count is clamped to the ancestor cap');

  const beforeDown = calls.length;
  const down = await handlers.selectChildNode('obj-1', 1);
  assert.ok(down, 'selectChildNode returns a model');
  assert.strictEqual(down.objectId, 'obj-kid', 'the step down is described as a full node model');
  const kidCall = calls.slice(beforeDown).find((c) => /k\[i\] \|\| null/.test(c.params.functionDeclaration));
  assert.ok(kidCall, 'selectChildNode dispatches one callFunctionOn');
  assert.deepStrictEqual(Array.from(kidCall.params.arguments.map((a) => a.value)), [1], 'the child index is passed as an argument');
  const beforeNeg = calls.length;
  await handlers.selectChildNode('obj-1', -3);
  const negCall = calls.slice(beforeNeg).find((c) => /k\[i\] \|\| null/.test(c.params.functionDeclaration));
  assert.deepStrictEqual(Array.from(negCall.params.arguments.map((a) => a.value)), [0], 'a negative child index clamps to the first child');

  // Matched rules — the read-only cascade. CSS.getMatchedStylesForNode is the
  // accurate source and needs a nodeId, so the guard that matters is that the
  // helper resolves one, asks the CSS domain, and normalizes the answer into
  // the panel's ordered list. `requestNodeId` returning 0 must fall through to
  // the in-page scan rather than leaving the section empty — that is the
  // difference between "no rules matched" and "this target can't be asked".
  respond.set('CSS.getMatchedStylesForNode', () => Promise.resolve({
    inlineStyle: { cssProperties: [{ name: 'color', value: 'red' }] },
    matchedCSSRules: [
      { rule: { selectorList: { selectors: [{ text: 'body' }] }, origin: 'regular', style: { cssProperties: [{ name: 'margin', value: '0' }] } } },
      { rule: { selectorList: { selectors: [{ text: '.card' }] }, origin: 'regular', style: { cssProperties: [{ name: 'padding', value: '10px' }] } } }
    ],
    inherited: []
  }));
  const rules = await handlers.readMatchedRules('obj-1');
  assert.ok(rules, 'readMatchedRules returns a model');
  const cssCall = calls.slice(-6).find((c) => c.method === 'CSS.getMatchedStylesForNode');
  assert.ok(cssCall, 'readMatchedRules asks the CSS domain for the cascade');
  assert.strictEqual(cssCall.params.nodeId, 17, 'the CSS read uses the nodeId resolved from the element objectId');
  assert.deepStrictEqual(Array.from(rules.rules, (r) => r.selector), ['element.style', '.card', 'body'],
    'element.style first, then the matched rules most specific first');
  assert.strictEqual(rules.rules[0].group, 'author', 'element.style is not a UA rule');
  assert.deepStrictEqual({ ...rules.counts }, { total: 3, author: 3, userAgent: 0 }, 'the counts describe the whole cascade');
  assert.strictEqual(rules.truncated, 0, 'a small cascade is not truncated');
  const scanCall = () => calls.slice(-8).find((c) => c.method === 'Runtime.callFunctionOn' && /document\.styleSheets/.test(c.params.functionDeclaration));
  assert.strictEqual(scanCall(), undefined, 'the in-page scan is not used while the CSS domain answers');

  // With no nodeId the CSS domain is unusable, so the panel tries the DOM
  // domain's own resolution path (a unique selector + DOM.querySelector)
  // before falling back to the in-page scan. `DOM.requestNode` answering 0 is
  // a real Chrome behaviour on some targets, and without this second attempt
  // the accurate cascade would silently degrade to the scan on exactly those
  // targets — which is how this was found: the fixture used to verify the
  // section reported no browser-default rules at all.
  respond.set('DOM.requestNode', () => Promise.resolve({ nodeId: 0 }));
  respond.set('Runtime.callFunctionOn', (p) => {
    if (p.functionDeclaration && /previousElementSibling/.test(p.functionDeclaration)) {
      return Promise.resolve({ result: { value: 'body > main#app > div.card:nth-of-type(2)' } });
    }
    if (/document\.styleSheets/.test(p.functionDeclaration)) {
      return Promise.resolve({ result: { value: {
        inlineStyle: { cssProperties: [] },
        matchedCSSRules: [{ rule: { selectorList: { selectors: [{ text: '.scanned' }] }, origin: 'regular', style: { cssProperties: [{ name: 'color', value: 'blue' }] } } }],
        inherited: []
      } } });
    }
    return Promise.resolve({ result: { value: modelValue() } });
  });
  respond.set('DOM.getDocument', () => Promise.resolve({ root: { nodeId: 1 } }));
  respond.set('DOM.querySelector', (p) => {
    if (p.selector === 'body > main#app > div.card:nth-of-type(2)') return Promise.resolve({ nodeId: 42 });
    return Promise.resolve({ nodeId: 0 });
  });
  const beforePath = calls.length;
  const viaPath = await handlers.readMatchedRules('obj-1');
  assert.ok(calls.slice(beforePath).some((c) => c.method === 'Runtime.callFunctionOn' && /previousElementSibling/.test(c.params.functionDeclaration)),
    'without a requestNode nodeId the helper builds a CSS selector path for the element');
  const docCall = calls.slice(beforePath).find((c) => c.method === 'DOM.getDocument');
  assert.ok(docCall, 'the selector is resolved against the document root');
  assert.strictEqual(docCall.params.depth, 0, 'the document is read shallow — only the root nodeId is needed');
  const qCall = calls.slice(beforePath).find((c) => c.method === 'DOM.querySelector');
  assert.ok(qCall, 'DOM.querySelector resolves the element from the built selector');
  assert.strictEqual(qCall.params.nodeId, 1, 'the query starts at the document root');
  const cssViaPath = calls.slice(beforePath).find((c) => c.method === 'CSS.getMatchedStylesForNode');
  assert.ok(cssViaPath, 'the CSS domain is asked once a nodeId was found');
  assert.strictEqual(cssViaPath.params.nodeId, 42, 'the CSS read uses the nodeId resolved through the DOM domain');
  assert.strictEqual(calls.slice(beforePath).filter((c) => /document\.styleSheets/.test(c.params.functionDeclaration)).length, 0,
    'the scan does not run once the DOM-domain resolution produced a nodeId');

  // With no nodeId at all, the scan fallback carries the section instead of
  // reporting an empty cascade.
  respond.set('DOM.getDocument', () => Promise.resolve({ root: { nodeId: 0 } }));
  const beforeScan = calls.length;
  const scanned = await handlers.readMatchedRules('obj-1');
  assert.deepStrictEqual(Array.from(scanned.rules, (r) => r.selector), ['.scanned'],
    'without a nodeId the in-page scan supplies the cascade');
  assert.ok(scanCall(), 'the scan runs as a callFunctionOn on the element');
  const scanParams = calls.slice(beforeScan).find((c) => /document\.styleSheets/.test(c.params.functionDeclaration));
  assert.strictEqual(scanParams.params.objectId, 'obj-1', 'the scan targets the selected element');
  assert.strictEqual(scanParams.params.returnByValue, true, 'the scan is by value — the panel only needs the description');
  assert.strictEqual(await handlers.readMatchedRules(null), null, 'no objectId yields no cascade');
  respond.set('DOM.requestNode', () => Promise.resolve({ nodeId: 17 }));
  respond.set('DOM.getDocument', () => Promise.resolve({ root: { nodeId: 1 } }));

  // --- the panel must not become a sideways page -----------------------
  // This is a UI invariant, not a detail: the Styles panel sits inside the
  // page's vertical scroller, so an accidental horizontal scroller in it hides
  // its own content and drags the panel sideways on a slightly diagonal swipe —
  // which is exactly how a long list gets scrolled on a phone. The quick-add
  // chips, the breadcrumb and the child chips each had one by accident and each
  // was removed in favour of wrapping. The breadcrumb has one *on purpose* now
  // (a deep path wrapped into three or four 44 px lines), so it is checked
  // separately below: it is one line that scrolls sideways with its vertical
  // axis pinned, never a wrapping row that happens to scroll.
  // The Inspector CSS lives in per-panel parts behind frontend/src/inspector.css;
  // the helper inlines the @imports so the rule checks see the whole cascade.
  const { readInspectorCss } = require('./inspector-css.js');
  const css = readInspectorCss();
  const panelCss = readInspectorCss();
  const H_SCROLL_CLASSES = [
    'inspector__styles-add',
    'inspector__styles-kids',
    'inspector__styles',
    'inspector__styles-list',
    'inspector__styles-section',
    'inspector__computed-bar',
    'inspector__computed-searchrow',
    'inspector__rules-bar'
  ];
  // Each rule is attributed to the *subject* of its rightmost compound selector
  // — the element the declaration actually applies to — rather than to whichever
  // guarded class its selector text happens to mention first. The looser match
  // read `.inspector__styles-tree-row--parents .inspector__styles-crumbs { ... }`
  // as a rule about `.inspector__styles`, so a scroller on the breadcrumb strip
  // was reported as the panel itself scrolling sideways.
  const cssRules = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const last = part.trim().split(/[\s>+~]+/).pop() || '';
      cssRules.push({
        selector: part.trim(),
        classes: (last.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1)),
        body: m[2]
      });
    }
  }
  for (const cls of H_SCROLL_CLASSES) {
    for (const rule of cssRules.filter((r) => r.classes.includes(cls))) {
      const overflowX = /overflow-x:\s*([a-z]+)/.exec(rule.body);
      if (overflowX) {
        assert.ok(overflowX[1] === 'hidden' || overflowX[1] === 'clip',
          '.' + cls + ' must not scroll horizontally (found overflow-x: ' + overflowX[1]
          + ' on "' + rule.selector + '")');
      }
      assert.ok(!/overflow-y:\s*(auto|scroll)/.test(rule.body) || /overflow-x:\s*(hidden|clip)/.test(rule.body),
        '.' + cls + ' sets overflow-y without pinning overflow-x — the computed overflow-x becomes auto and the panel can be dragged sideways ("'
        + rule.selector + '")');
    }
  }

  // The breadcrumb is the one intended horizontal scroller in the panel: the
  // Parents row is a single line, so a deep path is bounded instead of wrapping
  // into several 44 px lines above the property list. Three things make it safe
  // — it pins its own vertical axis (overflow-y must not be auto, or the row
  // swallows the panel's own vertical swipe), it is scrolled to its end by the
  // panel so the current element is the chip on screen, and the child chips stay
  // wrapped (a disclosure, not a path).
  const parentsRow = /\.inspector__styles-tree-row--parents\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(parentsRow, 'the Parents row has its own rule');
  assert.match(parentsRow[1], /display:\s*flex/,
    'the Parents row puts its label and its path on one line');
  const crumbStrip = /\.inspector__styles-tree-row--parents \.inspector__styles-crumbs\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(crumbStrip, 'the breadcrumb strip has a rule scoped to the Parents row');
  assert.match(crumbStrip[1], /overflow-x:\s*auto/, 'the breadcrumb scrolls sideways');
  assert.match(crumbStrip[1], /overflow-y:\s*hidden/,
    'the breadcrumb pins its vertical axis, so a vertical swipe still scrolls the property list');
  assert.match(crumbStrip[1], /flex-wrap:\s*nowrap/, 'the breadcrumb never wraps to a second line');
  const plainCrumbs = cssRules.find((r) => r.selector === '.inspector__styles-crumbs');
  assert.ok(plainCrumbs, 'the breadcrumb base rule still exists');
  assert.ok(!/overflow-x:\s*(auto|scroll)/.test(plainCrumbs.body),
    'the base breadcrumb rule does not scroll — only the Parents row does');
  const panelJsx = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
  assert.ok(/crumbsRef/.test(panelJsx) && /strip\.scrollLeft = strip\.scrollWidth/.test(panelJsx),
    'the panel scrolls the breadcrumb to its end, so the current element is the chip in view');
  assert.ok(/inspector__styles-tree-row--parents/.test(panelJsx),
    'the Parents row renders with that modifier');
  const kidsRule = /\.inspector__styles-kids\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(kidsRule && /flex-wrap:\s*wrap/.test(kidsRule[1]),
    'the child chips still wrap');

  // --- tap targets: a row that *looks* 44 px must *be* 44 px ------------
  // The declared-styles row is a 44 px card whose button sat at its own 18 px
  // text height, so most of the row did nothing when tapped — the worst kind
  // of tap target, because it looks fine. The button must stretch to the row's
  // full height, and the row must account for its own border.
  assert.ok(/align-self:\s*stretch/.test(panelCss),
    '.inspector__styles-row-main stretches to fill the row, so the whole row is tappable');
  const rowRule = /\.inspector__styles-row\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(rowRule, 'the styles row rule exists');
  assert.match(rowRule[1], /min-height:\s*calc\(var\(--tap\)\s*\+\s*2px\)/,
    'the row is --tap plus its 2 px of border, so the stretched button inside is a true 44 px target');
  assert.ok(!/padding:\s*\d+px\s+\d+px/.test(rowRule[1]),
  'the row carries no vertical padding — padding shrinks the tappable area while the row still looks full height');
  // The computed list is read-only apart from the rows changed in this session:
  // those open the value sheet, so they take the interactive 44 px row back while
  // the other ~400 stay compact. If the exception rule ever stops outweighing the
  // compact rule (or the hairline separator), a changed row silently drops back to
  // a 3 px strip that looks tappable and is not.
  const compactComputed = /\.inspector__styles-row--computed\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(compactComputed, 'the compact computed-row rule exists');
  assert.match(compactComputed[1], /min-height:\s*0/,
  'the plain computed row stays below the interactive minimum');
  const changedComputed = /\.inspector__styles-list--computed > li \.inspector__styles-row--computed\.inspector__styles-row--changed\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(changedComputed, 'a changed computed row has its own rule');
  assert.match(changedComputed[1], /min-height:\s*calc\(var\(--tap\)\s*\+\s*2px\)/,
  'a changed computed row is a full 44 px tap target');
  assert.match(changedComputed[1], /border:\s*1px solid var\(--accent\)/,
  'its border is pinned in that rule, so the separators of the rows around it cannot leak in');
  // Chips clip their text on a child span: `text-overflow` does not apply to
  // the anonymous flex item a bare text child becomes, so the label used to
  // overflow the chip's rounded border.
  assert.ok(/\.inspector__styles-kid-label\s*\{[^}]*text-overflow:\s*ellipsis/.test(panelCss),
    'the child chip clips its label on a span, not on the flex button');
  assert.ok(/\.inspector__styles-crumb-label\s*\{[^}]*text-overflow:\s*ellipsis/.test(panelCss),
    'the breadcrumb chip clips its label on a span too');
  const panelSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
  assert.ok(/inspector__styles-kid-label/.test(panelSrc) && /inspector__styles-crumb-label/.test(panelSrc),
  'the panel renders those label spans');
  // A changed computed row is an editor button on the value the page reports now
  // — the only row in that ~400-row read-only list that is interactive.
  assert.ok(/changedRow\s*\?\s*h\('button',\s*\{\s*class: 'inspector__styles-row-main'/.test(panelSrc),
  'only the changed computed row is rendered as a button');
  assert.ok(/onClick: \(\) => setEdit\(\{ prop: row\.prop, value: row\.value \}\)/.test(panelSrc),
  'a changed computed row opens the editor on the value the page reports now');

  // --- the computed filter label never leaves its chips -----------------
  // The label ("Show") explains what the three chips under it do, so it has to
  // travel with them. As siblings in the wrapping bar, the label — pinned right
  // by `margin-left: auto` — stayed on the first row at 360 px while the chips
  // dropped to the next one, so the bar read "COMPUTED 0/406 ... SHOW" with the
  // chips below and the word attached to nothing.
  assert.ok(/inspector__computed-showgroup/.test(panelSrc),
    'the computed Show label and its chips are rendered inside one wrapper');
  const showGroupRule = /\.inspector__computed-showgroup\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(showGroupRule, '.inspector__computed-showgroup has its own rule');
  assert.match(showGroupRule[1], /margin-left:\s*auto/,
    'the wrapper is the item that is pushed to the right edge, not the label');
  const showLabelRule = /\.inspector__computed-show\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(showLabelRule, '.inspector__computed-show has its own rule');
  assert.ok(!/margin-left/.test(showLabelRule[1]),
    '.inspector__computed-show must not push itself away from the chips it labels');

  // --- the cascade section names its controls ---------------------------
  // The section's only two controls read "Show" and "UA", and neither said what
  // it opened or filtered: "UA" is DevTools shorthand for the browser's own
  // stylesheet. The bar's button now names the list it opens, and the
  // browser-defaults toggle moved under the rules it filters with its count
  // spelled out in words — which is also why it cannot live in the 320 px bar
  // next to the heading, the count, and "Show rules".
  assert.ok(/'Hide rules' : 'Show rules'/.test(panelSrc),
    'the matched-rules button says which list it opens');
  assert.ok(/' browser default rule'/.test(panelSrc),
    'the browser-defaults toggle spells out what it reveals');
  assert.ok(/ORIGIN_LABEL\['user-agent'\]/.test(panelSrc),
    'the rule chip uses the shared origin label rather than its own abbreviation');
  const uaRule = /\.inspector__rules-ua\s*\{([^}]*)\}/.exec(panelCss);
  assert.ok(uaRule, '.inspector__rules-ua has its own rule');
  assert.match(uaRule[1], /width:\s*100%/,
    'the browser-defaults toggle owns a full row under the rules it filters');
  assert.ok(!/\.inspector__rules-toggle,\s*\n\.inspector__rules-ua\s*\{/.test(panelCss),
    'the two controls are no longer one shared rule — the toggle is not a bar item');
  assert.match(/\.inspector__rules-bar\s*\{([^}]*)\}/.exec(panelCss)[1], /flex-wrap:\s*wrap/,
    'the rules bar wraps rather than squeezing its labels at 320 px');

  console.log('PASS inspector styles CDP wiring (tap-to-select + selector + inline-style edit + pinned element preview + element tree + matched rules)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
