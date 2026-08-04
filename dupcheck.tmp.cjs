const fs = require('fs');
const path = require('path');
const { parse, walk, generate } = require('css-tree');

const dir = 'src/web/src';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.css'));
const selectorMap = new Map();

for (const file of files) {
  const css = fs.readFileSync(path.join(dir, file), 'utf8');
  const ast = parse(css, { positions: true });
  walk(ast, {
    visit: 'Rule',
    enter(node) {
      let sel = '';
      try { sel = generate(node.prelude); } catch (e) { return; }
      const normalized = sel.replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      const decls = {};
      walk(node.block, {
        visit: 'Declaration',
        enter(d) { decls[d.property] = d.value ? generate(d.value) : ''; }
      });
      if (!selectorMap.has(normalized)) selectorMap.set(normalized, []);
      selectorMap.get(normalized).push({ file, line: node.loc.start.line, decls });
    }
  });
}

console.log('=== EXACT duplicate selector lists (identical selector text) ===');
let count = 0;
for (const [sel, occs] of selectorMap) {
  if (occs.length > 1) {
    count++;
    console.log(`\n[${sel}]`);
    for (const o of occs) {
      console.log(`  ${o.file}:${o.line}  { ${Object.entries(o.decls).map(([p,v]) => `${p}: ${v}`).join('; ')} }`);
    }
  }
}
console.log(`\nTotal duplicated selector lists: ${count}`);
