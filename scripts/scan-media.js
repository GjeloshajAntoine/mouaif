const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'web', 'src');
for (const f of ['components.css','features.css']) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = s.split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (ln.includes('@media')) {
      // print following 8 lines
      const block = lines.slice(i, i + 10).join('\n');
      console.log('--- ' + f + ':' + (i + 1) + ' ---');
      console.log(block);
    }
  });
}
