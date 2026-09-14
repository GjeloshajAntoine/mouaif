'use strict';

// Inspector touch-first style controls — the control surface behind the Styles
// tab's chips, sliders, box model and swatches.
//
// The surface exists so a style can be changed on a phone without a keyboard, and
// every promise it makes is arithmetic or selection rather than layout:
//
//   - a control shows the value the element *has*, from its own declaration first
//     and the computed style second, so it agrees with the declared list;
//   - a slider's span, its Fine / Coarse steps, `+` and `−` are all computed, so
//     "tapping + moved it by 4px" is a rule and not a coincidence;
//   - a unit chip only offers a conversion it can do without inventing a base
//     size, and falls back to px when it cannot;
//   - only the controls that apply to this element are shown (a Block element has
//     no flex-direction row), which is what keeps six tabs from reading as a wall.
//
// All of that lives in frontend/src/components/inspector/styleControls.js, and is
// asserted here rather than through the UI. The last section checks the wiring and
// the CSS invariants a refactor could silently break: the 44 px floor on every
// touch target, no horizontal scroller anywhere in the surface, and the panel
// still handing the surface the same declared/computed pair it renders.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const { readInspectorCss } = require('./inspector-css.js');

const kindsSource = strip(read('frontend/src/components/inspector/valueKinds.js'));
const controlsSource = strip(read('frontend/src/components/inspector/styleControls.js'));
const surfaceSource = read('frontend/src/components/inspector/StyleControls.jsx');
const sheetSource = read('frontend/src/components/inspector/AddPropertySheet.jsx');
const portalSource = read('frontend/src/components/inspector/sheetPortal.js');
const panelSource = read('frontend/src/components/inspector/StylesPanel.jsx');
const css = readInspectorCss();

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const ctx = vm.createContext({});
vm.runInContext(
  kindsSource + '\n' + controlsSource
  + '\n;globalThis.TC = { GROUPS, SIDES, BOXES, CONTROLS, LIBRARY, LIBRARY_GROUPS, RANGE_SPECS,'
  + ' baseProp, specFor, specForValue, stepChoices, readValue, readDeclared, foldSides, isDeclared,'
  + ' parseNumber, pxOf, toUnit, unitFor,'
  + ' percentFor, quantize, valueAtPercent, nudgeValue, unitChoices, segmentOptions, isFlex, isGrid,'
  + ' controlsFor, defaultGroup, boxEdges, edgeValue, searchLibrary, libraryRow, libraryCounts };\n',
  ctx
);
const TC = ctx.TC;

// A stand-in for the panel's model: the element declares padding-top and
// font-size, and the page resolves everything else. 16 px root, 20 px parent font.
const DECLARED = [
  { prop: 'padding-top', value: '12px' },
  { prop: 'font-size', value: '1.25rem' },
  { prop: 'display', value: 'flex' }
];
const COMPUTED = [
  { prop: 'display', value: 'flex' },
  { prop: 'padding-top', value: '12px' },
  { prop: 'padding-right', value: '8px' },
  { prop: 'padding-bottom', value: '12px' },
  { prop: 'padding-left', value: '8px' },
  { prop: 'margin-top', value: '0px' },
  { prop: 'gap', value: '16px' },
  { prop: 'font-size', value: '20px' },
  { prop: 'color', value: 'rgb(236, 234, 241)' },
  { prop: 'position', value: 'static' },
  { prop: 'width', value: 'auto' }
];
const MODEL = { declared: DECLARED, computed: COMPUTED };
const UNITS = { rootFontSize: 16, parentFontSize: 20, fontSize: 20 };

// ---- property names ----------------------------------------------------

check('a side longhand resolves to its shorthand', TC.baseProp('padding-top') === 'padding');
check('a logical longhand is left alone', TC.baseProp('border-top-left-radius') === 'border-top-left-radius');
check('a plain property resolves to itself', TC.baseProp('gap') === 'gap');
check('a side longhand takes the shorthand\'s span',
  TC.specFor('padding-top').max === TC.RANGE_SPECS.padding.max);
check('an unknown property gets a usable default span',
  TC.specFor('object-fit').min === 0 && TC.specFor('object-fit').max > 0);
check('every range spec has a positive step and an ordered span',
  Object.keys(TC.RANGE_SPECS).every((p) => {
    const s = TC.RANGE_SPECS[p];
    return s.step > 0 && s.max > s.min;
  }));
check('Coarse is the spec step and Fine is smaller',
  TC.stepChoices({ step: 4 }).coarse === 4 && TC.stepChoices({ step: 4 }).fine === 1);
check('a sub-pixel spec keeps a half step rather than a quarter',
  TC.stepChoices({ step: 0.1 }).fine === 0.05);
// `line-height` resolves to px on any element whose value comes from a rule, so
// the multiplier's 0.8…3 span would pin the slider at its maximum and the row
// would look alive while doing nothing.
check('a unitless spec enforces its own form',
  TC.specForValue('line-height', '1.5') === TC.RANGE_SPECS['line-height']);
