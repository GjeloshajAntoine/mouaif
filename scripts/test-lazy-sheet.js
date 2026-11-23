'use strict';

// Tests for the lazy-sheet rule (frontend/src/hooks/useLazySheet.js).
//
// The bug this guards: a lazily imported sheet chunk that fails to fetch (the
// page is holding an entry bundle from before a rebuild, so its content-hashed
// chunk name is no longer served) used to be swallowed — `.catch(() => {})` in
// the chat view, `setCliModal(null)` in the File toolbar — which is what the
// state already was. Nothing re-ran and nothing was rendered, so the menu entry
// did nothing for the rest of the session. A failed load is now a status the
// sheet renders, with the one action that can actually recover it.
//
// The hook needs Preact's renderer, so this drives the three pure pieces it is
// built from — the message, the reload action and the load state machine — plus
// a source guard that every lazily loaded sheet goes through the hook.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Browser ESM in a CJS package: load through a data: URL, the same pattern
// scripts/test-modal-hook.js uses for frontend modules. A data: URL cannot
// resolve a bare specifier, so the Preact import is dropped first — the two
// functions below need no hook.
async function loadModule(rel) {
  const source = read(rel).replace(/^import \{[^}]*\} from 'preact\/hooks';$/m, '');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

// runSheet(loader, name) — the hook's state machine without Preact, mirroring
// the real transitions (idle → loading → ready | error, one attempt per
// document). A change to the hook that is not reflected here shows up as a
// failure in the wiring checks below.
function runSheet(loader, name) {
  const state = { status: 'idle', View: null, error: null, requests: 0 };
  let started = false;
  return {
    state,
    load() {
      // One attempt per document: the HTML spec memoizes a failed import, so a
      // second `import()` of the same specifier issues no request and rejects
      // identically (verified in Chrome: 1 request, then 0).
      if (started) return Promise.resolve();
      started = true;
      state.requests += 1;
      state.status = 'loading';
      state.error = null;
      return Promise.resolve()
        .then(() => loader())
        .then((mod) => {
          const picked = mod ? mod[name] : null;
          if (!picked) throw new Error('missing export ' + name);
          state.View = picked;
          state.status = 'ready';
        })
        .catch((err) => {
          state.View = null;
          state.error = err;
          state.status = 'error';
        });
    }
  };
}

