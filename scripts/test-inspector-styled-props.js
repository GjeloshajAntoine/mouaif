'use strict';
// Inspector Styles panel — "which properties did the page style, and by what".
//
// The Computed list opens on the Styled filter: only the rows a non-browser
// rule, the element's inline style, or this session's edits supply, each with
// the source that supplied it. styledProps.js is pure; this test locks in the
// rules that keep that set honest (inherited rules only through inheritable
// properties, shorthands expanded without over-matching, `initial` resets and
// browser defaults left out). It also covers the Add-property search reaching
// every property, and the in-page cascade scan not skipping style rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const context = vm.createContext({});
// styledProps imports writesProperty (shorthand.js → valueShapes.js →
// valueKinds.js / contrast.js); load the chain into one context.
for (const f of ['contrast.js', 'valueKinds.js', 'valueShapes.js', 'shorthand.js', 'styledProps.js']) {
  vm.runInContext(strip(read('frontend/src/components/inspector/' + f)), context);
}
const { styledSources, sourceFor, styledRows, isInherited } = context;
const labelOf = (sources, prop) => { const s = sourceFor(sources, prop); return s ? s.label : null; };

const rules = [
  { selector: 'element.style', origin: 'inline', group: 'author', inherited: '', props: [{ name: 'opacity', value: '0.9' }] },
  { selector: '.card', origin: 'regular', group: 'author', inherited: '', props: [
    { name: 'padding', value: '12px' },
    { name: 'border', value: '1px solid #ddd' },
    { name: 'background', value: '#fff' },
    { name: 'background-color', value: 'rgb(255, 255, 255)' },
    { name: 'background-image', value: 'initial' },
    { name: 'color', value: '#222' },
    { name: 'margin', value: '0', disabled: true }
  ] },
  { selector: 'div', origin: 'user-agent', group: 'user-agent', inherited: '', props: [{ name: 'display', value: 'block' }] },
  { selector: 'body', origin: 'regular', group: 'author', inherited: 'body', props: [
    { name: 'font-family', value: 'system-ui' },
    { name: 'padding', value: '20px' }
  ] }
];
const sources = styledSources({ inline: [{ prop: 'opacity', value: '0.9' }], rules, changed: ['z-index'] });

assert.strictEqual(labelOf(sources, 'opacity'), 'element.style', 'an inline declaration is sourced to element.style');
assert.strictEqual(labelOf(sources, 'z-index'), 'changed here', 'a session edit wins the label');
assert.strictEqual(labelOf(sources, 'padding-top'), '.card', 'a shorthand in a rule sources its longhands');
assert.strictEqual(labelOf(sources, 'border-left-color'), '.card', 'border expands to its side longhands');
assert.strictEqual(labelOf(sources, 'border-collapse'), null, 'border does not claim border-collapse');
assert.strictEqual(labelOf(sources, 'background-color'), '.card', 'an explicit longhand is sourced');
assert.strictEqual(labelOf(sources, 'background-image'), null,
  'an `initial` longhand from a shorthand is not styling, and the shorthand is not re-expanded over it');
assert.strictEqual(labelOf(sources, 'color-scheme'), null, 'color does not claim color-scheme');
assert.strictEqual(labelOf(sources, 'margin-top'), null, 'a disabled declaration styles nothing');
assert.strictEqual(labelOf(sources, 'display'), null, 'a browser-default rule is not "styled by the page"');
assert.strictEqual(labelOf(sources, 'font-family'), 'inherited from body', 'an inherited, inheritable property is sourced to its ancestor');
assert.strictEqual(labelOf(sources, 'padding-left'), '.card', 'the element\'s own rule wins over an ancestor');

const onlyInherited = styledSources({ rules: [rules[3]] });
assert.strictEqual(labelOf(onlyInherited, 'padding-top'), null, 'an ancestor\'s padding does not style the child');
assert.ok(isInherited('color') && isInherited('font-weight') && isInherited('--brand'), 'inheritable properties are recognised');
assert.ok(!isInherited('padding') && !isInherited('display'), 'non-inherited properties are recognised');

const computed = [
  { prop: 'accent-color', value: 'auto' }, { prop: 'color', value: 'rgb(34, 34, 34)' },
  { prop: 'display', value: 'block' }, { prop: 'padding-top', value: '12px' }
];
const styled = styledRows(computed, sources);
assert.deepStrictEqual(Array.from(styled.rows, (r) => r.prop), ['color', 'padding-top'],
  'the styled rows are the author-set ones, in the order given');

// The display cap in matchedRules.js must not hide a declaration from the lookup.
const mr = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/matchedRules.js')), mr);
const many = Array.from({ length: 30 }, (_, i) => ({ name: 'p' + i, value: String(i) }));
const norm = mr.normalizeMatchedRules({ matchedCSSRules: [{ rule: { selectorList: { selectors: [{ text: '.x' }] }, style: { cssProperties: many } } }] });
assert.strictEqual(norm.rules[0].props.length, 24, 'the display list is still capped');
assert.strictEqual(norm.rules[0].all.length, 30, 'the uncapped declaration list travels with the rule');

// --- Add property reaches every property -----------------------------------
const tc = vm.createContext({});
for (const f of ['contrast.js', 'valueKinds.js', 'styleControls.js']) vm.runInContext(strip(read('frontend/src/components/inspector/' + f)), tc);
const extraProperties = vm.runInContext('extraProperties', tc);
const names = ['z-index', 'transform', 'transform-origin', 'text-transform', 'padding', '-webkit-transform', 'aspect-ratio'];
const hit = extraProperties('transform', names);
assert.deepStrictEqual(Array.from(hit.rows, (r) => r.prop), ['transform', 'transform-origin', 'text-transform', '-webkit-transform'],
  'a search lists non-library properties, prefix matches first and vendor-prefixed last');
assert.strictEqual(extraProperties('padding', names).rows.length, 0, 'a library card is not listed twice');
assert.strictEqual(extraProperties('', names).rows.length, 0, 'no query lists nothing extra');
assert.ok(extraProperties('--brand', names).rows.some((r) => r.prop === '--brand' && r.typed),
  'a custom property name can be added as typed');
assert.strictEqual(extraProperties('aspectx', names, undefined, () => false).rows.length, 0,
  'a name the browser does not support is not offered');
const big = extraProperties('a', Array.from({ length: 100 }, (_, i) => 'a' + i));
assert.strictEqual(big.rows.length <= vm.runInContext('MAX_EXTRA', tc) + 1, true, 'a broad search is capped');
assert.ok(big.more > 0, 'the cap reports how many more matched');

// --- the cascade scan does not skip style rules ----------------------------
// With CSS nesting every CSSStyleRule has a (usually empty) cssRules list, so
// "has cssRules" is not "is a group rule". Treating it as one skipped every
// rule on the page and left Matched rules with element.style only.
const events = read('frontend/src/components/inspector/events.js');
assert.ok(/if \(!r\.selectorText\)\{\s*\n[\s\S]{0,600}if \(r\.cssRules\)\{/.test(events),
  'the scan recognises a group rule by its missing selector, not by cssRules');
assert.ok(/matchMedia\(mq\)\.matches/.test(events), 'the scan skips @media blocks that do not apply');

const panel = read('frontend/src/components/inspector/StylesPanel.jsx');
assert.ok(/import \{ styledSources, sourceFor \} from '\.\/styledProps\.js'/.test(panel), 'the panel imports styledProps');

console.log('PASS inspector styled props (sources, inheritance, shorthands, add-property search, cascade scan)');
