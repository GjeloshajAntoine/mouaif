'use strict';
// Regression test: the tool-card image lightbox cannot outlive the chat view.
//
// openImageLightbox() mounts its overlay on document.body — outside the Preact
// tree — and only dismiss() (Close button, Escape, tap outside) removed it.
// ChatView had no unmount teardown, so opening an image and navigating away
// (browser Back, a route change) left a fixed, full-viewport cover painted over
// the next screen, with its document keydown listener still attached. Each
// further open stacked another overlay and another listener.
//
// The fix publishes a teardown event that dismiss() also listens for, and
// ChatView fires it on unmount. This test runs the real toolRender.js against a
// minimal DOM and asserts the overlay and the listener both go away, including
// on the route-change path (only the teardown event, no user gesture).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/components/chat/toolRender.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- a DOM just big enough for the lightbox ------------------------
function makeDom() {
  const docListeners = new Map();  // type -> Set of handlers
  const winListeners = new Map();
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    type: '',
    style: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
    addEventListener() {},
    removeEventListener() {}
  });
  const body = makeEl('body');
  const document = {
    body,
    createElement: makeEl,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    }
  };
  const window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev.type);
      if (set) for (const fn of [...set]) fn(ev);
      return true;
    }
  };
  return {
    document, window, body,
    keydownCount: () => (docListeners.get('keydown') || new Set()).size,
    winCount: (t) => (winListeners.get(t) || new Set()).size,
    fireKeydown(key) {
      const set = docListeners.get('keydown');
      if (set) for (const fn of [...set]) fn({ key });
    }
  };
}

function makeModule(dom) {
  const context = vm.createContext({
    console,
    document: dom.document,
    window: dom.window,
    CustomEvent: class { constructor(type) { this.type = type; } }
  });
  // Only the lightbox half of the module is needed; the rest pulls in DOM/Preact.
  const start = source.indexOf('// openImageLightbox(src, alt)');
  const end = source.indexOf('// renderListFilesToolResult(');
  assert.ok(start > 0 && end > start, 'could not locate the lightbox section in toolRender.js');
  const slice = source.slice(start, end).replace(/^export /gm, '');
  // Pre-fix code has no teardown export at all. Model that as a no-op so the
  // behavioural checks below report "unmount left the overlay up" instead of
  // crashing on extraction.
  const stub = slice.includes('function teardownImageLightbox')
    ? ''
    : '\nfunction teardownImageLightbox() { /* pre-fix: no teardown path */ }\n';
  vm.runInContext(slice + stub + '; this.open = openImageLightbox; this.teardown = teardownImageLightbox;', context);
  return context;
}

(async () => {
  // ---- Escape still closes it --------------------------------------
  {
    const dom = makeDom();
    const mod = makeModule(dom);
    mod.open('data:image/png;base64,AA', 'shot');
    check('opening mounts the overlay on document.body', dom.body.children.length === 1);
    check('it arms one keydown listener', dom.keydownCount() === 1, 'count=' + dom.keydownCount());
    dom.fireKeydown('Escape');
    check('Escape removes the overlay', dom.body.children.length === 0);
    check('Escape removes the keydown listener', dom.keydownCount() === 0, 'count=' + dom.keydownCount());
  }

  // ---- the reported bug: leaving the chat --------------------------
  {
    const dom = makeDom();
    const mod = makeModule(dom);
    mod.open('data:image/png;base64,AA', 'shot');
    check('overlay is open before navigating away', dom.body.children.length === 1);
    // ChatView's unmount cleanup.
    mod.teardown();
    check('unmount removes the overlay (no full-screen cover on the next screen)',
      dom.body.children.length === 0, 'children=' + dom.body.children.length);
    check('unmount removes the keydown listener', dom.keydownCount() === 0, 'count=' + dom.keydownCount());
    check('unmount drops the teardown subscription too', dom.winCount('mouaif:teardown-lightbox') === 0,
      'subs=' + dom.winCount('mouaif:teardown-lightbox'));
  }

  // ---- no stacking across repeated opens ---------------------------
  {
    const dom = makeDom();
    const mod = makeModule(dom);
    mod.open('data:image/png;base64,AA', 'one');
    mod.open('data:image/png;base64,BB', 'two');
    check('a second open replaces the first instead of stacking',
      dom.body.children.length === 1, 'children=' + dom.body.children.length);
    check('only one keydown listener is armed after two opens',
      dom.keydownCount() === 1, 'count=' + dom.keydownCount());
    mod.teardown();
    check('teardown clears the replacement too', dom.body.children.length === 0 && dom.keydownCount() === 0);
  }

  // ---- teardown with nothing open is harmless ----------------------
  {
    const dom = makeDom();
    const mod = makeModule(dom);
    let threw = false;
    try { mod.teardown(); } catch { threw = true; }
    check('teardown with no overlay is a safe no-op', threw === false);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});