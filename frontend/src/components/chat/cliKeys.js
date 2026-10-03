// mouaif web — the CLI modal's on-screen key row.
//
// A phone keyboard has letters, digits and Enter, and nothing else a terminal
// needs: no Escape (leave `less`, `vim`, a TUI), no Tab (path and command
// completion), no arrows (the shell's own history), no Ctrl+C (stop the running
// command), no Ctrl+D (end input). On a desktop those keys exist; on a phone the
// modal was a prompt you could only type *new* commands into — an interactive
// program that had printed a question could not be answered with anything but
// words and Enter.
//
// This module is the one table of the keys that row offers, so each sequence
// lives in exactly one place and can be asserted byte for byte.
//
// Every key is sent as a *raw* write (no line terminator — see
// `writeCliCommand` in src/server-handlers-tools.js): appending a newline to
// `\x03` would send Ctrl+C *and* Enter, which answers a second prompt the user
// never saw. `\x1b[A` / `\x1b[B` are the VT sequences a real terminal sends for
// the up/down arrows; on a pty the shell's readline turns them into history.
//
// The row works in two modes, chosen per tap from who owns stdin:
//
//   * **local** — the shell's line editor is waiting (or the session is piped,
//     or nothing has said yet). The command line lives in the modal's own field,
//     so a key with a `local` action edits that field instead of writing to the
//     child: Tab completes and ↑/↓ recall (`completeLocally` / `stepHistory` in
//     ./cliSuggest.js), ←/→ move the caret, PgUp/PgDn scroll the output, and
//     Esc clears the field. Esc is local on purpose: a bare ESC written to
//     readline waits as a Meta prefix and swallows the first letter of the next
//     command (`Esc`, then `ls` → `M-l` + `s`).
//   * **program** — a command is running (the shell switched bracketed paste
//     off) or a full-screen program owns the alternate screen. Every key then
//     writes its sequence, so the arrows, Tab, PgUp/PgDn and Esc reach `less`,
//     `top`, `vim`, an interactive picker — the case a phone has no other way
//     to drive.
//
// Keys without a `local` action (^C, ^D, ^Z, ^L) write their byte in both modes.
// `app` is the cursor key's application-mode form (DECCKM, `ESC[?1h`), which a
// full-screen program may switch on and then expect instead of `ESC[`.
//
// `row` splits the table into the two rows of six the sheet lays out: control
// keys first, then movement — six keys fit a 360 px column even as small
// buttons (see `.cli__key` in frontend/src/chat-composer.css).
//
// The table holds twelve keys plus the two modifiers (`role: 'modifier'` —
// Ctrl and Fn): a phone keyboard has no Escape, Tab, arrows, Page keys or
// function keys, and two small rows are what the sheet shows instead plus the
// two keys that turn the next letter or digit into a control character or a
// function key.
export const CLI_KEYS = [
  { id: 'esc', row: 1, label: 'Esc', title: 'Escape — leave a full-screen program; clears the prompt at the shell', seq: '\x1b', local: 'clear' },
  { id: 'tab', row: 1, label: 'Tab', title: 'Tab — complete a path or command', seq: '\t', local: 'complete' },
  { id: 'int', row: 1, label: '^C', title: 'Ctrl+C — interrupt the running command', seq: '\x03' },
  { id: 'eof', row: 1, label: '^D', title: 'Ctrl+D — end input (EOF)', seq: '\x04' },
  { id: 'susp', row: 1, label: '^Z', title: 'Ctrl+Z — suspend the running command', seq: '\x1a' },
  { id: 'ff', row: 1, label: '^L', title: 'Ctrl+L — clear the screen', seq: '\x0c' },
  // The two modifier keys. They carry no sequence of their own: they *arm* the
  // next thing written, so the rest of the control characters (`^A`, `^E`,
  // `^K`, `^U`, `^W`, `^R`, `^]`…) cost no buttons — see `modifiedSequence` and
  // `applyModifiers` below. They sit at the *end* of each row and render as
  // toggles rather than senders (`role: 'modifier'`), so the row keeps reading
  // left to right as the keys a phone keyboard lacks, plus one that turns the
  // next letter into a control character.
  // The movement keys share the first row, and the two Page keys take the
  // second — the shape the small key row uses at 360 px (see `.cli__key` in
  // frontend/src/chat-composer.css). Ctrl sits between the control keys and the
  // arrows, Fn between the arrows and the pages.
  { id: 'ctrl', row: 1, role: 'modifier', label: 'Ctrl', title: 'Ctrl — tap, then a letter: Ctrl+C is ^C', seq: '' },
  { id: 'left', row: 1, label: '←', title: 'Left — move the cursor left', seq: '\x1b[D', app: '\x1bOD', local: 'caret-left' },
  { id: 'up', row: 1, label: '↑', title: 'Up — previous command from this session', seq: '\x1b[A', app: '\x1bOA', local: 'history-up' },
  { id: 'down', row: 1, label: '↓', title: 'Down — next command from this session', seq: '\x1b[B', app: '\x1bOB', local: 'history-down' },
  { id: 'right', row: 1, label: '→', title: 'Right — move the cursor right', seq: '\x1b[C', app: '\x1bOC', local: 'caret-right' },
  { id: 'fn', row: 1, role: 'modifier', label: 'Fn', title: 'Fn — tap, then a digit: sends F1–F9', seq: '' },
  { id: 'pgup', row: 2, label: 'PgUp', title: 'Page Up — scroll the output up', seq: '\x1b[5~', local: 'page-up' },
  { id: 'pgdn', row: 2, label: 'PgDn', title: 'Page Down — scroll the output down', seq: '\x1b[6~', local: 'page-down' }
];