check('the same property met in px gets a px span',
  TC.specForValue('line-height', '62px').max === 96
  && TC.specForValue('line-height', '62px').units.join() === 'px');
check('the px form puts the value inside its span',
  TC.percentFor('62px', TC.specForValue('line-height', '62px')) > 0.5
  && TC.percentFor('62px', TC.specForValue('line-height', '62px')) < 0.7);
check('a spec with no alternate form is returned as it is',
  TC.specForValue('opacity', '1') === TC.RANGE_SPECS.opacity);

// ---- reading the element ----------------------------------------------

check('a declared value wins over the computed one',
  TC.readValue('padding-top', MODEL) === '12px');
check('a computed value answers for a property the element does not declare',
  TC.readValue('gap', MODEL) === '16px');
check('a property in neither list reads empty', TC.readValue('z-index', MODEL) === '');
check('the read is case-insensitive', TC.readValue('PADDING-TOP', MODEL) === '12px');
check('a blank property reads empty', TC.readValue('', MODEL) === '');
check('a missing context reads empty', TC.readValue('gap', null) === '');
check('isDeclared is true only for the element\'s own style',
  TC.isDeclared('padding-top', MODEL) && !TC.isDeclared('gap', MODEL));
check('an untouched element declares nothing', !TC.isDeclared('gap', { computed: COMPUTED }));

// ---- numbers -----------------------------------------------------------

check('px parses into a number and a unit', TC.parseNumber('24px').number === 24
  && TC.parseNumber('24px').unit === 'px');
check('a unitless number parses', TC.parseNumber('1.5').number === 1.5);
check('a negative value parses', TC.parseNumber('-2px').number === -2);
check('a keyword does not parse', TC.parseNumber('auto') === null);
check('a calc does not parse', TC.parseNumber('calc(2px + 1rem)') === null);
check('a blank value does not parse', TC.parseNumber('') === null);
check('rem resolves to px with the root size', TC.pxOf('1.25rem', UNITS) === 20);
check('rem without a root size stays a number, so the slider still moves',
  TC.pxOf('1.25rem', {}) === 1.25);
check('em resolves against the parent font size', TC.pxOf('1.5em', UNITS) === 30);
check('a percentage is not treated as px', TC.pxOf('50%', UNITS) === 50);
check('a keyword has no px value', TC.pxOf('auto', UNITS) === null);

check('quantize snaps to the step grid', TC.quantize(23.4, 4) === 24);
check('quantize keeps a sub-pixel step honest', TC.quantize(1.24, 0.1) === 1.2);
check('percentFor maps the span ends to 0 and 1',
  TC.percentFor('0px', TC.RANGE_SPECS.gap) === 0
  && TC.percentFor('64px', TC.RANGE_SPECS.gap) === 1);
check('percentFor pins a value beyond the span to the near end',
  TC.percentFor('120px', TC.RANGE_SPECS.gap) === 1);
check('percentFor pins an unparsable value to 0 rather than failing',
  TC.percentFor('auto', TC.RANGE_SPECS.width) === 0);
check('valueAtPercent reads the span back', TC.valueAtPercent(0.5, TC.RANGE_SPECS.gap, 4) === 32);
check('valueAtPercent quantizes to the step in force',
  TC.valueAtPercent(0.51, TC.RANGE_SPECS.gap, 4) === 32);
check('valueAtPercent clamps outside 0…1', TC.valueAtPercent(2, TC.RANGE_SPECS.gap, 4) === 64);
check('a Fine step lands between the coarse values',
  TC.valueAtPercent(0.01, TC.RANGE_SPECS.gap, 1) === 1);

// ---- the steppers ------------------------------------------------------

check('+ moves by the coarse step', TC.nudgeValue('16px', 1, TC.RANGE_SPECS.gap, 4).css === '20px');
check('− moves the other way', TC.nudgeValue('16px', -1, TC.RANGE_SPECS.gap, 4).css === '12px');
check('− clamps at the bottom of the span instead of writing a negative padding',
  TC.nudgeValue('2px', -1, TC.RANGE_SPECS.padding, 4).css === '0px');
check('+ clamps at the top of the span',
  TC.nudgeValue('64px', 1, TC.RANGE_SPECS.gap, 4).css === '64px');
check('a keyword cannot be nudged — the steppers are disabled, not guessing',
  TC.nudgeValue('auto', 1, TC.RANGE_SPECS.width, 8) === null);
check('a Fine step moves a fraction', TC.nudgeValue('16px', 1, TC.RANGE_SPECS.gap, 1).css === '17px');

// ---- units -------------------------------------------------------------

check('a px value is written back in px', TC.toUnit(24, 'gap', 'px', UNITS) === '24px');
check('a rem write uses the root size', TC.toUnit(32, 'gap', 'rem', UNITS) === '2rem');
check('an em write uses the parent size', TC.toUnit(30, 'font-size', 'em', UNITS) === '1.5em');
check('font-size takes a percentage of the parent size',
  TC.toUnit(20, 'font-size', '%', UNITS) === '100%');
