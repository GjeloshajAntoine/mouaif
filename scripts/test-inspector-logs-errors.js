'use strict';
// Regression test for the Inspector's logs and error display.
//
// The console/network panels and the detail sheet are the only place the
// user sees what a page logged and what it broke. The existing inspector
// tests assert CDP command shapes and panel inventory, not what a row
// *looks like* once a message or a failure lands: that an error console
// row carries the level class the CSS colours, that an exception row is
// expandable and shows its stack, that a failed request is labelled FAIL,
// and that the detail sheet keeps the message and the stack readable.
//
// Each component is executed in a VM with a miniature Preact runtime and a
// fake DOM — the same technique the other inspector tests use — so the
// assertions are about observable rendering, not source regexes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- Fake DOM -----------------------------------------------------------
// Just enough of the Element contract for the panel renderers: className,
// textContent, children, the classList.add the console row renderer uses,
// and replaceChildren. No layout, no attributes beyond what we assert on.
function makeDoc() {
  function el() {
    const node = {
      className: '',
      title: '',
      style: {},
      children: [],
      parentNode: null,
      _text: '',
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      replaceChildren(...kids) { node.children = []; for (const k of kids) node.appendChild(k); },
      classList: { add(name) { node.className = (node.className + ' ' + name).trim(); } }
    };
    Object.defineProperty(node, 'textContent', {
      set(v) { node._text = String(v); node.children = []; },
      get() {
        if (node.children.length) return node.children.map((c) => c.textContent).join(' ');
        return node._text;
      }
    });
    return node;
  }
  return { createElement: () => el(), createTextNode: (t) => { const n = el(); n._text = String(t); return n; } };
}

// ---- Component loader ---------------------------------------------------
// Strip imports/exports (the module under test is a .jsx ES module) and run
// it in a sandbox that supplies only the globals it touches. `capture` is an
// out-param: createVirtualList stashes the render callback it was handed so
// the test can drive a row directly.
function loadComponent(rel, extra = {}) {
  const doc = makeDoc();
  const sandbox = {
    console,
    document: doc,
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    // The panels gate their createVirtualList call on the scroller ref being
    // set (`if (!scroller.current) return`), so a null ref would skip the
    // list entirely. A truthy placeholder lets the effect run; the real DOM
    // node is never touched by the list stub.
    useRef: (initial) => ({ current: initial === null || initial === undefined ? {} : initial }),
    useEffect: (fn) => { fn(); },
    fmtTime: () => '12:00:00',
    fmtBytes: (n) => (typeof n === 'number' ? n + ' B' : ''),
    fmtDur: (ms) => (typeof ms === 'number' ? ms + ' ms' : ''),
    statusLabel: (s) => (s === 'pending' ? '···' : s === 'failed' ? 'FAIL' : String(s)),
    statusClass: (s) => {
      if (s === 'pending') return 'pending';
      if (s === 'failed') return 'failed';
      const n = Number(s);
      if (!isNaN(n) && n >= 400) return 'error';
      if (!isNaN(n) && n >= 300) return 'redirect';
      if (!isNaN(n) && n >= 200) return 'ok';
      return 'other';
    },
    appendRemoteObject: (host, arg) => {
      const s = doc.createElement('span');
      s.textContent = arg && arg.value !== undefined ? arg.value : (arg && (arg.description || arg.type)) || '';
      host.appendChild(s);
    },
    sheetPortal: (x) => x,
    Object, Array, String, Number, JSON, Error, isNaN, Date,
    ...extra
  };
  const ctx = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');
  const exportName = extra.__export;
  vm.runInContext(source + '; this.__component = ' + exportName + ';', ctx);
  return { component: ctx.__component, doc, sandbox };
}

// createVirtualList stub shared by both panels. Records the options object
// so the test can call opts.render(item, node) itself.
function captureList() {
  const box = { opts: null };
  const createVirtualList = (opts) => {
    box.opts = opts;
    return { setData() {}, scrollToIndex() {}, destroy() {}, getData: () => opts.data };
  };
  return { box, createVirtualList };
}

