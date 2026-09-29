// Regression: the chat's tool trigger is a wrench, not a web-preview globe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('frontend/src/components/chat/ToolPopup.jsx', 'utf8')
  .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '').replace(/^export /gm, '');
let open = false;
const context = vm.createContext({
  h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat().filter(Boolean) }),
  useState: (initial) => typeof initial === 'boolean' ? [open, (value) => { open = value; }] : [initial, () => {}],
  useRef: () => ({ current: null }), useCallback: (fn) => fn,
  useClickOutside() {}, useVisualViewport() {}, buildToolGroups: () => [], ToolTree: 'tree'
});
vm.runInContext(source, context);
const find = (node, predicate) => predicate(node) ? node : node.children?.map((child) => find(child, predicate)).find(Boolean);
const render = () => context.ToolPopup({});
const root = render();
const trigger = find(root, (node) => node.props?.class?.includes('tool-popup__trigger'));
assert.equal(trigger.tag, 'button');
assert.equal(trigger.props['aria-label'], 'Toggle available tools');
assert.equal(trigger.props.title, 'Tool settings');
assert.equal(trigger.props['aria-expanded'], 'false');
const icon = find(trigger, (node) => node.tag === 'svg');
assert.equal(icon.props['aria-hidden'], 'true');
assert.equal(icon.props.viewBox, '0 0 24 24');
assert.equal(icon.props.width, 16);
assert.equal(icon.props.height, 16);
assert.equal(icon.props.fill, 'none');
assert.equal(icon.props.stroke, 'currentColor');
assert.equal(icon.props['stroke-width'], 2);
assert.equal(icon.props['stroke-linecap'], 'round');
assert.equal(icon.props['stroke-linejoin'], 'round');
assert.match(icon.children[0].props.d, /^M14\.7 6\.3/);
assert.equal(find(root, (node) => node.props?.role === 'dialog'), undefined);
trigger.props.onClick();
const expanded = render();
assert.equal(find(expanded, (node) => node.props?.class?.includes('tool-popup__trigger')).props['aria-expanded'], 'true');
assert.equal(find(expanded, (node) => node.props?.role === 'dialog').props['aria-label'], 'Tool settings');
find(expanded, (node) => node.props?.class === 'tool-popup__close').props.onClick();
assert.equal(open, false);
console.log('tool popup icon: themed wrench, accessible trigger, and open/close behavior passed');
