'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const strip = (s) => s.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
(async () => {
  const panel = read('frontend/src/components/inspector/StylesPanel.jsx');
  assert.ok(!/sheetPortal|inspector__overlay|aria-modal/.test(panel), 'editor has no portal, backdrop or modal');
  assert.match(panel, /class: 'inspector__value-editor'/);
  const render = panel.indexOf("class: 'inspector__styles' +");
  const pin = panel.indexOf("class: 'inspector__styles-pin'", render);
  const editor = panel.indexOf('valueEditor,', pin);
  const tree = panel.indexOf("'Element tree'", editor);
  assert.ok(render >= 0 && pin > render && editor > pin && tree > editor, 'editor is part of Styles under its identity');
  const field = panel.indexOf("id: 'inspector-edit-value'");
  const units = panel.indexOf('h(ValueUnitPicker,', field);
  const presets = panel.indexOf('h(ValuePresets,', units);
  const advanced = panel.indexOf("class: 'inspector__value-editor-options'", presets);
  assert.ok(field > 0 && units > field && presets > units && advanced > presets, 'field first, then units and suggestions; secondary controls later');
  assert.match(panel, /h\('summary', null, 'More options: property, type & priority'\)/);
  assert.match(panel, /class: 'inspector__value-discard', role: 'group'/);
  assert.match(panel, /editorOrigin\.current = .*document\.activeElement/);
  assert.match(panel, /panel\.scrollTop = editScroll\.current/);
  assert.match(panel, /origin\.focus\(\{ preventScroll: true \}\)/);
  const ctx = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (value) => [value, () => {}]
  });
  for (const file of ['valueKinds.js', 'touchValues.js', 'ValueUnitPicker.jsx']) vm.runInContext(strip(read('frontend/src/components/inspector/' + file)), ctx);
  let picked;
  const treeOut = ctx.ValueUnitPicker({ prop:'width', value:'16px', ctx:{rootFontSize:16}, onChange:v=>{picked=v;} });
  const walk = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(walk) : [n,...n.children.flatMap(walk)];
  const nodes = walk(treeOut);
  assert.equal(nodes.filter(n=>n.type==='input' && n.props.type==='checkbox').length, 1, 'conversion is one labelled checkbox, not another tab strip');
  assert.ok(nodes.some(n=>n.type==='details' && n.props.class==='inspector__value-other-units'), 'uncommon units collapse');
  const current = nodes.find(n=>n.type==='button' && n.children[0]==='px');
  assert.equal(current.props.disabled,false,'selected unit remains high contrast, not disabled-faded');
  nodes.find(n=>n.type==='button' && n.children[0]==='rem').props.onClick();
  assert.equal(picked,'16rem');
  const css = read('frontend/src/inspector-value-editor.css');
  const block = css.slice(css.indexOf('.inspector__value-editor {'), css.indexOf('.inspector__value-editor-head {'));
  assert.ok(!/position:\s*(fixed|absolute)|overflow-y|height:/.test(block), 'editor has no independent viewport/scroller');
  const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]+)/ig)].map(m=>[m[1],m[2]]));
  const { contrast } = await import('../frontend/src/components/inspector/contrast.js');
  for (const surface of ['surface','surface-2','surface-3']) {
    for (const text of ['fg','fg-soft','muted','muted-2']) assert.ok(contrast(tokens[surface],tokens[text]).ratio >= 4.5, text+' on '+surface+' meets AA');
    assert.ok(contrast(tokens[surface],tokens['border-strong']).ratio >= 3, 'control boundary meets 3:1 on '+surface);
  }
  console.log('PASS inline Inspector editor (no layers, ordered controls, return navigation, compact units, text/control contrast)');
})().catch(e=>{console.error(e);process.exitCode=1;});