check('a padding percentage falls back to px rather than inventing a container width',
  TC.toUnit(24, 'padding', '%', UNITS) === '24px');
check('a rem write without a root size falls back to px',
  TC.toUnit(24, 'gap', 'rem', {}) === '24px');
check('a unitless property is written unitless', TC.toUnit(0.5, 'opacity', '', UNITS) === '0.5');
check('a value keeps its own unit, so a rem declaration stays rem',
  TC.unitFor('font-size', '1.25rem', TC.RANGE_SPECS['font-size']) === 'rem');
check('a unitless property has no unit to keep',
  TC.unitFor('opacity', '0.5', TC.RANGE_SPECS.opacity) === '');
check('an unparsable value starts at the spec\'s first unit',
  TC.unitFor('width', 'auto', TC.RANGE_SPECS.width) === 'px');

check('a length offers its unit chips', TC.unitChoices('gap', '16px', UNITS).length >= 2);
check('the unit in use is marked current',
  TC.unitChoices('gap', '16px', UNITS).filter((u) => u.current).length === 1);
check('a unit conversion with no base size is offered but disabled, with a reason',
  TC.unitChoices('gap', '16px', {}).some((u) => !u.ok && u.reason));
check('a unitless property offers no unit chips', TC.unitChoices('opacity', '0.5', UNITS).length === 0);
check('a keyword value offers no unit chips', TC.unitChoices('width', 'auto', UNITS).length === 0);

// ---- segments ----------------------------------------------------------

const displayControl = TC.CONTROLS.find((c) => c.id === 'display');
const displayRows = TC.segmentOptions(displayControl, 'flex');
check('the value in force is the segment that is on',
  displayRows.filter((r) => r.isOn).length === 1 && displayRows.find((r) => r.isOn).value === 'flex');
check('every other segment is offered',
  displayRows.length === displayControl.options.length);
const unknownRows = TC.segmentOptions(displayControl, 'table');
check('a value outside the list still gets a chip, so the row answers "what is it now?"',
  unknownRows.length === displayControl.options.length + 1
  && unknownRows[0].value === 'table' && unknownRows[0].isOn && unknownRows[0].unknown);
check('an empty value leaves no segment on',
  TC.segmentOptions(displayControl, '').every((r) => !r.isOn));

// ---- which controls apply ---------------------------------------------

check('a flex container is a flex container', TC.isFlex(MODEL) && !TC.isGrid(MODEL));
check('a grid container is a grid container',
  TC.isGrid({ computed: [{ prop: 'display', value: 'grid' }] }));
check('the layout group offers Display and Position to a Block element',
  TC.controlsFor('layout', { computed: [{ prop: 'display', value: 'block' }] })
    .map((c) => c.prop).join(',') === 'display,position');
check('the flex controls are absent for a Block element',
  !TC.controlsFor('layout', { computed: [{ prop: 'display', value: 'block' }] })
    .some((c) => c.prop === 'flex-direction'));
const flexControls = TC.controlsFor('layout', MODEL).map((c) => c.prop);
check('a flex container gets direction, alignment, justify and gap',
  ['display', 'flex-direction', 'align-items', 'justify-content', 'gap']
    .every((p) => flexControls.indexOf(p) >= 0));
check('a grid container gets gap but no flex-direction',
  TC.controlsFor('layout', { computed: [{ prop: 'display', value: 'grid' }] })
    .some((c) => c.prop === 'gap')
  && !TC.controlsFor('layout', { computed: [{ prop: 'display', value: 'grid' }] })
    .some((c) => c.prop === 'flex-direction'));
check('the spacing group is the box model and nothing else',
  TC.controlsFor('spacing', MODEL).map((c) => c.prop).join(',') === 'padding');
check('every control names a group that exists',
  TC.CONTROLS.every((c) => TC.GROUPS.some((g) => g.id === c.group)));
check('every control has a label, a property and a kind',
  TC.CONTROLS.every((c) => c.label && c.prop && c.kind));
check('every group has at least one control that always applies',
  TC.GROUPS.every((g) => TC.CONTROLS.some((c) => c.group === g.id && !c.when)));
check('the default group is Layout for a flex container', TC.defaultGroup(MODEL) === 'layout');
check('the default group is Spacing otherwise',
  TC.defaultGroup({ computed: [{ prop: 'display', value: 'block' }] }) === 'spacing');

// ---- the box model -----------------------------------------------------

const edges = TC.boxEdges(MODEL);
check('the box model has eight edges', edges.length === 8);
check('a declared edge is marked as set',
  edges.find((e) => e.prop === 'padding-top').isSet);
check('a resolved edge still shows its value',
  TC.edgeValue(edges, 'padding', 'right') === '8px');
