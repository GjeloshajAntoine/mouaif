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
// `shellOnly` marks the three keys that only mean what their label says while
// the *shell* owns stdin. Tab and ↑/↓ are readline keys: a program showing its
// own prompt reads those bytes literally, which is usually not what the tap was
// for. The row dims exactly these while a program owns the prompt and leaves
// Esc, ^C and ^D lit — those three are useful in both modes (leave a full-screen
// program / interrupt / end input), and ^C is the key a waiting program needs.
export const CLI_KEYS = [
  { id: 'esc', label: 'Esc', title: 'Escape — leave a full-screen program', seq: '\x1b' },
  { id: 'tab', label: 'Tab', title: 'Tab — complete a path or command', seq: '\t', shellOnly: true },
  { id: 'up', label: '↑', title: 'Up — previous command in this shell’s history', seq: '\x1b[A', shellOnly: true },
  { id: 'down', label: '↓', title: 'Down — next command in this shell’s history', seq: '\x1b[B', shellOnly: true },
  { id: 'int', label: '^C', title: 'Ctrl+C — interrupt the running command', seq: '\x03' },
  { id: 'eof', label: '^D', title: 'Ctrl+D — end input (EOF)', seq: '\x04' }
];

// keyPayload(key, draft) → { seq, clearDraft } — what one tap actually writes.
//
// The modal's <input> is a *local* line buffer: nothing typed there reaches the
// shell until Enter. A readline key acts on the shell's own line, so sending
// Tab alone would complete an empty line — `npm ru` + Tab completed nothing.
// The three readline keys therefore flush the draft first (`npm ru\t` in one
// raw write) and hand the field back empty: from then on the shell's line,
// echoed on the screen by the pty, is the line being edited, and whatever is
// typed next continues it. ↑/↓ do the same, which is what a terminal does
// with a half-typed line (readline keeps it as the history's newest entry).
//
// ^C discards the local draft too — the terminal meaning of interrupting a line
// you were typing — but does not send it. Esc and ^D leave the field alone.
export function keyPayload(key, draft) {
  if (!key) return { seq: '', clearDraft: false };
  const text = String(draft == null ? '' : draft);
  if (key.shellOnly) return { seq: text + key.seq, clearDraft: text.length > 0 };
  if (key.id === 'int') return { seq: key.seq, clearDraft: text.length > 0 };
  return { seq: key.seq, clearDraft: false };
}

// splitTypedTab(value) → null | { draft, rest }
//
// Many phone keyboards that have a Tab key (Samsung's, Hacker's Keyboard, some
// Gboard layouts) never fire a `keydown` with `key: 'Tab'`: they report
// `Unidentified` (keyCode 229) and insert a literal HT into the field instead,
// so the tab sat in the <input> and never reached the shell. The prompt's
// `input` handler runs the field through this: text up to the first HT is the
// draft to send with Tab (exactly what the key row's Tab sends), and whatever
// followed it stays in the field. Stray further tabs are dropped — a command
// line typed on a phone has no use for a literal HT. `null` means no tab.
export function splitTypedTab(value) {
  const text = String(value == null ? '' : value);
  const at = text.indexOf('\t');
  if (at === -1) return null;
  return { draft: text.slice(0, at), rest: text.slice(at + 1).replace(/\t/g, '') };
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
