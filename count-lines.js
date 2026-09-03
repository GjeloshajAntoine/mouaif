// mouaif — count source lines across the project's main modules.
//
// Usage: node count-lines.js
const fs = require('fs');
const path = require('path');

const files = [
  'src/index.js',
  'src/ai.js',
  'src/ai-*.js',
  'frontend/src/components.css',
  'frontend/src/features.css',
  'frontend/src/components/Chat.jsx',
  'frontend/src/layout.css',
  'frontend/src/components/chat/cards.js',
  'frontend/src/components/chat/transcript.js',
  'frontend/src/components/Inspector.jsx',
  'frontend/src/components/SettingsProject.jsx',
  'frontend/src/components/SettingsProviders.jsx',
  'frontend/src/components/SettingsMcp.jsx',
  'src/mcp.js'
];

function expand(pattern) {
  // A pattern with a '*' is a glob; otherwise it's a literal path.
  if (!pattern.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((name) => re.test(name)).map((name) => path.join(dir, name));
}

let total = 0;
let missing = 0;
const seen = new Set();
for (const pattern of files) {
  for (const file of expand(pattern)) {
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let lines = 0;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').length;
      total += lines;
      console.log(String(lines).padStart(6) + '  ' + file);
    } catch (e) {
      missing++;
      console.log('ERR   ' + file);
    }
  }
}
console.log(String(total).padStart(6) + '  total');
if (missing) console.log(String(missing) + ' file(s) skipped (missing)');
