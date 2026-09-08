'use strict';
// Test for the Inspector Styles panel CDP wiring in events.js.
//
// The Styles panel inspects an element via the DOM/CSS domains and edits its
// inline style via Runtime.callFunctionOn. These are live CDP round-trips; we
// can't drive a real Chrome here, so we mock cdpSend (the CDP command
// dispatcher) and assert that the helper functions issue the exact commands
// the Styles panel depends on. This is a regression guard: a renamed domain
// method or a wrong arguments shape would silently break tap-to-select or
// live CSS editing on a device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/events.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

// A mock cdpSend that records each (method, params) call and returns canned
// responses per method. `respond` lets the test drive command output.
function makeState() {
  const calls = [];
  const respond = new Map();
  const state = {
    consoleEntries: { current: [] },
    networkEntries: { current: [] },
    reqMap: new Map(),
    consoleVL: { current: null },
    networkVL: { current: null },
    consoleCountRef: { current: null },
    networkCountRef: { current: null },
    rerender: () => {},
    cdpSend: (method, params) => {
      calls.push({ method, params });
      if (respond.has(method)) return respond.get(method)(params);
      return Promise.resolve({});
    }
  };
  return { calls, respond, state };
}

async function main() {
  const { calls, respond, state } = makeState();

  // Drive DOM.describeNode → a div#hero.card; DOM.resolveNode → objectId;
  // inline style read returns color/font-size; computed returns two props.
  respond.set('DOM.describeNode', () => ({ node: { nodeName: 'DIV', attributes: [{ name: 'id', value: 'hero' }, { name: 'class', value: 'card' }] } }));
  respond.set('DOM.resolveNode', () => ({ object: { objectId: 'obj-1' } }));
  respond.set('Runtime.callFunctionOn', (p) => {
    if (p.functionDeclaration.includes('style.length')) {
      return { result: { value: [['color', 'red'], ['font-size', '16px']] } };
    }
    return { result: { value: { ok: true } } };
  });
  respond.set('CSS.getComputedStyleForNode', () => ({ computedStyle: [{ name: 'color', value: 'rgb(255,0,0)' }, { name: 'margin', value: '0px' }] }));
  respond.set('DOM.getBoxModel', () => ({ model: { width: '373.5px', height: '40px' } }));
  respond.set('Runtime.evaluate', () => ({ result: { value: { sx: 0, sy: 0, dpr: 1 } } }));
  respond.set('DOM.getNodeForLocation', () => ({ nodeId: 17 }));
  respond.set('DOM.getDocument', () => ({ root: { nodeId: 1 } }));
  respond.set('DOM.querySelector', () => ({ nodeId: 42 }));

  // Put the module in a vm context. The exported createEventHandlers closes
  // over its `state` argument, so we call it inside the same context where
  // `state` is defined and capture the returned handlers object.
  const context = vm.createContext({ state, console: null });
  vm.runInContext(source, context);
  const handlers = context.createEventHandlers(state);

  const model = await handlers.pickNodeAt(100, 200);
  assert.ok(model, 'pickNodeAt returns a model');
  assert.strictEqual(model.nodeId, 17);
  assert.strictEqual(model.objectId, 'obj-1');
  assert.strictEqual(model.inlineProps.length, 2);
  assert.strictEqual(model.inlineProps[0].prop, 'color');
  assert.strictEqual(model.inlineProps[0].value, 'red');
  assert.strictEqual(model.computed.length, 2);
  assert.strictEqual(model.computed[1].prop, 'margin');
  assert.ok(model.box, 'box model present');
  assert.strictEqual(model.box.width, '373.5px');

  // Confirm the CDP command sequence: viewportCoords evaluate + node lookup,
  // then the style model builders.
  assert.ok(calls.some((c) => c.method === 'DOM.getNodeForLocation' && c.params.x === 100 && c.params.y === 200),
    'DOM.getNodeForLocation called with viewport coordinates');
  assert.ok(calls.some((c) => c.method === 'DOM.describeNode' && c.params.nodeId === 17));
  assert.ok(calls.some((c) => c.method === 'CSS.getComputedStyleForNode' && c.params.nodeId === 17));
  assert.ok(calls.some((c) => c.method === 'Overlay.highlightNode' && c.params.nodeId === 17));

  // setInlineStyleProperty issues Runtime.callFunctionOn with the prop/value args.
  const before = calls.length;
  await handlers.setInlineStyleProperty('obj-1', 'background-color', '#0af');
  const setCall = calls.slice(before).find((c) => c.method === 'Runtime.callFunctionOn');
  assert.ok(setCall, 'setInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(setCall.params.arguments.map((a) => a.value)), ['background-color', '#0af']);

  // removeInlineStyleProperty passes only the property name.
  const beforeRm = calls.length;
  await handlers.removeInlineStyleProperty('obj-1', 'background-color');
  const rmCall = calls.slice(beforeRm).find((c) => c.method === 'Runtime.callFunctionOn');
  assert.ok(rmCall, 'removeInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(rmCall.params.arguments.map((a) => a.value)), ['background-color']);

  // selectBySelector uses DOM.getDocument + DOM.querySelector to resolve a node.
  const selModel = await handlers.selectBySelector('.hero');
  assert.ok(selModel, 'selectBySelector returns a model');
  assert.strictEqual(selModel.nodeId, 42);
  assert.ok(calls.some((c) => c.method === 'DOM.querySelector' && c.params.selector === '.hero'));

  console.log('PASS inspector styles CDP wiring (pickNodeAt + selector + inline-style edit)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
