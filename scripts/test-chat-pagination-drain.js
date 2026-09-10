'use strict';
// Regression test: the eager older-page drainer must not stop on a page
// whose rows were all already in memory.
//
// fetchAndPrependOlderPage() advances the pagination cursor from the
// server's authoritative `beforeSeq` and dedupes rows against
// state.seenSeqs. A page can legitimately come back with every row
// already seen — a window edge from a reconcile that landed between
// loads — so it inserts nothing. Two things used to treat that as "no
// more history":
//
//   * the pager did `if (!body.hasMore || !inserted) pager.hasMore = false`
//     even though the server had said more existed, and
//   * loadAllOlderMessages() bailed on the `false` return value.
//
// Together they silently hid every remaining older page. Pagination is
// now ended only by the server's own `hasMore`, and the drain loop keys
// off cursor advance rather than the DOM-change return value.
//
// stream.js is loaded the way the transcript tests load it: the import
// block is stripped and the body runs in a VM whose globals supply the
// module's helpers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStream(globals) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    PAGE_SIZE_DEFAULT: 100
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(
    body + '; this.loadAllOlderMessages = loadAllOlderMessages; this.loadOlderMessages = loadOlderMessages; this.fetchAndPrependOlderPage = fetchAndPrependOlderPage;',
    context
  );
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A pager plus a fake server that serves the pages described by `pages`,
// keyed by the `beforeSeq` the client sends.
function harness(pages, opts = {}) {
  const fetches = [];
  const prepends = [];
  const state = {
    seenSeqs: new Set(opts.seen || []),
    messages: [],
    streaming: false,
    watchingRun: false,
    props: { projectDir: '/p', chatId: 'c' }
  };
  const refs = { transcript: { current: { tagName: 'DIV' } } };
  const mod = loadStream(Object.assign({
    whenTranscriptSettled: () => Promise.resolve(),
    cancelTranscriptRender() {},
    // fetchMessagesWindow() lives inside stream.js and builds the URL
    // itself, so the fake server is hooked one layer down at fetchJson.
    fetchJson: async (url) => {
      const m = /beforeSeq=(\d+)/.exec(url);
      const beforeSeq = m ? Number(m[1]) : null;
      fetches.push(beforeSeq);
      const page = pages[beforeSeq];
      if (!page) throw new Error('no page for beforeSeq ' + beforeSeq);
      if (page.error) throw new Error('boom');
      return { status: 200, body: page };
    },
    prependOlderTranscript: (st, rf, fresh) => {
      prepends.push(fresh.map((m) => m.seq));
      return fresh.length > 0;
    }
  }, opts.globals || {}));
  return { mod, state, refs, fetches, prepends };
}

async function main() {
  // ---- 1. a fully-deduped page does not end pagination ------------
  {
    // Page 1 (beforeSeq 30) is entirely already known; page 2 (beforeSeq
    // 25) still has real history AND is the last page.
    const h = harness({
      30: { messages: [{ seq: 25 }, { seq: 26 }, { seq: 27 }], hasMore: true, beforeSeq: 25 },
      25: { messages: [{ seq: 20 }, { seq: 21 }], hasMore: false, beforeSeq: 20 }
    }, { seen: [25, 26, 27, 20, 21] });
    const pager = { hasMore: true, beforeSeq: 30, loading: false, offset: 3, total: 9, firstSeq: 25 };
    await h.mod.loadAllOlderMessages(h.state, h.refs, pager);

    check('the deduped page did not stop pagination', h.fetches.length === 2, 'fetches=' + JSON.stringify(h.fetches));
    check('the drain continued past the deduped page',
      h.fetches[1] === 25, 'fetches=' + JSON.stringify(h.fetches));
    check('the deduped page reported no DOM change',
      JSON.stringify(h.prepends[0]) === '[]', JSON.stringify(h.prepends));
    check('the cursor advanced past the deduped page',
      pager.beforeSeq === 20, 'beforeSeq=' + pager.beforeSeq);
    check('the server\'s hasMore ends the drain', pager.hasMore === false, 'hasMore=' + pager.hasMore);
    check('the drain latch was released', pager.loading === false);
  }

  // ---- 2. a page with fresh rows still drains to the top ----------
  {
    const h = harness({
      30: { messages: [{ seq: 25 }, { seq: 26 }], hasMore: true, beforeSeq: 25 },
      25: { messages: [], hasMore: false, beforeSeq: null }
    }, { seen: [25, 26] });
    const pager = { hasMore: true, beforeSeq: 30, loading: false, offset: 2, total: 2, firstSeq: 25 };
    await h.mod.loadAllOlderMessages(h.state, h.refs, pager);
    check('an empty page ends the walk', pager.hasMore === false && pager.beforeSeq === null,
      'hasMore=' + pager.hasMore + ' beforeSeq=' + pager.beforeSeq);
    check('the empty page was not retried', h.fetches.length === 2, 'fetches=' + JSON.stringify(h.fetches));
  }

  // ---- 3. a failed fetch stops the drain and keeps the cursor -----
  {
    const h = harness({ 30: { error: true } }, { seen: [] });
    const pager = { hasMore: true, beforeSeq: 30, loading: false, offset: 0, total: 9, firstSeq: null };
    await h.mod.loadAllOlderMessages(h.state, h.refs, pager);
    check('a failed fetch does not spin', h.fetches.length === 1, 'fetches=' + JSON.stringify(h.fetches));
    check('a failed fetch leaves hasMore true for a retry', pager.hasMore === true, 'hasMore=' + pager.hasMore);
    check('a failed fetch leaves the cursor alone', pager.beforeSeq === 30, 'beforeSeq=' + pager.beforeSeq);
    check('a failed fetch releases the drain latch', pager.loading === false);
  }

  // ---- 4. the single-page scroll loader reports DOM change only ----
  {
    const h = harness({
      30: { messages: [{ seq: 25 }], hasMore: true, beforeSeq: 25 }
    }, { seen: [25] });
    const pager = { hasMore: true, beforeSeq: 30, loading: false, offset: 1, total: 5, firstSeq: 25 };
    const inserted = await h.mod.loadOlderMessages(h.state, h.refs, pager);
    check('a no-op page returns false but keeps hasMore',
      inserted === false && pager.hasMore === true, 'inserted=' + inserted + ' hasMore=' + pager.hasMore);
    check('a no-op page still advances the cursor', pager.beforeSeq === 25, 'beforeSeq=' + pager.beforeSeq);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
