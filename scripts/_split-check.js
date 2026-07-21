// Verify the ChatView function spans exactly [start, end] by brace
// counting, and report the byte ranges for the planned extraction
// blocks. Read-only sanity check before the mechanical split.
const fs = require('fs');
const s = fs.readFileSync('src/web/src/components/Chat.jsx', 'utf8');

function findLine(needle, from) {
  const i = s.indexOf(needle, from || 0);
  if (i < 0) throw new Error('not found: ' + needle.slice(0, 60));
  return i;
}
function lineOf(idx) {
  return s.slice(0, idx).split('\n').length;
}

// 1. locate `export function ChatView(props) {` and count braces
const fnStart = findLine('export function ChatView(props) {');
let depth = 0, i = fnStart, end = -1;
// find the first `{`
while (s[i] !== '{') i++;
for (; i < s.length; i++) {
  const ch = s[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) { end = i; break; }
  }
  // crude: skip string contents so braces in strings don't count
  if (ch === "'" || ch === '"' || ch === '`') {
    const q = ch;
    i++;
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\') i++;
      i++;
    }
  }
}
console.log('ChatView starts at line', lineOf(fnStart), 'ends at line', lineOf(end));
console.log('tail after end:', JSON.stringify(s.slice(end, end + 30)));
console.log('total lines:', s.split('\n').length);
