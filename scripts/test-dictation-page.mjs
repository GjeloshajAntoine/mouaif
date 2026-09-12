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

const KINDS = [
  { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
  { id: 'gemini', label: 'Gemini (inline audio)' }
];

// Two responses, because the page reads the catalog twice: the project models
// first (`live=0`, a fast settings read), then the merged list with the
// providers' live catalogs appended.
const PROJECT_MODELS = [
  { id: 'whisper-1', provider: 'openai-compatible', label: 'Whisper 1', kind: 'openai-compatible', source: 'project', connected: true },
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', source: 'project', connected: true }
];
const CATALOG = {
  models: PROJECT_MODELS,
  kinds: KINDS,
  total: 3,
  providers: ['openai-compatible', 'gemini'],
  liveFailures: []
};

// The response the *fast* pass gets, and the one the *live* pass gets.
// `current.project` defaults to CATALOG so a case that does not care about the
// split sees the same list twice.
function catalogFor(live) {
  if (!live) {
    return {
      // The fast pass serves the project's own records; a case that needs the
      // two passes to differ overrides `projectModels`.
      models: current.projectModels || PROJECT_MODELS,
      kinds: KINDS,
      total: current.projectTotal === undefined ? CATALOG.total : current.projectTotal,
      // The provider list comes from the app store, so both passes agree on
      // it — the fast pass is what tells the page whether the live pass is
      // worth making.
      providers: (current.liveCatalog || CATALOG).providers || [],
      liveFailures: []
    };
  }
  return current.liveCatalog || CATALOG;
}

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
    const live = new URL(url, 'http://fixture').searchParams.get('live') !== '0';
    return { status: 200, body: catalogFor(live) };
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
    // `catalog` overrides the *live* response; `projectTotal` overrides the
    // raw project model count the fast pass reports.
    liveCatalog: caseOptions.catalog || CATALOG,
    projectModels: caseOptions.projectModels,
    projectTotal: caseOptions.projectTotal,
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
  // The read order matters: settings once, then the fast project pass, then
  // the live pass. The page must not block its first paint on the live list,
  // and it must not re-read settings for it.
  assert.deepEqual(calls.map((c) => new URL(c.url, 'http://fixture').pathname + new URL(c.url, 'http://fixture').search),
    ['/api/settings',
      '/api/ai/transcribe/models?projectDir=%2Ffixture%2Fproject&live=0',
      '/api/ai/transcribe/models?projectDir=%2Ffixture%2Fproject'],
    'settings once, then the fast catalog pass, then the live pass');
}

// ---- One candidate preselects itself -----------------------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    catalog: { models: [CATALOG.models[0]], kinds: KINDS, total: 1, providers: ['openai-compatible'], liveFailures: [] }
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
    app: { dictation: { modelId: 'gemini-2.5-flash', providerId: 'gemini', kind: 'gemini' } },
    projectModels: []
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
    projectModels: [],
    catalog: { models: [CATALOG.models[1]], kinds: KINDS, total: 0, providers: ['gemini'], liveFailures: [] }
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
  // No project models and a connected provider that returned nothing usable.
  const view = useCase({
    projectDir: '/fixture/project',
    projectModels: [],
    catalog: { models: [], kinds: KINDS, total: 0, providers: ['openai-compatible'], liveFailures: [] }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  const hints = all(nodes, (n) => n.tag === 'p' && buttonClass(n).includes('hint')).map((n) => n.children.join(''));
  assert.ok(hints.some((text) => text.includes('Your providers returned no usable models')),
    'an empty catalog with a provider points at the connection: ' + JSON.stringify(hints));
  assert.equal(picker(nodes).placeholder, 'No models in this project');
  assert.equal(statusText(nodes), '', 'nothing is reported as an error before the user acts');
  // The refresh action only exists when there is something to refresh.
  assert.ok(find(nodes, (n) => buttonClass(n).includes('dictation__refresh')));
}

// ---- No provider at all ------------------------------------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    projectModels: [],
    catalog: { models: [], kinds: KINDS, total: 0, providers: [], liveFailures: [] }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  const hints = all(nodes, (n) => n.tag === 'p' && buttonClass(n).includes('hint')).map((n) => n.children.join(''));
  assert.ok(hints.some((text) => text.includes('no provider connection to list them from')),
    'with nothing connected the copy says so: ' + JSON.stringify(hints));
  assert.equal(find(nodes, (n) => buttonClass(n).includes('dictation__refresh')), null,
    'there is nothing to refresh without a provider');
  // With no providers the live pass is skipped entirely: one catalog read.
  assert.equal(calls.filter((c) => String(c.url).includes('/api/ai/transcribe/models')).length, 1,
    'no provider means no live round trip');
}

