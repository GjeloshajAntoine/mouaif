// Render checks for the shell-review surfaces.
//
// The interesting failure for a UI feature is not "does the bundle build" but
// "does the section render, save the right patch, and stay wired to the same
// choice model the server uses". These checks drive the real components with a
// stubbed fetch, the same way scripts/test-project-settings-render.mjs drives
// SettingsProjectView.
//
// Pinned here:
//   1. frontend/src/components/chat/shellReview.js — normalization mirrors
//      src/shellReview.js (unknown mode → off, blank prompt → built-in), and
//      verdictMeta maps the three verdicts;
//   2. ShellReviewSettings renders the three controls, saves ONE complete
//      `shellReview` object per change (never a partial one that would clear
//      the model on a mode change), and reports the not-configured state;
//   3. ToolPopup renders the "Review a command" row outside the tool tree, and
//      the row opens the sheet with the composer draft as its seed;
//   4. buildReviewBlock renders a verdict (and a failure) with the same text
//      the server returned, so the card and the sheet cannot drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const stripModule = (text) => text
  .replace(/^import .*;$/gm, '')
  .replace(/^export \{.*?\};$/gms, '')
  .replace(/^export /gm, '');
const read = (rel) => stripModule(fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));

// ---- 1. the shared choice model -----------------------------------------
const helpersContext = vm.createContext({ document: { createElement: () => ({}) } });
// `const` bindings in a vm script are not context properties, so the module
// is evaluated with an explicit export list appended — the same trick the
// render test uses for the component files.
vm.runInContext(read('frontend/src/components/chat/shellReview.js')
  + '\n;globalThis.__shellReview = { shellReviewFromResolved, verdictMeta, SHELL_REVIEW_MODES, buildReviewBlock, applyReviewToCard };',
helpersContext);
const { shellReviewFromResolved, verdictMeta, SHELL_REVIEW_MODES } = helpersContext.__shellReview;
// Arrays read out of the vm are from another realm, so compare values, not
// object identity (deepStrictEqual checks the prototype).
assert.deepEqual([...SHELL_REVIEW_MODES].map((m) => String(m.value)), ['off', 'ask', 'always']);
{
  const off = shellReviewFromResolved({ shellReview: { mode: 'sometimes', providerId: 'p', modelId: 'm' } });
  assert.equal(off.mode, 'off', 'an unknown mode reads as off');
  assert.equal(off.configured, false);
  const unset = shellReviewFromResolved(null);
  assert.equal(unset.mode, 'off');
  assert.equal(unset.configured, false);
  const ready = shellReviewFromResolved({ shellReview: { mode: 'always', providerId: 'openrouter', modelId: 'x/y' } });
  assert.equal(ready.configured, true);
  const half = shellReviewFromResolved({ shellReview: { mode: 'always', providerId: 'openrouter' } });
  assert.equal(half.configured, false, 'a mode without a model cannot review');
  assert.deepEqual({ ...verdictMeta('DANGER') }, { label: 'Danger', tone: 'danger' });
  assert.deepEqual({ ...verdictMeta('caution') }, { label: 'Caution', tone: 'caution' });
  assert.deepEqual({ ...verdictMeta('SAFE') }, { label: 'Safe', tone: 'safe' });
  assert.deepEqual({ ...verdictMeta('') }, { label: 'Review', tone: 'plain' });
}