// modifiedSequence(key, text) → the bytes a modifier turns `text` into, or null
// when the modifier has nothing to say about it.
//
//   * **Ctrl** — `text` is one character, and the byte is the character with the
//     top three bits cleared (`& 0x1f`): `c` → `\x03` (ETX), `a` → `\x01`,
//     `d` → `\x04`, `[` → `\x1b`. That is the whole rule — the same one a
//     terminal applies — so *every* control character is reachable, not just the
//     four that used to have a button. A multi-character answer (a chip, a whole
//     typed word) is not a control character and answers null.
//   * **Fn** — a single digit `1`–`9` is that function key's VT sequence
//     (`ESC O P` … `ESC [ 9 ~`), because a phone has no F-row and no other way to
//     press one.
export function modifiedSequence(key, text) {
  const s = String(text == null ? '' : text);
  const id = key && typeof key === 'object' ? key.id : key;
  if (id === 'ctrl') {
    if (s.length !== 1) return null;
    const code = s.charCodeAt(0);
    if (code > 0xff) return null;
    return String.fromCharCode(code & 0x1f);
  }
  if (id === 'fn') {
    const m = /^([1-9])$/.exec(s);
    return m ? fnSequence(Number(m[1])) : null;
  }
  return null;
}

// fnSequence(n) — the VT sequence for function key `n` (1–9). The first four are
// `ESC O`, the rest `ESC [ <n> ~`, which is what xterm and every terminal
// database on the platform describe.
export function fnSequence(n) {
  const SS3 = { 1: 'P', 2: 'Q', 3: 'R', 4: 'S' };
  if (SS3[n]) return '\x1bO' + SS3[n];
  return '\x1b[' + n + '~';
}

// applyModifiers(armed, text) → { seq, consumed }
//
//   * `armed` — the modifier ids currently on (`ctrl`, `fn`).
//   * `text` — what the user was about to write: a key from the row, a chip, or
//     the line they typed in the prompt.
//   * `seq` — the bytes to write instead, or null when nothing applies and the
//     caller should send `text` exactly as it always did.
//   * `consumed` — whether the modifiers were *used*. A modifier that changed
//     something is spent — a Ctrl+C must never turn the next command into
//     `M-x` — and a modifier that matched nothing stays armed, so a mistyped
//     letter costs a correction, not a second tap.
//
// With both armed the outer one wins: Ctrl is the byte a chord is named for, and
// `Fn` and Ctrl are never combined in practice.
export function applyModifiers(armed, text) {
  const set = armed && typeof armed === 'object' ? armed : {};
  for (const id of ['ctrl', 'fn']) {
    if (!set[id]) continue;
    const seq = modifiedSequence(id, text);
    if (seq != null) return { seq, consumed: true, modifier: id };
  }
  return { seq: null, consumed: false, modifier: null };
}

// keyPayload(key, mode) → { seq, clearDraft, local }
//
//   * `mode.program`   — a program owns stdin (see above);
//   * `mode.appCursor` — the screen is in application cursor mode.
//
// In local mode a key with a `local` action returns that action and **no
// bytes**: the field is edited in place and nothing reaches the child until
// Enter (an earlier version flushed the draft onto readline and emptied the
// field — "Tab ate my text"). Otherwise the key's sequence is written raw.
//
// ^C discards the local draft and sends ETX without a terminator — a newline
// after it would also press Enter and answer a prompt you never saw.
export function keyPayload(key, mode) {
  if (!key) return { seq: '', clearDraft: false, local: null };
  const m = mode || {};
  if (!m.program && key.local) return { seq: '', clearDraft: false, local: key.local };
  const seq = m.appCursor && key.app ? key.app : key.seq;
  return { seq, clearDraft: key.id === 'int', local: null };
}