check('an edge the page resolves from the element itself reads inline first',
  TC.edgeValue(edges, 'padding', 'top') === '12px');
check('a zero edge is a value, not a missing one',
  TC.edgeValue(edges, 'margin', 'top') === '0px');
check('every edge is a real longhand',
  edges.every((e) => e.prop === e.box + '-' + e.side));

// ---- the add-property library -----------------------------------------

const all = TC.searchLibrary('', 'all');
check('an empty query and the All category list every card', all.length === TC.LIBRARY.length);
check('every card names a group that exists',
  TC.LIBRARY.every((row) => TC.LIBRARY_GROUPS.some((g) => g.id === row.group)));
check('every card has a label, a blurb and a preview kind',
  TC.LIBRARY.every((row) => row.label && row.blurb && row.preview));
check('a query matches the property name', TC.searchLibrary('padding', 'all').length >= 1);
check('a query matches the card\'s own words, not just the CSS name',
  TC.searchLibrary('round', 'all').some((r) => r.prop === 'border-radius'));
check('a query matches the description',
  TC.searchLibrary('space outside', 'all').some((r) => r.prop === 'margin'));
check('a query is case-insensitive', TC.searchLibrary('PADDING', 'all').length
  === TC.searchLibrary('padding', 'all').length);
check('a category narrows the list',
  TC.searchLibrary('', 'colour').every((r) => r.group === 'colour'));
check('a query and a category are applied together',
  TC.searchLibrary('font', 'text').every((r) => r.group === 'text'));
check('a query nothing matches leaves nothing rather than everything',
  TC.searchLibrary('zzz-nope', 'all').length === 0);
const counts = TC.libraryCounts('');
check('the All count is every card',
  counts.all === TC.LIBRARY.length);
check('the category counts sum to the library',
  TC.LIBRARY_GROUPS.filter((g) => g.id !== 'all')
    .reduce((n, g) => n + counts[g.id], 0) === TC.LIBRARY.length);

// The CSSOM stores `padding: 12px 8px` as four longhands, so a question about the
// shorthand is answered by its longhands — and folded back for display.
const FULL = {
declared: [
{ prop: 'padding-top', value: '12px' },
{ prop: 'padding-right', value: '8px' },
{ prop: 'padding-bottom', value: '12px' },
{ prop: 'padding-left', value: '8px' }
],
computed: []
};
const card = TC.libraryRow(TC.LIBRARY.find((r) => r.prop === 'font-size'), MODEL);
check('a card for a declared property reads its current value',
card.isSet && card.value === '1.25rem' && card.action === 'Edit');
check('a shorthand is declared when the engine stored all of its longhands',
TC.readDeclared('padding', FULL) === '12px 8px' && TC.isDeclared('padding', FULL));
check('a card whose longhands are declared reads as set, folded into shorthand form',
TC.libraryRow(TC.LIBRARY.find((r) => r.prop === 'padding'), FULL).isSet
&& TC.libraryRow(TC.LIBRARY.find((r) => r.prop === 'padding'), FULL).value === '12px 8px');
check('four equal sides fold to one value',
TC.foldSides(['8px', '8px', '8px', '8px']) === '8px');
check('two equal pairs fold to two values',
TC.foldSides(['8px', '4px', '8px', '4px']) === '8px 4px');
check('three distinct values keep three, per CSS shorthand order',
TC.foldSides(['8px', '4px', '2px', '4px']) === '8px 4px 2px');
check('four distinct values keep all four',
TC.foldSides(['1px', '2px', '3px', '4px']) === '1px 2px 3px 4px');
check('a half-declared shorthand is not reported as set',
TC.readDeclared('padding', MODEL) === null && !TC.isDeclared('padding', MODEL));
check('a card for a property the element does not declare offers Choose',
!TC.libraryRow(TC.LIBRARY.find((r) => r.prop === 'max-width'), MODEL).isSet
&& TC.libraryRow(TC.LIBRARY.find((r) => r.prop === 'max-width'), MODEL).action === 'Choose');
check('a card\'s title says what tapping it will do',
/Edit Font size/.test(card.title) && /now 1\.25rem/.test(card.title));

// ---- the surface is wired to the panel --------------------------------

