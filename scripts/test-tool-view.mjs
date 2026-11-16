// The simplified tool view (frontend/src/toolView.js & ToolViewEditor.jsx):
// a project's own categories regroup the chat's tool tree without changing any
// tool state, with coverage stats, starter presets, search filtering, and live
// preview.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const {
  normalizeToolView,
  isToolViewActive,
  applyToolView,
  toolViewStats,
  toolViewSummary,
  TOOL_VIEW_PRESETS,
  MAX_CATEGORIES,
  MAX_NAME_LENGTH
} = await import('../frontend/src/toolView.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const groups = [
  { id: 'shell', name: 'Shell', checked: true, tools: [{ id: 'shell', name: 'shell', description: 'Run a shell command', checked: true, control: 'seg' }] },
  { id: 'files', name: 'File tools', checked: false, tools: [
    { id: 'read_file', name: 'read_file', description: 'Read a text file', checked: true },
    { id: 'write_file', name: 'write_file', description: 'Write a text file', checked: false }
  ] },
  { id: 'mcp-git', name: 'git', checked: true, tools: [{ id: 'mcp__git__git_log', name: 'git_log', description: 'Show git commits', checked: true }] }
];

check('a missing or malformed value normalizes to an inactive view', () => {
  for (const raw of [null, undefined, 'x', [], { categories: 'nope' }]) {
    assert.deepEqual(normalizeToolView(raw), { enabled: false, categories: [] });
    assert.equal(isToolViewActive(raw), false);
  }
});

check('normalize trims names, drops bad entries and duplicate tools', () => {
  const v = normalizeToolView({ enabled: true, categories: [
    { name: '  Read  ', tools: ['read_file', 'read_file', 7, ''] }, null, 'x', { name: 3 }
  ] });
  assert.deepEqual(v, { enabled: true, categories: [{ name: 'Read', tools: ['read_file'] }, { name: '', tools: [] }] });
});

check('the view is active only when on and a category picks a tool', () => {
  assert.equal(isToolViewActive({ enabled: true, categories: [{ name: 'A', tools: [] }] }), false);
  assert.equal(isToolViewActive({ enabled: false, categories: [{ name: 'A', tools: ['shell'] }] }), false);
  assert.equal(isToolViewActive({ enabled: true, categories: [{ name: 'A', tools: ['shell'] }] }), true);
});

check('an inactive view returns the default groups untouched', () => {
  assert.equal(applyToolView(groups, { enabled: false, categories: [{ name: 'A', tools: ['shell'] }] }), groups);
});

check('categories regroup the same leaf objects, in the picked order', () => {
  const out = applyToolView(groups, { enabled: true, categories: [
    { name: 'Look', tools: ['mcp__git__git_log', 'read_file'] },
    { name: 'Run', tools: ['shell'] }
  ] });
  assert.deepEqual(out.map((g) => g.name), ['Look', 'Run']);
  assert.deepEqual(out[0].tools.map((t) => t.id), ['mcp__git__git_log', 'read_file']);
  assert.equal(out[0].tools[1], groups[1].tools[0]);
  assert.equal(out[1].tools[0].control, 'seg');
  assert.equal(out[0].checked, true);
  assert.equal(out[1].alwaysExpanded, true);
  assert.equal(out[0].alwaysExpanded, false);
});

check('a category is checked only when every tool in it is on', () => {
  const out = applyToolView(groups, { enabled: true, categories: [{ name: 'Files', tools: ['read_file', 'write_file'] }] });
  assert.equal(out[0].checked, false);
});

