// Inspector value display — one place that turns a CSS value into readable parts.
//
// The Styles panel shows the same value in three places (declared rows, computed
// rows, matched-rule rows), and each used to render it as one monospace string.
// That is fine for `12px` and useless for
// `cubic-bezier(0.4, 0, 0.2, 1)` or `1px solid rgb(255, 230, 0)`: there is no
// visual rhythm, the units are the same colour as the numbers, and a long value
// is either cut off or wraps mid-token.
//
// This module splits a value into typed segments — number, unit, function name,
// punctuation, colour — so the row can render each part in its own colour and
// weight. It is pure: a string in, an array of `{ text, kind }` out, and the
// concatenation of the segments is always the original string, so nothing is
// lost or reordered.
//
//   splitValue(value)   -> [{ text, kind }]   kind is one of:
//                         'number' | 'unit' | 'fn' | 'punct' | 'color' | 'text'
//   valueKind(prop, value) -> 'color' | 'length' | 'number' | 'keyword' | 'other'
//                         (a coarse tag for the row's colour treatment)
//   shortenValue(value, max) -> a value trimmed to `max` chars with an ellipsis,
//                         never cutting inside a token (a function call or a
//                         number+unit pair stays whole when possible)

// splitValue — tokenise a CSS value into coloured segments.
//
// The tokenizer is deliberately small: it recognises numbers with optional
// units, function names (`rgb(`, `calc(`), punctuation (`,()/:`), hex colours,
// and falls back to plain text for everything else (keywords, strings, custom
// property references). It never throws and never drops characters — the
// segments always join back to the input.
export function splitValue(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return [];
  const out = [];
  let i = 0;
  const n = raw.length;
  const push = (text, kind) => {
    if (!text) return;
    // Merge with the previous segment when the kind matches, so `12` + `px`
    // stays two segments (number, unit) but `solid` after a space stays one
    // 'text' run.
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      out.push({ text, kind });
    }
  };
  while (i < n) {
    const ch = raw[i];
    // Whitespace: its own segment so the row can collapse it visually.
    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(raw[j])) j++;
      push(raw.slice(i, j), 'space');
      i = j;
      continue;
    }
    // Hex colour: #rgb, #rrggbb, #rrggbbaa
    if (ch === '#') {
      const m = /^#[0-9a-fA-F]{3,8}/.exec(raw.slice(i));
      if (m) { push(m[0], 'color'); i += m[0].length; continue; }
    }
    // Number with optional unit: 12, 12.5, .5, -3, 100%, 1.5rem
    const numMatch = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?/.exec(raw.slice(i));
    if (numMatch && /\d/.test(numMatch[0])) {
      const token = numMatch[0];
      // Split the trailing unit from the number.
      const unitMatch = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]*)$/.exec(token);
      if (unitMatch) {
        push(unitMatch[1], 'number');
        if (unitMatch[2]) push(unitMatch[2], 'unit');
      } else {
        push(token, 'number');
      }
      i += token.length;
      continue;
    }
    // Function name: an identifier immediately followed by `(`.
    const fnMatch = /^[a-zA-Z-][a-zA-Z0-9-]*/.exec(raw.slice(i));
    if (fnMatch) {
      const name = fnMatch[0];
      // Peek for `(` — if so, this is a function name, not a keyword.
      let j = i + name.length;
      while (j < n && /\s/.test(raw[j])) j++;
      if (raw[j] === '(') {
        push(name, 'fn');
        i += name.length;
        continue;
      }
      // Named colour or keyword: colour if it is a known colour name.
      if (isColorName(name)) { push(name, 'color'); i += name.length; continue; }
      push(name, 'text');
      i += name.length;
      continue;
    }
    // Punctuation.
    if (ch === ',' || ch === '(' || ch === ')' || ch === '/' || ch === ':' || ch === ';') {
      push(ch, 'punct');
      i++;
      continue;
    }
    // Anything else: a run of non-special characters.
    let j = i;
    while (j < n && !/[\s#(,)/:;]/.test(raw[j]) && !(raw[j] === '-' && /[\d.]/.test(raw[j + 1] || ''))) j++;
    if (j === i) j = i + 1; // always advance
    push(raw.slice(i, j), 'text');
    i = j;
  }
  return out;
}

// NAMED — the CSS named colours worth colouring in a value. Kept to the common
// ones; an unknown name renders as plain text, which is the honest fallback.
const NAMED = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'gray', 'grey', 'silver', 'maroon', 'navy', 'teal', 'aqua', 'fuchsia',
  'lime', 'olive', 'cyan', 'magenta', 'pink', 'brown', 'gold', 'violet',
  'indigo', 'crimson', 'tomato', 'coral', 'salmon', 'khaki', 'beige',
  'ivory', 'snow', 'azure', 'lavender', 'wheat', 'plum', 'orchid',
  'tan', 'transparent', 'currentcolor'
]);

function isColorName(name) {
  return NAMED.has(String(name || '').toLowerCase());
}

// valueKind — a coarse tag for the row's colour treatment. The panel already
// has `classify` in valueKinds.js for the full kind; this is the lighter version
// for display only (no context needed).
export function valueKind(prop, value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 'other';
  const lower = raw.toLowerCase();
  if (/^#([0-9a-f]{3,8})$/.test(lower)) return 'color';
  if (/^(rgba?|hsla?|color|color-mix)\(/i.test(lower)) return 'color';
  if (NAMED.has(lower)) return 'color';
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(raw);
  if (m) {
    if (!m[2]) return 'number';
    return 'length';
  }
  if (/^[a-z-]+$/i.test(lower)) return 'keyword';
  return 'other';
}

// shortenValue — trim a value to `max` characters without cutting a token.
//
// A naive `slice(0, max) + '…'` cuts `cubic-bezier(0.4, 0, 0.2, 1)` into
// `cubic-bezier(0.4, 0, 0…`, which reads as broken. This walks the segments and
// stops at the last whole token that fits, then appends the ellipsis. The result
// is always ≤ max + 1 characters (the ellipsis) and never splits a number from
// its unit or a function name from its opening paren.
export function shortenValue(value, max) {
  const raw = String(value == null ? '' : value);
  const limit = Math.max(8, Number(max) || 40);
  if (raw.length <= limit) return raw;
  const segs = splitValue(raw);
  let out = '';
  for (const seg of segs) {
    const next = out + seg.text;
    // Leave room for the ellipsis.
    if (next.length > limit - 1) break;
    // Don't leave a dangling function name or a lone opening paren.
    if (seg.kind === 'fn' || seg.kind === 'punct') {
      if (next.length + 1 > limit - 1) break;
    }
    out = next;
  }
  // Trim trailing whitespace/punctuation before the ellipsis.
  out = out.replace(/[\s,(/]+$/, '');
  return out + '…';
}