check('the panel renders the touch surface',
  /import \{ StyleControls \} from '\.\/StyleControls\.jsx'/.test(panelSource)
  && /h\(StyleControls, \{/.test(panelSource));
check('the surface is given the same declared/computed pair the lists render',
  /ctx: \{ declared: inlineRows, computed: computedRows \}/.test(panelSource));
check('the surface is given the base font sizes the unit chips convert with',
  /unitCtx,/.test(panelSource) && /rootFontSize: model\.bases\.root/.test(panelSource));
check('the surface is keyed by element, so a selection resets its group tab',
  /key: 'touch-' \+ \(\(model && model\.objectId\) \|\| 'none'\)/.test(panelSource));
check('the surface writes through the panel\'s own apply path',
  /onApply: applyControl,/.test(panelSource) && /async function applyControl\(prop, value\)/.test(panelSource)
  && /await applyEdit\(prop, value\)/.test(panelSource));
check('a failed control write is reported in the panel, not as a rejection',
  /async function applyControl[\s\S]{0,220}catch \(e\) \{[\s\S]{0,120}setError/.test(panelSource));
check('a control\'s value button opens the same editor a declared row opens',
  /onEdit: \(prop, value\) => setEdit\(\{ prop, value \}\)/.test(panelSource));
check('the value index answers the colour swatches, so they cost no page read',
  /swatchesFor: \(prop\) => valuesFor\(valueIndex, prop, 6\)/.test(panelSource));
check('the primary button opens the card sheet',
  /onAddProperty: \(\) => setAddOpen\(true\)/.test(panelSource));
check('the card sheet is rendered by the panel with its suggestions',
  /h\(AddPropertySheet, \{/.test(panelSource) && /suggestions: COMMON_CSS,/.test(panelSource));
check('picking a card closes the sheet and opens the value editor on that property',
  /onPick: \(row\) => \{[\s\S]{0,160}setAddOpen\(false\);[\s\S]{0,160}setEdit\(\{ prop: row\.prop, value: row\.isSet \? row\.value : '' \}\)/.test(panelSource));
check('clearing the selection closes the card sheet',
  /setEdit\(null\);[\s\S]{0,200}setAddOpen\(false\)/.test(panelSource));
check('the surface uses a native range, so a phone already knows how to drag it',
/type: 'range'/.test(surfaceSource) && /class: 'inspector__touch-slider'/.test(surfaceSource));
// ---- group-tab navigation must not strand the user ---------------------
// Switching group *replaces* every card below the chip row while the panel's
// own scroller keeps its offset. Measured on a 360 x 667 phone against a real
// debug target: after reading the bottom of the Text group and tapping Spacing,
// the chip row and the whole new group sat 2 192 px above the panel, leaving an
// empty panel on screen — the tap read as "the panel emptied". These pin the
// three pieces that fix it: the panel asks, the surface exposes the one node
// that must stay in view, and the ask happens only on a real group change.
check('a group tap reports the new group up to the panel',
/if \(props\.onGroupChange\) props\.onGroupChange\(g\.id\)/.test(surfaceSource));
check('re-tapping the group already on is not a group change',
/p\.id !== group\) return;/.test(surfaceSource) || /g\.id === group\) return;/.test(surfaceSource));
check('the surface publishes its chip row through the caller\'s ref',
/ref: props\.tabsRef/.test(surfaceSource));
check('the surface exposes a reveal that reads the caller\'s ref, not one of its own',
/props\.revealRef\.current = \(\) => revealInPanel\(/.test(surfaceSource)
&& /props\.tabsRef && props\.tabsRef\.current/.test(surfaceSource));
check('the panel owns the group state so it can scroll after the render',
/const \[touchGroup, setTouchGroup\] = useState\(''\)/.test(panelSource));
check('the reveal runs from an effect keyed on the group change',
/useEffect\(\(\) => \{[\s\S]{0,400}revealRef\.current[\s\S]{0,80}\}, \[touchGroup\]\)/.test(panelSource));
check('an untouched panel never reveals',
/if \(!touchGroup\) return;/.test(panelSource));
check('the panel wires the surface\'s ref, reveal and change reporter',
/tabsRef,/.test(panelSource) && /revealRef,/.test(panelSource) && /onGroupChange: setTouchGroup/.test(panelSource));
// The reveal must account for the panel's sticky block: it is opaque chrome
// welded to the top of the scroller, so a node aligned to the scroller's top
// edge lands *under* it and is invisible.
check('the reveal starts below the panel\'s sticky block, not at the scroller top',
/querySelector\('\.inspector__styles-pin'\)/.test(surfaceSource)
&& /Math\.max\(bounds\.top, pinBox\.bottom\)/.test(surfaceSource));
check('the reveal refuses to move a panel with no visible height',
/if \(!bounds\.height\) return;/.test(surfaceSource));
check('the reveal leaves an already-visible node alone',
/box\.top >= top \+ pad && box\.bottom <= bounds\.bottom - pad\) return;/.test(surfaceSource));
// A hook used but not imported fails at *runtime*, not at build time: the
// missing-import version of this surface built cleanly and then threw on the
// first render (Preact's `useRef` was undefined), taking the whole panel down.
// Nothing in the toolchain catches it — .jsx files are not part of `npm run
// lint` — so the import list is checked against actual use here.
for (const [file, src] of [['StyleControls.jsx', surfaceSource], ['StylesPanel.jsx', panelSource]]) {
  const imported = (/import \{([^}]*)\} from 'preact\/hooks'/.exec(src) || [, ''])[1]
    .split(',').map((s) => s.trim()).filter(Boolean);
  const used = Array.from(new Set((src.match(/\b(use[A-Z][A-Za-z]*)\s*\(/g) || [])
    .map((m) => m.replace(/[\s(]/g, ''))))
    .filter((name) => /^use(State|Effect|Ref|Memo|Callback|Context|Reducer|LayoutEffect)$/.test(name));
  const missing = used.filter((name) => !imported.includes(name));
  check(file + ' imports every preact hook it uses',
    missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : used.sort().join(','));
}

// ---- an element hop must reveal the element it landed on ---------------
// Every tree hop re-reads the element, its tree and its rules, so the panel
// grows; an offset measured against the old element is stale by definition. The
// same measurement as above left a new selection's identity, pinned preview and
// chip row 2 193 px above the viewport.
check('a new element scrolls the panel back to its sticky block',
/const \[panelRef\]|panelRef = useRef\(null\)/.test(panelSource)
&& /revealedRef\.current = objectId;/.test(panelSource)
&& /if \(panel\) panel\.scrollTop = 0;/.test(panelSource));
check('re-reading the same element does not move the panel',
/revealedRef\.current === objectId\) return;/.test(panelSource));
check('a cleared panel forgets what it had revealed',
/revealedRef\.current = ''; return;/.test(panelSource));
// The error line is what a *failed* hop reports through, and a failed hop is
// exactly the case where the user is scrolled deep in the panel — so it lives
// with the element it is about, inside the sticky block.
check('a failed hop reports inside the sticky block, where the user is looking',
(() => {
  const pin = panelSource.indexOf("h('div', { class: 'inspector__styles-pin' },");
  const alert = panelSource.indexOf("role: 'alert'", pin);
  return pin >= 0 && alert > pin && alert - pin < 1200;
})());
check('a drag previews locally and writes once on release',
  /onInput: \(e\) => setDraft/.test(surfaceSource) && /onChange: \(e\) => \{ setDraft\(null\); commitPct/.test(surfaceSource));
check('the surface offers Fine and Coarse steps',
  /'Coarse'/.test(surfaceSource) && /'Fine'/.test(surfaceSource));
check('every control has a value button into the exact editor',
  /class: 'inspector__touch-value'/.test(surfaceSource)
  && /onClick: \(\) => props\.onEdit\(props\.prop, props\.value\)/.test(surfaceSource));
check('the box model renders a margin ring and a nested padding ring',
  /box: 'margin'/.test(surfaceSource) && /box: 'padding'/.test(surfaceSource)
  && /inspector__touch-boxes/.test(surfaceSource));
check('the card sheet has a search field and category tabs',
/type: 'search'/.test(sheetSource) && /LIBRARY_GROUPS\.map/.test(sheetSource));
// Switching category (or typing a search) replaces every card under the
// controls, and a scroller keeps its offset across that swap — so the new list
// rendered *past* its own end and the chip row you had just tapped sat above the
// body's top edge. Measured at 360 x 667: All scrolled to `2208/2208`, tap Type,
// body still at `183/183` with the chips at `top 63` against a body top of `156`.
// The chips and the search field live at the top of this scroller, so the reset
// is what makes the tap read as "I changed category".
check('switching category or search returns the card sheet to its top',
/const bodyRef = useRef\(null\)/.test(sheetSource)
&& /bodyRef\.current/.test(sheetSource)
&& /\[group, query\]/.test(sheetSource)
&& /inspector__addprop-body', ref: bodyRef/.test(sheetSource));
// The imported hooks have to match what the file uses. `.jsx` is not covered by
// `node -c` (see the note in this file's header), so a missing import builds
// cleanly and then throws on first render, taking the sheet down.
{
const hooks = new Set([...sheetSource.matchAll(/\b(use[A-Z][A-Za-z]*)\s*\(/g)].map((m) => m[1]));
const imported = new Set(
(/from 'preact\/hooks';/.test(sheetSource)
? (/import\s*\{([^}]*)\}\s*from 'preact\/hooks';/.exec(sheetSource) || [, ''])[1]
: '').split(',').map((s) => s.trim()).filter(Boolean)
);
const missing = [...hooks].filter((hh) => !imported.has(hh));
check('the card sheet imports every preact hook it calls', missing.length === 0, missing.join(', '));
}
// A sheet whose max-height is `dvh`-only loses its ceiling on a browser that
// does not understand `dvh`, and is then sized by its content: the Add-property
// sheet grew to 757 px in a 667 px viewport, and `align-items: flex-end` pushed
// its header and Close off screen with nothing left tappable to dismiss it
// (measured: hit-test at the Close button's centre returned null, and neither the
// space above nor below the sheet belonged to the overlay). Every sheet ceiling
// therefore states a `vh` fallback first, the same pattern base.css uses on
// html/body.
{
const sheetsCss = read('frontend/src/inspector-sheets.css');
const baseSheet = rule(sheetsCss, '.inspector__sheet');
check('the shared sheet ceiling has a vh fallback before dvh',
!!baseSheet && /max-height:\s*80vh;[\s\S]*max-height:\s*80dvh;/.test(baseSheet),
baseSheet ? baseSheet.replace(/\s+/g, ' ').slice(0, 90) : 'rule missing');
for (const [file, sel] of [
['frontend/src/inspector-touch.css', '.inspector__sheet--addprop'],
['frontend/src/inspector-profiles.css', '.inspector__sheet--profiles'],
['frontend/src/inspector-sheets.css', '.inspector__sheet--confirm']
]) {
const body = rule(read(file), sel);
check(sel + ' keeps a vh fallback', !!body
&& /max-height:\s*[0-9.]+vh;/.test(body) && /max-height:\s*[0-9.]+dvh;/.test(body),
body ? body.replace(/\s+/g, ' ').slice(0, 90) : 'rule missing');
}
}
check('the card sheet draws a picture per card',
/inspector__propcard--' \+ \(props\.kind/.test(sheetSource));
check('the card sheet says what a card will do before the tap',
  /row\.action/.test(sheetSource) && /inspector__addprop-value/.test(sheetSource));

// ---- a sheet must not be mounted inside a scroller ----------------------
// The overlays used to render where the panel that owns them renders, so the
// Add-property card sheet and the style editor were mounted inside
// `.inspector__styles` — a scroller nested in the page's own scroller — and the
// detail / confirm / profiles sheets inside the (also scrollable) panel stack.
// When such an ancestor becomes a `position: fixed` box's containing block
// (WebKit's behaviour for a fixed descendant of a scroller), `inset: 0`
// resolves against the *scroller*, the overlay is clipped by that scroller's
// overflow, and only the sheet's body scrolls — so a header and Close button
// pushed above the scroller's top are unreachable and the backdrop only covers
// the panel body. Reproduced on a 393 x 852 viewport by forcing the containing
// block with `.inspector__styles { transform: translateZ(0) }`: the overlay
// went from 960 px (viewport) to 497 px (the scroller's box, top -725), the
// 826 px sheet's head landed at top -1053, and `elementFromPoint` at Close's
// centre returned null. Portalling to `document.body` is the fix, and these
// checks keep every sheet portalled rather than only the two that were
// measured.
check('the portal helper mounts at the document root, not in a panel',
  /createPortal\(node, document\.body\)/.test(portalSource)
  && /typeof document === 'undefined'/.test(portalSource));
for (const file of [
  'AddPropertySheet.jsx',
  'ConfirmSheet.jsx',
  'DetailSheet.jsx',
  'InspectorProfilesSheet.jsx',
  'StylesPanel.jsx'
]) {
  const src = read('frontend/src/components/inspector/' + file);
  const overlays = (src.match(/class: 'inspector__overlay'/g) || []).length;
  const portalled = (src.match(/sheetPortal\(h\('div', \{\s*class: 'inspector__overlay'/g) || []).length;
  check(file + ' imports the portal helper', /import \{ sheetPortal \} from '\.\/sheetPortal\.js';/.test(src));
  check(file + ' portals every overlay it renders',
    overlays > 0 && portalled === overlays,
    overlays + ' overlay(s), ' + portalled + ' portalled');
}
// A sheet is a child of the overlay, so the render shape `sheetPortal(h('div',
// { class: 'inspector__overlay' …` is the only one that can be portalled at the
// root. Assert the helper is not called anywhere else in a way that would wrap
// an unrelated node.
check('no sheet overlay is left rendering inline in the panel stack',
  !/return h\('div', \{ class: 'inspector__overlay'/.test(sheetSource)
  && !/return h\('div', \{ class: 'inspector__overlay'/.test(panelSource));

// ---- CSS invariants ----------------------------------------------------

check('the touch stylesheet is part of the Inspector cascade',
  /@import '\.\/inspector-touch\.css';/.test(read('frontend/src/inspector.css')));
check('the touch sheet loads before the panel styles it extends',
  read('frontend/src/inspector.css').indexOf("inspector-touch.css")
  < read('frontend/src/inspector.css').indexOf("inspector-styles.css"));
check('the dead quick-add chip rules went with their markup',
  !/\.inspector__styles-chip\b/.test(css) && !/\.inspector__styles-add\b/.test(css)
  && !/inspector__styles-chip/.test(panelSource));

// The 44 px floor, class by class. Every one of these is a thing a thumb has to
// hit; a control that looks tappable and is not is exactly the bug this surface
// replaces, so the floor is asserted rather than assumed.
const TAP_RULES = [
  ['.inspector__touch-tab', /min-height:\s*var\(--tap\)/],
  ['.inspector__touch-chip', /min-height:\s*var\(--tap\)/],
  ['.inspector__touch-segbtn', /min-height:\s*var\(--tap\)/],
  ['.inspector__touch-value', /min-height:\s*var\(--tap\)/],
  ['.inspector__touch-slider', /height:\s*var\(--tap\)/]
];
for (const [cls, re] of TAP_RULES) {
  const body = rule(css, cls);
  check(cls + ' exists and keeps the 44 px floor',
    !!body && re.test(body), body ? body.replace(/\s+/g, ' ').slice(0, 80) : 'rule missing');
}
const stepRule = rule(css, '.inspector__touch-step');
check('.inspector__touch-step is a full 44 x 44 target',
  !!stepRule && /width:\s*var\(--tap\)/.test(stepRule) && /height:\s*var\(--tap\)/.test(stepRule));
const edgeRule = rule(css, '.inspector__touch-edge');
check('.inspector__touch-edge is a full tap target',
  !!edgeRule && /min-height:\s*var\(--tap\)/.test(edgeRule));
const swatchShared = rule(css, '.inspector__touch-stroke,\n.inspector__touch-swatch');
check('the swatch pair is 44 px square',
  !!swatchShared && /width:\s*var\(--tap\)/.test(swatchShared) && /height:\s*var\(--tap\)/.test(swatchShared));
const cardRule = rule(css, '.inspector__addprop-card');
check('a property card is taller than a bare row but still a card',
  !!cardRule && /min-height:\s*calc\(var\(--tap\) \+ 20px\)/.test(cardRule));
const addRule = rule(css, '.inspector__touch-add');
check('the primary button is a full-width target taller than the floor',
  !!addRule && /min-height:\s*48px/.test(addRule) && /width:\s*100%/.test(addRule));

// No horizontal scroller anywhere in the surface: the panel is a vertical
// scroller inside the page's own scroller, so a sideways one hides its content
// and drags the panel sideways on a diagonal swipe. Every chip row wraps instead.
const touchCss = read('frontend/src/inspector-touch.css').replace(/\/\*[\s\S]*?\*\//g, '');
check('no rule in the touch sheet scrolls sideways',
  !/overflow-x:\s*(auto|scroll)/.test(touchCss));
for (const cls of ['.inspector__touch-tabs', '.inspector__touch-chips', '.inspector__addprop-tabs']) {
const body = rule(touchCss, cls);
check(cls + ' wraps', !!body && /flex-wrap:\s*wrap/.test(body));
}
// The group chips are the only index of the touch surface: once a user has
// scrolled deep into a group's cards, switching to a different group needs the
// chip row to be reachable (the JS reveal only fires on a *tap*, so it can't
// help a chip that's off screen). Pinning the row inside the Styles scroller
// is what keeps navigation available while reading content.
check('.inspector__touch-tabs is pinned inside the Styles scroller',
  /position:\s*sticky/.test(rule(touchCss, '.inspector__touch-tabs') || '')
  && /top:\s*0/.test(rule(touchCss, '.inspector__touch-tabs') || ''));
check('.inspector__touch-tabs covers the panel padding so chips read flush',
  /margin:\s*0\s+-8px/.test(rule(touchCss, '.inspector__touch-tabs') || ''));
check('the segment grid auto-fits instead of overflowing',
  /grid-template-columns:\s*repeat\(auto-fit, minmax\(76px, 1fr\)\)/.test(touchCss));
check('the slider keeps a vertical swipe for the panel',
  /\.inspector__touch-slider\s*\{([^}]*)\}/.exec(css)[1].indexOf('touch-action: pan-y') >= 0);
check('no control is hover-only: the slider and the box edges style :active or :disabled',
  /\.inspector__touch-step:active/.test(css) && /\.inspector__touch-edge:hover/.test(css));
check('the surface is single-column on a phone and only relaxes above 560 px',
/@media \(min-width: 560px\)/.test(touchCss)
&& touchCss.indexOf('@media (min-width: 560px)')
> touchCss.indexOf('.inspector__addprop-card'));
// The card picture is NOT `.inspector__preview`: that name belongs to the live
// page preview in PreviewPanel. This sheet is imported AFTER inspector-targets.css,
// so a shared name turned the preview into a 52x52 card — and, because that card
// rule declares `overflow: hidden` and a 52px width, it also clipped the preview
// frame to a ~38px column. One CSS section silently re-laid out a different
// panel. The namespaced `.inspector__propcard` is what keeps them apart, and
// this check is what stops the collision coming back.
check('the card picture does not reuse the page preview class',
!/inspector__preview\b/.test(touchCss)
&& /\.inspector__propcard\b/.test(touchCss)
&& !/inspector__preview\b/.test(sheetSource)
&& /inspector__propcard\b/.test(sheetSource));


// rules(css, selector) — every rule body for a selector, concatenated. The
// selectors here are used by more than one rule (base + state), so a single
// `exec` on the first match would read the wrong one.
function rules(source, selector) {
  const out = [];
  const re = new RegExp('\\' + selector + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out.join('\n');
}
function rule(source, selector) {
  const all = rules(source, selector);
  return all || null;
}

// ---- summary -----------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' inspector touch-control assertion(s) failed');