// ---- 2. ShellReviewSettings ---------------------------------------------
// A tiny Preact stand-in: h() records vnodes, hooks keep a slot array, and the
// model picker is a marker component (its own behaviour is tested elsewhere).
function renderShellReviewSettings({ resolved, saveStatus = 200, models = [], providers = [] }) {
  const requests = [];
  const nodes = [];
  let cursor = 0;
  let first = true;
  let states = [];
  const h = (tag, attrs, ...children) => {
    const node = { tag, attrs: attrs || {}, children: children.flat(Infinity).filter((c) => c != null) };
    nodes.push(node);
    return node;
  };
  const context = vm.createContext({
    h,
    Fragment: 'fragment',
    ModelPickerField: 'model-picker',
    SHELL_REVIEW_MODES: [
      { value: 'off', label: 'Off' },
      { value: 'ask', label: 'On demand' },
      { value: 'always', label: 'Always' }
    ],
    shellReviewFromResolved,
    fetchLiveModels: async (provider) => ({ models: models.filter((m) => m.provider === provider) }),
    fetchJson: async (url, init) => {
      if (init && init.method === 'PUT') {
        requests.push(JSON.parse(init.body));
        if (saveStatus !== 200) return { status: saveStatus, body: {} };
        const body = JSON.parse(init.body);
        return { status: 200, body: { project: { shellReview: body.shellReview } } };
      }
      if (url.startsWith('/api/settings/resolved')) return { status: 200, body: { resolved } };
      if (url.startsWith('/api/ai/models/providers')) return { status: 200, body: { providers: providers.map((id) => ({ id })) } };
      if (url.startsWith('/api/ai/models')) return { status: 200, body: { models } };
      return { status: 404, body: {} };
    },
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useRef: (initial) => {
      const slot = { current: initial === undefined ? null : initial };
      if (first) return slot;
      return slot;
    },
    // Effects run once, like a mount: a re-render does not re-fire them, so
    // the load effect cannot reset the state this test just saved. The returned
    // cleanup is deliberately NOT called — it is an unmount, and unmounting
    // would cancel the asynchronous load the test is waiting for.
    useEffect: (fn) => { if (!first) return; fn(); },
    Promise, console
  });
  vm.runInContext(read('frontend/src/components/settings/ShellReviewSettings.jsx')
    + '\n;globalThis.__shellReviewSettings = ShellReviewSettings;', context);
  const View = context.__shellReviewSettings;
  const render = () => { cursor = 0; nodes.length = 0; return View({ projectDir: '/p', onProjectSaved() {} }); };
  return {
    // The component loads asynchronously, so the caller renders, waits for the
    // load to settle, and renders again to read the loaded view.
    async load() {
      const before = render();
      first = false;
      await settle();
      return { before, view: render(), requests, context };
    },
    rerender: () => render(),
    requests,
    context
  };
}
// settle() — let every pending microtask (the stubbed fetch chain) run.
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) flatten(child, out);
  return out;
}
{
  // The component name is bound by the module eval inside the vm; capture it by
  // running that eval once with a context we can read back.
  const rendered = await renderShellReviewSettings({
    resolved: { shellReview: { mode: 'ask', providerId: 'openrouter', modelId: 'x/y', prompt: 'My prompt' } },
    models: [{ id: 'x/y', provider: 'openrouter' }],
    providers: ['openrouter']
  }).load();
  const root = rendered.view;
  assert.ok(root, 'the section renders');
  const flat = flatten(root);
  const select = flat.find((n) => n.tag === 'select' && n.attrs.id === 'sp-shell-review-mode');
  assert.ok(select, 'the When control renders');
  assert.equal(select.attrs.value, 'ask', 'the select shows the resolved mode');
  const options = flat.filter((n) => n.tag === 'option').map((n) => n.attrs.value);
  assert.deepEqual(options.map(String), ['off', 'ask', 'always'], 'every mode is offered');
  const picker = flat.find((n) => n.tag === 'model-picker');
  assert.ok(picker, 'the model picker renders');
  assert.deepEqual({ ...picker.attrs.value }, { modelId: 'x/y', providerId: 'openrouter' });
  assert.equal(picker.attrs.clearLabel, 'No reviewer');
  const prompt = flat.find((n) => n.tag === 'textarea' && n.attrs.id === 'sp-shell-review-prompt');
  assert.ok(prompt, 'the prompt field renders');
  assert.equal(prompt.attrs.value, 'My prompt');
  // The section must say that the reviewer cannot approve or run anything —
  // that sentence is what keeps "always" from reading like an auto-approval.
  const text = JSON.stringify(root);
  assert.match(text, /cannot approve, run or change anything/);
}
{
  // A mode change writes the WHOLE block, so the saved model survives it.
  const rendered = await renderShellReviewSettings({
    resolved: { shellReview: { mode: 'off', providerId: 'openrouter', modelId: 'x/y', prompt: 'Keep me' } },
    models: [{ id: 'x/y', provider: 'openrouter' }],
    providers: ['openrouter']
  }).load();
  const flat = flatten(rendered.view);
  const select = flat.find((n) => n.tag === 'select' && n.attrs.id === 'sp-shell-review-mode');
  select.attrs.onChange({ target: { value: 'always' } });
  // onChange is async (it awaits the PUT); let the request chain settle.
  await settle();
  const put = rendered.requests[0];
  assert.ok(put, 'picking a mode saves');
  // Compare values: the object came back through the vm realm.
  assert.deepEqual({ ...put.shellReview }, {
    mode: 'always',
    providerId: 'openrouter',
    modelId: 'x/y',
    prompt: 'Keep me'
  }, 'a mode change keeps the configured model and prompt');
  assert.deepEqual(Object.keys(put.shellReview).sort(), ['mode', 'modelId', 'prompt', 'providerId'],
    'the write is the complete block, never a partial one');
}
{
  // No reviewer configured: an off project says so, and a mode without a
  // model says what is still missing rather than pretending reviews happen.
  const off = await renderShellReviewSettings({ resolved: {}, models: [], providers: [] }).load();
  assert.match(JSON.stringify(off.view), /Off — no command is sent to another model/,
    'an unconfigured project reads as off');
  const halfConfigured = await renderShellReviewSettings({
    resolved: { shellReview: { mode: 'always' } }, models: [], providers: []
  }).load();
  assert.match(JSON.stringify(halfConfigured.view), /Pick a model below/,
    'a mode without a model says what is missing');
}

