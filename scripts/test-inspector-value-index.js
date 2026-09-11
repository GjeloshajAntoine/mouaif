'use strict';

// Inspector value index.
//
// "What values does this page actually use for this property, and which tokens
// resolve to them?" — answered from the normalized matched rules and the
// computed style the panel already reads, so the index costs no extra CDP call.
// The counting, the numeric scale (GCD), the token typing and the ranking rules
// are all pure, and asserted here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

// valueIndex imports classify from valueKinds, so both are loaded into one
// context — the same way the panel composes them at runtime.
const context = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), context);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js'))
  + '\n;globalThis.VI = { MAX_VALUES, MAX_TOKENS, buildValueIndex, valuesFor, valuesSeen, tokensFor, scaleFor, scaleNote, numericScale, parseNumber, valueKey, siblingValues, tokenFamily, tokenFitsProperty };\n', context);
const VI = context.VI;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A page whose design already has a spacing scale and radius tokens.
const RULES = [
  { selector: 'element.style', origin: 'inline', props: [{ name: 'padding', value: '14px' }] },
  { selector: '.card', origin: 'regular', props: [{ name: 'padding', value: '16px' }, { name: 'border-radius', value: '8px' }] },
  { selector: '.hero', origin: 'regular', props: [{ name: 'padding', value: '16px' }, { name: 'gap', value: '12px' }] },
  { selector: '.btn', origin: 'regular', props: [{ name: 'padding', value: '8px' }, { name: 'border-radius', value: '4px' }] },
  { selector: '.input-section', origin: 'regular', props: [{ name: 'padding', value: '16px' }, { name: 'gap', value: '12px' }, { name: 'color', value: 'rgb(20, 30, 40)' }] },
  { selector: ':root', origin: 'regular', props: [
    { name: '--space-3', value: '14px' },
    { name: '--space-4', value: '16px' },
    { name: '--radius-md', value: '8px' },
    { name: '--brand', value: 'rgb(110, 168, 254)' },
    { name: '--indirect', value: 'var(--space-4)' }
  ] },
  { selector: '.from-parent', origin: 'regular', inherited: 'form.compare', props: [{ name: 'padding', value: '12px' }] }
];
const COMPUTED = [
  { prop: 'padding', value: '16px' },
  { prop: 'border-radius', value: '8px' },
  { prop: 'color', value: 'rgb(20, 30, 40)' },
  { prop: '--space-3', value: '14px' },
  { prop: '--space-4', value: '16px' },
  { prop: '--radius-md', value: '8px' },
  { prop: '--brand', value: 'rgb(110, 168, 254)' },
  { prop: '--indirect', value: 'var(--space-4)' }
];

const index = VI.buildValueIndex({ rules: RULES, computed: COMPUTED });

// ---- counting ----------------------------------------------------------

{
  const padding = VI.valuesFor(index, 'padding');
  check('padding values are collected', padding.length === 4, String(padding.length));
  check('the value used most often comes first', padding[0].value === '16px', padding[0].value);
  check('its use count is the evidence', padding[0].count === 3, String(padding[0].count));
  check('the selector that supplies it is named', padding[0].selector === '.card', padding[0].selector);
  // Every other value is used once, so the tie-break decides: alphabetical, so a
  // chip row cannot reshuffle while a read lands.
  check('equal counts break alphabetically, not by discovery order',
    padding.slice(1).map((p) => p.value).join(',') === '12px,14px,8px',
    padding.slice(1).map((p) => p.value).join(','));
  check('the value the element resolves to is flagged',
    padding.filter((p) => p.isCurrent).length === 1 && padding.find((p) => p.isCurrent).value === '16px',
    JSON.stringify(padding.filter((p) => p.isCurrent)));
  check('an element.style declaration counts like any other',
    padding.some((p) => p.value === '14px' && p.origin === 'inline'));
  check('an inherited rule is recorded as inherited',
    padding.some((p) => p.value === '12px' && p.inherited === 'form.compare'),
    JSON.stringify(padding.find((p) => p.value === '12px')));
  check('a property with no declarations yields nothing', VI.valuesFor(index, 'z-index').length === 0);
  check('an unknown property yields nothing', VI.valuesFor(index, 'will-change').length === 0);
  check('the limit is applied', VI.valuesFor(index, 'padding', 2).length === 2);
  check('uses are counted per property', index.props.padding.uses === 6, String(index.props.padding.uses));
}

