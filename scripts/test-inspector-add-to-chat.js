'use strict';
// Regression test for the Inspector detail sheet's "Add to chat" button.
//
// The button hands a tapped console log / exception / network request to a
// chat draft. Two things have to hold:
//
//   1. the text that lands in the draft is a faithful, readable summary of
//      the entry (buildEntryText) — the whole point of the feature; and
//   2. the button exists on the sheet, is disabled when there is nothing to
//      send, and calls back rather than sending anything itself (Draft Craft
//      never starts a model run).
//
// The pure builder runs directly; the sheet is executed in a VM against a
// miniature Preact runtime, the technique the other inspector tests use.

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

function flatten(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
  if (node.children) for (const c of node.children) flatten(c, out);
  return out;
}

// findByClass — depth-first search for the first node whose class includes
// `name`. Returns null when absent.
function findByClass(node, name) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (c && typeof c.props === 'object' && typeof c.props.class === 'string' && c.props.class.includes(name)) return c;
    const found = findByClass(c, name);
    if (found) return found;
  }
  return null;
}

function loadDetailSheet() {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/inspector/DetailSheet.jsx'), 'utf8'
  );
  const sandbox = {
    console,
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    fmtTime: () => '12:00:00',
    fmtBytes: (n) => (typeof n === 'number' ? n + ' B' : ''),
    fmtDur: (ms) => (typeof ms === 'number' ? ms + ' ms' : ''),
    statusLabel: (s) => (s === 'pending' ? '···' : s === 'failed' ? 'FAIL' : String(s)),
    sheetPortal: (x) => x,
    Object, Array, String, Number, JSON, Error, isNaN
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    source.replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '; this.DetailSheet = DetailSheet;',
    ctx
  );
  return ctx.DetailSheet;
}

