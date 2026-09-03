// Unit test for the CLI modal's ANSI output stripping
// (frontend/src/components/chat/utils.js `stripAnsi`).
//
// The CLI modal runs a persistent shell as a piped (non-TTY) child, so
// TUI programs (htop, top, less) emit cursor-positioning and color escape
// codes that are meaningless in a <pre>. stripAnsi must turn that into
// readable plain text: drop color/erase/alternate-screen escapes, turn
// forward cursor moves into newlines so screen rows stay separated, and
// fold carriage-return overwrites.
//
// Pure module, no preact/DOM — runnable directly.

'use strict';

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + JSON.stringify(msg)) : '')); }
}

async function run() {
  const { stripAnsi } = await import('../frontend/src/components/chat/utils.js');

  // 1. Plain text passes through untouched.
  t('plain text unchanged', stripAnsi('hello\nworld') === 'hello\nworld', stripAnsi('hello\nworld'));

  // 2. SGR color codes are dropped.
  t('SGR color dropped', stripAnsi('\x1b[31mred\x1b[0m') === 'red', stripAnsi('\x1b[31mred\x1b[0m'));

  // 3. The exact garbage from the htop bug is gone.
  t('htop color jumble removed', !/\x1b/.test(stripAnsi('\x1b[39;49mSetup\x1b[39;49m')), stripAnsi('\x1b[39;49mSetup\x1b[39;49m'));

  // 4. Forward cursor positioning produces line breaks so rows stay separate.
  const cupped = stripAnsi('\x1b[1;1HRowOne\x1b[2;1HRowTwo\x1b[3;1HRowThree');
  t('CUP moves become newlines', cupped === 'RowOne\nRowTwo\nRowThree', cupped);

  // 5. Cursor-down (ESC[B) advances the row.
  const down = stripAnsi('A\x1b[1;1HB\x1b[B');
  t('cursor down advances a line', /\n/.test(stripAnsi('X\x1b[B')) , stripAnsi('X\x1b[B'));

  // 6. Alternate-screen enter/leave (ESC[?1049h / ESC[?1049l) is dropped.
  t('alt-screen enter dropped', stripAnsi('\x1b[?1049hcontent\x1b[?1049l') === 'content', stripAnsi('\x1b[?1049hcontent\x1b[?1049l'));

  // 7. Erase display (ESC[2J) and erase line (ESC[K) are dropped.
  t('erase codes dropped', stripAnsi('abc\x1b[2J\x1b[Kdef') === 'abcdef', stripAnsi('abc\x1b[2J\x1b[Kdef'));

  // 8. OSC sequences (ESC ] ... BEL) are dropped.
  t('OSC dropped', stripAnsi('\x1b]0;title\x07text') === 'text', stripAnsi('\x1b]0;title\x07text'));

  // 9. Carriage-return overwrite keeps the later text and trims the rest.
  t('CR overwrite', stripAnsi('12345\rAB') === 'AB345', stripAnsi('12345\rAB'));
  t('CR longer replacement', stripAnsi('abc\rABCDE') === 'ABCDE', stripAnsi('abc\rABCDE'));

  // 10. A representative htop screen: rows remain on separate lines and no
  //     control codes survive. Building the string from CUP-positioned rows.
  const htopLike =
    '\x1b[?1049h' +                                   // enter alt screen
    '\x1b[2J\x1b[H' +                                 // clear + home
    '\x1b[0;1mTasks:\x1b[0m 115' + '\n'.repeat(0) +    // no-op
    '\x1b[3;1H    PID USER' +                          // header row 3
    '\x1b[4;1H3697815 ubuntu' +                       // process row 4
    '\x1b[5;1H35903 ubuntu' +                         // process row 5
    '\x1b[?1049l';                                    // leave alt screen
  const cleaned = stripAnsi(htopLike);
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  t('htop rows on separate lines', cleaned.indexOf('PID') < cleaned.indexOf('3697815') && cleaned.indexOf('3697815') < cleaned.indexOf('35903'), JSON.stringify(lines));
  t('htop screen has no escape codes', !/\x1b/.test(cleaned), JSON.stringify(cleaned));
  t('htop content survives', /Tasks:/.test(cleaned) && /3697815/.test(cleaned), JSON.stringify(cleaned));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
