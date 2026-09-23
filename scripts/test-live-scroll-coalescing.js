'use strict';

// Regression test: the live preview scroll is coalesced, not forced per chunk.
//
// The first version of the live-preview pin ran `scrollTop = scrollHeight` —
// a forced layout — and then scheduled a second, identical pair on the next
// frame, so every chunk cost two synchronous layouts. On a token-rate stream
// that is the dominant cost, and on returning to a running chat the whole
// buffered output is replayed in one burst, so a long build log could lock the
// page for a moment.
//
// scrollToolBodyToBottomSoon instead does the work inside one
// requestAnimationFrame per body per frame: a burst of N chunks schedules one
// frame, and the frame reads layout once. These assertions count frames and
// layout reads, so restoring the per-chunk version fails them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- Counting DOM stub ------------------------------------------------

function makeBody() {
  const body = {
    nodeType: 1,
    tagName: 'DIV',
    className: 'tool-card__body',
    parentNode: null,
    isConnected: true,
    scrollHeight: 1000,
    clientHeight: 300,
    _scrollTop: 0,
    // Count every layout read and every write, which is what the fix is about.
    reads: 0,
    writes: 0,
    get scrollTop() { this.reads++; return this._scrollTop; },
    set scrollTop(v) { this.writes++; this._scrollTop = v; },
    closest(sel) { return sel === '.tool-card__body' ? body : null; }
  };
  return body;
}

function installDom() {
  const frames = [];
  let cancelled = 0;
  return {
    frames,
    get cancelled() { return cancelled; },
    globals: {
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
      cancelAnimationFrame: () => { cancelled++; },
      WeakMap, Map, Set, Object, String, Number, Boolean, Math, JSON, Array, Error, console
    },
    // Run every queued frame once, in order, and report how many ran.
    flush() {
      const queued = frames.splice(0, frames.length);
      for (const fn of queued) fn();
      return queued.length;
    }
  };
}

function loadScroll(globals) {
  const source = fs.readFileSync(path.join(CHAT_DIR, 'scroll.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({ document: { querySelector: () => null, addEventListener() {}, removeEventListener() {} } }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.scrollToolBodyToBottomSoon = scrollToolBodyToBottomSoon;'
    + ' this.cancelToolBodyScroll = cancelToolBodyScroll;', context);
  return context;
}

function main() {
  const dom = installDom();
  const mod = loadScroll(dom.globals);

  // ---- 1. A burst of chunks schedules exactly one frame --------------
  {
    const body = makeBody();
    for (let i = 0; i < 50; i++) mod.scrollToolBodyToBottomSoon(body);
    const beforeFlushReads = body.reads;
    check('a burst of 50 chunks forces no synchronous layout',
      beforeFlushReads === 0, 'reads=' + beforeFlushReads);
    const ran = dom.flush();
    check('a burst of 50 chunks schedules a single frame', ran === 1, 'frames=' + ran);
    check('the frame pinned the body to the bottom', body._scrollTop === body.scrollHeight,
      body._scrollTop + ' vs ' + body.scrollHeight);
  }

  // ---- 2. Layout is read once per frame, not twice ------------------
  {
    const body = makeBody();
    mod.scrollToolBodyToBottomSoon(body);
    dom.flush();
    // One read serves both the write and the settled check is expected; what
    // must not happen is a *second* frame that repeats the pair needlessly.
    check('a settled body schedules no follow-up frame', dom.frames.length === 0,
      'frames=' + dom.frames.length);
  }

  // ---- 3. A torn-down preview cannot keep scrolling ------------------
  {
    const body = makeBody();
    mod.scrollToolBodyToBottomSoon(body);
    check('a frame is queued', dom.frames.length === 1);
    mod.cancelToolBodyScroll(body);
    // A browser rAF cannot be un-queued, so cancel neutralises the frame: it
    // still runs, but must not touch the body that is being torn down.
    dom.flush();
    check('a cancelled frame does not scroll the torn-down body', body.writes === 0,
      'writes=' + body.writes);
    check('a later schedule after cancel is accepted again', (() => {
      const before = dom.frames.length;
      mod.scrollToolBodyToBottomSoon(body);
      return dom.frames.length === before + 1;
    })(), 'frames=' + dom.frames.length);
    dom.flush();
    check('the re-scheduled frame does scroll', body.writes === 1, 'writes=' + body.writes);
  }

  // ---- 4. A detached body stops the loop ----------------------------
  {
    const body = makeBody();
    mod.scrollToolBodyToBottomSoon(body);
    body.isConnected = false;
    dom.flush();
    check('a detached body is not scrolled', body.writes === 0, 'writes=' + body.writes);
    check('a detached body leaves no frame queued', dom.frames.length === 0);
  }

  // ---- 5. The re-pin budget is bounded ------------------------------
  {
    const body = makeBody();
    // A body that never reaches the bottom would otherwise re-arm forever.
    Object.defineProperty(body, 'scrollTop', {
      get() { return 0; },
      set() { /* refuse the write, so it is never "settled" */ }
    });
    mod.scrollToolBodyToBottomSoon(body);
    let frames = 0;
    while (dom.frames.length && frames < 500) { frames += dom.flush(); }
    check('the re-pin run is bounded, not infinite', frames <= 10, 'frames=' + frames);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