async function main() {
  const { buildEntryText } = await import('../frontend/src/components/inspector/entryText.js');

  // ===== 1. buildEntryText ==============================================
  {
    const ctx = { pageTitle: 'My Page', pageUrl: 'http://x/' };

    const err = buildEntryText({
      kind: 'console', level: 'error', ts: new Date('2020-01-01T00:00:00').getTime(),
      text: 'Error: nope', url: 'http://x/app.js', line: 12, stack: '  at f (app.js:12:4)'
    }, ctx);
    check('console text names the level and the page',
      err.includes('console error') && err.includes('My Page'), err.split('\n')[0]);
    check('console text carries the message', err.includes('Error: nope'));
    check('console text carries the source location',
      err.includes('http://x/app.js:12'), err);
    check('console text carries the stack trace',
      err.includes('Stack:') && err.includes('at f (app.js:12:4)'));

    // An uncaught exception is named as such, not "console error".
    const ex = buildEntryText({
      kind: 'exception', level: 'error', ts: Date.now(),
      text: 'Uncaught TypeError: x', url: 'http://x/b.js', line: 3
    }, ctx);
    check('exception text names the exception kind',
      ex.includes('Inspector exception'), ex.split('\n')[0]);
    check('exception text omits a stack section when there is none',
      !ex.includes('Stack:'), ex);

    // A transport failure names its cause.
    const failed = buildEntryText({
      kind: 'request', method: 'GET', url: 'http://x/api', status: 'failed', statusText: 'net::ERR_FAILED'
    }, { pageUrl: 'http://x/' });
    check('failed request text names the method and FAIL',
      failed.includes('GET FAIL'), failed.split('\n')[0]);
    check('failed request text carries the url and the error text',
      failed.includes('http://x/api') && failed.includes('net::ERR_FAILED'), failed);
    check('failed request text falls back to the page URL for context',
      failed.includes('http://x/'), failed.split('\n')[0]);

    // A normal HTTP response summarises its metadata and does not label the
    // status text as an error.
    const ok = buildEntryText({
      kind: 'request', method: 'POST', url: 'http://x/api', status: 404, statusText: 'Not Found',
      type: 'XHR', mimeType: 'application/json; charset=utf-8', size: 2048, duration: 120
    }, ctx);
    check('request text carries the metadata row',
      ok.includes('XHR') && ok.includes('application/json') && ok.includes('120 ms'), ok);
    check('a status response is not labelled an error',
      !ok.includes('Not Found') && !/^Error:/m.test(ok), ok);

    // No page identity: still a complete sentence.
    const bare = buildEntryText({ kind: 'console', level: 'log', ts: Date.now(), text: 'hi' }, {});
    check('bare text names a neutral page', bare.includes('the inspected page'), bare.split('\n')[0]);

    // A partial entry (a request row before its response) must not throw.
    let threw = null;
    try { buildEntryText({ kind: 'request', method: 'GET', url: 'http://x/a', status: 'pending' }, ctx); }
    catch (e) { threw = e; }
    check('a partial request entry does not throw', threw === null, threw && threw.message);

    // No entry → empty string, so the caller can disable the button.
    check('a missing entry yields empty text', buildEntryText(null, ctx) === '');
    check('a non-object entry yields empty text', buildEntryText('nope', ctx) === '');
  }

  // ===== 2. The button on the detail sheet ==============================
  {
    const DetailSheet = loadDetailSheet();

    // A console error entry: the button is present, enabled, and calls back.
    let calls = 0;
    let tree = DetailSheet({
      item: { kind: 'console', level: 'error', ts: 1, text: 'boom', url: null, line: null, stack: null },
      onClose: () => {}, onAddToChat: () => { calls++; }
    });
    const btn = findByClass(tree, 'inspector__sheet-add-chat');
    check('the sheet renders an Add to chat button', !!btn);
    check('the button carries the label',
      btn && flatten(btn).includes('Add to chat'), btn && flatten(btn).join('|'));
    check('the button is enabled when a handler is supplied', btn && btn.props.disabled === false);
    btn.props.onClick({ stopPropagation() {} });
    check('the button calls back instead of sending', calls === 1, 'calls=' + calls);
    check('the sheet still renders its Close button',
      flatten(tree).includes('Close'));

    // No handler (nothing to route to) → disabled, not hidden: a missing
    // button would read as a missing feature.
    tree = DetailSheet({
      item: { kind: 'console', level: 'log', ts: 1, text: 'hi' },
      onClose: () => {}
    });
    const noHandler = findByClass(tree, 'inspector__sheet-add-chat');
    check('the button is rendered but disabled without a handler',
      noHandler && noHandler.props.disabled === true, noHandler && String(noHandler.props.disabled));

    // A caller can label the busy state without the sheet knowing why.
    tree = DetailSheet({
      item: { kind: 'request', method: 'GET', url: 'http://x/a', status: 200 },
      onClose: () => {}, onAddToChat: () => {}, addToChatLabel: 'Adding…', addToChatDisabled: true
    });
    const busy = findByClass(tree, 'inspector__sheet-add-chat');
    check('the button label is overridable', busy && flatten(busy).includes('Adding…'),
      busy && flatten(busy).join('|'));
    check('the button can be disabled while busy', busy && busy.props.disabled === true);

    // The button lives in the sheet head, beside Close — not down in the
    // scrolling body, where a long stack would push it off screen.
    const head = findByClass(tree, 'inspector__sheet-head');
    const inHead = head && (function walk(n) {
      if (!n || !n.children) return false;
      for (const c of n.children) {
        if (c === busy) return true;
        if (walk(c)) return true;
      }
      return false;
    })(head);
    check('the button sits in the sheet head', !!inHead);
  }

  // ===== 3. The Inspector wires one project/chat picker =================
  {
    const inspector = fs.readFileSync(
      path.join(__dirname, '../frontend/src/components/Inspector.jsx'), 'utf8'
    );
    check('the Inspector reuses the shared Draft Craft sheet',
      /import \{ DraftCraftSheet \} from '\.\/DraftCraftSheet\.jsx'/.test(inspector));
    check('the sheet gets the built entry text',
      /buildEntryText\(detailItem/.test(inspector));
    check('the picker defaults to the active project',
      /projectDir: activeProject\(\)/.test(inspector));
    check('the entry is only offered when there is text to send',
      /if \(!text\) return;/.test(inspector));
    check('the payload describes itself to the sheet',
      /description: 'Add this Inspector entry to any chat draft\.'/.test(inspector));

    const sheet = fs.readFileSync(
      path.join(__dirname, '../frontend/src/components/DraftCraftSheet.jsx'), 'utf8'
    );
    check('the Draft Craft sheet keeps its default subtitle',
      /Add selected file code to any chat draft\.'/.test(sheet));
    check('callers can override the subtitle',
      /payload\.description/.test(sheet));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
