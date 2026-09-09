import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
const helpers = await import('data:text/javascript;base64,' + Buffer.from(source('components/settings/hiddenRanges.js')).toString('base64'));
const { normalizeRanges, toggleLine, hiddenContentPath } = helpers;
assert.deepEqual(normalizeRanges([{ start: '3', end: '5' }, { start: 1, end: 2 }]), [{ start: 1, end: 5 }]);
assert.deepEqual(toggleLine([{ start: 1, end: 5 }], 3), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
assert.deepEqual(toggleLine([{ start: 1, end: 1 }], 1), []);
assert.deepEqual(toggleLine([{ start: 2, end: 2 }], 1), [{ start: 1, end: 2 }]);
for (const [start, end] of [['', 2], [0, 2], [3, 2], [1.5, 2], [1, ''], [1, Infinity]]) {
  assert.throws(() => normalizeRanges([{ start, end }]));
}
const routeContext = { projectDir: '/projects/a & b', from: 'settings/projects', filePath: 'src/a #?.js' };
const routeSandbox = { URLSearchParams, route: {}, window: { location: { hash: '#/' + hiddenContentPath(routeContext) }, addEventListener() {} } };
vm.runInNewContext(source('router.js').replace("import { route } from './api.js';", '').replace('export function nav', 'function nav'), routeSandbox);
for (const field of Object.keys(routeContext)) assert.equal(routeSandbox.route.value[field], routeContext[field]);
assert.equal(routeSandbox.route.value.name, 'settingsProjectHide');
console.log('PASS range merging, splitting, validation and project-scoped file routing');

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
  projectDir: '/fixture', filePath: 'sample.txt', initialRanges: [], onClose: () => closed++,
  onSave: async (path, ranges) => {
    requests++;
    assert.equal(path, 'sample.txt');
    assert.deepEqual(JSON.parse(JSON.stringify(ranges)), [{ start: 1, end: 1 }]);
    await new Promise(resolve => { release = resolve; });
    if (fail) throw new Error('Could not save. Selection kept.');
  }
};
function render() { cursor = 0; nodes = []; effects = []; context.HiddenContentEditor(props); first = false; }
const button = (label) => nodes.find(n => n.tag === 'button' && n.children.includes(label));
render();
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
