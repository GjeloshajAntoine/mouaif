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
