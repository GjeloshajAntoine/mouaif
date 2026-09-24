// Unit tests for the CLI modal's suggestion row and key row — the two
// affordances that make the terminal usable on a phone, where the soft keyboard
// has no Escape, Tab, arrow or Ctrl key and re-typing a long command is the
// expensive part.
//
// What this guards, byte for byte:
//
//   * `CLI_KEYS` — every key is a *raw* sequence with no line terminator. A
//     terminator on `\x03` sends Ctrl+C *and* Enter, which answers a second
//     prompt the user never saw; that is the one mistake that must not be
//     introduced by "tidying" the table.
//   * `historyFromOutput` / `suggestionsFor` — the suggestion row is built from
//     the session's own echo lines and the project's own listing: newest first,
//     de-duped, prefix matches before substring matches, and never a chip equal
//     to what is already in the field.
//
// Both modules are pure (no Preact, no DOM), so they run directly.
'use strict';

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + JSON.stringify(msg)) : '')); }
}

async function run() {
  const keys = await import('../frontend/src/components/chat/cliKeys.js');
  const suggest = await import('../frontend/src/components/chat/cliSuggest.js');
  const { CLI_KEYS, keyById, keepEditorFocus } = keys;
  const { MAX_SUGGESTIONS, commandFromEchoLine, historyFromOutput, suggestionsFor } = suggest;

  // ---- 1. The key row -------------------------------------------------

  const byId = {};
  for (const k of CLI_KEYS) byId[k.id] = k;

  t('the row offers the six keys a phone keyboard lacks',
    CLI_KEYS.length === 6
    && ['esc', 'tab', 'up', 'down', 'int', 'eof'].every((id) => byId[id]),
    CLI_KEYS.map((k) => k.id));

  t('every key has a sequence and a label', CLI_KEYS.every((k) =>
    typeof k.seq === 'string' && k.seq.length > 0 && typeof k.label === 'string' && k.label.length > 0));

  // The sequences themselves. These are what a real terminal sends, so the
  // assertion is written as the literal bytes rather than as a formula.
  t('Esc is a bare ESC', byId.esc.seq === '\x1b', JSON.stringify(byId.esc.seq));
  t('Tab is HT', byId.tab.seq === '\t', JSON.stringify(byId.tab.seq));
  t('Up is the VT cursor-up sequence', byId.up.seq === '\x1b[A', JSON.stringify(byId.up.seq));
  t('Down is the VT cursor-down sequence', byId.down.seq === '\x1b[B', JSON.stringify(byId.down.seq));
  t('Ctrl+C is ETX', byId.int.seq === '\x03', JSON.stringify(byId.int.seq));
  t('Ctrl+D is EOT', byId.eof.seq === '\x04', JSON.stringify(byId.eof.seq));

  // No terminator anywhere: the client sends every key with `raw: true`, and
  // these bytes are exactly what must land on the child's stdin.
  t('no key carries a line terminator', CLI_KEYS.every((k) => k.seq.indexOf('\n') === -1 && k.seq.indexOf('\r') === -1));

  // The arrow keys are the one pair that *are* an escape sequence: they must
  // start with ESC, or a shell's readline reads them as `[` `A`.
  t('the arrow keys are escape sequences', byId.up.seq[0] === '\x1b' && byId.down.seq[0] === '\x1b');

  t('every key is titled well enough to be tapped blind', CLI_KEYS.every((k) =>
    typeof k.title === 'string' && k.title.length > 8));

  t('keyById finds a key and answers null for an unknown id',
    keyById('tab') === byId.tab && keyById('nope') === null);

  // A single label per key, so the row is a fixed six buttons on a 360 px
  // screen. Two keys sharing a label would be indistinguishable to a sighted
  // user even though their sequences differ.
  const labels = CLI_KEYS.map((k) => k.label);
  t('labels are unique', new Set(labels).size === labels.length, labels);

  // `shellOnly` is the row's dimming rule: only Tab and the two arrows are a
  // *shell's* readline keys. Esc, ^C and ^D mean the same thing to a program,
  // and ^C is the key a waiting program needs, so they must not be marked.
  const shellOnly = CLI_KEYS.filter((k) => k.shellOnly).map((k) => k.id);
  t('exactly Tab, Up and Down are marked shell-only',
    JSON.stringify(shellOnly) === JSON.stringify(['tab', 'up', 'down']), shellOnly);
  t('the interrupt and EOF keys are never dimmed', !byId.int.shellOnly && !byId.eof.shellOnly && !byId.esc.shellOnly);

  // keepEditorFocus — the mousedown guard that keeps the soft keyboard open.
  let prevented = 0;
  keepEditorFocus({ preventDefault: () => { prevented++; } });
  keepEditorFocus(null);      // a key event with no target must not throw
  keepEditorFocus(undefined);
  t('keepEditorFocus cancels the default and survives a null event', prevented === 1, prevented);

  // ---- 2. The echo line ----------------------------------------------

  t('the prompt mark is stripped', commandFromEchoLine('\u276F ls -la') === 'ls -la', commandFromEchoLine('\u276F ls -la'));
  t('a bare prompt line is not a command', commandFromEchoLine('\u276F') === '', commandFromEchoLine('\u276F'));
  t('an empty line is not a command', commandFromEchoLine('\u276F   ') === '', commandFromEchoLine('\u276F   '));
  t('shell output is not a command', commandFromEchoLine('total 4') === '', commandFromEchoLine('total 4'));
  t('a CR-terminated echo line still parses', commandFromEchoLine('\u276F pwd\r') === 'pwd');
  t('a non-string line is not a command', commandFromEchoLine(null) === '' && commandFromEchoLine(7) === '');

  // ---- 3. History from the rendered screen -----------------------------
  //
  // The rendered frame is what the reader is looking at, so it is the honest
  // source. Newest first, de-duped, and the leading indent a shell prompt adds
  // is not part of the command.
  const screen = [
    'mouaif 0.3.5',
    '\u276F ls',
    'bin  src  package.json',
    '\u276F npm run test:cli',
    '\u276F ls',
    'bin  src  package.json'
  ].join('\n');
  const hist = historyFromOutput(screen);
  t('history is newest first, de-duped', JSON.stringify(hist) === JSON.stringify(['ls', 'npm run test:cli']), hist);

  t('history of empty output is empty', historyFromOutput('').length === 0 && historyFromOutput(null).length === 0);
  t('history is capped', historyFromOutput(
    Array.from({ length: 200 }, (_, i) => '\u276F cmd' + i + '\n').join('')
  ).length === 40);

  // ---- 4. The suggestion row ------------------------------------------

  const entries = [
    { name: 'src', type: 'dir' },
    { name: 'bin', type: 'dir' },
    { name: 'package.json', type: 'file' },
    { name: '.gitignore', type: 'file' }
  ];

  const empty = suggestionsFor({ draft: '', history: hist, entries });
  t('an empty field offers history first, then names',
    JSON.stringify(empty.map((s) => s.text)) === JSON.stringify(['ls', 'npm run test:cli', 'src/', 'bin/', 'package.json']),
    empty);
  t('a directory carries a trailing slash and a file does not',
    empty.find((s) => s.text === 'src/').kind === 'file' && empty.some((s) => s.text === 'package.json'));
  t('hidden dotfiles are not offered', !empty.some((s) => s.text === '.gitignore'));

  // Prefix matches lead: typing `ls` must offer the history entry `ls`… which
  // is equal to the draft, so the file that merely contains `ls` is what shows.
  const draftLs = suggestionsFor({ draft: 'ls', history: hist, entries });
  t('a chip equal to the draft is dropped', !draftLs.some((s) => s.text === 'ls'), draftLs);
  t('the row still filters to matching candidates', draftLs.every((s) => s.text.toLowerCase().indexOf('ls') !== -1), draftLs);

  const prefix = suggestionsFor({ draft: 'p', history: ['npm test', 'pnpm i', 'git push'], entries });
  t('a prefix match sorts before a substring match, source order inside a rank',
    JSON.stringify(prefix.map((s) => s.text)) === JSON.stringify(['pnpm i', 'package.json', 'npm test', 'git push']),
    prefix);
  t('and the two ranks are really ordered by prefix',
    prefix.slice(0, 2).every((s) => s.text.toLowerCase().startsWith('p'))
    && prefix.slice(2).every((s) => !s.text.toLowerCase().startsWith('p')));

  const noMatch = suggestionsFor({ draft: 'zzzz', history: hist, entries });
  t('a draft nothing matches yields no chips', noMatch.length === 0, noMatch);

  t('a listing that has not answered invents no chips',
    JSON.stringify(suggestionsFor({ draft: '', history: ['pwd'], entries: null }).map((s) => s.text)) === JSON.stringify(['pwd']));

  const capped = suggestionsFor({
    draft: '',
    history: Array.from({ length: 50 }, (_, i) => 'cmd' + i),
    entries
  });
  t('the row is capped', capped.length === MAX_SUGGESTIONS, capped.length);

  t('no chip is ever empty', suggestionsFor({ draft: '', history: [''], entries: [{ name: '', type: 'file' }] }).length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
