// Render the real dictation page against a fake API.
//
// A Vite build cannot catch a render expression that reads a name that no
// longer exists, and the page's first paint has to be right *before* anything
// is recorded (the model picker, the request-shape control, the disabled
// action chips). So the module is evaluated in a VM with its imports stripped
// and re-supplied as context globals, then rendered twice: once cold (the
// catalog is still loading) and once after it resolves.
//
// Two deliberate choices:
//   * `frontend/src/dictation.js` is loaded as a *real* module (through a
//     data: URL), not stubbed. Its preselect rule — remembered model, else the
//     single candidate in the family — is exactly the kind of logic that looks
//     fine in a hand-written stub and is wrong in the browser.
//   * One `fetchJson` serves the whole file. The page and the helper both call
//     it, so a single dispatcher keeps the two from disagreeing about what the
//     server returns, which is what a per-module stub would hide.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../frontend/src/', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
// Imports are stripped (and re-supplied) only for the component script that
// runs in the VM. The helper module keeps its imports and is loaded for real,
// so this regex is never applied to it.
const stripImports = (text) => text
  .replace(/^import[\s\S]*?from\s*'[^']*';$/gm, '')
  .replace(/^import\s*'[^']*';$/gm, '');
const asScript = (file) => stripImports(read(file)).replace(/^export /gm, '');

// ---- The fake server ----------------------------------------------------

