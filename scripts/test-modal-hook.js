'use strict';

// Tests for the shared sheet behaviour (Escape, Tab cycle, focus restore).
//
// Two halves:
//   1. the pure modal stack (frontend/src/hooks/modalStack.js), driven
//      directly — it decides which open sheet owns the keyboard;
//   2. a source guard on every component that renders a full-screen sheet:
//      it must use the shared hook and must not hand-roll an Escape listener.
//      That is the invariant the hook exists for; a new sheet that copies the
//      old boilerplate would otherwise pass review unnoticed.
//
// The DOM wiring in frontend/src/hooks/useModal.js needs a browser (focus
// moves, computed styles); it is exercised at 360 px in Chrome, and the parts
// that can be wrong in a way a browser would not show — the stack order — are
// covered here.

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

// Browser ESM in a CJS package: load through a data: URL (the same pattern
// test-agent-page-flow.mjs uses), so this runs on any supported Node.
async function loadModule(rel) {
  const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

// [component, sheet element it must hand the ref to]
const SHEETS = [
  ['frontend/src/components/chat/CliModal.jsx'],
  ['frontend/src/components/chat/GitModal.jsx'],
  ['frontend/src/components/chat/McpErrorModal.jsx'],
  ['frontend/src/components/chat/WebpreviewModal.jsx'],
  ['frontend/src/components/chat/PreviewUrlPrompt.jsx'],
  ['frontend/src/components/AgentFilePicker.jsx'],
  ['frontend/src/components/inspector/PreviewPanel.jsx']
];

(async () => {
  const stack = await loadModule('frontend/src/hooks/modalStack.js');
  const { openModal, closeModal, isTopModal, modalDepth, resetModalStack } = stack;

  // ---- 1. The stack ----------------------------------------------------

  check('an empty stack owns nothing', () => {
    resetModalStack();
    assert.equal(modalDepth(), 0);
    assert.equal(isTopModal({}), false);
  });

  check('the sheet that opened last owns the keyboard', () => {
    resetModalStack();
    const outer = {};
    const inner = {};
    openModal(outer);
    assert.equal(isTopModal(outer), true);
    openModal(inner);
    assert.equal(isTopModal(inner), true, 'the nested sheet takes over');
    assert.equal(isTopModal(outer), false, 'and the one below it goes quiet');
    assert.equal(modalDepth(), 2);
  });

  check('closing the top sheet hands the keyboard back', () => {
    resetModalStack();
    const outer = {};
    const inner = {};
    openModal(outer);
    openModal(inner);
    assert.equal(closeModal(inner), true, 'closing the top reports the hand-back');
    assert.equal(isTopModal(outer), true);
    assert.equal(modalDepth(), 1);
  });

  check('closing a sheet that is not on top leaves the top alone', () => {
    resetModalStack();
    const outer = {};
    const inner = {};
    openModal(outer);
    openModal(inner);
    assert.equal(closeModal(outer), false);
    assert.equal(isTopModal(inner), true);
    assert.equal(isTopModal(outer), false);
    assert.equal(modalDepth(), 1);
  });

  check('closing twice is a no-op', () => {
    resetModalStack();
    const only = {};
    openModal(only);
    assert.equal(closeModal(only), true);
    assert.equal(closeModal(only), false);
    assert.equal(modalDepth(), 0);
  });

  check('re-opening a token moves it to the top instead of duplicating it', () => {
    resetModalStack();
    const a = {};
    const b = {};
    openModal(a);
    openModal(b);
    openModal(a);
    assert.equal(modalDepth(), 2, 'no duplicate token');
    assert.equal(isTopModal(a), true);
    assert.equal(isTopModal(b), false);
  });

  check('a full open/close cycle of three sheets unwinds in order', () => {
    resetModalStack();
    const [a, b, c] = [{}, {}, {}];
    openModal(a); openModal(b); openModal(c);
    assert.deepEqual([isTopModal(a), isTopModal(b), isTopModal(c)], [false, false, true]);
    closeModal(c);
    assert.deepEqual([isTopModal(a), isTopModal(b)], [false, true]);
    closeModal(b);
    assert.equal(isTopModal(a), true);
    closeModal(a);
    assert.equal(modalDepth(), 0);
  });

  // ---- 2. Source guard on the sheets -----------------------------------

  const hookPath = 'frontend/src/hooks/useModal.js';
  const hookSource = fs.readFileSync(path.join(__dirname, '..', hookPath), 'utf8');

  check('the hook itself guards Escape on the top-most sheet only', () => {
    assert.ok(/isTopModal\(token\)/.test(hookSource), 'useModal must consult the stack');
    assert.ok(/addEventListener\('keydown', onKeyDown, true\)/.test(hookSource), 'capture listener expected');
    assert.ok(/stopPropagation\(\)/.test(hookSource), 'Escape must not reach the app behind the sheet');
  });

  for (const [file] of SHEETS) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    check(file + ' uses the shared sheet hook', () => {
      assert.ok(/import \{ useModal \} from '(\.\.\/)+hooks\/useModal\.js';/.test(src),
        'expected an import of hooks/useModal.js');
      assert.ok(/const \w+ = useModal\(/.test(src), 'expected a useModal() call');
    });

    check(file + ' hands the hook ref to its sheet', () => {
    const refs = Array.from(src.matchAll(/const (\w+) = useModal\(/g)).map((m) => m[1]);
    assert.ok(refs.length > 0, 'no useModal() ref found');
    for (const ref of refs) {
      const direct = new RegExp('ref:\\s*' + ref + '\\b').test(src);
      // A nested sheet component can hand the ref down as a `sheetRef` prop
      // (the Git confirm sheet does); then the prop must be attached inside.
      const handedOff = new RegExp('sheetRef:\\s*' + ref + '\\b').test(src)
      && /ref:\s*sheetRef\b/.test(src);
      assert.ok(direct || handedOff, 'the ' + ref + ' ref is never attached to an element');
    }
    });

    check(file + ' no longer hand-rolls an Escape listener', () => {
      assert.ok(!/key === 'Escape'/.test(src), 'Escape handling belongs to hooks/useModal.js');
      assert.ok(!/addEventListener\('keydown'/.test(src), 'a keydown listener belongs to hooks/useModal.js');
    });
  }

  check('the nested Git confirm sheet is declared after the modal it sits on', () => {
    const src = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/GitModal.jsx'), 'utf8');
    const order = Array.from(src.matchAll(/const (\w+) = useModal\(/g)).map((m) => m[1]);
    assert.deepEqual(order, ['sheetRef', 'confirmSheetRef'],
      'the confirm sheet must push its token after the modal, so it is the one Escape reaches');
  });

  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  if (fail) process.exit(1);
})();
