// The hidden-files list: labels and the per-row remove action.
//
// Two contracts are pinned here:
//   1. Labels describe what is hidden. A rule can hide whole lines, selected
//      text, or both, so a char-only rule must never read "No lines selected"
//      (describeHidden in frontend/src/components/settings/hiddenRanges.js).
//   2. Row remove. Each row carries its own remove action; it confirms first,
//      writes the whole rule set back without that file, drops the row only
//      after the server accepted it, and keeps the row (with an explanation)
//      when the write fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
const helpers = await import('data:text/javascript;base64,' + Buffer.from(source('components/settings/hiddenRanges.js')).toString('base64'));
const { describeHidden, charSpanLabel } = helpers;

// ---- describeHidden unit cases -------------------------------------------
assert.equal(describeHidden({ ranges: [], chars: [] }), 'Nothing hidden', 'empty rule');
assert.equal(describeHidden({}), 'Nothing hidden', 'missing input');
assert.equal(describeHidden({ ranges: [{ start: 3, end: 3 }] }), 'Lines 3', 'single hidden line');
assert.equal(describeHidden({ ranges: [{ start: 3, end: 5 }, { start: 9, end: 9 }] }), 'Lines 3–5, 9', 'line list');
assert.equal(
  describeHidden({ ranges: [], chars: [{ startLine: 8, endLine: 8, startCol: 4, endCol: 9 }] }),
  'Text on line 8, cols 4–9',
  'char-only rule is labelled as text, not lines'
);
assert.equal(
  describeHidden({ chars: [{ startLine: 4, endLine: 7, startCol: 2, endCol: 5 }] }),
  'Text on lines 4–7',
  'multi-line span hides the boundary lines'
);
assert.equal(
  describeHidden({ ranges: [{ start: 3, end: 5 }], chars: [{ startLine: 8, endLine: 8, startCol: 4, endCol: 9 }] }),
  'Lines 3–5 · Text on line 8, cols 4–9',
  'lines and text are both reported'
);
assert.equal(
  describeHidden({ chars: [
    { startLine: 8, endLine: 8, startCol: 4, endCol: 9 },
    { startLine: 10, endLine: 10, startCol: 1, endCol: 3 }
  ] }),
  'Text on line 8, cols 4–9; line 10, cols 1–3',
  'several spans are separated'
);
assert.equal(
  describeHidden({ chars: [
    { startLine: 8, endLine: 8, startCol: 4, endCol: 9 },
    { startLine: 8, endLine: 8, startCol: 7, endCol: 12 }
  ] }),
  'Text on line 8, cols 4–12',
  'overlapping spans merge before labelling'
);
assert.equal(describeHidden({ chars: [{ startLine: 0, endLine: 1, startCol: 1, endCol: 2 }] }), 'Nothing hidden', 'invalid span dropped');
assert.equal(charSpanLabel({ startLine: 2, endLine: 2, startCol: 1, endCol: 4 }), 'line 2, cols 1–4', 'span label');

// ---- list render harness -------------------------------------------------
const projectDir = '/fixture/project & name';
const SEED = [
  { path: 'src/char-only.js', ranges: [], chars: [{ startLine: 5, endLine: 5, startCol: 8, endCol: 17 }] },
  { path: 'src/lines-only.js', ranges: [{ start: 3, end: 5 }] },
  { path: 'src/both.js', ranges: [{ start: 1, end: 1 }], chars: [{ startLine: 4, endLine: 4, startCol: 2, endCol: 6 }] }
];

