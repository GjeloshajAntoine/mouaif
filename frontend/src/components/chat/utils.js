// mouaif web — Chat view utilities
//
// Tiny helpers used by multiple chat/* modules. Kept pure so the
// other modules can import without dragging in the whole view.

// CSS.escape polyfill for older mobile browsers; we only need to
// escape the chars that can appear in a tool call id (alnum, _, -).
export function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c);
}

// Strip ANSI/VT control codes from a command's output and reconstruct a
// readable plain-text view of a screen. Used by the interactive CLI modal,
// whose session is a **piped, non-TTY** child: programs that draw a full
// screen (htop, top, less, vim) emit cursor-positioning (`ESC[<row>;<col>H`),
// color (`ESC[<n>m`), erase and alternate-screen escapes that a `<pre>` cannot
// interpret, so they would otherwise render as raw `\x1b[...` garbage.
//
// The interpreter keeps a logical cursor row and turns forward cursor moves
// into newlines, so screen rows stay on separate lines; it drops color / erase
// / alternate-screen escapes; it folds carriage-return overwrites (a `\r`
// returns to column 0, so later text overwrites the start of the line). Column
// layout is not reconstructed — it is a best-effort plain-text view, not a
// terminal emulator.
export function stripAnsi(s) {
  let out = String(s || '');
  let row = 1;
  let i = 0;
  const n = out.length;
  let res = '';
  while (i < n) {
    const c = out[i];
    if (c === '\x1b') {
      if (out[i + 1] === '[') {
        // CSI: ESC [ params? intermediates? final
        let j = i + 2;
        let params = '';
        while (j < n && /[0-9;?]/.test(out[j])) { params += out[j]; j++; }
        while (j < n && /[ -/]/.test(out[j])) { j++; } // intermediates
        const finalCh = out[j]; j++;
        const p = (params || '').split(';').map((x) => (x === '' ? 1 : Number(x)));
        const cmd = finalCh;
        // Forward cursor moves advance the logical row.
        if (cmd === 'H' || cmd === 'f') {
          const r = p[0] || 1;
          if (r > row) { res += '\n'.repeat(Math.min(r - row, 80)); row = r; }
        } else if (cmd === 'E' || cmd === 'B') {
          const d = p[0] || 1;
          res += '\n'.repeat(Math.min(d, 80)); row += d;
        } else if (cmd === 'A') {
          row = Math.max(1, row - (p[0] || 1));
        } else if (cmd === 'd') {
          const r = p[0] || 1;
          if (r > row) { res += '\n'.repeat(Math.min(r - row, 80)); row = r; }
        }
        // Other CSI (colors `m`, erase `K`/`J`, private `?` like alternate
        // screen) are dropped.
        i = j;
        continue;
      }
      if (out[i + 1] === ']') {
        // OSC: ESC ] text BEL | ESC ] text ESC \
        let j = i + 2;
        while (j < n && out[j] !== '\x07' && !(out[j] === '\x1b' && out[j + 1] === '\\')) j++;
        i = (out[j] === '\x07') ? j + 1 : j + 2;
        continue;
      }
      if (out[i + 1] === '(' || out[i + 1] === ')' || out[i + 1] === '#') { i += 3; continue; }
      // Any other escape (e.g. ESC =, ESC >, ESC 7/8, ESC c) — drop it.
      i += (out[i + 1] !== undefined) ? 2 : 1;
      continue;
    }
    if (c === '\r') { res += c; i += 1; continue; } // retained for the CR fold below
    res += c;
    i += 1;
  }
  // Fold carriage-return overwrites: within each line, split on \r and let
  // each successive segment overwrite the start of the accumulated text.
return res.split('\n').map((line) => {
const parts = line.split('\r');
let acc = '';
for (const part of parts) acc = part + acc.slice(part.length);
return acc;
}).join('\n');
}

