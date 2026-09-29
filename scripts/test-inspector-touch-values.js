'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
(async () => {
  const { scalarValue, touchUnitOptions: units, valuePresets, numericParts, replaceNumericPart } = await import('../frontend/src/components/inspector/touchValues.js');
  const ctx = { rootFontSize: 16, parentFontSize: 20, fontSize: 24 };
  const option = (prop, value, unit, mode = 'choose', basis = ctx) => units(prop, value, basis, mode).find((o) => o.unit === unit);
  assert.equal(option('width', 'auto', '%').value, '0%');
  assert.equal(option('width', '', 'rem').value, '0rem');
  assert.equal(option('width', '24px', 'rem').value, '24rem');
  assert.equal(option('width', '24px', 'rem', 'convert').value, '1.5rem');
  assert.equal(option('width', '24px', '%', 'convert').ok, false);
  assert.equal(option('width', '24px', 'rem', 'convert', {}).ok, false);
  assert.equal(option('width', '1ch', 'px', 'convert').ok, false);
  assert.equal(option('width', '50%', 'px').value, '50px');
  assert.equal(option('width', '10px', 'dvh').value, '10dvh');
  assert.equal(option('transition-duration', '200ms', 's', 'convert').value, '0.2s');
  assert.equal(option('rotate', '200grad', 'deg', 'convert').value, '180deg');
  assert.equal(option('opacity', '50%', '', 'convert').value, '0.5');
  assert.equal(option('line-height', 'normal', 'px').value, '0px');
  assert.equal(option('transform', '20px', 'rem').value, '20rem');
  assert.equal(option('--track', '2fr', 'fr').value, '2fr');
  assert.equal(scalarValue('rgba(0,0,0,.4)'), null);
  assert.equal(scalarValue('calc(100% - 2px)'), null);
  assert.equal(scalarValue('12dvh').kind, 'length');
  assert.equal(scalarValue('2fr').kind, 'track');
  assert.equal(units('width', 'calc(100% - 2px)').length, 0);
  assert.equal(units('padding', '10px 20px').length, 0);
  assert.equal(numericParts('translate3d(1px, 2px, 3px)').length, 3);
  for (const [prop, preset] of [
    ['grid-template-columns','repeat(auto-fit, minmax(12rem, 1fr))'],
    ['aspect-ratio','16 / 9'], ['font-family','monospace'],
    ['transform','translateY(0px)'], ['border','1px solid currentColor'],
    ['box-shadow','none'], ['background-image','none'], ['overflow-wrap','anywhere']
  ]) assert.ok(valuePresets(prop).includes(preset), prop + ' has useful suggestions');
  assert.deepEqual(valuePresets('width', (p, v) => v === 'auto'), ['auto']);
  const source = 'calc(100% - 2px) minmax(12rem, 1fr)';
  const parts = numericParts(source);
  assert.deepEqual(parts.map((p) => p.raw), ['100%', '2px', '12rem', '1fr']);
  assert.equal(replaceNumericPart(source, parts[1], '3rem'), 'calc(100% - 3rem) minmax(12rem, 1fr)');
  assert.equal(replaceNumericPart('stale', parts[1], '3rem'), 'stale');
  for (const opaque of ['url(image123.png)', '"16px"', '#123456', 'var(--space-2, 16px)', 'env(safe-area-inset-bottom, 12px)', 'rgb(1, 2, 3)', 'color-mix(in srgb, red 30%, blue)']) {
    assert.equal(numericParts(opaque).length, 0, opaque + ' remains opaque');
  }
  const shadow = 'inset 0px 2px 8px rgba(0, 0, 0, 0.2)';
  const shadowParts = numericParts(shadow);
  assert.deepEqual(shadowParts.map((p) => p.raw), ['0px','2px','8px']);
  assert.equal(replaceNumericPart(shadow, shadowParts[2], '1rem'), 'inset 0px 2px 1rem rgba(0, 0, 0, 0.2)');
  assert.equal(numericParts('step-start foo123 1px /* 2px */').length, 1);
  const controls = await import('../frontend/src/components/inspector/styleControls.js');
  const spec = controls.specForValue('font-size', '1.5rem');
  assert.equal(controls.nudgeValue('1.5rem', 1, spec, 2, ctx, 'font-size').css, '1.625rem');
  assert.equal(controls.nudgeValue('1.5rem', 1, spec, 2, {}, 'font-size'), null);
  assert.equal(controls.percentFor('1.5rem', spec, ctx), .25);
  assert.equal(controls.nudgeValue('50%', 1, controls.specForValue('width', '50%'), 8, ctx, 'width').css, '56%');
  assert.equal(controls.nudgeValue('10vw', 1, controls.specFor('width'), 8, ctx, 'width'), null);

  // Real component render and interactions, without a DOM. No write callback:
  // a unit/preset click must only update the draft through onChange.
  const modules = ['valueKinds.js', 'touchValues.js'];
  let picked;
  const sandbox = vm.createContext({
    h: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : ({ type, props: props || {}, children }),
    useState: (v) => [v, () => {}], CSS: { supports: () => true }
  });
  const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  for (const file of modules) vm.runInContext(strip(read('frontend/src/components/inspector/' + file)), sandbox);
  for (const file of ['ValueUnitPicker.jsx','ValuePresets.jsx','NumericValueParts.jsx']) vm.runInContext(strip(read('frontend/src/components/inspector/' + file)), sandbox);
  const walk = (node) => !node || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(walk) : [node, ...node.children.flatMap(walk)];
  const tree = sandbox.ValueUnitPicker({ prop:'width',value:'auto',ctx,onChange:v=>{picked=v;} });
  const rem = walk(tree).find((n)=>n.type==='button' && n.children[0]==='rem');
  assert.ok(rem && !rem.props.disabled);
  rem.props.onClick(); assert.equal(picked,'0rem');
  const presets = sandbox.ValuePresets({prop:'grid-template-columns',value:'none',onChange:v=>{picked=v;}});
  walk(presets).find(n=>n.type==='button'&&n.children[0]==='1fr 1fr').props.onClick();
  assert.equal(picked,'1fr 1fr');
  const compound = sandbox.NumericValueParts({prop:'box-shadow',value:shadow,ctx,onChange:v=>{picked=v;}});
  walk(compound).find(n=>n.props['aria-label']==='Increase numeric part 2').props.onClick();
  assert.equal(picked, 'inset 0px 3px 8px rgba(0, 0, 0, 0.2)');
  const panel = read('frontend/src/components/inspector/StylesPanel.jsx');
  assert.match(panel, /h\(ValueUnitPicker, \{ prop: propName/);
  assert.match(panel, /h\(ValuePresets,/);
  assert.match(panel, /h\(NumericValueParts,/);
  assert.match(panel, /const onField = .*setDirty\(true\)/);
  const views = read('frontend/src/components/inspector/ValueKindsView.jsx');
  assert.ok(!views.includes("replace(/[^\\d.+-]/g, '')"), 'no rail parses identifiers or colours as numbers');
  const css = read('frontend/src/inspector-value-editor.css');
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /min-width: 2\.75rem/);
  assert.match(css, /min-height: 2\.75rem/);
  console.log('PASS Inspector touch values (units, conversions, presets, compound tokens, rem nudges, real component taps)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
