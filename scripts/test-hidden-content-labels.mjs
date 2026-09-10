// Labels for hidden content must describe what is actually hidden.
// A rule can hide whole lines, selected text, or both; the file list and the
// editor footer share one label (describeHidden) so a char-only rule can
// never be summarised as "No lines selected".
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

// ---- list rows render the shared label -----------------------------------
const projectDir = '/fixture/project & name';
const rules = [
  { path: 'src/char-only.js', ranges: [], chars: [{ startLine: 5, endLine: 5, startCol: 8, endCol: 17 }] },
  { path: 'src/lines-only.js', ranges: [{ start: 3, end: 5 }] },
  { path: 'src/both.js', ranges: [{ start: 1, end: 1 }], chars: [{ startLine: 4, endLine: 4, startCol: 2, endCol: 6 }] }
];

function createView(loadedRules) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [];
  const context = vm.createContext({
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    activeProject: { value: { dir: '' } },
    Fragment: 'fragment', AgentFilePicker: 'file-picker', HiddenContentEditor: 'hidden-editor',
    nav() {},                     // the harness never navigates
    useEffect: (effect) => { effects.push(effect); },
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url) => {
      assert.ok(url.startsWith('/api/settings/hide-file-content?'), 'unexpected request: ' + url);
      return { status: 200, body: { rules: loadedRules } };
    }
  });
  vm.runInContext(source('components/settings/hiddenRanges.js').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(source('components/SettingsHiddenContent.jsx').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
  return {
    async render() {
      cursor = 0; nodes = []; effects = [];
      context.SettingsHiddenContentView({ projectDir, from: 'settings/projects', filePath: '' });
      first = false;
      effects.forEach(effect => effect());
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      cursor = 0; nodes = [];
      context.SettingsHiddenContentView({ projectDir, from: 'settings/projects', filePath: '' });
      return nodes;
    }
  };
}

const rows = await createView(rules).render();
const rowLabels = rows
  .filter(node => node.attrs?.class === 'hidden-content__muted')
  .map(node => node.children.filter(child => typeof child === 'string').join(''));
assert.deepEqual(
  rowLabels,
  ['Text on line 5, cols 8–17', 'Lines 3–5', 'Lines 1 · Text on line 4, cols 2–6'],
  'each file row labels what it hides: ' + JSON.stringify(rowLabels)
);
assert.equal(rowLabels.some(label => label.includes('No lines selected')), false, 'no misleading empty-line label');

const empty = await createView([]).render();
assert.ok(
  empty.some(node => node.attrs?.class === 'hidden-content__empty' && String(node.children[0]).includes('Nothing hidden yet')),
  'the empty state speaks about hidden lines and text'
);

console.log('PASS hidden-content labels: describeHidden cases, file-row labels, char-only rows and empty state');
