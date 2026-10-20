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
//   2. ShellReviewPage uses the app's model control: the SAME
//      ModelPickerField the chat head / agent editor / dictation render, over
//      project models unioned with every provider's live catalog, with the
//      shared pinned + recent rows and refresh action — no bespoke provider
//      select or free-text id. One pick is one write, and the write is always
//      the complete `shellReview` object;
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
// "Like the rest of the app" is the requirement this pins: the reviewer is
// configured with the SAME ModelPickerField every other surface uses — project
// models unioned with each provider's live catalog, pinned and recent rows,
// one { providerId, modelId } value saved on pick — not with a bespoke
// provider select + free-text id.
function renderShellReviewPage({ resolved, saveStatus = 200, models = [], providers = [], live = [] }) {
  const requests = [];
  const nodes = [];
  const effects = [];
  let cursor = 0;
  let first = true;
  let states = [];
  const effectKeys = [];
  const h = (tag, attrs, ...children) => {
    const node = { tag, attrs: attrs || {}, children: children.flat(Infinity).filter((c) => c != null) };
    nodes.push(node);
    return node;
  };
  const bookmarks = new Set();
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
    // The shared bookmark helpers the chat picker and dictation use.
    loadPinned: () => new Set(bookmarks),
    togglePin: (provider, id) => { const k = provider + '\u0000' + id; if (bookmarks.has(k)) bookmarks.delete(k); else bookmarks.add(k); },
    loadRecent: () => [{ provider: 'ollama', id: 'recent-model', ts: 1 }],
    loadRecentFromServer: async () => true,
    touchRecent: () => {},
    migrateProjectScopedBookmarks: () => {},
    fetchLiveModels: async (provider) => ({ models: live.filter((m) => m.provider === provider) }),
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
      const i = cursor++;
      if (first) states[i] = { current: initial === undefined ? null : initial };
      return states[i];
    },
    // Dependency-aware effects, like Preact: a mount runs every effect, a
    // re-render only one whose deps changed (the catalog load follows the
    // project). Cleanups are not called — unmounting would cancel the
    // asynchronous load this test waits for.
    useEffect: (fn, deps) => {
      const i = cursor++;
      const key = deps === undefined ? 'always' : JSON.stringify(deps);
      if (effectKeys[i] === key) return;
      effectKeys[i] = key;
      effects.push(fn);
      fn();
    },
    Promise, console, setTimeout, clearTimeout
  });
  vm.runInContext(read('frontend/src/components/ShellReviewPage.jsx')
    + '\n;globalThis.__shellReviewPage = ShellReviewPageView;', context);
  const View = context.__shellReviewPage;
  const render = () => { cursor = 0; nodes.length = 0; return View({ projectDir: '/p' }); };
  return {
    async load() {
      const before = render();
      first = false;
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
  // A configured reviewer: the mode select, the app's model picker, and the
  // prompt — nothing bespoke.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'ask', providerId: 'openrouter', modelId: 'x/y', prompt: 'My prompt' } },
    models: [{ id: 'x/y', provider: 'openrouter' }],
    providers: ['openrouter', 'ollama'],
    live: [{ id: 'x/z', provider: 'openrouter' }, { id: 'llama-local', provider: 'ollama' }]
  }).load();
  const flat = flatten(rendered.view);
  const mode = byId(flat, 'sr-mode');
  assert.ok(mode, 'the mode select renders');
  assert.equal(mode.attrs.value, 'ask');
  assert.deepEqual(flat.filter((n) => n.tag === 'option' && n.attrs.value).map((n) => n.attrs.value).slice(0, 3),
    ['off', 'ask', 'always'], 'every mode is offered');

  // The model control is the shared picker — the same component the chat head,
  // the agent editor, the subagent defaults and dictation render.
  const pickers = flat.filter((n) => n.tag === 'model-picker');
  assert.equal(pickers.length, 1, 'exactly one model control, the shared picker');
  const picker = pickers[0];
  assert.deepEqual({ ...picker.attrs.value }, { modelId: 'x/y', providerId: 'openrouter' });
  assert.equal(picker.attrs.variant, 'sheet', 'the picker uses the app\'s mobile sheet variant');
  assert.equal(picker.attrs.ariaLabel, 'Model that reviews shell commands');
  // Pinned + recent rows are the app-wide bookmark lists, not a private copy.
  assert.ok(picker.attrs.pinned instanceof Object, 'pins come from the shared bookmark list');
  assert.deepEqual([...picker.attrs.recent].map((r) => r.id), ['recent-model'], 'recents come from the shared list');
  assert.equal(typeof picker.attrs.onTogglePin, 'function');
  assert.equal(typeof picker.attrs.refresh, 'function', 'the picker keeps the app\'s refresh action');
  assert.equal(picker.attrs.refreshEmpty, 'Refresh models');
  // The catalog is the project models UNION every configured provider's live
  // list — so an id the project never saved can still be picked.
  // Arrays read out of the vm are another realm's Array, so compare values.
  const listed = [...picker.attrs.models].map((m) => (m.provider || '') + '/' + m.id).sort();
  assert.deepEqual([...listed], ['ollama/llama-local', 'openrouter/x/y', 'openrouter/x/z']);
  assert.deepEqual([...picker.attrs.extraProviders], ['openrouter', 'ollama']);

  // There is no bespoke provider select or free-text model-id field any more.
  assert.equal(byId(flat, 'sr-provider'), undefined, 'no separate provider select');
  assert.equal(byId(flat, 'sr-model'), undefined, 'no free-text model-id field');

  const prompt = byId(flat, 'sr-prompt');
  assert.equal(prompt.attrs.value, 'My prompt');
  // The page is built from its sibling pages' pieces, not a bespoke layout:
  // `.group__list` cards with a bold title + note + status, the same idiom as
  // Settings → Project → File tool options. The first version nested the
  // generic `.row` in its own padded wrapper, which double-indented every
  // control and shrank the labels — this pins the fix.
  const root = rendered.view;
  const cls = (n) => String((n.attrs && (n.attrs.class || n.attrs.className)) || '');
  const has = (n, name) => cls(n).split(/\s+/).includes(name);
  // The page root is the shell's `.settings-project` section, like every other
  // settings sub-page — not a bespoke wrapper of its own.
  const section = flat.find((n) => n.tag === 'section');
  assert.equal(cls(section), 'settings-project', 'the page uses the shared settings section wrapper');
  const items = flat.filter((n) => has(n, 'settings-project__item'));
  assert.ok(items.length >= 4, 'the page uses settings item cards: ' + items.length);
  assert.ok(flat.some((n) => n.tag === 'ul' && has(n, 'group__list')),
    'controls live in a .group__list, like every sibling page');
  const titles = flat.filter((n) => has(n, 'settings-project__item-title'))
    .map((n) => n.children.join(''));
  assert.ok(titles.includes('Mode'), 'the Mode row is titled like a settings row');
  assert.ok(titles.includes('Model'), 'the Model row is titled like a settings row');
  assert.ok(titles.includes('Review prompt'), 'the prompt row is titled like a settings row');
  // ...and there is no leftover bespoke container or .row wrapper.
  assert.ok(!flat.some((n) => cls(n).includes('settings-project__shell-review') && !/warn|prompt|model|providers/.test(cls(n))),
    'no bespoke page container remains');
  assert.ok(!flat.some((n) => cls(n) === 'row'),
    'no generic .row wrapper inside the page');
  assert.match(JSON.stringify(root), /settings-project__item-note/, 'rows carry the shared note line');
  const text = JSON.stringify(rendered.view);
  assert.match(text, /never runs, approves or changes anything/);
  assert.match(text, /Reviews go to openrouter · x\/y/, 'the row names the model that will be asked');
  // That sentence is a NOTE, not a status: a permanent green "saved"-looking
  // line was the layout complaint this pins.
  const noteNode = flat.find((n) => cls(n).split(/\s+/).includes('settings-project__item-note')
    && JSON.stringify(n.children).includes('Reviews go to'));
  assert.ok(noteNode, 'the standing state renders as a settings note');
  assert.ok(!flat.some((n) => cls(n).split(/\s+/).includes('settings-project__item-status')
    && JSON.stringify(n.children).includes('Reviews go to')),
    'the standing state is never painted as save feedback');
}
{
  // Picking a model saves ONE complete block, keeps the mode and prompt, and
  // is the single write a pick makes (one tap = one request, like every other
  // model control in the app).
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always', providerId: '', modelId: '', prompt: 'Keep me' } },
    models: [], providers: ['ollama'], live: [{ id: 'llama-local', provider: 'ollama' }]
  }).load();
  const picker = flatten(rendered.view).find((n) => n.tag === 'model-picker');
  picker.attrs.onChange({ providerId: 'ollama', modelId: 'llama-local' });
  await settle();
  assert.equal(rendered.requests.length, 1, 'one pick is one write');
  assert.deepEqual({ ...rendered.requests[0].shellReview }, {
    mode: 'always',
    providerId: 'ollama',
    modelId: 'llama-local',
    prompt: 'Keep me'
  }, 'a pick saves with the mode and prompt intact');
}
{
  // The prompt autosaves, debounced: typing does not send a request per
  // keystroke, and what lands is one complete block.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'ask', providerId: 'openrouter', modelId: 'x/y', prompt: '' } },
    models: [], providers: ['openrouter']
  }).load();
  const prompt = byId(flatten(rendered.view), 'sr-prompt');
  prompt.attrs.onInput({ currentTarget: { value: 'Review it.' } });
  assert.equal(rendered.requests.length, 0, 'typing alone does not write');
  assert.match(JSON.stringify(rendered.view), /Saved automatically as you type/, 'the prompt row says it autosaves');
}
{
  // A saved model whose provider lost its connection is called out, and the
  // stored pair is not rewritten by the option list.
  const rendered = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always', providerId: 'openrouter', modelId: 'x/y' } },
    models: [], providers: ['ollama']
  }).load();
  const picker = flatten(rendered.view).find((n) => n.tag === 'model-picker');
  assert.deepEqual({ ...picker.attrs.value }, { providerId: 'openrouter', modelId: 'x/y' },
    'the saved pair is shown even when its provider is gone');
  assert.match(JSON.stringify(rendered.view), /which has no connection any more/);
}
{
  // Off with nothing configured still renders and explains the state.
  const rendered = await renderShellReviewPage({ resolved: {}, models: [], providers: [] }).load();
  assert.match(JSON.stringify(rendered.view), /Off — no command is sent to another model/);
  // Picking a model when mode is 'off' automatically activates 'ask' (On demand)
  // so the user's pick is immediately ready without a second dropdown change.
  const offPicker = flatten(rendered.view).find((n) => n.tag === 'model-picker');
  offPicker.attrs.onChange({ providerId: 'openrouter', modelId: 'x/y' });
  await settle();
  assert.equal(rendered.requests.at(-1).shellReview.mode, 'ask',
    'picking a model from Off switches mode to ask');
  const half = await renderShellReviewPage({
    resolved: { shellReview: { mode: 'always' } }, models: [], providers: []
  }).load();
  assert.match(JSON.stringify(half.view), /No review is sent yet: pick a model below/,
    'a mode without a model says what is missing');
}

