// The ask_user card's one-line header and result summary.
//
// A persisted ask_user call renders as a collapsed tool card. Before this
// there was no `ask_user` branch in either formatter, so the head showed
// `JSON.stringify(args, null, 2)` — the full options array, truncated at 220
// chars in the middle of an option description — and the result summary showed
// nothing at all. The card now reads as the question, with the recorded answer
// in the summarised slot.
//
// Loaded the way scripts/test-git-count-format.mjs loads frontend ESM helpers:
// through a data: URL, so node does not warn about the CJS-typed package.
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../frontend/src/components/chat/tools.js', import.meta.url), 'utf8');
const { formatToolArgs, formatResultSummary } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

const QUESTION = 'Which branch should the release be cut from?';
const ARGS = {
  question: QUESTION,
  options: [
    { label: 'main', value: 'main', description: 'the canonical default branch' },
    { label: 'trunk', value: 'trunk', description: 'the release line we cut from' }
  ],
  multiSelect: false
};
const RESULT = {
  answered: true,
  choice: 'main',
  extra: 'use the trunk for hotfixes too',
  options: [{ label: 'main', value: 'main' }, { label: 'trunk', value: 'trunk' }],
  multiSelect: false,
  cancelled: false
};

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error('  FAIL  ' + name + ': ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  } else {
    console.log('  ok   - ' + name);
  }
}

// ---- header (the collapsed card's head line) -------------------------
check('the head line is the question', formatToolArgs(ARGS, 'ask_user'), QUESTION);
check('a namespaced tool name is normalized',
  formatToolArgs(ARGS, 'functions.ask_user'), QUESTION);
check('no raw JSON leaks into the head line',
  formatToolArgs(ARGS, 'ask_user').includes('"options"'), false);
check('a missing question degrades to the empty string',
  formatToolArgs({ options: ARGS.options }, 'ask_user'), '');
check('an unknown tool still falls back to JSON',
  formatToolArgs({ a: 1 }, 'mcp__x__y').includes('"a"'), true);

// ---- result summary (the collapsed card's trailing slot) -------------
check('the recorded answer is the summary', formatResultSummary('ask_user', RESULT), 'main');
check('a multi-select answer counts its picks',
  formatResultSummary('ask_user', { choice: ['main', 'trunk'], multiSelect: true }), '2 choices');
check('a dismissed question reads as dismissed',
  formatResultSummary('ask_user', { cancelled: true, choice: '' }), 'dismissed');
check('an unanswered result has no summary',
  formatResultSummary('ask_user', { answered: true, choice: '' }), null);
check('an error result has no summary',
  formatResultSummary('ask_user', { error: { code: 'EBADINPUT', message: 'options required' } }), null);
check('a namespaced tool name is normalized',
  formatResultSummary('functions.ask_user', RESULT), 'main');

console.log(failures ? '  ' + failures + ' failed' : '  all ask card summary assertions passed');
if (failures) process.exitCode = 1;
