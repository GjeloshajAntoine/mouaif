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
//   * `keyPayload` — at the shell, Tab / arrows / Page keys / Esc edit the
//     prompt's own buffer and write nothing; while a program owns stdin every
//     key writes its sequence (application-mode arrows under DECCKM).
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
  const { CLI_KEYS, cursorKeyMode, keyById, keyForEvent, keepEditorFocus, keyPayload, lineEditorState, splitTypedTab } = keys;
  const { MAX_SUGGESTIONS, MAX_HISTORY, rememberCommand, suggestionsFor, completeLocally, completionReport, listDirFor, relativeDir, stepHistory } = suggest;

  // ---- 1. The key row -------------------------------------------------

  const byId = {};
  for (const k of CLI_KEYS) byId[k.id] = k;

  t('the rows offer the twelve keys a phone keyboard lacks',
    CLI_KEYS.length === 12
    && ['esc', 'tab', 'int', 'eof', 'susp', 'ff', 'left', 'up', 'down', 'right', 'pgup', 'pgdn'].every((id) => byId[id]),
    CLI_KEYS.map((k) => k.id));
  t('two rows of six, so each fits a 360 px column at 44 px a key',
    CLI_KEYS.filter((k) => k.row === 1).length === 6 && CLI_KEYS.filter((k) => k.row === 2).length === 6);

  t('every key has a sequence and a label', CLI_KEYS.every((k) =>
    typeof k.seq === 'string' && k.seq.length > 0 && typeof k.label === 'string' && k.label.length > 0));

  // The sequences themselves. These are what a real terminal sends, so the
  // assertion is written as the literal bytes rather than as a formula.
  t('Esc is a bare ESC', byId.esc.seq === '\x1b', JSON.stringify(byId.esc.seq));
  t('Tab is HT', byId.tab.seq === '\t', JSON.stringify(byId.tab.seq));
  t('Up is the VT cursor-up sequence', byId.up.seq === '\x1b[A' && byId.up.app === '\x1bOA', JSON.stringify(byId.up));
  t('Down is the VT cursor-down sequence', byId.down.seq === '\x1b[B' && byId.down.app === '\x1bOB', JSON.stringify(byId.down));
  t('Right is the VT cursor-right sequence', byId.right.seq === '\x1b[C' && byId.right.app === '\x1bOC');
  t('Left is the VT cursor-left sequence', byId.left.seq === '\x1b[D' && byId.left.app === '\x1bOD');
  t('PgUp / PgDn are the VT page sequences', byId.pgup.seq === '\x1b[5~' && byId.pgdn.seq === '\x1b[6~');
  t('Ctrl+C is ETX', byId.int.seq === '\x03', JSON.stringify(byId.int.seq));
  t('Ctrl+D is EOT', byId.eof.seq === '\x04', JSON.stringify(byId.eof.seq));
  t('Ctrl+Z is SUB', byId.susp.seq === '\x1a', JSON.stringify(byId.susp.seq));
  t('Ctrl+L is FF', byId.ff.seq === '\x0c', JSON.stringify(byId.ff.seq));

  // No terminator anywhere: the client sends every key with `raw: true`, and
  // these bytes are exactly what must land on the child's stdin.
  t('no key carries a line terminator', CLI_KEYS.every((k) => !/[\r\n]/.test(k.seq) && !/[\r\n]/.test(k.app || '')));

  t('every key is titled well enough to be tapped blind', CLI_KEYS.every((k) =>
    typeof k.title === 'string' && k.title.length > 8));

  t('keyById finds a key and answers null for an unknown id',
    keyById('tab') === byId.tab && keyById('nope') === null);

  const labels = CLI_KEYS.map((k) => k.label);
  t('labels are unique', new Set(labels).size === labels.length, labels);

  // The control keys mean the same to a shell and a program: never local.
  t('^C, ^D, ^Z and ^L always write their byte',
    ['int', 'eof', 'susp', 'ff'].every((id) => !byId[id].local));

  // keepEditorFocus — the mousedown guard that keeps the soft keyboard open.
  let prevented = 0;
  keepEditorFocus({ preventDefault: () => { prevented++; } });
  keepEditorFocus(null);      // a key event with no target must not throw
  keepEditorFocus(undefined);
  t('keepEditorFocus cancels the default and survives a null event', prevented === 1, prevented);

  // ---- 2. What a key tap writes ----------------------------------------
  //
  // At the shell, the field is a local line buffer: Tab / arrows / Page keys /
  // Esc edit it (or scroll the output) and write nothing. While a program owns
  // stdin, every key writes its bytes — that is what makes `less` or `top`
  // drivable from a phone.

  const shell = { program: false };
  const prog = { program: true };
  const local = (id) => keyPayload(byId[id], shell);
  t('at the shell, Tab completes locally and writes nothing', local('tab').seq === '' && local('tab').local === 'complete');
  t('at the shell, ↑/↓ recall locally', local('up').local === 'history-up' && local('down').local === 'history-down' && local('up').seq === '');
  t('at the shell, ←/→ move the caret locally', local('left').local === 'caret-left' && local('right').local === 'caret-right');
  t('at the shell, PgUp/PgDn scroll the output', local('pgup').local === 'page-up' && local('pgdn').local === 'page-down');
  t('at the shell, Esc clears the field instead of arming readline\'s Meta prefix',
    local('esc').local === 'clear' && local('esc').seq === '');
  const intDraft = keyPayload(byId.int, shell);
  t('^C sends ETX and discards the draft', intDraft.seq === '\x03' && intDraft.clearDraft === true && !intDraft.local, intDraft);
  t('^D, ^Z, ^L write their byte at the shell and keep the draft',
    ['eof', 'susp', 'ff'].every((id) => local(id).seq === byId[id].seq && !local(id).clearDraft && !local(id).local));

  t('to a program, every key writes its sequence',
    CLI_KEYS.every((k) => keyPayload(k, prog).seq === k.seq && !keyPayload(k, prog).local));
  t('in application cursor mode the arrows use ESC O',
    keyPayload(byId.up, { program: true, appCursor: true }).seq === '\x1bOA'
    && keyPayload(byId.left, { program: true, appCursor: true }).seq === '\x1bOD'
    && keyPayload(byId.pgup, { program: true, appCursor: true }).seq === '\x1b[5~');
  t('no payload ever carries a line terminator',
    CLI_KEYS.every((k) => [shell, prog].every((m) => !/[\r\n]/.test(keyPayload(k, m).seq))));
  t('a missing key writes nothing', keyPayload(null).seq === '' && keyPayload(null).local === null);
  t('no mode given means the shell', keyPayload(byId.tab).local === 'complete');

  // Hardware keys map onto the same table; modified keys and Escape do not
  // (Shift+Tab leaves the prompt, Escape closes the sheet).
  t('hardware Tab and arrows map to their row keys',
    keyForEvent({ key: 'Tab' }) === byId.tab && keyForEvent({ key: 'ArrowUp' }) === byId.up
    && keyForEvent({ key: 'PageDown' }) === byId.pgdn);
  t('Shift+Tab, Ctrl+arrow and Escape are not mapped',
    keyForEvent({ key: 'Tab', shiftKey: true }) === null && keyForEvent({ key: 'ArrowUp', ctrlKey: true }) === null
    && keyForEvent({ key: 'Escape' }) === null && keyForEvent(null) === null);

  // DECCKM, split across chunks like the bracketed-paste markers.
  let ck = cursorKeyMode('', 'less output\x1b[?1h\x1b=');
  t('ESC[?1h switches the arrows to application mode', ck.app === true, ck);
  ck = cursorKeyMode(ck.tail, 'more text');
  t('a chunk without the switch leaves the mode unknown', ck.app === null, ck);
  const ckA = cursorKeyMode('', 'bye\x1b[?');
  const ckB = cursorKeyMode(ckA.tail, '1l$ ');
  t('a DECCKM switch cut across chunks is still seen', ckA.app === null && ckB.app === false, [ckA, ckB]);

  // A phone keyboard's Tab key types a literal HT into the field instead of
  // firing a Tab keydown; the prompt splits it off and completes the text
  // before it, keeping what followed it in the field.
  t('no tab in the field → nothing to split', splitTypedTab('npm ru') === null && splitTypedTab('') === null && splitTypedTab(null) === null);
  const typedEnd = splitTypedTab('npm ru\t');
  t('a typed tab at the end splits the text before it from the rest',
    typedEnd && typedEnd.before === 'npm ru' && typedEnd.rest === '', typedEnd);
  const typedMid = splitTypedTab('ls sr\tc/x');
  t('a tab typed mid-line keeps what followed it',
    typedMid && typedMid.before === 'ls sr' && typedMid.rest === 'c/x', typedMid);
  const typedMany = splitTypedTab('\ta\tb');
  t('a lone tab completes an empty line; further tabs are dropped',
    typedMany && typedMany.before === '' && typedMany.rest === 'ab', typedMany);

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

  // ---- 6. Tab: completion in the field -----------------------------------
  //
  // Tab used to flush the draft onto the shell's readline line and clear the
  // box; it now completes *in the field*, so nothing the user typed is lost and
  // nothing is sent until Enter.

  const cHist = ['npm run test:cli', 'npm run build', 'git status', 'git checkout main'];
  const cEntries = [
    { name: 'src', type: 'dir' },
    { name: 'scripts', type: 'dir' },
    { name: 'package.json', type: 'file' },
    { name: 'package-lock.json', type: 'file' }
  ];

  t('an empty line completes nothing', completeLocally('', cHist, cEntries) === null);

  // The line phase: a history command that extends what is typed.
  t('a unique command prefix completes the whole line in place',
    completeLocally('git chec', cHist, cEntries) === 'git checkout main',
    completeLocally('git chec', cHist, cEntries));
  t('several matching commands settle on their common prefix, in the field',
    completeLocally('npm ru', cHist, cEntries) === 'npm run ',
    completeLocally('npm ru', cHist, cEntries));
  t('a line equal to a command is not "completed" to itself',
    completeLocally('git status', cHist, cEntries) === null,
    completeLocally('git status', cHist, cEntries));

  // The word phase: only reached when no history command matches the line. The
  // listing is one level deep, so `src` after `cd ` completes the word, not a
  // nested path.
  t('a name prefix completes the trailing word, keeping the rest of the line',
    completeLocally('ls scr', cHist, cEntries) === 'ls scripts/',
    completeLocally('ls scr', cHist, cEntries));
  t('several matching names settle on their common prefix',
    completeLocally('ls pac', cHist, cEntries) === 'ls package',
    completeLocally('ls pac', cHist, cEntries));
  t('a unique name completes whole',
    completeLocally('cat pack', cHist, cEntries) === 'cat package',
    completeLocally('cat pack', cHist, cEntries));
  t('a directory name adds its trailing slash, so the completion differs from the word',
    completeLocally('ls src', cHist, cEntries) === 'ls src/',
    completeLocally('ls src', cHist, cEntries));
  t('nothing matching leaves the text untouched',
    completeLocally('zzzz', cHist, cEntries) === null);
  t('a listing that has not answered completes from history only',
    completeLocally('git ch', cHist, null) === 'git checkout main',
    completeLocally('git ch', cHist, null));

  // The field ends up holding the completion — never empty.
  const completed = completeLocally('npm ru', cHist, cEntries);
  t('completion is never an emptied field',
    typeof completed === 'string' && completed.length >= 'npm ru'.length, completed);

  // ---- 6b. Nested paths: completing *inside* a listed directory ----------
  //
  // The top-level listing can never answer `src/comp` — that is Tab's "it only
  // completes some things". The directory the user completed into answers
  // instead, and only for words that lie inside it.
  const srcDir = { relDir: 'src', names: ['components/', 'styles.css', 'index.js'] };

  t('a path inside the listed directory completes from its children',
    completeLocally('ls src/comp', cHist, cEntries, srcDir) === 'ls src/components/',
    completeLocally('ls src/comp', cHist, cEntries, srcDir));
  t('several children settle on their common prefix',
    completeLocally('cat src/i', cHist, cEntries, { relDir: 'src', names: ['index.js'] }) === 'cat src/index.js',
    completeLocally('cat src/i', cHist, cEntries, { relDir: 'src', names: ['index.js'] }));
  t('a deeper path keeps walking forward, one step per Tab',
    completeLocally('ls src/styles.c', cHist, cEntries, srcDir) === 'ls src/styles.css',
    completeLocally('ls src/styles.c', cHist, cEntries, srcDir));
  t('the directory listing wins over the top level for a path inside it',
    completeLocally('ls src/p', cHist, cEntries, { relDir: 'src', names: ['package.json'] }) === 'ls src/package.json',
    completeLocally('ls src/p', cHist, cEntries, { relDir: 'src', names: ['package.json'] }));
    t('a word outside the listed directory still uses the top level',
    completeLocally('ls scr', cHist, cEntries, srcDir) === 'ls scripts/',
    completeLocally('ls scr', cHist, cEntries, srcDir));
  t('a path that matches nothing changes nothing',
    completionReport('ls src/zzz', cHist, cEntries, srcDir).reason === 'none',
    completionReport('ls src/zzz', cHist, cEntries, srcDir));
  t('with no directory listed, a nested path falls back to the top level',
    completeLocally('ls src/comp', cHist, cEntries, null) === null);
  t('a history command still wins over a directory listing',
    completeLocally('npm ru', cHist, cEntries, { relDir: 'npm', names: ['run'] }) === 'npm run ',
    completeLocally('npm ru', cHist, cEntries, { relDir: 'npm', names: ['run'] }));

  // ---- 6c. Naming a folder, and typing the slash yourself ---------------
  //
  // The case a phone user reaches first: type a folder's name and press Tab to
  // see inside it, or type `frontend/` and press Tab. Both used to fail — `src`
  // only ever completed its slash, and a word ending in `/` was refused outright.
  t('a folder name completes to the folder itself',
    completeLocally('cd src', cHist, cEntries) === 'cd src/',
    completeLocally('cd src', cHist, cEntries));
  t('...keeping the command and the rest of the line',
    completeLocally('las frontend', cHist, cEntries, { relDir: 'frontend', names: [] }) === 'las frontend/',
    completeLocally('las frontend', cHist, cEntries, { relDir: 'frontend', names: [] }));
  t('a word that is already a listed folder keeps every byte before it',
    completeLocally('ls src/', cHist, cEntries, srcDir) === 'ls src/',
    completeLocally('ls src/', cHist, cEntries, srcDir));
  t('...and reports no change rather than rewriting the line',
    completionReport('ls src/', cHist, cEntries, srcDir).changed === false);
  t('a folder completes to its slash once it has been listed',
    completeLocally('cd frontend', [], [{ name: 'frontend', type: 'dir' }], null) === 'cd frontend/',
    completeLocally('cd frontend', [], [{ name: 'frontend', type: 'dir' }], null));

  // listDirFor — which directory a Tab should list, derived from the text the
  // user has, with a slash as the only claim that a segment is a directory.
  t('a word that is a folder names that folder',
    listDirFor('frontend/', null) === 'frontend', listDirFor('frontend/', null));
  t('...with its command in front of it',
    listDirFor('ls frontend/', null) === 'frontend', listDirFor('ls frontend/', null));
  t('a nested path names the directory the path lives in',
    listDirFor('git add src/components/', null) === 'src/components', listDirFor('git add src/components/', null));
  t('a path being typed names the directory it is inside',
    listDirFor('ls src/comp', null) === 'src', listDirFor('ls src/comp', null));
  t('a bare name has no directory part',
    listDirFor('cd src', null) === null, listDirFor('cd src', null));
  t('a bare name with no slash asks for no listing',
    listDirFor('ls package.json', null) === null, listDirFor('ls package.json', null));
  t('an empty line asks for no directory', listDirFor('', null) === null);
  t('a leading slash is not a directory to list', listDirFor('/usr', null) === null);
  t("a './' prefix is dropped, so the path matches the listing",
    listDirFor('ls ./src/comp', null) === 'src', listDirFor('ls ./src/comp', null));
  t('an absolute path stays absolute',
    listDirFor('ls /home/me/app/src/co', null) === '/home/me/app/src',
    listDirFor('ls /home/me/app/src/co', null));
  t('a trailing slash does not leave a trailing separator on the directory',
    listDirFor('ls deep/nested/', null) === 'deep/nested', listDirFor('ls deep/nested/', null));
  t('the directory already listed is not re-requested',
    listDirFor('cd src/comp', { relDir: 'src', names: [] }) === null,
    listDirFor('cd src/comp', { relDir: 'src', names: [] }));
  t('...nor is one the user has just named',
    listDirFor('cd src/', { relDir: 'src', names: [] }) === null,
    listDirFor('cd src/', { relDir: 'src', names: [] }));

  // relativeDir — the path a listing request is built from.
  t('a directory under the project root is project-relative',
    relativeDir('', 'src') === 'src', relativeDir('', 'src'));
  t('a directory under a listed directory keeps the prefix',
    relativeDir('src', 'components') === 'src/components', relativeDir('src', 'components'));
  t('an absolute reference stays absolute',
    relativeDir('/home/me/app', 'src') === '/home/me/app/src', relativeDir('/home/me/app', 'src'));
  t('a trailing slash on the reference is not doubled',
    relativeDir('src/', 'components') === 'src/components', relativeDir('src/', 'components'));
  t('no name means no path', relativeDir('src', '') === null);

  // ---- 7. ↑/↓: recall in the field ---------------------------------------

  t('↑ with no history leaves the field alone', stepHistory([], -1, 'up').text === null);
  t('↑ from a fresh line walks to the newest command',
    JSON.stringify(stepHistory(cHist, -1, 'up')) === JSON.stringify({ index: 0, text: 'npm run test:cli' }),
    stepHistory(cHist, -1, 'up'));
  t('↑ again walks to the next older command',
    stepHistory(cHist, 0, 'up').text === 'npm run build');
  t('↑ stops at the oldest command',
    stepHistory(cHist, cHist.length - 1, 'up').text === cHist[cHist.length - 1]);
  t('↓ walks back toward the newest',
    stepHistory(cHist, 1, 'down').text === 'npm run test:cli');
  t('↓ past the newest returns an empty line and stops walking',
    JSON.stringify(stepHistory(cHist, 0, 'down')) === JSON.stringify({ index: -1, text: '' }));
  t('↓ with a fresh line does nothing (only ↑ starts a recall)',
    stepHistory(cHist, -1, 'down').text === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