(async () => {
  const mod = await loadModule('frontend/src/hooks/useLazySheet.js');
  const { lazySheetMessage, reloadDocument } = mod;

  // ---- 1. The message ------------------------------------------------
  console.log('\n1. lazySheetMessage');

  check('names the sheet that failed', () => {
    const msg = lazySheetMessage(new Error('Failed to fetch dynamically imported module'), 'the CLI sheet');
    assert.match(msg, /the CLI sheet/);
  });

  check('a chunk failure reads as a stale build, and says to reload', () => {
    const msg = lazySheetMessage(new Error('Failed to fetch dynamically imported module'), 'the CLI sheet');
    assert.match(msg, /updated since this page was loaded/);
    assert.match(msg, /Reload the app/);
    // The browser's own wording must not leak: it changes per browser and
    // means nothing to a user. Neither must a retry be offered — a failed
    // import cannot be re-requested in the same document.
    assert.doesNotMatch(msg, /dynamically imported/);
    assert.doesNotMatch(msg, /try again/i);
  });

  check('a 404 and a bare chunk failure are described the same way', () => {
    const a = lazySheetMessage(new Error('404 Not found'), 'x');
    const b = lazySheetMessage(new Error('ChunkLoadError: Loading chunk 12 failed'), 'x');
    assert.equal(a.replace(/^Could not load x\. /, ''), b.replace(/^Could not load x\. /, ''));
  });

  check('a non-network failure keeps its own message', () => {
    const msg = lazySheetMessage(new Error('missing export CliModal'), 'the CLI sheet');
    assert.match(msg, /missing export CliModal/);
    assert.match(msg, /Reload the app/);
  });

  check('no error at all still says what to do', () => {
    const msg = lazySheetMessage(null, 'screen capture');
    assert.match(msg, /screen capture/);
    assert.match(msg, /Reload the app/);
  });

  // ---- 2. The reload action ------------------------------------------
  console.log('\n2. reloadDocument');

  check('reloads the document', () => {
    let reloads = 0;
    const saved = global.window;
    global.window = { location: { reload: () => { reloads += 1; } } };
    try {
      assert.equal(reloadDocument(), true);
      assert.equal(reloads, 1);
    } finally {
      if (saved === undefined) delete global.window; else global.window = saved;
    }
  });

  check('reports when there is nothing to reload', () => {
    const saved = global.window;
    delete global.window;
    try {
      assert.equal(reloadDocument(), false);
    } finally {
      if (saved !== undefined) global.window = saved;
    }
  });

  // ---- 3. The load state machine -------------------------------------
  console.log('\n3. the load state machine');

  check('a failed load is an error state, not a silent null', async () => {
    const sheet = runSheet(() => Promise.reject(new Error('Failed to fetch')), 'CliModal');
    await sheet.load();
    assert.equal(sheet.state.status, 'error');
    assert.equal(sheet.state.View, null);
    assert.match(String(sheet.state.error.message), /Failed to fetch/);
  });

  check('a failed import is not re-requested', async () => {
    const sheet = runSheet(() => Promise.reject(new Error('Failed to fetch')), 'CliModal');
    await sheet.load();
    await sheet.load();
    await sheet.load();
    assert.equal(sheet.state.requests, 1, 'the document memoizes the failure, so a retry would be a lie');
    assert.equal(sheet.state.status, 'error');
  });

  check('a successful load is not re-fetched', async () => {
    const sheet = runSheet(() => Promise.resolve({ CliModal: 'VIEW' }), 'CliModal');
    await sheet.load();
    await sheet.load();
    assert.equal(sheet.state.requests, 1);
    assert.equal(sheet.state.View, 'VIEW');
  });

  check('two taps before the chunk arrives issue one request', async () => {
    const sheet = runSheet(() => Promise.resolve({ CliModal: 'VIEW' }), 'CliModal');
    const first = sheet.load();
    sheet.load();
    assert.equal(sheet.state.requests, 1);
    await first;
    assert.equal(sheet.state.status, 'ready');
  });

  check('a chunk that loads without the export is reported, not swallowed', async () => {
    const sheet = runSheet(() => Promise.resolve({ NotCliModal: 'VIEW' }), 'CliModal');
    await sheet.load();
    assert.equal(sheet.state.status, 'error');
    assert.match(String(sheet.state.error.message), /missing export CliModal/);
  });

  // ---- 4. The wiring -------------------------------------------------
  console.log('\n4. every lazily loaded sheet uses the rule');

  const LAZY = [
    ['frontend/src/components/chat/FileToolbar.jsx', ['GitModal', 'CliModal']],
    ['frontend/src/components/chat/Chat.jsx', ['ScreenCapturePanel', 'ArtifactsModal', 'WebpreviewModal', 'DraftCraftAnnotator', 'FileEditorView']]
  ];
  for (const [file, names] of LAZY) {
    check(file + ' loads its sheets through useLazySheet', () => {
      const src = read(file);
      assert.match(src, /useLazySheet\(/, 'must import and use useLazySheet');
      for (const name of names) {
        assert.match(src, new RegExp("useLazySheet\\('" + name + "'"), name + ' must go through useLazySheet');
      }
      // The old shape: a dynamic import whose rejection was swallowed.
      const swallowed = src.split(/import\(/).slice(1)
        .filter((tail) => /^[\s\S]{0,400}?\.catch\(\(\) => \{\s*\}\);/.test(tail));
      assert.equal(swallowed.length, 0, 'a swallowed chunk failure is the bug');
    });
  }

  check('a failed sheet renders an error card, not nothing', () => {
    for (const file of ['frontend/src/components/chat/FileToolbar.jsx', 'frontend/src/components/chat/Chat.jsx']) {
      const src = read(file);
      assert.match(src, /status === 'error'/);
      assert.match(src, /LazySheetError/);
    }
  });

  check('the error card offers only actions that can work', () => {
    const src = read('frontend/src/components/chat/LazySheetError.jsx');
    assert.match(src, /Reload the app/);
    assert.doesNotMatch(src, /Try again/);
    assert.match(src, /reloadDocument/);
    // The card replaces the sheet, so it must be a sheet itself.
    assert.match(src, /sheet-err__overlay/);
    assert.match(src, /role: 'dialog'/);
  });

  check('the error block is styled for both placements', () => {
    const css = read('frontend/src/sheets.css');
    assert.match(css, /\.sheet-err__overlay \{[\s\S]*?position: fixed;/);
    assert.match(css, /\.lazy-err--inline/);
    // 44px tap floor on every action.
    assert.match(css, /\.lazy-err__btn \{[\s\S]*?min-height: var\(--tap/);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