check('unknown tools are skipped and an empty category is not rendered', () => {
  const out = applyToolView(groups, { enabled: true, categories: [
    { name: 'Gone', tools: ['mcp__old__x'] },
    { name: '', tools: ['shell', 'nope'] }
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Category 2');
  assert.equal(out[0].id, 'view-1');
  assert.deepEqual(out[0].tools.map((t) => t.id), ['shell']);
});

check('toolViewStats counts pinned vs remaining active tools accurately', () => {
  const s = toolViewStats(groups, {
    enabled: true,
    categories: [
      { name: 'Read', tools: ['read_file', 'mcp__missing__nope'] },
      { name: 'Empty', tools: [] }
    ]
  });
  assert.equal(s.totalTools, 4);
  assert.equal(s.shownTools, 1);
  assert.equal(s.hiddenTools, 3);
  assert.equal(s.activeCategories, 1);
  assert.equal(s.totalCategories, 2);
});

check('toolViewSummary describes inactive, empty, and active views clearly', () => {
  assert.equal(toolViewSummary(null), 'All tools');
  assert.equal(toolViewSummary({ enabled: true, categories: [] }), 'No tools picked');
  assert.equal(
    toolViewSummary({ enabled: true, categories: [{ name: 'Read', tools: ['read_file', 'write_file'] }] }),
    'Simplified · 1 category (2)'
  );
  assert.equal(
    toolViewSummary({
      enabled: true,
      categories: [
        { name: 'Read', tools: ['read_file'] },
        { name: 'Run', tools: ['shell', 'read_file'] }
      ]
    }),
    'Simplified · 2 categories (2)'
  );
});

check('ToolViewEditor renders mode cards, presets, search filter, and live preview', () => {
  const editorSrc = fs.readFileSync(new URL('../frontend/src/components/settings/ToolViewEditor.jsx', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const states = [];
  let cursor = 0;
  let savedView = normalizeToolView({ enabled: true, categories: [] });
  const ctx = vm.createContext({
    h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (init) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (v) => { states[idx] = typeof v === 'function' ? v(states[idx]) : v; }];
    },
    ToolTree: 'ToolTree',
    sectionIcon: () => 'icon',
    MAX_CATEGORIES,
    MAX_NAME_LENGTH,
    TOOL_VIEW_PRESETS,
    applyToolView,
    isToolViewActive,
    toolViewStats
  });
  vm.runInContext(editorSrc, ctx);
  const render = () => {
    cursor = 0;
    return ctx.ToolViewEditor({
      view: savedView,
      groups,
      loading: false,
      status: 'saved',
      onChange: (next) => { savedView = normalizeToolView(next); }
    });
  };
  const find = (node, pred) => {
    if (!node || typeof node !== 'object') return null;
    if (pred(node)) return node;
    for (const child of (node.children || [])) {
      const m = find(child, pred);
      if (m) return m;
    }
    return null;
  };

  // Empty enabled view shows preset cards and pending banner
  let tree = render();
  const presetBtn = find(tree, (n) => n.props?.class === 'tve-preset-card');
  assert.ok(presetBtn, 'preset card renders when no tools are picked');
  presetBtn.props.onClick();
  assert.equal(savedView.enabled, true);
  assert.ok(savedView.categories.length > 0, 'clicking preset populates categories');

  // Re-render with populated categories: live preview and coverage stats appear
  tree = render();
  const preview = find(tree, (n) => n.props?.class?.includes('tve-preview-section'));
  assert.ok(preview, 'live chat preview section renders when simplified view is active');
  const primaryPill = find(tree, (n) => n.props?.class?.includes('tve-summary__pill--primary'));
  // The "Coding essentials" preset picks read_file, shell and nothing else the
  // fixture advertises (write_file and mcp__git__git_log stay unpinned).
  assert.ok(primaryPill && String(primaryPill.children[0]).includes('3 of 4 tools pinned in 3 categories'), 'coverage pill shows pinned vs total tools');

  // Open tool picker on category 0 and filter by query
  const pickBtn = find(tree, (n) => n.props?.class?.includes('tve-cat__pick'));
  pickBtn.props.onClick();
  tree = render();
  const searchInput = find(tree, (n) => n.props?.class?.includes('tve-picker-bar__input'));
  assert.ok(searchInput, 'tool picker search input renders when open');
  searchInput.props.onInput({ currentTarget: { value: 'git_log' } });
  tree = render();
  const pickerTree = find(tree, (n) => n.tag === 'ToolTree');
  assert.equal(pickerTree.props.groups.length, 1);
  assert.equal(pickerTree.props.groups[0].tools[0].id, 'mcp__git__git_log');
});

console.log(passed + ' passed');