// Execute the real component with a minimal hook harness and a fake server.
// Effects run only on mount, so a state change re-renders like React does
// instead of re-fetching (which would hide what the write actually did).
function createList(seed) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [], confirmAnswer = true;
  const server = { rules: seed.map((rule) => ({ ...rule })) };
  const writes = [];
  let failNext = false, hold = false, release = null;
  const context = vm.createContext({
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    activeProject: { value: { dir: '' } },
    window: { confirm: () => confirmAnswer },
    nav() {},
    Fragment: 'fragment', AgentFilePicker: 'file-picker', HiddenContentEditor: 'hidden-editor',
    useRef: (value) => { const i = cursor++; if (first) states[i] = { current: value }; return states[i]; },
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (effect) => { effects.push(effect); },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url, init) => {
      if (init?.method === 'PUT') {
        const payload = JSON.parse(init.body);
        writes.push(payload);
        if (hold) await new Promise((resolve) => { release = resolve; });
        if (failNext) { failNext = false; return { status: 503, body: { error: 'nope' } }; }
        server.rules = payload.rules;
        return { status: 200, body: { rules: server.rules } };
      }
      assert.ok(url.startsWith('/api/settings/hide-file-content?'), 'unexpected request: ' + url);
      return { status: 200, body: { rules: server.rules } };
    }
  });
  vm.runInContext(source('components/settings/hiddenRanges.js').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(source('components/SettingsHiddenContent.jsx').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);

  function render(runEffects = false) {
    cursor = 0; nodes = [];
    if (runEffects) effects = [];
    context.SettingsHiddenContentView({ projectDir, from: 'settings/projects', filePath: '' });
    first = false;
    if (runEffects) effects.forEach((effect) => effect());
    return nodes;
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    writes,
    render,
    flush,
    setConfirm: (value) => { confirmAnswer = value; },
    failNextWrite: () => { failNext = true; },
    holdWrite: () => { hold = true; },
    releaseWrite: () => { const done = release; release = null; hold = false; if (done) done(); },
    async mount() {
      render(true);
      await flush();
      await flush();
      return render();
    },
    // Update state the way a click does: run the handler, let promises settle,
    // then re-render without re-running effects. Returns the new node list.
    async click(node) {
    node.attrs.onClick();
    await flush();
    await flush();
    return render();
    }
  };
}

// The h() stub records every element in one flat array, so selections are a
// plain filter — recursing would count each element once per nesting level.
const select = (nodes, predicate) => nodes.filter((node) => node.tag && predicate(node));
const rowsOf = (nodes) => select(nodes, (node) => node.attrs.class === 'hidden-content__row');
const removeButtons = (nodes) => select(nodes, (node) => node.attrs.class === 'hidden-content__remove');
const rowLabels = (nodes) => select(nodes, (node) => node.attrs.class === 'hidden-content__muted')
  .map((node) => node.children.filter((child) => typeof child === 'string').join(''));
const noticeText = (nodes) => select(nodes, (node) => node.attrs.class === 'hidden-content__notice')
  .map((node) => node.children.filter((child) => typeof child === 'string').join(''))[0];
const alertText = (nodes) => select(nodes, (node) => node.attrs.role === 'alert')
  .map((node) => node.children.map((child) => (typeof child === 'string' ? child : '')).join('')).join(' ');

// ---- 1. labels -----------------------------------------------------------
const labelled = createList(SEED);
let nodes = await labelled.mount();
assert.deepEqual(
  rowLabels(nodes),
  ['Text on line 5, cols 8–17', 'Lines 3–5', 'Lines 1 · Text on line 4, cols 2–6'],
  'each file row labels what it hides: ' + JSON.stringify(rowLabels(nodes))
);
assert.equal(rowLabels(nodes).some((label) => label.includes('No lines selected')), false, 'no misleading empty-line label');
assert.equal(rowsOf(nodes).length, 3, 'one row per rule');

const emptyList = createList([]);
nodes = await emptyList.mount();
assert.ok(
  select(nodes, (node) => node.attrs.class === 'hidden-content__empty').some((node) => String(node.children[0]).includes('Nothing hidden yet')),
  'the empty state speaks about hidden lines and text'
);
assert.equal(removeButtons(nodes).length, 0, 'no remove action without rows');

// ---- 2. every row offers a labelled remove action ------------------------
nodes = await labelled.mount();
assert.deepEqual(
  removeButtons(nodes).map((node) => node.attrs['aria-label']),
  ['Stop hiding content in src/char-only.js', 'Stop hiding content in src/lines-only.js', 'Stop hiding content in src/both.js'],
  'each row remove control names the file it affects'
);
for (const button of removeButtons(nodes)) {
  assert.equal(button.attrs.type, 'button', 'a remove control never submits a form');
  assert.ok(button.children.includes('Remove'), 'the remove control is labelled for sighted users too');
}

