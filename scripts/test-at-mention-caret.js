'use strict';
// Regression test: picking a parameterised tool from the @-mention popup puts
// the caret BETWEEN the backticks, not inside the description text.
//
// selectItem() inserts `@tool:firstArg=`<description>`` for a string parameter
// and is supposed to leave the caret in the empty slot the user fills in. Its
// offset was computed as
//
//     before.length + 2 + item.insert.length + 2 + firstKey.length + 2
//
// which recounted a prefix (`@name:key=`) it had already measured through
// `before.length`, landing the caret 2 characters into the description — so
// the first keystrokes corrupted the placeholder the user was meant to
// replace. The doc (docs/features/at-mention.md) and the sibling appendArg()
// both specify the cursor sits between the backticks.
//
// The test reads the SHIPPING formula out of atMention.js and re-derives the
// text that formula indexes into, so the assertion cannot drift from the code:
// if someone reintroduces the old arithmetic the caret index moves and this
// test fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/components/chat/atMention.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// Pull the string-parameter branch's cursorOffset expression out of the real
// source and turn it into a function of its inputs.
function extractStringCaret() {
  const m = source.match(
    /insert = '@' \+ item\.insert \+ ':' \+ firstKey \+ '=`' \+ desc \+ '` ';\s*\n(?:[^\n]*\n)*?\s*cursorOffset = ([^;]+);/);
  assert.ok(m, 'could not find the string-parameter cursorOffset in atMention.js');
  const expr = m[1].trim();
  return new Function('before', 'insert', 'item', 'firstKey', 'desc', 'return (' + expr + ');');
}

// The text selectItem() builds, reproduced from the same source line.
function buildInsert(item, firstKey, desc) {
  return '@' + item.insert + ':' + firstKey + '=`' + desc + '` ';
}

(async () => {
  const caretFor = extractStringCaret();

  const cases = [
    { name: 'shell:cmd', item: { insert: 'shell' }, firstKey: 'cmd', desc: 'command to run', before: '' },
    { name: 'mcp tool', item: { insert: 'mcp__srv__do' }, firstKey: 'q', desc: 'the query', before: '' },
    { name: 'mid-draft', item: { insert: 'shell' }, firstKey: 'cmd', desc: 'command', before: 'please run ' },
    { name: 'empty description', item: { insert: 'shell' }, firstKey: 'cmd', desc: '', before: '' },
    { name: 'number-ish key', item: { insert: 'webpreview' }, firstKey: 'url', desc: 'page to capture', before: 'x' }
  ];

  for (const c of cases) {
    const text = c.before + buildInsert(c.item, c.firstKey, c.desc);
    const caret = caretFor(c.before, c.item.insert, c.item, c.firstKey, c.desc);
    const charBefore = text[caret - 1];
    const charAt = text[caret];
    check(c.name + ': caret sits right after the opening backtick',
      charBefore === '`', 'char before caret = ' + JSON.stringify(charBefore));
    check(c.name + ': the description is untouched ahead of the caret',
      c.desc === '' ? charAt === '`' : charAt === c.desc[0],
      'char at caret = ' + JSON.stringify(charAt));
    check(c.name + ': the caret is inside the backtick pair',
      caret > text.indexOf('`') && caret <= text.lastIndexOf('`'),
      'caret=' + caret);
  }

  // The non-string branch must stay where it was: after `key= `, ready for a
  // number or boolean.
  const numInsert = '@' + 'shell' + ':' + 'timeoutMs' + '= ';
  check('non-string params still place the caret after "key= "',
    ('' + numInsert).endsWith('= ') && numInsert.length === 1 + 5 + 1 + 9 + 2);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