// -------------------------------------------------------------------------
(async () => {
  // ===== 1. Console log rows ============================================
  {
    const { box, createVirtualList } = captureList();
    const { component } = loadComponent('frontend/src/components/inspector/ConsolePanel.jsx', {
      createVirtualList, JsConsole: 'JsConsole', __export: 'ConsolePanel'
    });
    component({ onRowTap: () => {}, onReady: () => {} });
    const render = box.opts.render;

    // A plain log: level class, uppercase level label, message text.
    let node = makeDocElement();
    render({ id: 'c1', level: 'log', ts: 1, text: 'hello', args: [] }, node);
    check('a log row carries its level class',
      node.className.includes('inspector__row--log'), node.className);
    check('a log row renders the message',
      node.textContent.includes('hello'), node.textContent);
    check('a log row shows an uppercase level label',
      node.textContent.includes('LOG'), node.textContent);

    // An error entry is the thing the user must be able to spot: the level
    // class the CSS paints red (`--error`).
    node = makeDocElement();
    render({ id: 'c2', level: 'error', ts: 2, text: 'boom', args: [] }, node);
    check('an error row carries the error class',
      node.className.includes('inspector__row--error'), node.className);
    check('an error row shows ERROR',
      node.textContent.includes('ERROR'), node.textContent);

    // RemoteObject args are rendered individually, not stringified away.
    node = makeDocElement();
    render({ id: 'c3', level: 'log', ts: 3, args: [{ type: 'string', value: 'a' }, { type: 'number', value: 2 }] }, node);
    check('remote-object args are each rendered',
      node.textContent.includes('a') && node.textContent.includes('2'), node.textContent);

    // An exception entry: stack present, so the row is expandable and its
    // meta advertises the stack the detail sheet will show.
    node = makeDocElement();
    render({
      id: 'c4', level: 'error', ts: 4, text: 'Uncaught',
      url: 'http://x/app.js', line: 10,
      stack: '  at f (app.js:10:4)'
    }, node);
    check('an exception row is expandable',
      node.className.includes('inspector__row--expandable'), node.className);
    check('an exception row advertises its stack',
      node.title === 'tap for stack trace', node.title);
    // `meta` is appended inside the row body, not as a direct child.
    const meta = findByClass(node, 'inspector__row-meta');
    check('an exception row shows its source file and line',
    meta && meta.textContent.includes('app.js') && meta.textContent.includes('10'),
    meta && meta.textContent);
    check('an exception row marks the stack in the meta',
      meta && meta.textContent.includes('stack'), meta && meta.textContent);
  }

  // ===== 2. The event handlers build those rows =========================
  {
    const { createEventHandlers } = await import('../frontend/src/components/inspector/events.js');
    const state = () => ({
      consoleEntries: { current: [] }, networkEntries: { current: [] },
      reqMap: { current: new Map() },
      consoleVL: { current: null }, networkVL: { current: null },
      consoleCountRef: { current: null }, networkCountRef: { current: null },
      cdpSend: async () => ({}), onNavigate: () => {}
    });

    const s = state();
    const handlers = createEventHandlers(s);
    handlers.onConsoleEvent({
      type: 'error',
      args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 42 }],
      stackTrace: { callFrames: [{ functionName: 'f', url: 'http://x/a.js', lineNumber: 9, columnNumber: 3 }] }
    });
    const row = s.consoleEntries.current[0];
    check('onConsoleEvent keeps the error level', row.level === 'error', row.level);
    check('onConsoleEvent joins the args as text', row.text === 'boom 42', row.text);
    check('onConsoleEvent keeps the args for the row renderer', row.args.length === 2);
    check('onConsoleEvent converts a 0-based line to 1-based',
      row.line === 10, String(row.line));
    check('onConsoleEvent builds a readable stack',
      /at f \(http:\/\/x\/a\.js:10:4\)/.test(row.stack || ''), row.stack);

    const s2 = state();
    const h2 = createEventHandlers(s2);
    h2.onExceptionEvent({
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', description: 'Error: nope' },
        url: 'http://x/b.js', lineNumber: 4,
        stackTrace: { callFrames: [{ functionName: 'g', url: 'http://x/b.js', lineNumber: 4, columnNumber: 0 }] }
      }
    });
    const ex = s2.consoleEntries.current[0];
    check('onExceptionEvent is an error-kind entry',
      ex.kind === 'exception' && ex.level === 'error', ex.kind + '/' + ex.level);
    check('onExceptionEvent prefers the exception description',
      ex.text === 'Error: nope', ex.text);
    check('onExceptionEvent records source url and 1-based line',
      ex.url === 'http://x/b.js' && ex.line === 5, ex.url + ':' + ex.line);
    check('onExceptionEvent keeps the exception as a remote object',
      ex.args.length === 1 && ex.args[0].type === 'object');
  }

  // ===== 3. The editable JS console reports errors, not silence =========
  {
    const { createEventHandlers } = await import('../frontend/src/components/inspector/events.js');
    const state = (send) => ({
      consoleEntries: { current: [] }, networkEntries: { current: [] },
      reqMap: { current: new Map() },
      consoleVL: { current: null }, networkVL: { current: null },
      cdpSend: send, onNavigate: () => {}
    });

    // A value result renders as text on an info row.
    let h = createEventHandlers(state(async () => ({ result: { type: 'number', value: 7 } })));
    let entry = await h.evaluateExpression('1+6');
    check('a successful evaluation returns an info row',
      entry && entry.level === 'info' && entry.text === '7', entry && entry.text);

    // A thrown exception becomes an error row with its stack — the failure
    // is visible in the log, not swallowed.
    h = createEventHandlers(state(async () => ({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', description: 'Error: nope' },
        stackTrace: { callFrames: [{ functionName: 'b', url: 'u', lineNumber: 2, columnNumber: 1 }] }
      }
    })));
    entry = await h.evaluateExpression('throw 1');
    check('a thrown evaluation is an error row',
      entry && entry.level === 'error', entry && entry.level);
    check('a thrown evaluation keeps the exception description',
      entry.text === 'Error: nope', entry.text);
    check('a thrown evaluation keeps the stack',
      /at b \(u:3:2\)/.test(entry.stack || ''), entry.stack);

    // A transport failure (the CDP socket) is reported too, instead of
    // rejecting and leaving the user with no feedback.
    h = createEventHandlers(state(async () => { throw new Error('ws down'); }));
    entry = await h.evaluateExpression('x');
    check('a CDP failure is surfaced as an error row',
      entry && entry.level === 'error' && /ws down/.test(entry.text), entry && entry.text);

    // A blank line is not an evaluation and produces no row.
    h = createEventHandlers(state(async () => ({})));
    check('an empty expression produces no row', await h.evaluateExpression('   ') === null);
  }

  // ===== 4. Network failure rows =======================================
  {
    const { box, createVirtualList } = captureList();
    const { component } = loadComponent('frontend/src/components/inspector/NetworkPanel.jsx', {
      createVirtualList, __export: 'NetworkPanel'
    });
    component({ onRowTap: () => {}, onReady: () => {} });
    const render = box.opts.render;

    let node = makeDocElement();
    render({ id: 'n1', method: 'GET', url: 'http://x/a', status: 404, type: 'XHR', size: 10, duration: 5 }, node);
    const status = node.children[0].children.find((c) => c.className.includes('inspector__row-status'));
    check('a 4xx request is labelled with the code',
      status && status.textContent === '404', status && status.textContent);
    check('a 4xx request uses the error status class',
      status && status.className.includes('inspector__row-status--error'), status && status.className);

    node = makeDocElement();
    render({ id: 'n2', method: 'GET', url: 'http://x/b', status: 'failed', type: 'XHR' }, node);
    const failed = node.children[0].children.find((c) => c.className.includes('inspector__row-status'));
    check('a failed request is labelled FAIL',
      failed && failed.textContent === 'FAIL', failed && failed.textContent);
    check('a failed request uses the failed status class',
      failed && failed.className.includes('inspector__row-status--failed'), failed && failed.className);
  }

  // ===== 5. Detail sheet keeps errors readable =========================
  {
    const { component: DetailSheet } = loadComponent('frontend/src/components/inspector/DetailSheet.jsx', {
      __export: 'DetailSheet'
    });

    const tree = DetailSheet({
      item: {
        kind: 'console', level: 'error', ts: 1, text: 'Error: nope',
        url: 'http://x/app.js', line: 3, stack: '  at f (app.js:3:4)'
      },
      onClose: () => {}
    });
    const flat = flatten(tree);
    check('the detail sheet titles console errors by level',
      flat.some((s) => s === 'ERROR'), flat.filter((s) => typeof s === 'string').join('|'));
    check('the detail sheet shows the error message',
      flat.includes('Error: nope'));
    check('the detail sheet shows the stack trace',
      flat.includes('  at f (app.js:3:4)'));
    check('the detail sheet names a stack-trace section',
      flat.includes('Stack trace'));
    check('the detail sheet shows the source location',
      flat.some((s) => typeof s === 'string' && s.includes('http://x/app.js:3')), flat.join('|'));

    // A console row without a stack must not render an empty stack section.
    const noStack = flatten(DetailSheet({ item: { kind: 'console', level: 'log', ts: 1, text: 'hi', stack: null }, onClose: () => {} }));
    check('the detail sheet omits the stack section when there is none',
      !noStack.includes('Stack trace'));

    // A failed request shows its error text in the Error field.
    const net = flatten(DetailSheet({
      item: { kind: 'request', method: 'GET', url: 'http://x/a', status: 'failed', statusText: 'net::ERR_FAILED', headers: {} },
      onClose: () => {}, onLoadBody: () => {}
    }));
    check('the detail sheet titles a failed request as FAIL',
      net.some((s) => s === 'GET FAIL'), net.join('|'));
    check('the detail sheet shows the request error text',
      net.includes('net::ERR_FAILED'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// ---- helpers ------------------------------------------------------------
function makeDocElement() {
  const doc = makeDoc();
  return doc.createElement('span');
}

// findByClass — depth-first search of the fake DOM for the first descendant
// whose className includes `name`.
function findByClass(node, name) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (typeof c.className === 'string' && c.className.includes(name)) return c;
    const found = findByClass(c, name);
    if (found) return found;
  }
  return null;
}

// flatten — walk the h(...) tree the components return and collect every
// string child, so assertions read the rendered text rather than the shape.
function flatten(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
  if (node.children) for (const c of node.children) flatten(c, out);
  return out;
}
