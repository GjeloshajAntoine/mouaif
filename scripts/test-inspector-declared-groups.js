'use strict';
// Inspector Styles panel — Declared styles grouped as written.
//
// The CSSOM lists an inline `border: 1px solid #ddd` as seventeen longhands;
// declaredGroups.js folds them back into the declarations `style.cssText`
// serialises, without ever hiding a longhand the element really has. Pure, so
// it is loaded into a vm context the same way the other inspector tests load
// their modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const ctx = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueShapes.js')).replace(/^export \{ hslToRgb, rgbToHsl \};$/m, ''), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/shorthand.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/declaredGroups.js'))
  + '\n;globalThis.DG = { parseCssText, groupDeclared, memberNames, changedKey, groupChanged, findDeclaration };\n', ctx);
const DG = ctx.DG;
const plain = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok   - ' + name);
}

const BORDER_LONGHANDS = [
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'
];
const heroRows = [{ prop: 'margin-top', value: '20px', priority: '' }].concat(BORDER_LONGHANDS.map((prop) => ({
  prop,
  value: /width/.test(prop) && !/image/.test(prop) ? '1px' : /style/.test(prop) ? 'solid' : /color/.test(prop) ? 'rgb(221, 221, 221)' : 'initial',
  priority: ''
})));
const heroCss = 'margin-top: 20px; border: 1px solid rgb(221, 221, 221);';

check('parseCssText splits top-level declarations and reads !important', () => {
  assert.deepStrictEqual(plain(DG.parseCssText('color: red; margin: 0 auto !important;')), [
    { prop: 'color', value: 'red', priority: '' },
    { prop: 'margin', value: '0 auto', priority: 'important' }
  ]);
});

check('parseCssText keeps semicolons inside quotes and parentheses', () => {
  const out = DG.parseCssText('background-image: url("data:image/png;base64,AA"); content: "a;b"; --X: 1');
  assert.deepStrictEqual(plain(out.map((d) => d.prop)), ['background-image', 'content', '--X']);
  assert.strictEqual(out[0].value, 'url("data:image/png;base64,AA")');
  assert.strictEqual(out[1].value, '"a;b"');
});

check('a border shorthand is one row, not seventeen', () => {
  const rows = DG.groupDeclared(heroRows, heroCss);
  assert.deepStrictEqual(plain(rows.map((r) => r.prop)), ['margin-top', 'border']);
  assert.strictEqual(rows[1].value, '1px solid rgb(221, 221, 221)');
  assert.deepStrictEqual(plain(rows[1].longhands), BORDER_LONGHANDS);
  assert.deepStrictEqual(plain(rows[0].longhands), []);
});

check('without cssText every longhand is its own row (older snapshot shape)', () => {
  const rows = DG.groupDeclared(heroRows, '');
  assert.strictEqual(rows.length, heroRows.length);
});

check('a longhand no declaration claims is never hidden', () => {
  const rows = DG.groupDeclared(heroRows.concat([{ prop: 'color', value: 'red', priority: '' }]), heroCss);
  assert.deepStrictEqual(plain(rows.map((r) => r.prop)), ['margin-top', 'border', 'color']);
});

check('a stale declaration with no matching longhand is dropped', () => {
  const rows = DG.groupDeclared([{ prop: 'color', value: 'red', priority: '' }], 'color: red; padding: 4px;');
  assert.deepStrictEqual(plain(rows.map((r) => r.prop)), ['color']);
});

check('the more specific shorthand claims its longhands first', () => {
  const rows = DG.groupDeclared([
    { prop: 'border-top-left-radius', value: '4px', priority: '' },
    { prop: 'border-top-right-radius', value: '4px', priority: '' },
    { prop: 'border-bottom-right-radius', value: '4px', priority: '' },
    { prop: 'border-bottom-left-radius', value: '4px', priority: '' }
  ].concat(heroRows.slice(1)), 'border: 1px solid rgb(221, 221, 221); border-radius: 4px;');
  const radius = rows.find((r) => r.prop === 'border-radius');
  const border = rows.find((r) => r.prop === 'border');
  assert.ok(radius && radius.longhands.length === 4, 'border-radius holds the four corners');
  assert.ok(border && border.longhands.every((n) => !/radius/.test(n)), 'border does not swallow the radius');
  assert.deepStrictEqual(plain(rows.map((r) => r.prop)), ['border', 'border-radius'], 'cssText order is kept');
});

