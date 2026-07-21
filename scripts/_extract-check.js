// Dry-run the split: locate each extraction block by its first/last
// line text (unique anchors), confirm ordering + no overlap, then
// report the exact char ranges. No files are written.
const fs = require('fs');
const src = fs.readFileSync('src/web/src/components/Chat.jsx', 'utf8');
const lines = src.split('\r\n');
console.log('lines:', lines.length);

function findBlock(name, firstRe, lastRe, fromLine) {
  let a = -1, b = -1;
  for (let i = fromLine || 0; i < lines.length; i++) {
    if (a < 0 && firstRe.test(lines[i])) a = i;
    if (a >= 0 && lastRe.test(lines[i])) { b = i; break; }
  }
  if (a < 0 || b < 0) throw new Error('block not found: ' + name);
  // block ends after the following blank line
  let end = b + 1;
  while (end < lines.length && lines[end] === '') end++;
  console.log(name.padEnd(12), 'lines', a + 1, '-', end, '(', end - a, 'lines )');
  return { name, a, end };
}

const blocks = [
  findBlock('toolFormat', /^  function normalizeToolName/, /^  }\s*$/, 1500),
];
// find the exact end of formatToolArgs (the try/catch close)
for (let i = 0; i < lines.length; i++) {
  if (/^  function normalizeToolName/.test(lines[i])) {
    // walk back to the blank line before it
    let j = i - 1;
    while (lines[j] === '') j--;
    console.log('formatToolArgs last code line', j + 1, JSON.stringify(lines[j]));
    break;
  }
}