const CATALOG = {
  models: [
    { id: 'whisper-1', provider: 'openai-compatible', label: 'Whisper 1', kind: 'openai-compatible', connected: true },
    { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', connected: true }
  ],
  kinds: [
    { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
    { id: 'gemini', label: 'Gemini (inline audio)' }
  ],
  total: 3
};

// `current` is the case the dispatcher answers for. Reassigned per case before
// any render, so one `fetchJson` can serve the page's settings read and the
// helper's catalog read without either closing over stale data.
let current = { app: {}, catalog: CATALOG };
const calls = [];

async function fetchJson(url, init) {
  calls.push({ url, init });
  assert.equal(init && init.method, undefined, 'a page load must not write settings');
  const endpoint = new URL(url, 'http://fixture').pathname;
  if (endpoint === '/api/settings') {
    assert.equal(current.appFail, undefined, 'no failure flag for the settings read');
    return { status: 200, body: { app: current.app || {}, defaults: {}, home: '/tmp/mouaif' } };
  }
  if (endpoint === '/api/projects/registered') {
    return { status: 200, body: { projects: current.projects || [] } };
  }
  if (endpoint === '/api/ai/transcribe/models') {
    return { status: 200, body: current.catalog || CATALOG };
  }
  throw new AssertionError('unexpected dependency: ' + endpoint);
}


// The helper module the page imports. It is loaded as a real ES module (so
// `resolveDefaultModel` and friends are the shipped implementations) with its
// one dependency — the app's `fetchJson` — injected first.
globalThis.__mouaifDictationFetch = fetchJson;
const dictation = await import('data:text/javascript;base64,' + Buffer.from(
  'const fetchJson = globalThis.__mouaifDictationFetch;\n'
  + read('dictation.js').replace(/^import .*api\.js';$/m, '')
).toString('base64'));

// ---- The render harness -------------------------------------------------

function createView(options) {
  const opt = options || {};
  const states = [];
  let cursor = 0;
  let first = true;
  let effects = [];
  let nodes = [];
  const context = vm.createContext({
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Blob,
    console,
    activeProject: { value: { dir: opt.projectDir || '', name: '' } },
    // A component is a vnode tag, never called by this `h`, so the picker's
    // props are read back off the recorded node by pickerNodes().
    ModelPickerField: 'model-picker',
    fetchJson,
    saveApp: async () => {},
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (effect) => { effects.push(effect); },
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useCallback: (fn) => fn,
    h: (tag, attrs, ...children) => {
      const node = { tag, attrs: attrs || {}, children: children.flat() };
      nodes.push(node);
      return node;
    }
  });
  // The page's own helper imports, as the real implementations.
  for (const [name, value] of Object.entries(dictation)) context[name] = value;
  vm.runInContext(asScript('components/DictationPage.jsx'), context);

  function render() {
    cursor = 0;
    nodes = [];
    effects = [];
    context.DictationView({});
    first = false;
    return nodes;
  }
  // One paint cycle: run the effects the render registered, then let the
  // catalog promise settle before the next render reads the state.
  async function settle() {
    effects.forEach((effect) => effect());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { render, settle, states };
}

const find = (nodes, predicate) => nodes.find(predicate) || null;
const all = (nodes, predicate) => nodes.filter(predicate);
const buttons = (nodes) => all(nodes, (n) => n.tag === 'button');
const buttonClass = (node) => String(node.attrs.class || '');
// The model picker is a component, so it is found by the props it was given.
const pickerNodes = (nodes) => all(nodes, (n) => n.tag === 'model-picker');
const picker = (nodes) => {
  const list = pickerNodes(nodes);
  assert.equal(list.length, 1, 'exactly one model picker');
  return list[0].attrs;
};
// Selections come out of the VM realm, so they never compare deepStrictEqual
// with an object literal from this realm (different Object prototypes). This
// flattens one to a plain pair for comparison.
const selectionOf = (node) => {
  const v = node.attrs.value;
  return v ? { providerId: v.providerId, modelId: v.modelId } : null;
};
const radios = (nodes) => all(nodes, (n) => n.tag === 'label' && buttonClass(n).startsWith('seg__item'));
const chipLabels = (nodes) => buttons(nodes)
  .filter((n) => buttonClass(n).startsWith('btn'))
  .map((n) => n.children.join(''));
const statusText = (nodes) => (find(nodes, (n) => buttonClass(n).includes('dictation__status')) || { children: [''] }).children.join('');

function useCase(caseOptions) {
  current = {
    app: caseOptions.app || {},
    catalog: caseOptions.catalog || CATALOG,
    projects: caseOptions.projects || []
  };
  calls.length = 0;
  return createView(caseOptions);
}

// ---- First paint, before the catalog resolves ---------------------------

{
  const view = useCase({ projectDir: '/fixture/project' });
  const nodes = view.render();
  assert.equal(find(nodes, (n) => n.tag === 'h2').children.join(''), 'Dictation', 'the page is titled');
  assert.equal(find(nodes, (n) => buttonClass(n) === 'view-back').attrs.href, '#/projects', 'the back link points at the chat list');
  const record = find(nodes, (n) => n.tag === 'button' && buttonClass(n).startsWith('dictation__record'));
  assert.equal(record.attrs['aria-label'], 'Record', 'the primary control is labelled');
  assert.equal(record.attrs.type, 'button', 'the record control is a real button');
  assert.equal(record.children.length, 2, 'the button holds a dot and a label');
  assert.equal(find(nodes, (n) => buttonClass(n) === 'dictation__record-label').children[0], 'Record');
  assert.equal(find(nodes, (n) => buttonClass(n) === 'dictation__meter').attrs.role, 'meter', 'the level meter is exposed');
  // A take is required before the transcribe action exists: a permanently
  // disabled button would read as "broken", not as "not yet".
  assert.equal(find(nodes, (n) => buttonClass(n) === 'dictation__transcribe'), null);
  assert.deepEqual(chipLabels(nodes), ['Copy', 'Insert in chat', 'Send to chat', 'Clear']);
  for (const node of buttons(nodes).filter((n) => buttonClass(n).startsWith('btn'))) {
    assert.equal(node.attrs.disabled, true, 'nothing is offered before there is anything to act on');
  }
  assert.equal(picker(nodes).placeholder, 'Loading models…', 'the picker says it is loading');
}

// ---- After the catalog resolves ----------------------------------------

{
  const view = useCase({ projectDir: '/fixture/project' });
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.equal(picker(nodes).placeholder, 'Pick a model', 'the loading placeholder is gone');
  // The list is the rows of the family currently selected; the family control
  // switches the list, the picker does not. Here the OpenAI-shaped family has
  // exactly one row, so it is preselected — the "pick a model" prompt only
  // appears when the *selected* family has more than one candidate.
  assert.deepEqual(picker(nodes).models.map((m) => m.id), ['whisper-1'],
    'the OpenAI-shaped family is listed while that shape is selected');
  assert.deepEqual(selectionOf(pickerNodes(nodes)[0]), { providerId: 'openai-compatible', modelId: 'whisper-1' });

  const shape = radios(nodes);
  assert.equal(shape.length, 2, 'one chip per request family');
  assert.equal(shape[0].children[1].children.join(''), 'OpenAI-shaped', 'the chip shows the short label');
  assert.equal(shape[0].children[1].attrs.title, CATALOG.kinds[0].label, 'the full label survives as the tooltip');
  assert.ok(buttonClass(shape[0]).includes('seg__item--on'), 'the auto-picked family is the checked one');
  assert.equal(find(nodes, (n) => buttonClass(n).includes('dictation__kind-hint')).children.join(''), CATALOG.kinds[0].label);
  // Both files read the settings once, and only through fetchJson.
  assert.deepEqual(calls.map((c) => new URL(c.url, 'http://fixture').pathname),
    ['/api/settings', '/api/ai/transcribe/models'], 'the page reads settings once, then the catalog');
}

// ---- One candidate preselects itself -----------------------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    catalog: { models: [CATALOG.models[0]], kinds: CATALOG.kinds, total: 1 }
  });
  view.render();
  await view.settle();
  assert.deepEqual(selectionOf(pickerNodes(view.render())[0]), { providerId: 'openai-compatible', modelId: 'whisper-1' },
    'a single candidate needs no decision');
}

// ---- A remembered model beats the family default -----------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    app: { dictation: { modelId: 'gemini-2.5-flash', providerId: 'gemini', kind: 'gemini' } }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.deepEqual(selectionOf(pickerNodes(nodes)[0]), { providerId: 'gemini', modelId: 'gemini-2.5-flash' });
  assert.deepEqual(picker(nodes).models.map((m) => m.id), ['gemini-2.5-flash'], 'the remembered family filters the list');
  assert.equal(find(nodes, (n) => buttonClass(n).includes('dictation__kind-hint')).children.join(''), 'Gemini (inline audio)');
  assert.ok(buttonClass(radios(nodes)[1]).includes('seg__item--on'), 'the remembered shape is checked');
}

