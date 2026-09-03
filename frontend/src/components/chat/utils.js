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
