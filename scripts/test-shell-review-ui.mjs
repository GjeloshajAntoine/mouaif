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
//   2. ShellReviewPage renders all four inputs — mode, provider, model id
//      and prompt — saves ONE complete `shellReview` object per change (never
//      a partial one that would clear the model on a mode change), suggests
//      the provider's live catalog in the id field, and reports the
//      not-configured and unconfigured-provider states;
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

// ---- 2. ShellReviewPage -------------------------------------------------
// A tiny Preact stand-in: h() records vnodes, hooks keep a slot array, and the
// model picker is a marker component (its own behaviour is tested elsewhere).
// The page is the only editor of `shellReview`, so this pins its inputs — the
// provider select and the free-text model id are the two fields the inline
// section did not have.
function renderShellReviewPage({ resolved, saveStatus = 200, models = [], providers = [], live = [] }) {
  const requests = [];
  const nodes = [];
  let cursor = 0;
  let first = true;
  let states = [];
  // Effect slots: an effect re-runs when its dependency list changes, the way
  // Preact does. The page's catalog fetch depends on the chosen provider, so a
  // once-only effect would never see the provider the load set.
  const effectDeps = [];
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
    activeProject: { value: { dir: '' } },
    sectionIcon: () => null,
    settingsLink: (path) => '#/' + path,
    backHref: () => '#/settings/project',
    backTarget: () => ({ path: 'settings/project', label: 'Back to project settings' }),
    fetchLiveModels: async (provider) => ({ models: live.filter((m) => m.provider === provider) }),
    fetchJson: async (url, init) => {
      if (init && init.method === 'PUT') {
        requests.push(JSON.parse(init.body));
        if (saveStatus !== 200) return { status: saveStatus, body: {} };
        const body = JSON.parse(init.body);
        return { status: 200, body: { project: { shellReview: body.shellReview } } };
      }
      if (init && init.method === 'POST') {
        requests.push({ test: JSON.parse(init.body) });
        return { status: 200, body: { ok: true } };
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
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    // Dependency-aware effects: a mount runs every effect once, and a re-render
    // only re-runs one whose deps changed (the page's catalog fetch follows the
    // provider). The returned cleanup is deliberately NOT called: unmounting
    // would cancel the asynchronous load the test is waiting for.
    useEffect: (fn, deps) => {
      const i = cursor++;
      const key = deps === undefined ? 'always' : JSON.stringify(deps);
      if (effectDeps[i] === key) return;
      effectDeps[i] = key;
      fn();
    },
    Promise, console
  });
  vm.runInContext(read('frontend/src/components/ShellReviewPage.jsx')
    + '\n;globalThis.__shellReviewPage = ShellReviewPageView;', context);
  const View = context.__shellReviewPage;
  const render = () => { cursor = 0; nodes.length = 0; return View({ projectDir: '/p' }); };
  return {
    // The page loads asynchronously, so the caller renders, waits for the load
    // to settle, and renders again to read the loaded view.
    async load() {
      const before = render();
      first = false;
      // Two passes: the load effect fills in the saved provider, and the
      // catalog effect (which depends on that provider) answers after it.
      await settle();
      render();
      await settle();
      return { before, view: render(), requests, context, rerender: () => render() };
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
function byId(nodes, id) {
  return nodes.find((n) => n.attrs && n.attrs.id === id);
}

{
  // A fully configured reviewer: every input shows the saved value.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'ask', providerId: 'openrouter', modelId: 'x/y', prompt: 'My prompt' } },
    models: [{ id: 'x/y', provider: 'openrouter' }],
    providers: ['openrouter', 'ollama'],
    live: [{ id: 'x/y', provider: 'openrouter' }, { id: 'x/z', provider: 'openrouter' }]
  }).load();
  const flat = flatten(rendered.view);
  const mode = byId(flat, 'sr-mode');
  assert.ok(mode, 'the mode select renders');
  assert.equal(mode.attrs.value, 'ask', 'the select shows the resolved mode');
  assert.deepEqual(flat.filter((n) => n.tag === 'option' && n.attrs.value).map((n) => n.attrs.value).slice(0, 3),
    ['off', 'ask', 'always'], 'every mode is offered');
  const provider = byId(flat, 'sr-provider');
  assert.ok(provider, 'the provider select renders — the input the old section lacked');
  assert.equal(provider.attrs.value, 'openrouter');
  assert.deepEqual(provider.children.filter((n) => n.tag === 'option').map((n) => String(n.attrs.value)),
    ['', 'openrouter', 'ollama'], 'the configured connections are offered');
  const model = byId(flat, 'sr-model');
  assert.ok(model, 'the model-id field renders — the other input the old section lacked');
  assert.equal(model.attrs.value, 'x/y');
  assert.equal(model.attrs.list, 'sr-model-suggestions', 'the id field suggests the live catalog');
  const suggestions = byId(flat, 'sr-model-suggestions');
  assert.ok(suggestions, 'a datalist backs the id field');
  assert.deepEqual(suggestions.children.map((n) => String(n.attrs.value)), ['x/y', 'x/z']);
  const prompt = byId(flat, 'sr-prompt');
  assert.equal(prompt.attrs.value, 'My prompt');
  const picker = flat.find((n) => n.tag === 'model-picker');
  assert.ok(picker, 'the catalog picker is still the fast path');
  assert.deepEqual({ ...picker.attrs.value }, { modelId: 'x/y', providerId: 'openrouter' });
  // The page must say the reviewer cannot approve or run anything.
  const text = JSON.stringify(rendered.view);
  assert.match(text, /never runs, approves or changes anything/);
  assert.match(text, /Reviews go to openrouter · x\/y/, 'the status names the model that will be asked');
}
{
  // Typing a model id + provider and saving writes ONE complete block, and
  // keeps the mode/prompt that were already stored.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always', providerId: '', modelId: '', prompt: 'Keep me' } },
    models: [], providers: ['openrouter', 'ollama']
  }).load();
  let flat = flatten(rendered.view);
  byId(flat, 'sr-provider').attrs.onChange({ currentTarget: { value: 'ollama' } });
  flat = flatten(rendered.rerender());
  byId(flat, 'sr-model').attrs.onInput({ currentTarget: { value: 'qwen2.5-coder:7b' } });
  flat = flatten(rendered.rerender());
  const save = flat.find((n) => n.tag === 'button' && JSON.stringify(n.children) === '["Save model"]');
  assert.ok(save, 'the page has a Save model action');
  assert.equal(save.attrs.disabled, false, 'an edited model can be saved');
  await save.attrs.onClick();
  await settle();
  const put = rendered.requests[0];
  assert.ok(put && put.shellReview, 'saving writes shellReview');
  assert.deepEqual({ ...put.shellReview }, {
    mode: 'always',
    providerId: 'ollama',
    modelId: 'qwen2.5-coder:7b',
    prompt: 'Keep me'
  }, 'a manual model id saves with the mode and prompt intact');
}
{
  // A provider with no configured connection is called out: reviews would fail.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always', providerId: 'openrouter', modelId: 'x/y' } },
    models: [], providers: ['ollama']
  }).load();
  const text = JSON.stringify(rendered.view);
  assert.match(text, /No connection is configured for .*openrouter/,
    'an unconfigured provider is warned about');
  // ...and the stored id is not silently rewritten by the option list.
  const optionValues = flatten(rendered.view)
    .filter((n) => n.tag === 'option').map((n) => String(n.attrs.value));
  assert.ok(optionValues.includes('openrouter'), 'the unconfigured provider stays selectable');
  assert.match(text, /not configured/);
}
{
  // Check model asks the real test route about the named pair.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'ask', providerId: 'openrouter', modelId: 'x/y' } },
    models: [], providers: ['openrouter']
  }).load();
  const flat = flatten(rendered.view);
  const check = flat.find((n) => n.tag === 'button' && JSON.stringify(n.children) === '["Check model"]');
  assert.ok(check, 'the page has a Check model action');
  await check.attrs.onClick();
  await settle();
  const post = rendered.requests.find((r) => r.test);
  assert.ok(post, 'checking sends a request');
  assert.deepEqual({ ...post.test }, { projectDir: '/p', modelId: 'x/y', providerId: 'openrouter' });
}
{
  // Off with nothing configured still renders and explains the state.
  const rendered = await renderShellReviewPage({ resolved: {}, models: [], providers: [] }).load();
  assert.match(JSON.stringify(rendered.view), /Off — no command is sent to another model/);
  const half = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always' } }, models: [], providers: []
  }).load();
  assert.match(JSON.stringify(half.view), /No review is sent yet/,
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
  // The page is a real route, not a section of the project page: the link row
  // must point at it, and the router must own it.
  const routes = fs.readFileSync(new URL('../frontend/src/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /settings\/project\/shell-review/, 'the router has the shell-review page');
  assert.match(routes, /name: 'settingsProjectShellReview'/);
  const app = fs.readFileSync(new URL('../frontend/src/components/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /settingsProjectShellReview: \[ShellReviewPageView/);
  const project = fs.readFileSync(new URL('../frontend/src/components/SettingsProject.jsx', import.meta.url), 'utf8');
  assert.match(project, /settings\/project\/shell-review\?' \+ projectBackQS\(\)/, 'the project page links to the page');
  assert.match(project, /shellReviewSummary/, 'the link row names the current choice');
  assert.ok(!/ShellReviewSettings/.test(project), 'the old inline section is gone');
}
{
  const sheet = fs.readFileSync(new URL('../frontend/src/components/chat/ShellReviewSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /\/api\/tools\/shell\/review/, 'the sheet calls the review endpoint');
  assert.match(sheet, /nothing is run|not run/i, 'the sheet says nothing is run');
  assert.match(sheet, /buildReviewBlock/, 'the sheet reuses the shared verdict block');
  assert.match(sheet, /useModal/, 'the sheet uses the shared Escape/Tab/focus hook');
  assert.match(sheet, /settings\/project\/shell-review/, 'an unconfigured reviewer links to its own page');
}

console.log('PASS  shell review choice model, settings page (mode/provider/model id/prompt + check), verdict block, popup row and sheet');