// keyForEvent(event) — the CLI_KEYS entry a hardware key press stands for, so
// a desktop keyboard's Tab and arrows go through the same two modes as the
// row. Escape is not mapped: the sheet's own Escape closes it (useModal).
const HARDWARE_KEYS = { Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pgup', PageDown: 'pgdn' };
export function keyForEvent(event) {
  if (!event || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  const id = HARDWARE_KEYS[event.key];
  return id ? keyById(id) : null;
}

// splitTypedTab(value) → null | { before, rest }
//
// Many phone keyboards that have a Tab key (Samsung's, Hacker's Keyboard, some
// Gboard layouts) never fire a `keydown` with `key: 'Tab'`: they report
// `Unidentified` (keyCode 229) and insert a literal HT into the field instead.
// The prompt's `input` handler runs the field through this: `before` is the text
// up to the first HT — what Tab completes, exactly as the key row's Tab does —
// and `rest` is whatever followed it, kept in the field. Stray further tabs are
// dropped: a command line typed on a phone has no use for a literal HT. `null`
// means there was no tab.
export function splitTypedTab(value) {
  const text = String(value == null ? '' : value);
  const at = text.indexOf('\t');
  if (at === -1) return null;
  return { before: text.slice(0, at), rest: text.slice(at + 1).replace(/\t/g, '') };
}

// Bracketed-paste mode markers. bash (readline ≥ 8.1) and zsh (≥ 5.1) switch
// it on while their line editor waits for a command and off the moment the
// line is accepted, so the pair is the shell's own statement of who owns
// stdin: `?2004h` → the shell's prompt, `?2004l` → a program is running. It is
// a real signal from the child rather than a guess from what the output looks
// like, and a shell that never sends it (dash, a piped child) simply leaves
// the mode unknown.
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

// lineEditorState(tail, chunk) → { state, tail }
//
//   * `state` — 'shell' when the chunk's last marker switched bracketed paste
//     on, 'program' when it switched it off, null when the chunk has no marker
//     (the caller keeps its previous state);
//   * `tail` — the carry to pass with the next chunk. Output arrives in
//     arbitrary pieces, so a marker can be cut in two; the carry is one byte
//     shorter than a marker, so a marker is never counted twice.
export function lineEditorState(tail, chunk) {
  const text = String(tail || '') + String(chunk == null ? '' : chunk);
  const on = text.lastIndexOf(PASTE_ON);
  const off = text.lastIndexOf(PASTE_OFF);
  let state = null;
  if (on !== -1 || off !== -1) state = on > off ? 'shell' : 'program';
  return { state, tail: text.slice(-(PASTE_ON.length - 1)) };
}

// cursorKeyMode(tail, chunk) → { app, tail }
//
// Follows DECCKM: `ESC[?1h` switches the cursor keys to application mode
// (`ESC O A` instead of `ESC [ A`), `ESC[?1l` switches them back. `less`,
// `vim` and `top` turn it on, and some ignore the normal form while it is on.
// `app` is true/false for the chunk's last switch, null when there was none;
// `tail` carries a cut marker into the next chunk, as in lineEditorState.
const DECCKM_ON = '\x1b[?1h';
const DECCKM_OFF = '\x1b[?1l';
export function cursorKeyMode(tail, chunk) {
  const text = String(tail || '') + String(chunk == null ? '' : chunk);
  const on = text.lastIndexOf(DECCKM_ON);
  const off = text.lastIndexOf(DECCKM_OFF);
  let app = null;
  if (on !== -1 || off !== -1) app = on > off;
  return { app, tail: text.slice(-(DECCKM_ON.length - 1)) };
}

// keyById(id) — one key's definition, or null. Exported so a caller (and the
// test) never has to guess at an index into CLI_KEYS.
export function keyById(id) {
  return CLI_KEYS.find((k) => k.id === id) || null;
}

// keepEditorFocus(event) — the `mousedown` handler for every control in the key
// row and the suggestion row.
//
// On touch, the browser's default action for `mousedown` moves focus to the
// button, which on iOS/Android closes the soft keyboard: the user taps Tab and
// the keyboard they were typing on folds away, so the next character costs a
// second tap on the input. Cancelling the default keeps the caret in the prompt
// where it was; the tap itself still fires a `click`, so the key is sent.
export function keepEditorFocus(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
}