// ---- 3. buildReviewBlock -------------------------------------------------
function renderReviewBlock(review) {
  // A minimal DOM: createElement returns a node whose textContent/appendChild
  // behave enough for the renderer, and querySelector is unused on a fresh node.
  const make = (tag) => ({
    tag,
    className: '',
    dataset: {},
    children: [],
    textContent: '',
    get firstChild() { return this.children[0] || null; },
    set textContent(value) { this._text = String(value); this.children = []; },
    get textContent() { return this._text || ''; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.unshift(child); return child; },
    replaceWith(child) { this._replaced = child; },
    querySelector() { return null; }
  });
  const context = vm.createContext({ document: { createElement: make } });
  vm.runInContext(read('frontend/src/components/chat/shellReview.js')
    + '\n;globalThis.__block = buildReviewBlock;', context);
  return context.__block(review);
}
{
  const block = renderReviewBlock({ ok: true, text: 'Deletes dist. Be sure.\nCAUTION', verdict: 'CAUTION', model: { provider: 'openrouter', id: 'x/y' } });
  assert.equal(block.dataset.tone, 'caution');
  const head = block.children[0];
  const labels = head.children.map((c) => c.textContent);
  assert.ok(labels.includes('Second opinion'), 'the block names what it is');
  assert.ok(labels.includes('Caution'), 'the verdict pill shows the verdict');
  assert.ok(labels.some((t) => /openrouter · x\/y/.test(t)), 'the block names the reviewing model');
  const body = block.children[1];
  assert.match(body.textContent, /Deletes dist/);
  assert.equal(renderReviewBlock(null), null);
  const failed = renderReviewBlock({ ok: false, error: 'review timed out after 45s' });
  assert.match(failed.children[1].textContent, /No review: review timed out/);
  const plain = renderReviewBlock({ ok: true, text: 'Reads a file.' });
  assert.equal(plain.dataset.tone, 'plain', 'an answer without a verdict stays neutral');
}

// ---- 4. the popup row and the sheet -------------------------------------
{
  const source = fs.readFileSync(new URL('../frontend/src/components/chat/ToolPopup.jsx', import.meta.url), 'utf8');
  assert.match(source, /Review a command/, 'the popup carries the review row');
  assert.match(source, /openReview\(draftCommand/, 'the row seeds the sheet with the composer draft');
  assert.match(source, /ShellReviewSheet/, 'the sheet is wired in');
  assert.match(source, /tool-popup__actions/, 'the row is its own action block, not a tree row');
  // The sheet must be outside the popup card: a sheet inside the fixed popup
  // would be clipped by its max-height.
  const sheetAt = source.indexOf("h(ShellReviewSheet");
  const popupClose = source.lastIndexOf("h('div', { class: 'tool-popup__foot' }");
  assert.ok(sheetAt > popupClose, 'the sheet renders after the popup card');
}
{
  const sheet = fs.readFileSync(new URL('../frontend/src/components/chat/ShellReviewSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /\/api\/tools\/shell\/review/, 'the sheet calls the review endpoint');
  assert.match(sheet, /nothing is run|not run/i, 'the sheet says nothing is run');
  assert.match(sheet, /buildReviewBlock/, 'the sheet reuses the shared verdict block');
  assert.match(sheet, /useModal/, 'the sheet uses the shared Escape/Tab/focus hook');
  assert.match(sheet, /settings\/project/, 'an unconfigured reviewer links to project settings');
}

console.log('PASS  shell review choice model, settings section, verdict block, popup row and sheet');