check('a declaration that is its own longhand keeps the model value (fresher than cssText)', () => {
  const rows = DG.groupDeclared([{ prop: 'color', value: 'blue', priority: 'important' }], 'color: red;');
  assert.deepStrictEqual(plain(rows), [{ prop: 'color', value: 'blue', priority: 'important', longhands: [] }]);
});

check('a shorthand row carries the serialised priority', () => {
  const rows = DG.groupDeclared([
    { prop: 'padding-top', value: '4px', priority: 'important' },
    { prop: 'padding-right', value: '4px', priority: 'important' },
    { prop: 'padding-bottom', value: '4px', priority: 'important' },
    { prop: 'padding-left', value: '4px', priority: 'important' }
  ], 'padding: 4px !important;');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].priority, 'important');
});

check('custom properties are never grouped under a prefix', () => {
  const rows = DG.groupDeclared([
    { prop: '--a', value: '1', priority: '' },
    { prop: '--a-b', value: '2', priority: '' }
  ], '--a: 1; --a-b: 2;');
  assert.deepStrictEqual(plain(rows.map((r) => r.prop)), ['--a', '--a-b']);
});

check('changedKey / groupChanged follow any member of the group', () => {
  const border = DG.groupDeclared(heroRows, heroCss)[1];
  assert.strictEqual(DG.groupChanged(border, ['border-top-width']), true);
  assert.strictEqual(DG.groupChanged(border, ['margin-top']), false);
  assert.strictEqual(DG.changedKey(border, ['color', 'border-left-color', 'border-top-width']), 'border-left-color');
  assert.strictEqual(DG.changedKey(border, []), 'border');
  assert.deepStrictEqual(plain(DG.memberNames({ prop: 'x' })), ['x']);
});

check('findDeclaration returns the shorthand an edit replaces', () => {
  assert.deepStrictEqual(plain(DG.findDeclaration(heroCss, 'border')), { prop: 'border', value: '1px solid rgb(221, 221, 221)', priority: '' });
  assert.strictEqual(DG.findDeclaration(heroCss, 'padding'), null);
  assert.strictEqual(DG.findDeclaration('', 'border'), null);
});

// --- wiring ---------------------------------------------------------------
const panel = read('frontend/src/components/inspector/StylesPanel.jsx');
const events = read('frontend/src/components/inspector/events.js');
check('the panel renders the grouped rows, ordered by their most recent member', () => {
  assert.ok(/const groupedRows = groupDeclared\(inlineRows, model\.inlineCss\)/.test(panel));
  assert.ok(/orderChangedFirst\(groupedRows, changed, \(row\) => changedKey\(row, changed\)\)/.test(panel));
  assert.ok(/declaredRows\.map/.test(panel));
});
check('an edit of a shorthand row records the serialised value it replaces', () => {
  assert.strictEqual((panel.match(/\|\| findDeclaration\(modelRef\.current && modelRef\.current\.inlineCss, prop\)/g) || []).length, 2);
});
check('both page reads report style.cssText', () => {
  assert.ok(/cssText:this\.style\.cssText/.test(events), 'buildNodeModel');
  assert.ok(/cssText: this\.style\.cssText/.test(events), 'readElementStyles');
});
check('the computed list puts vendor-prefixed properties last', () => {
  const m = /function compareComputed\(a, b\) \{[\s\S]*?\n\}/.exec(events);
  assert.ok(m, 'compareComputed exists');
  const cmp = vm.runInNewContext('(' + m[0] + ')');
  const sorted = ['-webkit-box-flex', 'color', '--custom', 'align-items', '-webkit-appearance']
    .map((prop) => ({ prop })).sort(cmp).map((r) => r.prop);
  assert.deepStrictEqual(sorted, ['--custom', 'align-items', 'color', '-webkit-appearance', '-webkit-box-flex']);
});

console.log('PASS inspector declared groups (' + passed + ' checks)');