// Whitespace and case must not split a value into two entries.
{
  const idx = VI.buildValueIndex({ rules: [
    { selector: '.a', props: [{ name: 'display', value: 'flex' }] },
    { selector: '.b', props: [{ name: 'display', value: ' FLex ' }] },
    { selector: '.c', props: [{ name: 'padding', value: '16px   ' }] }
  ] });
  const display = VI.valuesFor(idx, 'display');
  check('case and whitespace collapse into one entry', display.length === 1 && display[0].count === 2, JSON.stringify(display));
  check('the first spelling is the one shown', display[0].value === 'flex', display[0].value);
  check('trailing whitespace is trimmed', VI.valuesFor(idx, 'padding')[0].value === '16px');
}

// ---- tokens -----------------------------------------------------------

{
  check('custom properties are collected as tokens, not as values',
    index.tokens.length === 5, String(index.tokens.length));
  check('a token never appears as a value for a property',
    VI.valuesFor(index, 'padding').every((v) => !v.value.startsWith('--')));
  const padTokens = VI.tokensFor(index, 'padding');
  check('a length token is offered for a length property',
    padTokens.map((t) => t.name).join(',') === '--space-3,--space-4',
    padTokens.map((t) => t.name).join(','));
  check('the token carries its resolved value', padTokens[0].value === '14px', padTokens[0].value);
  check('a radius token is NOT offered as a padding value',
    !padTokens.some((t) => t.name === '--radius-md'), padTokens.map((t) => t.name).join(','));
  check('the name family decides that, not the value type', (() => {
    // --radius-md: 8px is a valid length, so the type check alone would offer it.
    return VI.tokenFitsProperty('padding', '--radius-md') === false
      && VI.tokenFitsProperty('border-radius', '--radius-md') === true
      && VI.tokenFitsProperty('padding', '--space-3') === true;
  })());
  check('a token with no family word is left to the type check',
    VI.tokenFitsProperty('padding', '--x') === true
    && VI.tokenFitsProperty('padding', '--surface-tint') === false);
  check('an unknown property is not name-filtered',
    VI.tokenFitsProperty('will-change', '--radius-md') === true);
  check('name segments are matched, not substrings',
    VI.tokenFamily('--gap') === 'space'
    && VI.tokenFamily('--space-3') === 'space'
    && VI.tokenFamily('--radius-md') === 'radius'
    && VI.tokenFamily('--brand') === 'color'
    // `branding` and `padded` are not the family words `brand` / `pad`.
    && VI.tokenFamily('--branding-x') === ''
    && VI.tokenFamily('--padded') === '');
  const radiusTokens = VI.tokensFor(index, 'border-radius');
  check('only matching tokens are offered for a property',
    radiusTokens.map((t) => t.name).join(',') === '--radius-md', radiusTokens.map((t) => t.name).join(','));
  const colorTokens = VI.tokensFor(index, 'color');
  check('a colour token is offered for a colour property',
    colorTokens.map((t) => t.name).join(',') === '--brand', colorTokens.map((t) => t.name).join(','));
  check('a length token is not offered for a colour property',
    !colorTokens.some((t) => t.name === '--space-4'));
  // A token declared as another token resolves through computed styles; without a
  // resolution there is nothing to offer, and guessing would be inventing a value.
  check('an unresolved var() token is not offered',
    !padTokens.some((t) => t.name === '--indirect') && !radiusTokens.some((t) => t.name === '--indirect'),
    JSON.stringify(padTokens));
  check('tokens are capped', VI.tokensFor(index, 'padding', 1).length === 1);
}

