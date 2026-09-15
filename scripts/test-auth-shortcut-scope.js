'use strict';
// Regression test: the authorization card's 1-4 decision shortcuts must not
// fire while the user is typing.
//
// The card renders a per-run subagent model picker, whose "Search models" input
// mounts INSIDE the card (cards.js buildAuthModelPicker -> AuthModelPicker ->
// ModelPickerField). The card's keydown handler was bound to the whole card and
// only compared `e.key` against each button's shortcut, so typing "1"-"4" in
// that search box clicked a decision button. "4" is Deny — a keystroke meant for
// the model filter answered a live authorization prompt instead, which the model
// then saw as a refusal.
//
// The fix scopes the shortcuts to non-text targets. This test extracts the
// shipping isTypingTarget/onKey pair out of cards.js and drives it directly, so
// it fails if the guard is removed or weakened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/components/chat/cards.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// Slice the keydown handler (and its guard, when present) straight out of the
// module. The region runs from the handler's own comment to its registration,
// so it does not depend on isTypingTarget existing.
const marker = source.indexOf('// Keyboard shortcuts:');
const end = source.indexOf("card.addEventListener('keydown', onKey);");
assert.ok(marker > 0 && end > marker, 'could not locate the authorization keydown handler in cards.js');
let handlerSource = source.slice(marker, end);
// Pre-fix code has no typing guard at all. Model that faithfully with a
// permissive stub so the behavioural checks below fail with a readable
// "the prompt was answered by a keystroke" instead of an extraction crash.
if (!handlerSource.includes('isTypingTarget')) {
  handlerSource += '\nfunction isTypingTarget() { return false; }\n';
}

function makeHandler() {
  const clicks = [];
  const buttons = ['1', '2', '3', '4'].map((k) => ({
    dataset: { shortcut: k },
    click() { clicks.push(k); }
  }));
  const context = vm.createContext({ console, String, __buttons: buttons });
  // Declare `buttons` in the evaluated scope so onKey closes over it exactly
  // as it does in the module.
  vm.runInContext(
    'const buttons = __buttons;' + handlerSource + '; this.onKey = onKey; this.isTypingTarget = isTypingTarget;',
    context
  );
  return { onKey: context.onKey, isTypingTarget: context.isTypingTarget, clicks };
}

const el = (tagName, extra) => Object.assign({ tagName }, extra);

(async () => {
  const h = makeHandler();

  // The shortcut buttons own the card, so the keys still work there.
  for (const key of ['1', '2', '3', '4']) {
    h.onKey({ key, target: el('BUTTON') });
  }
  check('digits still resolve the prompt from a button target',
    h.clicks.join(',') === '1,2,3,4', h.clicks.join(','));

  // And from the card itself (no target, e.g. chrome).
  h.clicks.length = 0;
  for (const key of ['1', '2', '3']) h.onKey({ key, target: el('DIV') });
  check('digits still resolve from a non-field card target',
    h.clicks.join(',') === '1,2,3', h.clicks.join(','));

  // Now the bug: typing in the embedded model search must NOT answer.
  h.clicks.length = 0;
  for (const key of ['1', '2', '3', '4']) h.onKey({ key, target: el('INPUT') });
  check('typing 1-4 in the embedded search does not answer the prompt',
    h.clicks.length === 0, 'clicked=' + h.clicks.join(','));

  h.clicks.length = 0;
  h.onKey({ key: 'Escape', target: el('INPUT') });
  check('Escape in a field does not deny the prompt', h.clicks.length === 0);

  h.clicks.length = 0;
  h.onKey({ key: 'Escape', target: el('BUTTON') });
  check('Escape still denies from a non-field target', h.clicks.join(',') === '4', h.clicks.join(','));

  // Other field types are covered too.
  h.clicks.length = 0;
  h.onKey({ key: '4', target: el('TEXTAREA') });
  h.onKey({ key: '4', target: el('SELECT') });
  h.onKey({ key: '4', target: el('DIV', { isContentEditable: true }) });
  check('textarea, select and contenteditable are all treated as typing targets',
    h.clicks.length === 0, 'clicked=' + h.clicks.join(','));

  check('the guard recognises fields by tag',
    h.isTypingTarget(el('INPUT')) && h.isTypingTarget(el('TEXTAREA')) &&
    h.isTypingTarget(el('SELECT')) && !h.isTypingTarget(el('BUTTON')));

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