// ---- A model that no longer exists is never preselected ----------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    app: { dictation: { modelId: 'whisper-deleted', providerId: 'openai-compatible' } },
    catalog: { models: [CATALOG.models[1]], kinds: CATALOG.kinds, total: 1 }
  });
  view.render();
  await view.settle();
  assert.deepEqual(selectionOf(pickerNodes(view.render())[0]), { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
    'the surviving candidate is used instead of the deleted model');
}

// ---- Falling back to a registered project ------------------------------

{
  // The Dictate tab is reachable directly (cold start, installed PWA) where
  // nothing has written the active-project signal yet. Rather than showing an
  // empty picker, the page adopts the first registered project and names it.
  const view = useCase({ projectDir: '', projects: [{ id: 'p1', path: '/fixture/alpha', name: 'alpha' }] });
  view.render();
  await view.settle();
  // Two paint cycles: the first effect batch adopts the project, the second
  // reads its catalog (the catalog effect is keyed on projectDir).
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.deepEqual(all(nodes, (n) => buttonClass(n) === 'group__title-note').map((n) => n.children.join('')),
    ['alpha'], 'the adopted project is named');
  assert.equal(picker(nodes).placeholder, 'Pick a model', "the adopted project's catalog is on offer");
  assert.equal(picker(nodes).models.length, 1);
  assert.ok(calls.some((c) => new URL(c.url, 'http://fixture').pathname === '/api/projects/registered'));
  assert.ok(calls.some((c) => String(c.url).includes('projectDir=%2Ffixture%2Falpha')),
    'the catalog is read for the adopted project');
}

// ---- Without a project -------------------------------------------------

{
  const view = useCase({ projectDir: '' });
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.deepEqual(all(nodes, (n) => buttonClass(n) === 'group__title-note').map((n) => n.children.join('')),
    ['no project'], 'the scope is stated, not implied');
  const insert = find(nodes, (n) => n.tag === 'button' && n.children.join('') === 'Insert in chat');
  assert.equal(insert.attrs.disabled, true, 'the chat hand-off is disabled rather than writing nowhere');
}

// ---- An empty catalog explains itself ----------------------------------

{
  const view = useCase({ projectDir: '/fixture/project', catalog: { models: [], kinds: CATALOG.kinds, total: 0 } });
  view.render();
  await view.settle();
  const nodes = view.render();
  const hints = all(nodes, (n) => n.tag === 'p' && buttonClass(n).includes('hint')).map((n) => n.children.join(''));
  assert.ok(hints.some((text) => text.includes('No models in this project yet')),
    'an empty project says how to fix it: ' + JSON.stringify(hints));
  assert.equal(picker(nodes).placeholder, 'No models in this project');
  assert.equal(statusText(nodes), '', 'nothing is reported as an error before the user acts');
}

// ---- The preselect rule on its own -------------------------------------

{
  const { resolveDefaultModel, modelsForKind } = dictation;
  assert.equal(resolveDefaultModel([], { modelId: 'x' }, 'openai-compatible'), null);
  assert.equal(resolveDefaultModel([], {}, 'openai-compatible'), null);
  assert.deepEqual(
    resolveDefaultModel([{ id: 'a', provider: 'p', kind: 'openai-compatible' }], {}, 'openai-compatible'),
    { modelId: 'a', providerId: 'p' }
  );
  assert.equal(
    resolveDefaultModel([{ id: 'a', kind: 'gemini' }, { id: 'b', kind: 'gemini' }], {}, 'gemini'),
    null,
    'two candidates in the family is a decision the user makes'
  );
  // A remembered model that moved provider is still found by id alone.
  assert.deepEqual(
    resolveDefaultModel([{ id: 'a', provider: 'p2', kind: 'gemini' }], { modelId: 'a', providerId: 'p1' }, 'gemini'),
    { modelId: 'a', providerId: 'p2' }
  );
  assert.deepEqual(modelsForKind([{ id: 'a', kind: 'gemini' }], 'gemini').map((m) => m.id), ['a']);
}

console.log('PASS dictation page: cold paint, catalog load, preselect rules, project-less and empty states');
