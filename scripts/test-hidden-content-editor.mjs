import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
const helpers = await import('data:text/javascript;base64,' + Buffer.from(source('components/settings/hiddenRanges.js')).toString('base64'));
const {
  normalizeRanges, toggleLine, hiddenContentPath, normalizeChars, toggleChar,
  isValidCharSpan, charSpanCount, removeRange, rangeChipLabel,
  findMatchingCharSpan, removeCharSpan, previewRedactedText
} = helpers;
assert.deepEqual(normalizeRanges([{ start: '3', end: '5' }, { start: 1, end: 2 }]), [{ start: 1, end: 5 }]);
assert.deepEqual(toggleLine([{ start: 1, end: 5 }], 3), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
assert.deepEqual(toggleLine([{ start: 1, end: 1 }], 1), []);
assert.deepEqual(toggleLine([{ start: 2, end: 2 }], 1), [{ start: 1, end: 2 }]);
assert.deepEqual(removeRange([{ start: 1, end: 2 }, { start: 5, end: 6 }], { start: 1, end: 2 }), [{ start: 5, end: 6 }], 'removeRange drops the chosen range');
assert.equal(rangeChipLabel({ start: 4, end: 4 }), 'Line 4', 'single-line chip label');
assert.equal(rangeChipLabel({ start: 4, end: 7 }), 'Lines 4–7', 'multi-line chip label');
for (const [start, end] of [['', 2], [0, 2], [3, 2], [1.5, 2], [1, ''], [1, Infinity]]) {
  assert.throws(() => normalizeRanges([{ start, end }]));
}
// Char-span unit tests: single-line merge, containment drop, toggle add/remove,
// overlap match, removeCharSpan, previewRedactedText, isValidCharSpan rejections and multi-line span count.
assert.deepEqual(
  normalizeChars([{ startLine: 1, endLine: 1, startCol: 5, endCol: 10 }, { startLine: 1, endLine: 1, startCol: 8, endCol: 12 }]),
  [{ startLine: 1, endLine: 1, startCol: 5, endCol: 12 }],
  'overlapping single-line spans merge'
);
assert.deepEqual(
  normalizeChars([{ startLine: 1, endLine: 1, startCol: 1, endCol: 10 }, { startLine: 1, endLine: 1, startCol: 15, endCol: 20 }]),
  [{ startLine: 1, endLine: 1, startCol: 1, endCol: 20 }],
  'same-line spans merge across gaps'
);
assert.deepEqual(
  normalizeChars([{ startLine: 1, endLine: 1, startCol: 1, endCol: 10 }, { startLine: 2, endLine: 2, startCol: 15, endCol: 20 }]),
  [{ startLine: 1, endLine: 1, startCol: 1, endCol: 10 }, { startLine: 2, endLine: 2, startCol: 15, endCol: 20 }],
  'different-line spans do not merge'
);
assert.deepEqual(
  normalizeChars([{ startLine: 1, endLine: 3, startCol: 4, endCol: 9 }, { startLine: 1, endLine: 1, startCol: 5, endCol: 7 }]),
  [{ startLine: 1, endLine: 3, startCol: 4, endCol: 9 }],
  'a span fully inside another is dropped'
);
assert.equal(isValidCharSpan({ startLine: 0, endLine: 1, startCol: 1, endCol: 2 }), false, 'startLine below 1');
assert.equal(isValidCharSpan({ startLine: 2, endLine: 1, startCol: 1, endCol: 2 }), false, 'end before start');
assert.equal(isValidCharSpan({ startLine: 1, endLine: 1, startCol: 4, endCol: 2 }), false, 'empty single-line span');
assert.equal(isValidCharSpan({ startLine: 1, endLine: 2, startCol: 4, endCol: 2 }), true, 'multi-line span allows reverse boundary columns');
assert.equal(isValidCharSpan({}), false, 'empty object');
const span = { startLine: 1, endLine: 1, startCol: 4, endCol: 9 };
const afterAdd = toggleChar([], span);
assert.equal(afterAdd.length, 1, 'toggleChar adds a missing span');
const afterRemove = toggleChar(afterAdd, span);
assert.equal(afterRemove.length, 0, 'toggleChar removes an existing span');
assert.deepEqual(
  findMatchingCharSpan(afterAdd, { startLine: 1, endLine: 1, startCol: 5, endCol: 7 }),
  span,
  'findMatchingCharSpan finds an overlapping saved span even when columns are not identical'
);
assert.equal(findMatchingCharSpan(afterAdd, { startLine: 1, endLine: 1, startCol: 12, endCol: 15 }), null, 'disjoint span does not match');
assert.deepEqual(removeCharSpan(afterAdd, span), [], 'removeCharSpan removes the target span');
assert.equal(
  previewRedactedText('const key = "secret";\nconst ok = 1;\nprivateLine();', {
    ranges: [{ start: 3, end: 3 }],
    chars: [{ startLine: 1, endLine: 1, startCol: 14, endCol: 19 }]
  }),
  'const key = "[hidden]";\nconst ok = 1;\n[hidden]',
  'previewRedactedText matches agent read_file output'
);
assert.equal(charSpanCount([{ startLine: 1, endLine: 1, startCol: 4, endCol: 9 }]), 6, 'single-line span counts characters');
assert.equal(charSpanCount([{ startLine: 1, endLine: 3, startCol: 4, endCol: 9 }]), 2, 'multi-line span counts boundary lines');
const routeContext = { projectDir: '/projects/a & b', from: 'settings/projects', filePath: 'src/a #?.js' };
// The hash → route table is frontend/src/routes.js (pure, no imports);
// router.js is only the browser wiring now, so there is nothing to stub.
const routesSandbox = { URLSearchParams };
vm.runInNewContext(source('routes.js').replace(/^export /gm, ''), routesSandbox);
const hideRoute = routesSandbox.parseHash('#/' + hiddenContentPath(routeContext));
for (const field of Object.keys(routeContext)) assert.equal(hideRoute[field], routeContext[field]);
assert.equal(hideRoute.name, 'settingsProjectHide');
console.log('PASS range merging, splitting, validation, char-span merge/contain/toggle, count, project-scoped file routing');

// Execute the real component event handlers with a minimal hook harness.
// Browser layout/DOM coverage lives in test-hidden-content-ui.mjs.
let hooks = [], cursor = 0, nodes = [], effects = [], first = true;
let requests = 0, closed = 0, fail = true, release;
const context = vm.createContext({
  ...helpers, URLSearchParams, AbortController,
  window: { confirm: () => true, addEventListener() {}, removeEventListener() {} },
  fetchJson: async () => ({ status: 200, body: { content: 'one\ntwo\nthree' } }),
  useRef: (value) => { const i = cursor++; if (first) hooks[i] = { current: value }; return hooks[i]; },
  useState: (value) => { const i = cursor++; if (first) hooks[i] = typeof value === 'function' ? value() : value; return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
  useMemo: (fn) => fn(),
  useEffect: (fn) => { effects.push(fn); },
  Fragment: 'fragment',
  h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; }
});
vm.runInContext(source('components/settings/HiddenContentEditor.jsx').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
const props = {
projectDir: '/fixture', filePath: 'sample.txt', initialRule: null, onClose: () => closed++,
onSave: async (path, payload) => {
requests++;
assert.equal(path, 'sample.txt');
assert.deepEqual(JSON.parse(JSON.stringify(payload.ranges)), [{ start: 1, end: 1 }]);
assert.deepEqual(JSON.parse(JSON.stringify(payload.chars)), []);
await new Promise(resolve => { release = resolve; });
if (fail) throw new Error('Could not save. Selection kept.');
}
};
function render() { cursor = 0; nodes = []; effects = []; context.HiddenContentEditor(props); first = false; }
const button = (label) => nodes.find(n => n.tag === 'button' && n.children.includes(label));
render();
// Load the preview so the editor + footer branch renders, then assert the
// ownership rule that keeps this view's buttons tappable: every action lives
// in the sticky footer. A control rendered outside it (the old editor
// toolbar) could overlap the footer and swallow taps on Cancel/Save.
effects[3]();
await new Promise(resolve => setTimeout(resolve, 0));
render();
const descendants = (node, out = []) => {
for (const child of node.children || []) { if (child && child.tag) { out.push(child); descendants(child, out); } }
return out;
};
const footer = nodes.find(n => n.tag === 'footer' && n.attrs.class === 'hidden-content__footer');
assert.ok(footer, 'the sticky footer renders');
const footerNodes = descendants(footer);
const isHideAction = n => n.tag === 'button' && String(n.attrs.class || '').includes('hidden-content__hide-action');
const hideAction = footerNodes.find(isHideAction);
assert.ok(hideAction, 'the hide-selection action lives in the sticky footer');
assert.equal(hideAction.attrs.type, 'button', 'the hide-selection action never submits the form');
assert.equal(nodes.filter(isHideAction).length, 1, 'the hide-selection action is not rendered outside the footer');
assert.ok(hideAction.children.includes('Select text to hide') && hideAction.attrs.disabled, 'with no selection the action is disabled and says what to do');
const rangesToggle = footerNodes.find(n => n.attrs['aria-controls'] === 'hidden-content-manual');
assert.ok(rangesToggle && rangesToggle.attrs['aria-expanded'] === 'false', 'the manual-ranges toggle lives in the footer, collapsed');
const manualPanel = nodes.find(n => n.attrs.id === 'hidden-content-manual');
assert.equal(manualPanel.attrs.hidden, true, 'manual ranges start collapsed');
rangesToggle.attrs.onClick();
render();
assert.equal(nodes.find(n => n.attrs.id === 'hidden-content-manual').attrs.hidden, false, 'Ranges opens the manual panel');
for (const label of ['Cancel', 'Save']) {
assert.ok(footerNodes.some(n => n.tag === 'button' && n.children.includes(label)), label + ' lives in the sticky footer');
}
// Mode switcher ("Edit selection" / "What agent sees") renders in the toolbar.
const editModeBtn = button('Edit selection');
const agentModeBtn = button('What agent sees');
assert.ok(editModeBtn && agentModeBtn, 'mode switcher buttons render');
assert.equal(editModeBtn.attrs['aria-pressed'], 'true');
assert.equal(agentModeBtn.attrs['aria-pressed'], 'false');
agentModeBtn.attrs.onClick();
render();
assert.equal(button('What agent sees').attrs['aria-pressed'], 'true', 'switching to agent preview updates pressed state');
assert.ok(nodes.some(n => String(n.attrs.class || '').includes('hidden-content__editor--agent')), 'editor host gets agent modifier class');
button('Edit selection').attrs.onClick();
render();
assert.equal(button('Edit selection').attrs['aria-pressed'], 'true', 'switching back to edit mode restores state');

button('+ Add range').attrs.onClick();
render();
// Active item chip renders in the footer and can unhide directly with ×.
const chipRemove = nodes.find(n => n.tag === 'button' && n.attrs['aria-label'] === 'Unhide Line 1');
assert.ok(chipRemove, 'interactive chip renders for active hidden line');
chipRemove.attrs.onClick();
render();
assert.equal(nodes.some(n => n.tag === 'button' && n.attrs['aria-label'] === 'Unhide Line 1'), false, 'tapping chip × unhides the range');
button('+ Add range').attrs.onClick();
render();
let submit = nodes.find(n => n.tag === 'form').attrs.onSubmit;
const pending = submit({ preventDefault() {} });
await submit({ preventDefault() {} });
assert.equal(requests, 1, 'double Save does not duplicate requests');
render();
assert.equal(nodes.find(n => n.tag === 'fieldset').attrs.disabled, true);
release();
await pending;
render();
assert.equal(closed, 0, 'failure keeps the editor open');
assert.equal(nodes.find(n => n.attrs['aria-label'] === 'From line for range 1').attrs.value, 1);
assert.ok(nodes.some(n => n.attrs.role === 'alert' && n.children.some(text => typeof text === 'string' && text.includes('Your selection is kept'))));
// Draft effect persists only metadata, then remount the same file as after Back.
effects[1]();
hooks = []; first = true;
render();
assert.equal(nodes.find(n => n.attrs['aria-label'] === 'From line for range 1').attrs.value, 1, 'remount restores draft');
fail = false;
submit = nodes.find(n => n.tag === 'form').attrs.onSubmit;
const retry = submit({ preventDefault() {} });
release();
await retry;
assert.equal(closed, 1);
assert.equal(requests, 2);
hooks = []; first = true;
render();
assert.equal(nodes.some(n => n.attrs['aria-label'] === 'From line for range 1'), false, 'success clears cached draft');
console.log('PASS failed-save retention, retry, duplicate-save guard, busy controls and draft recovery');

button('+ Add range').attrs.onClick();
render();
effects[1]();
const cleanup = effects[0]();
const detachedSave = nodes.find(n => n.tag === 'form').attrs.onSubmit({ preventDefault() {} });
cleanup();
release();
await detachedSave;
assert.equal(closed, 1, 'late save never navigates after leaving the editor');
hooks = []; first = true;
render();
assert.equal(nodes.some(n => n.attrs['aria-label'] === 'From line for range 1'), false);
button('+ Add range').attrs.onClick();
render();
effects[1]();
button('Cancel').attrs.onClick();
assert.equal(closed, 2);
hooks = []; first = true;
render();
assert.equal(nodes.some(n => n.attrs['aria-label'] === 'From line for range 1'), false, 'Cancel clears draft after confirmation');
console.log('PASS cancelled drafts and safe completion after browser navigation');