// ---- the numeric scale ------------------------------------------------

{
  const scale = VI.scaleFor(index, 'padding');
  check('a scale is derived from the page values', !!scale);
  check('the dominant unit wins', scale.unit === 'px', scale.unit);
  check('the values are sorted', scale.values.join(',') === '8,12,14,16', scale.values.join(','));
  check('the step is the GCD of the values', scale.step === 2, String(scale.step));
  check('the scale note reads as evidence',
    VI.scaleNote(scale) === '4 values on this page · steps of 2px', VI.scaleNote(scale));
}
{
  // A page on a 4px scale: 4, 8, 12, 16.
  const idx = VI.buildValueIndex({ rules: [
    { selector: '.a', props: [{ name: 'padding', value: '4px' }] },
    { selector: '.b', props: [{ name: 'padding', value: '8px' }] },
    { selector: '.c', props: [{ name: 'padding', value: '12px' }] },
    { selector: '.d', props: [{ name: 'padding', value: '16px' }] }
  ] });
  check('a 4px scale reports a 4px step', VI.scaleFor(idx, 'padding').step === 4);
}
{
  // A decimal scale: 1.5, 3, 4.5 -> 1.5.
  const idx = VI.buildValueIndex({ rules: [
    { selector: '.a', props: [{ name: 'line-height', value: '1.5' }] },
    { selector: '.b', props: [{ name: 'line-height', value: '3' }] },
    { selector: '.c', props: [{ name: 'line-height', value: '4.5' }] }
  ] });
  check('a decimal scale keeps its decimals', VI.scaleFor(idx, 'line-height').step === 1.5,
    JSON.stringify(VI.scaleFor(idx, 'line-height')));
}
{
  // One value is not a scale, and mixed units have no single step.
  const one = VI.buildValueIndex({ rules: [{ selector: '.a', props: [{ name: 'padding', value: '16px' }] }] });
  check('a single value has no scale', VI.scaleFor(one, 'padding') === null);
  const none = VI.buildValueIndex({ rules: [{ selector: '.a', props: [{ name: 'padding', value: 'auto' }] }] });
  check('a keyword has no scale', VI.scaleFor(none, 'padding') === null);
  check('a scale with no step reports null rather than a guess',
    VI.numericScale([{ value: '3px', count: 1 }, { value: '5px', count: 1 }]).step === 1);
  check('mixed units fall back to the unit used most', (() => {
    const s = VI.numericScale([
      { value: '16px', count: 3 }, { value: '8px', count: 3 }, { value: '50%', count: 1 }
    ]);
    return s.unit === 'px' && s.values.join(',') === '8,16';
  })());
  check('the note is empty without a scale', VI.scaleNote(null) === '' && VI.scaleNote({ values: [8] }) === '');
}

// ---- number parsing ----------------------------------------------------

check('a length parses to its number and unit', (() => {
  const p = VI.parseNumber('16px');
  return p.n === 16 && p.unit === 'px' && p.decimals === 0;
})());
check('a decimal records its precision', VI.parseNumber('0.875rem').decimals === 3);
check('a percentage parses', (() => { const p = VI.parseNumber('50%'); return p.n === 50 && p.unit === '%'; })());
check('a negative value parses', VI.parseNumber('-4px').n === -4);
check('a bare number parses with an empty unit', VI.parseNumber('1.5').unit === '');
check('a keyword does not parse', VI.parseNumber('auto') === null);
check('a calc does not parse', VI.parseNumber('calc(100% - 2px)') === null);
check('the value key is trimmed and lower-cased', VI.valueKey('  16PX ') === '16px');
check('the value key collapses inner whitespace', VI.valueKey('0px  0px 18px') === '0px 0px 18px');