// ---- 3. buildReviewBlock + applyReviewToCard -----------------------------
function makeDomNode(tag) {
  return {
    tag: String(tag || '').toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    parentNode: null,
    _text: '',
    get firstChild() { return this.children[0] || null; },
    set textContent(value) { this._text = String(value); this.children = []; },
    get textContent() { return this._text || ''; },
    appendChild(child) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child);
        if (idx >= 0) child.parentNode.children.splice(idx, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child);
        if (idx >= 0) child.parentNode.children.splice(idx, 1);
      }
      child.parentNode = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at >= 0) this.children.splice(at, 0, child);
      else this.children.unshift(child);
      return child;
    },
    replaceWith(child) {
      this._replaced = child;
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) {
        child.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 1, child);
      }
    },
    querySelector(sel) {
      const parts = String(sel).split(',').map((s) => s.trim().replace(/^\./, ''));
      const visit = (node) => {
        for (const c of node.children || []) {
          const classes = String(c.className || '').split(/\s+/);
          if (parts.some((p) => classes.includes(p))) return c;
          const found = visit(c);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    }
  };
}
function renderReviewBlock(review) {
  const context = vm.createContext({ document: { createElement: makeDomNode } });
  vm.runInContext(read('frontend/src/components/chat/shellReview.js')
    + '\n;globalThis.__block = buildReviewBlock; globalThis.__apply = applyReviewToCard;', context);
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

  // Approval card placement: applyReviewToCard inserts the review block ABOVE
  // `.tool-card__actions` (and never inside the `<pre class="tool-card__body">`
  // command detail or below the decision buttons).
  const context = vm.createContext({ document: { createElement: makeDomNode } });
  vm.runInContext(read('frontend/src/components/chat/shellReview.js')
    + '\n;globalThis.__apply = applyReviewToCard;', context);
  const authCard = makeDomNode('div');
  authCard.className = 'tool-card tool-card--authorization';
  authCard.dataset.awaitingReview = '1';
  const cardHead = makeDomNode('div'); cardHead.className = 'tool-card__head';
  const cardDetail = makeDomNode('pre'); cardDetail.className = 'tool-card__body'; cardDetail.textContent = 'rm -rf dist';
  const cardActions = makeDomNode('div'); cardActions.className = 'tool-card__actions';
  authCard.appendChild(cardHead);
  authCard.appendChild(cardDetail);
  authCard.appendChild(cardActions);
  context.__apply(authCard, { ok: true, text: 'Deletes dist.\nDANGER', verdict: 'DANGER', model: { provider: 'openrouter', id: 'x/y' } });
  assert.equal(authCard.dataset.awaitingReview, undefined, 'applying review clears awaitingReview');
  assert.equal(authCard.dataset.reviewed, 'danger');
  assert.equal(cardDetail.children.length, 0, 'the command <pre> is untouched');
  const reviewIdx = authCard.children.findIndex((c) => c.className === 'tool-card__review');
  const actionsIdx = authCard.children.indexOf(cardActions);
  assert.ok(reviewIdx > 0 && reviewIdx < actionsIdx, 'review block sits above the decision buttons on the approval card');
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

  const transcript = fs.readFileSync(new URL('../frontend/src/components/chat/transcript.js', import.meta.url), 'utf8');
  assert.match(transcript, /\.tool-card--authorization\[data-auth-call-id=/,
    'handleShellReviewEvent locates the pending approval card by data-auth-call-id');
  assert.match(transcript, /takePendingShellReview/,
    'early shell_review frames are buffered until the card mounts');
}

console.log('PASS  shell review choice model, settings page (shared model picker + mode + prompt), verdict block, popup row and sheet');
