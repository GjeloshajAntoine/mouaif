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
  const { stripAnsi, CliScreen } = await import('../frontend/src/components/chat/utils.js');

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

  // --- CliScreen — stateful streaming decoder -------------------------------
  // The CLI modal receives output as a stream of SSE frames. A full-screen
  // TUI's escape codes can be split across frame boundaries, and each redraw
  // must replace its frame in place. These drive the stateful CliScreen used
  // by CliModal (the stateless stripAnsi above cannot handle split sequences).

  // 11. A sequence split across two frames must consume as one (no `[5;3H` leak).
  const sc1 = new CliScreen();
  sc1.write('A\x1b[');   // frame 1 ends mid-CSI
  sc1.write('5;3H B');   // frame 2 completes it
  const splitOut = sc1.render();
  t('split escape consumed', !/5;3H|\[5/.test(splitOut), JSON.stringify(splitOut));
  t('split escape no ESC leak', !/\x1b/.test(splitOut), JSON.stringify(splitOut));

  // 12. A full-screen redraw (home + rewrite) replaces, not appends.
  const sc2 = new CliScreen();
  sc2.write('\x1b[?1049h\x1b[2J\x1b[H');  // enter alt screen, clear, home
  sc2.write('AAA\r\nBBB\r\nCCC');
  sc2.write('\x1b[H');
  sc2.write('AAA\r\nBBB\r\nDDD');
  sc2.write('\x1b[H');
  sc2.write('XXX\r\nYYY\r\nZZZ');
  const redrawOut = sc2.render();
  t('redraw replaces in place', redrawOut === 'XXX\nYYY\nZZZ', JSON.stringify(redrawOut));
  t('redraw no old rows', (redrawOut.match(/AAA|BBB|DDD/g) || []).length === 0, JSON.stringify(redrawOut));

  // 13. Ordinary scrollback output still grows (not clamped to one frame).
  const sc3 = new CliScreen();
  sc3.write('line1\r\nline2\nline3');
  sc3.write('\nline4');
  const growOut = sc3.render();
  t('scrollback grows', /line1/.test(growOut) && /line2/.test(growOut) && /line3/.test(growOut) && /line4/.test(growOut), JSON.stringify(growOut));

  // 14. Cursor positioning in a fresh frame is honoured with no leak.
  const sc4 = new CliScreen();
  sc4.write('row:');
  sc4.write('\x1b[2;5Hdone');
  const posOut = sc4.render();
  t('cursor position honoured', /done/.test(posOut) && !/\x1b/.test(posOut), JSON.stringify(posOut));

  // 15. `isFullScreen` tracks alternate-screen enter/leave so the modal can
  //     preserve the scroll position for a TUI redraw instead of pinning.
  const sc5 = new CliScreen();
  t('not full-screen by default', sc5.isFullScreen === false);
  sc5.write('\x1b[?1049h');           // enter alt screen (htop)
  t('full-screen after alt enter', sc5.isFullScreen === true);
  sc5.write('\x1b[?1049l');           // leave alt screen
  t('not full-screen after alt leave', sc5.isFullScreen === false);

  // 16. Split tokens: every escape sequence must render the same no matter
  //     where the SSE frame boundary falls — including a lone trailing ESC,
  //     which used to be dropped so the rest (`[31m`, `]0;title`) leaked as
  //     text. Each sample is split at every pair of positions (three chunks)
  //     and also fed one code point at a time.
  const splitSamples = {
    'SGR colour': 'a\x1b[31mred\x1b[0m b',
    'cursor position': '\x1b[2;5Hxy\x1b[K',
    'OSC title (BEL)': '\x1b]0;title\x07after',
    'OSC title (ESC \\)': '\x1b]0;title\x1b\\after',
    'OSC 8 hyperlink': '\x1b]8;;http://a\x1b\\link\x1b]8;;\x1b\\ end',
    'charset designator': '\x1b(Bplain',
    'keypad modes': '\x1b=\x1b>ok',
    'bracketed paste': '\x1b[?2004hprompt$ ',
    'DCS string': '\x1bP1$r0m\x1b\\done',
    'APC string': '\x1b_hidden\x1b\\vis',
    '8-bit CSI': 'x\u009b31my',
    'emoji next to SGR': 'ok \u{1F389}\x1b[1m\u2713\x1b[0m'
  };
  const expected = {
    'SGR colour': 'ared b', 'cursor position': '    xy', 'OSC title (BEL)': 'after',
    'OSC title (ESC \\)': 'after', 'OSC 8 hyperlink': 'link end', 'charset designator': 'plain',
    'keypad modes': 'ok', 'bracketed paste': 'prompt$', 'DCS string': 'done', 'APC string': 'vis',
    '8-bit CSI': 'xy', 'emoji next to SGR': 'ok \u{1F389}\u2713'
  };
  for (const [name, s] of Object.entries(splitSamples)) {
    const whole = new CliScreen(); whole.write(s);
    t(name + ': whole chunk renders clean', whole.render() === expected[name], whole.render());
    const cps = Array.from(s);
    let firstBad = null;
    for (let x = 1; x < cps.length && !firstBad; x++) {
      for (let y = x; y < cps.length && !firstBad; y++) {
        const sc = new CliScreen();
        sc.write(cps.slice(0, x).join('')); sc.write(cps.slice(x, y).join('')); sc.write(cps.slice(y).join(''));
        if (sc.render() !== expected[name]) firstBad = { x, y, got: sc.render() };
      }
    }
    t(name + ': identical at every split point', !firstBad, firstBad);
    const one = new CliScreen(); for (const ch of cps) one.write(ch);
    t(name + ': identical fed one code point at a time', one.render() === expected[name], one.render());
  }

  // 17. A control string that never terminates must not swallow every later
  //     byte: past the pending cap it is abandoned and output resumes.
  const runaway = new CliScreen();
  runaway.write('\x1b]0;');
  for (let k = 0; k < 20; k++) runaway.write('x'.repeat(1000));
  runaway.write('\nVISIBLE');
  t('an unterminated OSC is abandoned past the cap', /VISIBLE/.test(runaway.render()), runaway.render().slice(-40));

  // 18. A malformed CSI (a byte that cannot belong to one) is abandoned
  //     instead of eating the text that follows.
  const malformed = new CliScreen(); malformed.write('a\x1b[1\u00e9b');
  t('a malformed CSI does not eat following text', malformed.render() === 'a\u00e9b', malformed.render());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