// ---- 3. declining the confirmation writes nothing ------------------------
const declining = createList(SEED);
nodes = await declining.mount();
declining.setConfirm(false);
await declining.click(removeButtons(nodes)[0]);
assert.equal(declining.writes.length, 0, 'declining the confirmation does not write');
assert.equal(rowsOf(declining.render()).length, 3, 'declining keeps every row');

// ---- 4. confirming removes exactly that file ----------------------------
const removing = createList(SEED);
nodes = await removing.mount();
removing.setConfirm(true);
await removing.click(removeButtons(nodes)[1]);
assert.equal(removing.writes.length, 1, 'one write per removal');
assert.equal(removing.writes[0].projectDir, projectDir, 'the write is scoped to the project');
assert.deepEqual(
  removing.writes[0].rules.map((rule) => rule.path),
  ['src/char-only.js', 'src/both.js'],
  'the write keeps every other rule'
);
nodes = removing.render();
assert.deepEqual(rowsOf(nodes).map((row) => row.attrs.key), ['src/char-only.js', 'src/both.js'], 'the removed row is gone');
assert.equal(noticeText(nodes), 'src/lines-only.js is no longer hidden.', 'the notice names the removed file');
assert.equal(alertText(nodes), '', 'a successful removal reports no error');

// Re-removing the rest empties the list.
nodes = await removing.click(removeButtons(nodes)[0]);
nodes = await removing.click(removeButtons(nodes)[0]);
assert.equal(removing.writes.length, 3, 'each removal writes once');
assert.equal(rowsOf(nodes).length, 0, 'removing the last rule empties the list');
assert.ok(select(nodes, (node) => node.attrs.class === 'hidden-content__empty').length, 'the empty state replaces the last row');
assert.equal(noticeText(nodes), 'src/both.js is no longer hidden.', 'the last removal is announced');

// ---- 5. a failed removal keeps the row and explains why ------------------
const failing = createList(SEED);
nodes = await failing.mount();
failing.setConfirm(true);
failing.failNextWrite();
await failing.click(removeButtons(nodes)[0]);
nodes = failing.render();
assert.equal(failing.writes.length, 1, 'the failed removal still attempted one write');
assert.equal(rowsOf(nodes).length, 3, 'a failed removal keeps every row');
assert.ok(alertText(nodes).includes('still hidden'), 'the failure says nothing changed: ' + alertText(nodes));
assert.ok(alertText(nodes).includes('HTTP 503'), 'the failure keeps the status code: ' + alertText(nodes));
assert.equal(removeButtons(nodes).some((button) => button.attrs.disabled), false, 'controls are usable again after a failure');
assert.equal(noticeText(nodes), '', 'a failed removal claims no success');

// A retry after the failure works and clears the error.
nodes = await failing.click(removeButtons(nodes)[0]);
assert.equal(failing.writes.length, 2, 'the retry writes again');
assert.deepEqual(rowsOf(failing.render()).map((row) => row.attrs.key), ['src/lines-only.js', 'src/both.js'], 'the retry removes the row');
assert.equal(alertText(failing.render()), '', 'the retry clears the failure message');

// ---- 6. busy state: one write per tap -----------------------------------
const busy = createList(SEED);
nodes = await busy.mount();
busy.setConfirm(true);
busy.holdWrite();
const inFlight = removeButtons(nodes)[0].attrs.onClick();
await busy.flush();
nodes = busy.render();
assert.equal(removeButtons(nodes)[0].children[0], 'Removing…', 'the tapped row shows progress');
assert.ok(removeButtons(nodes).every((button) => button.attrs.disabled), 'every remove control is disabled while saving');
// A second tap while the first write is still in flight must not queue a write.
const second = removeButtons(nodes)[1].attrs.onClick();
await busy.flush();
assert.equal(busy.writes.length, 1, 'a tap during a write is ignored');
await second;
assert.equal(busy.writes.length, 1, 'the ignored tap never writes, even after it settles');
busy.releaseWrite();
await inFlight;
await busy.flush();
nodes = busy.render();
assert.equal(busy.writes.length, 1, 'releasing the write does not duplicate it');
assert.equal(rowsOf(nodes).length, 2, 'the held removal completes once');
assert.equal(removeButtons(nodes).some((button) => button.attrs.disabled), false, 'controls re-enable after the write');

console.log('PASS hidden-content list: labels, per-row remove (confirm, payload, retry, busy) and empty state');