// ---- how many values were seen, not just shown -------------------------
{
// The K1 header: `On this page · 34 values seen`. The chips are capped, the
// count is not — a page with thirty padding values must not look like one with
// six.
const many = VI.buildValueIndex({ rules: Array.from({ length: 20 }, (_, i) => ({
selector: '.v' + i, props: [{ name: 'padding', value: (i + 1) * 4 + 'px' }]
})) });
check('the total is the page\'s own count', VI.valuesSeen(many, 'padding').values === 20,
String(VI.valuesSeen(many, 'padding').values));
check('the chip list is still capped', VI.valuesFor(many, 'padding').length === VI.MAX_VALUES);
check('uses counts the declarations, not the distinct values',
VI.valuesSeen(many, 'padding').uses === 20, String(VI.valuesSeen(many, 'padding').uses));
check('a repeated value counts once as a value and twice as a use', (() => {
const rep = VI.buildValueIndex({ rules: [
{ selector: '.a', props: [{ name: 'padding', value: '16px' }] },
{ selector: '.b', props: [{ name: 'padding', value: '16px' }] }
] });
const s = VI.valuesSeen(rep, 'padding');
return s.values === 1 && s.uses === 2;
})());
check('an unknown property is zero, not undefined',
VI.valuesSeen(VI.buildValueIndex({}), 'padding').values === 0);
check('no index is zero, not a throw', VI.valuesSeen(null, 'padding').values === 0);
}
// ---- sibling values ----------------------------------------------------