// CliScreen — a stateful, streaming ANSI/VT screen decoder for the CLI modal.
//
// `stripAnsi` above is stateless: it works great on a complete blob of text,
// but the CLI modal receives output as a *stream* of SSE `cli_output` frames,
// and a full-screen program (htop, top, less, vim) emits its escape codes in
// no particular chunk alignment. Two things break:
//
//   1. An escape sequence can be split across two frames (e.g. `ESC[` ends one
//      frame, `8;1H` starts the next). A stateless strip consumes neither, so
//      `[8;1H`, `[39;49m`, `[32m` fragments leak into the rendered `<pre>` —
//      the `||5.372` / `||5.3` garbage in the report.
//   2. A TUI redraws *in place*, but appending each stripped frame stacks
//      repeated copies of the whole screen ("scroll but refreshes").
//
// CliScreen models a real terminal screen: it buffers any escape sequence
// that is still in flight across the chunk boundary, holds a grid of text
// rows, honours cursor-positioning (CUP / up/down/left/right / erase), and
// enters/leaves the alternate screen. `render()` returns the *current* plain
// text screen, so a TUI's redraw replaces its previous frame instead of
// appending, while ordinary scrollback output grows the grid as before.
//
// It is deliberately a best-effort plain-text view, not a terminal emulator:
// colour and cell-width attributes are dropped and column layout is not
// reconstructed (column 0 is the left edge). Keep it cheap — no Preact/DOM.
export class CliScreen {
constructor() {
this.grid = [];   // grid[r] = array of chars ('' = blank cell)
this.row = 1;     // 1-based cursor row
this.col = 1;     // 1-based cursor column
this.pending = ''; // escape bytes not yet terminated (split across frames)
this.fullScreen = false; // true once a program enters the alternate screen
}
// True when the current output belongs to a full-screen TUI (alt screen).
get isFullScreen() { return this.fullScreen; }
// Resize the grid so it has at least `row` rows, return the 1-based row.
_ensureRow(row) {
if (row < 1) row = 1;
while (this.grid.length < row) this.grid.push([]);
return this.grid[row - 1];
}
// Write one printable code point into the grid at (row, col).
_put(ch, row, col) {
if (row < 1) row = 1;
if (col < 1) col = 1;
const line = this._ensureRow(row);
const idx = col - 1;
while (line.length < idx) line.push(' ');
line[idx] = ch;
}
// Interpret a CSI sequence. `body` is the text between ESC[ and the final
// byte; `final` is that byte.
_csi(body, final) {
let priv = false;
let params = body;
if (params[0] === '?') { priv = true; params = params.slice(1); }
// Drop intermediate bytes (0x20-0x2f) — rare, ignored.
params = params.replace(/[\x20-\x2f]/g, '');
const nums = params === '' ? [] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
const n0 = nums.length ? nums[0] : (final === 'K' || final === 'J' ? 0 : 1);
switch (final) {
case 'H': case 'f': // Cursor position (CUP)
this.row = nums[0] || 1;
this.col = nums[1] || 1;
if (this.row < 1) this.row = 1;
if (this.col < 1) this.col = 1;
this._ensureRow(this.row);
break;
case 'A': this.row = Math.max(1, this.row - (n0 || 1)); break; // up
case 'B': this.row += (n0 || 1); this._ensureRow(this.row); break; // down
case 'C': this.col += (n0 || 1); break; // right
case 'D': this.col = Math.max(1, this.col - (n0 || 1)); break; // left
case 'E': this.row += (n0 || 1); this.col = 1; this._ensureRow(this.row); break;
case 'F': this.row = Math.max(1, this.row - (n0 || 1)); this.col = 1; break;
case 'G': this.col = n0 || 1; if (this.col < 1) this.col = 1; break;
case 'd': this.row = n0 || 1; this._ensureRow(this.row); break;
case 'K': { // erase line
const line = this._ensureRow(this.row);
const mode = nums.length ? nums[0] : 0;
if (mode === 2) { for (let k = 0; k < line.length; k++) line[k] = ' '; }
else if (mode === 1) { for (let k = 0; k < Math.min(this.col - 1, line.length); k++) line[k] = ' '; }
else { for (let k = this.col - 1; k < line.length; k++) line[k] = ' '; }
break;
}
case 'J': { // erase display
const mode = nums.length ? nums[0] : 0;
if (mode === 2 || mode === 3) { this.grid = []; }
else if (mode === 1) {
for (let r = 0; r < this.row - 1; r++) { const l = this.grid[r]; if (l) for (let k = 0; k < l.length; k++) l[k] = ' '; }
const line = this._ensureRow(this.row);
for (let k = 0; k < Math.min(this.col - 1, line.length); k++) line[k] = ' ';
}
else { // mode 0 — clear from cursor to end
const line = this._ensureRow(this.row);
for (let k = this.col - 1; k < line.length; k++) line[k] = ' ';
for (let r = this.row; r < this.grid.length; r++) { const l = this.grid[r]; if (l) for (let k = 0; k < l.length; k++) l[k] = ' '; }
}
this._ensureRow(this.row);
break;
}
case 'h': case 'l': // mode set/reset — alternate screen only
if (priv && nums.indexOf(1049) !== -1) {
if (final === 'h') {
// Enter alternate screen: a full-screen TUI is about to draw. Start
// a fresh frame and mark the output as full-screen so the modal can
// preserve the scroll position instead of pinning to the bottom.
this.grid = [];
this.row = 1; this.col = 1;
this.fullScreen = true;
} else {
// Leave alternate screen: back to normal scrollback.
this.fullScreen = false;
}
}
break;
default: break; // SGR colour (m), scroll region (r), window ops (t), etc.
}
}
// Feed one chunk of raw output. Any escape sequence left unterminated at the
// end of the chunk is buffered and completed on the next call.
write(chunk) {
const s = this.pending + String(chunk || '');
this.pending = '';
// Operate on code points so a surrogate pair (e.g. an emoji) never splits.
const a = Array.from(s);
let i = 0;
const n = a.length;
while (i < n) {
const c = a[i];
if (c === '\x1b') {
const nxt = a[i + 1];
if (nxt === '[') {
// CSI: ESC [ params? intermediates? final
let j = i + 2;
while (j < n && !(a[j] >= '\x40' && a[j] <= '\x7e')) j++;
if (j >= n) { this.pending = a.slice(i).join(''); break; }
this._csi(a.slice(i + 2, j).join(''), a[j]);
i = j + 1;
continue;
}
if (nxt === ']') {
// OSC: ESC ] text BEL | ESC ] text ESC \
let j = i + 2;
while (j < n && a[j] !== '\x07' && !(a[j] === '\x1b' && a[j + 1] === '\\')) j++;
if (j >= n) { this.pending = a.slice(i).join(''); break; }
i = (a[j] === '\x07') ? j + 1 : j + 2;
continue;
}
if (nxt === '(' || nxt === ')' || nxt === '#' || nxt === '%') {
if (i + 2 >= n) { this.pending = a.slice(i).join(''); break; }
i += 3;
continue;
}
// Any other escape (ESC =, ESC >, ESC 7/8, ESC c, ...) — drop it.
i += (a[i + 1] !== undefined) ? 2 : 1;
continue;
}
if (c === '\r') { this.col = 1; i += 1; continue; }
if (c === '\n') { this.row += 1; this.col = 1; this._ensureRow(this.row); i += 1; continue; }
if (c === '\x08') { this.col = Math.max(1, this.col - 1); i += 1; continue; } // backspace
if (c === '\x0b') { this.row += 1; this.col = 1; this._ensureRow(this.row); i += 1; continue; } // vertical tab
if (c < ' ' || c === '\x7f') { i += 1; continue; } // drop other C0/DEL controls
this._put(c, this.row, this.col);
this.col += 1;
i += 1;
}
}
// Render the current screen as plain text: join non-blank rows, trimming
// trailing whitespace per row and dropping entirely blank trailing rows.
render() {
const lines = [];
for (let r = 0; r < this.grid.length; r++) {
const line = this.grid[r];
let s = '';
for (let k = 0; k < line.length; k++) s += (line[k] || ' ');
s = s.replace(/\s+$/, '');
if (s.length) lines.push(s);
}
return lines.join('\n');
}
}