// ---- A live row is labelled as coming from the provider ----------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    catalog: {
      models: [
        { id: 'whisper-1', provider: 'openai-compatible', kind: 'openai-compatible', source: 'project', connected: true },
        { id: 'whisper-large-v3', provider: 'groq', label: 'Whisper large v3', kind: 'openai-compatible', source: 'live', connected: true }
      ],
      kinds: KINDS, total: 1, providers: ['openai-compatible', 'groq'], liveFailures: []
    }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.deepEqual(picker(nodes).models.map((m) => m.id), ['whisper-1', 'whisper-large-v3'],
    'project and live rows in the same family are both offered');
  const note = find(nodes, (n) => buttonClass(n).includes('dictation__catalog-note'));
  const text = note.children.length ? JSON.stringify(note.children) : '';
  assert.ok(text.includes('1 project model') && text.includes('plus models from your provider'),
    'the note distinguishes the two sources: ' + text);
}

// ---- A provider that failed is named, not fatal ------------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    catalog: {
      models: PROJECT_MODELS,
      kinds: KINDS, total: 2, providers: ['openai-compatible', 'gemini'],
      liveFailures: [{ provider: 'gemini', code: 'EUNREACHABLE', error: 'fetch failed' }]
    }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  const errors = all(nodes, (n) => buttonClass(n).includes('dictation__error')).map((n) => n.children.join(''));
  assert.ok(errors.some((t) => t.includes('gemini') && t.includes('fetch failed')),
    'the failing provider is reported with its own message: ' + JSON.stringify(errors));
  // The good rows are still offered: one bad provider must not empty the list.
  assert.ok(picker(nodes).models.length > 0);
}

// ---- The case that made the page unusable: no project models at all ----
//
// A fresh install: nothing in .mouaif.json, one connected provider. The first
// (fast) pass has no rows, so it must not lock the request shape to the first
// family in the list — the live pass supplies Gemini rows, and the shape has
// to follow them.
{
  const view = useCase({
    projectDir: '/fixture/project',
    projectModels: [],
    catalog: {
      models: [
        { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', source: 'live', connected: true },
        { id: 'gemini-2.5-pro', provider: 'gemini', label: 'Gemini 2.5 Pro', kind: 'gemini', source: 'live', connected: true }
      ],
      kinds: KINDS, total: 0, providers: ['gemini'], liveFailures: []
    }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  const shape = radios(nodes);
  assert.ok(buttonClass(shape[1]).includes('seg__item--on'),
    'the shape follows the only family with models, not the order of the family list');
  assert.equal(find(nodes, (n) => buttonClass(n).includes('dictation__kind-hint')).children.join(''),
    'Gemini (inline audio)');
  // Two candidates in the family, so the model itself is still the user's
  // call — but the list is no longer empty.
  assert.deepEqual(picker(nodes).models.map((m) => m.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.equal(selectionOf(pickerNodes(nodes)[0]), null);
}

// ---- A remembered shape survives the live pass -------------------------

{
  const view = useCase({
    projectDir: '/fixture/project',
    projectModels: [],
    app: { dictation: { kind: 'gemini' } },
    catalog: {
      models: [
        { id: 'gemini-2.5-flash', provider: 'gemini', kind: 'gemini', source: 'live', connected: true },
        { id: 'whisper-large-v3', provider: 'groq', kind: 'openai-compatible', source: 'live', connected: true }
      ],
      kinds: KINDS, total: 0, providers: ['gemini', 'groq'], liveFailures: []
    }
  });
  view.render();
  await view.settle();
  const nodes = view.render();
  assert.ok(buttonClass(radios(nodes)[1]).includes('seg__item--on'),
    'the shape remembered from the last session wins over the first family');
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
