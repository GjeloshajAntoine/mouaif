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
//   * `keyPayload` — Tab and the arrows carry the typed draft onto the shell's
//     line, so `npm ru` + Tab completes `npm ru`, not an empty line.
//   * `lineEditorState` — who owns stdin, read from the shell's own
//     bracketed-paste markers, including a marker cut across two chunks.
//   * `rememberCommand` / `suggestionsFor` — the suggestion row is built from
//     the commands sent to the shell (never an answer to a program's prompt,
//     which may be a password) and the project's own listing: newest first,
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
  const { CLI_KEYS, keyById, keepEditorFocus, keyPayload, lineEditorState } = keys;
  const { MAX_SUGGESTIONS, MAX_HISTORY, rememberCommand, suggestionsFor } = suggest;

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

  // ---- 2. What a key tap writes ----------------------------------------
  //
  // The field is a local line buffer: nothing typed reaches the shell until
  // Enter. Tab with a draft must complete *the draft*, so the readline keys
  // carry it with them in one raw write and hand the field back empty.

  const tabDraft = keyPayload(byId.tab, 'npm ru');
  t('Tab sends the draft and the Tab together', tabDraft.seq === 'npm ru\t' && tabDraft.clearDraft === true, tabDraft);
  const tabEmpty = keyPayload(byId.tab, '');
  t('Tab on an empty field is a bare Tab and clears nothing', tabEmpty.seq === '\t' && tabEmpty.clearDraft === false, tabEmpty);
  const upDraft = keyPayload(byId.up, 'git');
  t('Up carries the draft onto the shell line too', upDraft.seq === 'git\x1b[A' && upDraft.clearDraft === true, upDraft);
  const intDraft = keyPayload(byId.int, 'rm -rf build');
  t('^C discards the draft without sending it', intDraft.seq === '\x03' && intDraft.clearDraft === true, intDraft);
  const escDraft = keyPayload(byId.esc, 'q');
  t('Esc and ^D leave the draft alone', escDraft.seq === '\x1b' && !escDraft.clearDraft
    && keyPayload(byId.eof, 'x').seq === '\x04' && !keyPayload(byId.eof, 'x').clearDraft, escDraft);
  t('no payload ever carries a line terminator',
    CLI_KEYS.every((k) => !/[\r\n]/.test(keyPayload(k, 'abc').seq)));
  t('a missing key writes nothing', keyPayload(null, 'x').seq === '');

  // ---- 3. Who owns stdin -------------------------------------------------
  //
  // bash/zsh switch bracketed paste on at their prompt and off when a command
  // starts. This is real bash output captured from a session.
  const bashOut = '\x1b[?2004hme@host:~$ read -s -p "pw: " x\r\n\x1b[?2004l\rpw: ';
  let st = lineEditorState('', bashOut);
  t('the last marker wins: a command started, so a program owns stdin', st.state === 'program', st);
  st = lineEditorState(st.tail, 'got\r\n\x1b[?2004hme@host:~$ ');
  t('the shell prompt is back', st.state === 'shell', st);
  st = lineEditorState(st.tail, 'plain output, no markers');
  t('a chunk without a marker leaves the state unknown', st.state === null, st);

  // A marker cut across two chunks is still seen, and exactly once.
  const a = lineEditorState('', 'output\x1b[?20');
  t('half a marker is not a marker', a.state === null, a);
  const b = lineEditorState(a.tail, '04h$ ');
  t('the carried half completes it', b.state === 'shell', b);
  const c = lineEditorState(b.tail, 'more');
  t('a completed marker is not counted again from the carry', c.state === null, c);
  t('the carry stays shorter than a marker', b.tail.length < '\x1b[?2004h'.length, b.tail);

  // ---- 4. What the history keeps -----------------------------------------
  //
  // Only lines sent to the shell are kept. An answer to a program's prompt —
  // `read -s`, sudo, an npm one-time code — must never become a chip.
  let hist = [];
  hist = rememberCommand(hist, 'npm run test:cli', 'shell');
  hist = rememberCommand(hist, 'ls', 'shell');
  t('commands sent to the shell are kept, newest first',
    JSON.stringify(hist) === JSON.stringify(['ls', 'npm run test:cli']), hist);
  t('an answer to a program is not kept', rememberCommand(hist, 'secret123', 'program') === hist);
  t('a line sent while the owner is unknown is not kept', rememberCommand(hist, 'secret123', null) === hist);
  t('a piped session has no prompts, so its lines are commands',
    rememberCommand([], 'pwd', 'piped')[0] === 'pwd');
  t('a blank line is not kept', rememberCommand(hist, '   ', 'shell') === hist);
  t('a history expansion is not kept', rememberCommand(hist, '!!', 'shell') === hist
    && rememberCommand(hist, '!git', 'shell') === hist);
  t('re-sending the newest command changes nothing', rememberCommand(hist, 'ls', 'shell') === hist);
  const moved = rememberCommand(hist, 'npm run test:cli', 'shell');
  t('re-sending an older command moves it to the front, de-duped',
    JSON.stringify(moved) === JSON.stringify(['npm run test:cli', 'ls']), moved);
  let many = [];
  for (let i = 0; i < 200; i++) many = rememberCommand(many, 'cmd' + i, 'shell');
  t('history is capped', many.length === MAX_HISTORY && many[0] === 'cmd199', many.length);

  // ---- 5. The suggestion row ------------------------------------------

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