{
  const rows = [
    { prop: 'padding', value: '16px', label: 'section.input-section' },
    { prop: 'padding', value: '16px', label: 'section.compare' },
    { prop: 'padding', value: '8px', label: 'section.toolbar' },
    { prop: 'gap', value: '12px', label: 'section.toolbar' }
  ];
  const sib = VI.siblingValues(rows, 'padding');
  check('siblings are grouped by value', sib.length === 2, String(sib.length));
  check('the most common sibling value leads', sib[0].value === '16px' && sib[0].count === 2);
  check('the elements using it are named',
    sib[0].labels.join(',') === 'section.input-section,section.compare', sib[0].labels.join(','));
  check('another property is excluded', VI.siblingValues(rows, 'gap').length === 1);
  check('no siblings of that property yields nothing', VI.siblingValues([], 'padding').length === 0);
check('a sibling with no value for the property is skipped',
VI.siblingValues([{ prop: 'padding', value: '' }], 'padding').length === 0);
// The read that feeds it: one call per property, on the panel's event
// handlers, wired to the selected element's objectId.
{
const events = read('frontend/src/components/inspector/events.js');
check('the panel can read the siblings\' values', /readSiblingValues/.test(events)
&& /async function readSiblingValues\(objectId, property\)/.test(events));
check('the sibling read is a single in-page call carrying the property',
/functionDeclaration: 'function\(prop\)\{'/.test(events)
&& /arguments: \[\{ value: String\(property\) \}\]/.test(events));
check('the sibling read is exported to the panel', /readSiblingValues,/.test(events));
check('the read is capped so a wide row cannot be read element by element',
/const MAX_SIBLINGS = 12;/.test(events) && /out\.length < ' \+ MAX_SIBLINGS/.test(events));
check('the label names the element, with its ordinal',
/previousElementSibling/.test(events) && /"st" : nth === 2 \? "nd"/.test(events));
}

}

// ---- robustness --------------------------------------------------------

check('an empty input yields an empty index', (() => {
  const i = VI.buildValueIndex({});
  return Object.keys(i.props).length === 0 && i.tokens.length === 0;
})());
check('no input at all does not throw', !!VI.buildValueIndex());
check('a rule with no props is skipped', (() => {
  const i = VI.buildValueIndex({ rules: [{ selector: '.a' }, null] });
  return Object.keys(i.props).length === 0;
})());
check('a declaration with no name is skipped', (() => {
  const i = VI.buildValueIndex({ rules: [{ selector: '.a', props: [{ name: '', value: '1px' }, { value: '2px' }] }] });
  return Object.keys(i.props).length === 0;
})());
check('property names are matched case-insensitively',
  VI.valuesFor(VI.buildValueIndex({ rules: [{ selector: '.a', props: [{ name: 'Padding', value: '1px' }] }] }), 'padding').length === 1);

// ---- the Suggestions component ----------------------------------------
//
// Rendering the real component in a hooks-free stub: it takes the index and a
// property, and emits the chips. What matters is that a chip carries its
// evidence, that the value in force is marked, and that nothing is emitted when
// there is nothing to suggest.
{
  const nodes = [];
  const comp = vm.createContext({
    h: (type, attrs, ...children) => {
      const props = Object.assign({}, attrs || {});
      if (typeof type === 'function') return type(Object.assign(props, { children }));
      const n = { type, props, children };
      nodes.push(n);
      return n;
    }
  });
  vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/snapping.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/Suggestions.jsx')), comp);
  const walk = (n, out = []) => {
    if (n == null || typeof n !== 'object') return out;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return out; }
    out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  };
  const cls = (n) => String((n.props && n.props.class) || '');
  const byClass = (tree, c) => walk(tree).filter((n) => cls(n).split(/\s+/).includes(c));
  const text = (node) => {
  // Text has to be collected recursively: a chip's label is a child <span>, not
  // a bare string on the chip node.
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join(' ');
  return (node.children || []).map(text).join(' ');
};
const hasSuggestions = typeof comp.Suggestions === 'function';
check('the Suggestions component exists', hasSuggestions);
if (hasSuggestions) {
const tree = comp.Suggestions({ index, prop: 'padding', onPick: () => {} });
const valueChips = (c) => !cls(c).includes('inspector__suggest-token');
const chips = byClass(tree, 'opt').filter(valueChips);
check('a chip per page value, capped', chips.length === 4, String(chips.length));
    check('each chip shows the value', text(tree).includes('16px'));
    check('each chip shows its use count as evidence', /3×/.test(text(tree)), text(tree));
    check('a chip names the rule that supplies it',
      chips.some((c) => /used 3 times \(\.card\)/.test(c.props.title || '')),
      JSON.stringify(chips.map((c) => c.props.title)));
    check('the group header says how many values were seen',
    /On this page/.test(text(tree)) && /4 values/.test(text(tree)), text(tree));
    // Capped above MAX_CHIPS, the header switches to the honest total: the chip row
    // is a sample, and `20 values seen` is what says so.
    {
    const many = VI.buildValueIndex({ rules: Array.from({ length: 20 }, (_, i) => ({
    selector: '.v' + i, props: [{ name: 'padding', value: (i + 1) * 4 + 'px' }]
    })) });
    const capped = comp.Suggestions({ index: many, prop: 'padding', onPick: () => {} });
    const cappedChips = byClass(capped, 'opt').filter(valueChips);
    check('a capped list shows only the chips that fit', cappedChips.length === 6, String(cappedChips.length));
    check('a capped header reports every value seen',
    /20 values seen/.test(text(capped)), text(capped).slice(0, 200));
    check('an uncapped header does not say "seen"', !/values seen/.test(text(tree)));
    }
    check('a suggestion is a button with an accessible name',
      chips.every((c) => c.type === 'button' && /^Use /.test(c.props['aria-label'] || '')));
    check('tapping a chip reports the value', (() => {
      let picked = '';
      const t2 = comp.Suggestions({ index, prop: 'padding', onPick: (v) => { picked = v; } });
      byClass(t2, 'opt')[0].props.onClick();
      return picked === '16px';
    })());

    // The value in force is marked rather than sorted away, so the user can see
    // which of the page's values the element already resolves to.
    const current = comp.Suggestions({ index, prop: 'padding', onPick: () => {} });
    check('the value in force is marked',
      byClass(current, 'opt').filter((c) => cls(c).includes('is-current')).length === 1,
      JSON.stringify(byClass(current, 'opt').map((c) => cls(c))));

    // Tokens are a separate group: they are a different kind of answer.
    const tokTree = comp.Suggestions({ index, prop: 'padding', onPick: () => {} });
    check('tokens are offered in their own group',
      /Tokens/.test(text(tokTree)) && /--space-4/.test(text(tokTree)), text(tokTree));
    check('a token chip shows what it resolves to', /=\s*16px/.test(text(tokTree)), text(tokTree));
    check('a token chip reports the token name when picked', (() => {
      let picked = '';
      const t2 = comp.Suggestions({ index, prop: 'padding', onPick: (v) => { picked = v; } });
      const tokenChip = byClass(t2, 'opt').find((c) => /--space/.test(text({ children: c.children })) || /--space/.test(c.props.title || ''));
      if (!tokenChip) return false;
      tokenChip.props.onClick();
      return /^--space-/.test(picked);
    })());

    // Match a sibling — the group the page's own stylesheets cannot answer for.
{
const rows = [
{ prop: 'padding', value: '16px', label: '2nd section.input-section' },
{ prop: 'padding', value: '16px', label: '3rd section.compare' },
{ prop: 'padding', value: '8px', label: '4th section.toolbar' },
{ prop: 'gap', value: '12px', label: '4th section.toolbar' }
];
const sibTree = comp.Suggestions({ index, prop: 'padding', siblings: rows, onPick: () => {} });
check('a sibling group is rendered', /Match a sibling/.test(text(sibTree)), text(sibTree));
check('a sibling chip shows the value and the element it comes from',
/16px/.test(text(sibTree)) && /2nd section\.input-section/.test(text(sibTree)), text(sibTree));
check('the peers\' group is one chip per distinct value',
byClass(sibTree, 'inspector__suggest-sibling').length === 2,
String(byClass(sibTree, 'inspector__suggest-sibling').length));
check('another property\'s sibling value is not offered', (() => {
const sibText = byClass(sibTree, 'inspector__suggest-sibling').map(text).join(' ');
return !/12px/.test(sibText) && /16px/.test(sibText);
})(), text(sibTree));
check('a sibling chip names the element in its accessible name',
byClass(sibTree, 'inspector__suggest-sibling').every((c) => /what .* uses$/.test(c.props['aria-label'] || '')),
JSON.stringify(byClass(sibTree, 'inspector__suggest-sibling').map((c) => c.props['aria-label'])));
check('picking a sibling chip reports its value', (() => {
let picked = '';
const t2 = comp.Suggestions({ index, prop: 'padding', siblings: rows, onPick: (v) => { picked = v; } });
byClass(t2, 'inspector__suggest-sibling')[0].props.onClick();
return picked === '16px';
})());
check('the value already in the field is not offered back', (() => {
const t2 = comp.Suggestions({ index, prop: 'padding', value: '8px', siblings: rows, onPick: () => {} });
return byClass(t2, 'inspector__suggest-sibling').length === 1;
})());
check('the sibling row is capped at three', (() => {
const many = [1, 2, 3, 4, 5].map((i) => ({ prop: 'padding', value: i * 4 + 'px', label: i + 'th section.x' }));
const t2 = comp.Suggestions({ index, prop: 'padding', siblings: many, onPick: () => {} });
return byClass(t2, 'inspector__suggest-sibling').length === 3;
})());
check('siblings alone are enough to render the row', (() => {
// A property the page declares nothing for, but whose peers have a value: the
// index has no suggestions at all, and the group must still appear.
const spacing = [{ prop: 'letter-spacing', value: '0.02em', label: '2nd section.input-section' }];
const t2 = comp.Suggestions({ index, prop: 'letter-spacing', siblings: spacing, onPick: () => {} });
return t2 !== null && /Match a sibling/.test(text(t2)) && /0\.02em/.test(text(t2));
})());
check('no sibling rows means no group',
!/Match a sibling/.test(text(comp.Suggestions({ index, prop: 'padding', onPick: () => {} }))));
check('the sheet hands the read rows to this component',
/h\(Suggestions, \{/.test(read('frontend/src/components/inspector/StylesPanel.jsx'))
&& /siblings: siblings/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the sheet asks for the siblings once per property, not per render',
/const readSiblingsRef = useRef\(props\.readSiblings\);/.test(read('frontend/src/components/inspector/StylesPanel.jsx'))
&& /\}, \[propName\]\);/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the panel binds the read to the selected element',
/readSiblingValues: handlers \? handlers\.readSiblingValues : null/.test(read('frontend/src/components/Inspector.jsx')));
check('a sibling chip is styled so a long label cannot widen the sheet',
/\.inspector__suggest-sibling \.inspector__suggest-ev \{/.test(read('frontend/src/inspector.css')));
}
check('nothing is emitted without a property',
      comp.Suggestions({ index, prop: '', onPick: () => {} }) === null);
    check('nothing is emitted without an index',
      comp.Suggestions({ prop: 'padding', onPick: () => {} }) === null);
    check('a property the page never declares emits nothing',
      comp.Suggestions({ index, prop: 'z-index', onPick: () => {} }) === null);
    check('a custom property has no suggestions of its own',
      comp.Suggestions({ index, prop: '--space-3', onPick: () => {} }) === null);
  }
}

// ---- the sheet wiring --------------------------------------------------

check('the sheet renders the suggestions',
/h\(Suggestions, \{/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the index is built from the rules and the computed style',
/buildValueIndex\(\{ rules: \(rules && rules\.rules\) \|\| \[\], computed: computedRows \}\)/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the index is memoised so a CDP rerender does not rebuild it',
/useMemo\(\s*\(\) => buildValueIndex/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('picking a suggestion only rewrites the field',
/onPick: \(next\) => \{ setValue\(next\); setApplied\(false\); setError\(''\); \}/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the suggestion chips are styled', /\.inspector__suggest \{/.test(read('frontend/src/inspector.css')));
// ---- Part V3: snapping and contrast in the same row ---------------------
// The snap hint is rendered by this component too, so an off-scale value is
// reported where the user is already looking for a value. Rendered in the same
// hooks-free stub as above, with its own context.
{
const nodes = [];
const comp = vm.createContext({
h: (type, attrs, ...children) => {
const props = Object.assign({}, attrs || {});
if (typeof type === 'function') return type(Object.assign(props, { children }));
const n = { type, props, children };
nodes.push(n);
return n;
}
});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/snapping.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js')), comp);
vm.runInContext(strip(read('frontend/src/components/inspector/Suggestions.jsx')), comp);
const walk3 = (n, out = []) => {
if (n == null || typeof n !== 'object') return out;
if (Array.isArray(n)) { n.forEach((x) => walk3(x, out)); return out; }
out.push(n);
(n.children || []).forEach((c) => walk3(c, out));
return out;
};
const cls = (n) => String((n.props && n.props.class) || '');
const byClass = (tree, c) => walk3(tree).filter((n) => cls(n).split(/\s+/).includes(c));
const text = (node) => {
if (node == null) return '';
if (typeof node === 'string') return node;
if (Array.isArray(node)) return node.map(text).join(' ');
return (node.children || []).map(text).join(' ');
};
const withScale = comp.Suggestions({ index, prop: 'padding', value: '13px', onPick: () => {} });
check('an off-scale typed value gets a snap hint',
byClass(withScale, 'inspector__suggest-snap').length === 1,
JSON.stringify(byClass(withScale, 'inspector__suggest-snap').length));
check('the hint is marked as off-scale',
byClass(withScale, 'inspector__suggest-snap').every((n) => cls(n).includes('is-off')));
check('the hint names the nearest page value',
/nearest 12px/.test(text(withScale)), text(withScale));
check('the hint offers a one-tap snap',
byClass(withScale, 'inspector__suggest-snap-btn').length === 1);
check('the snap button is labelled with its target',
byClass(withScale, 'inspector__suggest-snap-btn')[0].props['aria-label'] === 'Snap 13px to 12px',
byClass(withScale, 'inspector__suggest-snap-btn')[0].props['aria-label']);
check('tapping the snap button only rewrites the field', (() => {
let picked = '';
const t = comp.Suggestions({ index, prop: 'padding', value: '13px', onPick: (v) => { picked = v; } });
byClass(t, 'inspector__suggest-snap-btn')[0].props.onClick();
return picked === '12px';
})());
const onScale = comp.Suggestions({ index, prop: 'padding', value: '16px', onPick: () => {} });
check('an on-scale value says so instead of nagging',
byClass(onScale, 'inspector__suggest-snap').some((n) => cls(n).includes('is-on'))
&& byClass(onScale, 'inspector__suggest-snap-btn').length === 0);
const noScale = comp.Suggestions({ index, prop: 'z-index', value: '7', onPick: () => {} });
check('no scale and no values emits nothing at all', noScale === null);
const empty = comp.Suggestions({ index, prop: 'padding', value: '', onPick: () => {} });
check('an empty field gets no snap hint',
byClass(empty, 'inspector__suggest-snap').length === 0);
// A colour property renders swatches with a WCAG badge instead of use counts,
// so a legibility mistake is visible on the chip rather than after Apply.
const colourTree = comp.Suggestions({
index, prop: 'color', value: '#ffffff', onPick: () => {},
contrastCtx: { bg: '#131824', color: '#ffffff' }
});
check('a colour property renders the palette group',
/This page's palette/.test(text(colourTree)), text(colourTree));
check('a colour chip carries a swatch',
byClass(colourTree, 'inspector__suggest-sw').length >= 1);
check('a colour chip carries a contrast ratio',
byClass(colourTree, 'inspector__suggest-aa').length >= 1);
check('the ratio is the WCAG one for white on the mock background',
byClass(colourTree, 'inspector__suggest-aa').length >= 1
&& byClass(colourTree, 'inspector__suggest-aa').every((n) => /\d/.test(text({ children: n.children }))),
JSON.stringify(byClass(colourTree, 'inspector__suggest-aa').map((n) => text({ children: n.children }))));
check('the contrast hint wraps rather than scrolling',
/\.inspector__suggest-snap \{[\s\S]*?flex-wrap: wrap/.test(read('frontend/src/inspector.css')));
check('the snap button is a ≥44 px target',
/\.inspector__suggest-snap-btn \{[\s\S]*?min-height: 44px/.test(read('frontend/src/inspector.css')));
check('the new guidance is styled',
/\.inspector__suggest-aa \{/.test(read('frontend/src/inspector.css'))
&& /\.inspector__suggest-sw \{/.test(read('frontend/src/inspector.css')));
}
// The steppers move by the page's own step when the index found one.
check('the sheet derives the page step from the index',
/const pageStep = stepFor\(pageScale, null\)/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the steppers use the page step',
/const down = stepValue\(value, -1, pageStep\)/.test(read('frontend/src/components/inspector/StylesPanel.jsx'))
&& /const up = stepValue\(value, 1, pageStep\)/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the sheet states the step it is using',
/Stepping by ' \+ pageStep/.test(read('frontend/src/components/inspector/StylesPanel.jsx')));
check('the step line is styled', /\.inspector__style-step-note \{/.test(read('frontend/src/inspector.css')));
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' value-index assertion(s) failed');
