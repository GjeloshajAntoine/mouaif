'use strict';
// Test for the Inspector Styles panel CDP wiring in events.js.
//
// The Styles panel inspects an element via Runtime (elementFromPoint /
// querySelector + callFunctionOn) and edits its inline style via
// Runtime.callFunctionOn. These are live CDP round-trips; we can't drive a
// real Chrome here, so we mock cdpSend (the CDP command dispatcher) and assert
// that the helper functions issue the exact commands the Styles panel depends
// on. This is a regression guard: a renamed domain method or a wrong arguments
// shape would silently break tap-to-select or live CSS editing on a device.
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

// The model read back from Runtime.callFunctionOn for a single element. Kept
// as a function so callFunctionOn returns the same model regardless of which
// element was selected.
function modelValue() {
  return {
    tag: 'DIV', id: 'hero', className: 'card',
    inline: [['color', 'red'], ['font-size', '16px']],
    computed: [['color', 'rgb(255,0,0)'], ['margin', '0px']],
    width: 373.5, height: 40
  };
}

async function main() {
  const { calls, respond, state } = makeState();

  respond.set('Runtime.evaluate', (p) => {
    // elementFromPoint is the tap-to-select path; querySelector is the
    // selector path. Both return an object (returnByValue: false).
    return Promise.resolve({ result: { type: 'object', subtype: 'node', objectId: 'obj-1', description: 'div#hero.card' } });
  });
  respond.set('Runtime.callFunctionOn', (p) => {
    // The model builder reads the element; the edit helpers call setProperty /
    // removeProperty. Return the model for reads and an ok result for edits.
    if (/setProperty|removeProperty/.test(p.functionDeclaration)) return Promise.resolve({ result: { value: { ok: true } } });
    return Promise.resolve({ result: { value: modelValue() } });
  });
  // DOM.requestNode may or may not yield a usable nodeId; here it does.
  respond.set('DOM.requestNode', () => Promise.resolve({ nodeId: 17 }));
  respond.set('Overlay.highlightNode', () => Promise.resolve({}));

  const context = vm.createContext({ state, console: null });
  vm.runInContext(source, context);
  const handlers = context.createEventHandlers(state);

  // pickNodeAt — viewportCoords evaluate + elementFromPoint + model build.
  const model = await handlers.pickNodeAt(100, 200);
  assert.ok(model, 'pickNodeAt returns a model');
  assert.strictEqual(model.objectId, 'obj-1');
  assert.strictEqual(model.inlineProps.length, 2);
  assert.strictEqual(model.inlineProps[0].prop, 'color');
  assert.strictEqual(model.inlineProps[0].value, 'red');
  assert.strictEqual(model.computed.length, 2);
  assert.strictEqual(model.computed[1].prop, 'margin');
  assert.ok(model.box, 'box model present');
  assert.strictEqual(model.box.width, 373.5);

  // Confirm the command sequence: viewportCoords evaluate, elementFromPoint
  // evaluate, model callFunctionOn, requestNode + highlight.
  assert.ok(calls.some((c) => c.method === 'Runtime.evaluate' && /elementFromPoint/.test(c.params.expression)),
    'elementFromPoint evaluated for tap-to-select');
  assert.ok(calls.some((c) => c.method === 'Runtime.callFunctionOn' && c.params.objectId === 'obj-1'),
    'model built via callFunctionOn on the element objectId');
  assert.ok(calls.some((c) => c.method === 'DOM.requestNode' && c.params.objectId === 'obj-1'),
    'requestNode called to resolve a nodeId for highlight');
  assert.ok(calls.some((c) => c.method === 'Overlay.highlightNode' && c.params.nodeId === 17),
    'highlight applied to the resolved node');

  // setInlineStyleProperty issues Runtime.callFunctionOn with the prop/value args.
  const before = calls.length;
  await handlers.setInlineStyleProperty('obj-1', 'background-color', '#0af');
  const setCall = calls.slice(before).find((c) => c.method === 'Runtime.callFunctionOn' && /setProperty/.test(c.params.functionDeclaration));
  assert.ok(setCall, 'setInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(setCall.params.arguments.map((a) => a.value)), ['background-color', '#0af']);

  // removeInlineStyleProperty passes only the property name.
  const beforeRm = calls.length;
  await handlers.removeInlineStyleProperty('obj-1', 'background-color');
  const rmCall = calls.slice(beforeRm).find((c) => c.method === 'Runtime.callFunctionOn' && /removeProperty/.test(c.params.functionDeclaration));
  assert.ok(rmCall, 'removeInlineStyleProperty dispatch a callFunctionOn');
  assert.deepStrictEqual(Array.from(rmCall.params.arguments.map((a) => a.value)), ['background-color']);

  // selectBySelector uses Runtime.evaluate + querySelector, then model build.
  const selModel = await handlers.selectBySelector('.hero');
  assert.ok(selModel, 'selectBySelector returns a model');
  assert.strictEqual(selModel.objectId, 'obj-1');
  assert.ok(calls.some((c) => c.method === 'Runtime.evaluate' && /querySelector/.test(c.params.expression)),
    'querySelector evaluated for the selector path');

  console.log('PASS inspector styles CDP wiring (tap-to-select + selector + inline-style edit)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
