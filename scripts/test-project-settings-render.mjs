// Render the real project settings component before and after loading.
// A Vite build cannot catch references to deleted state in render expressions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = (file) => fs.readFileSync(new URL('../frontend/src/components/' + file, import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const projectDir = '/fixture/project & name';
const from = 'settings/projects';
const chatId = 'chat-1';

function createView(project, toolCatalog = []) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [];
  const requests = [];
  const context = vm.createContext({
    URLSearchParams, TextEncoder, setTimeout, clearTimeout,
    activeProject: { value: { dir: '' } }, setActiveProject() {},
    Fragment: 'fragment', ToolTree: 'tool-tree', McpAuthSeg: 'mcp-auth',
// The shared per-tool authorization control and its helpers. The
// component files are evaluated with their imports stripped, so the
// names they reference have to exist on the context.
ToolAuthSeg: 'auth-seg', TOOL_MODE_CHOICES: [{ value: 'off', label: 'Off' }],
ASK_USER_MODE_CHOICES: [{ value: 'off', label: 'Off' }],
segMode: (mode) => (mode === 'allowlist' ? 'ask' : mode),
shortDesc: (text) => String(text || '').replace(/\s+/g, ' ').trim(),
    AgentFilePicker: 'file-picker', WebpreviewModal: 'preview-modal', PreviewUrlPrompt: 'preview-prompt',
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (effect) => { effects.push(effect); },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url, init) => {
      assert.equal(init?.method, undefined, 'render/load must not write settings');
      requests.push(url);
      const endpoint = new URL(url, 'http://fixture').pathname;
      const bodies = {
        '/api/settings/project': { project, path: projectDir + '/.mouaif.json' },
        '/api/settings/resolved': { resolved: {} },
        '/api/tools/authorization': { tools: {}, mcp: {} },
        '/api/tools/list': { tools: toolCatalog },
        '/api/mcp/servers': { servers: [] },
        '/api/prompts': { prompts: [] },
        '/api/agents': { agents: [] }
      };
      assert.ok(endpoint in bodies, 'unexpected settings dependency: ' + endpoint);
      return { status: 200, body: bodies[endpoint] };
    }
  });
  const PROJECT_NAV = source('settings/projectNavigation.js');
  const FILE_GROUPS = source('settings/fileToolGroups.js');
  vm.runInContext(PROJECT_NAV, context);
  vm.runInContext(FILE_GROUPS, context);
  vm.runInContext(source('settingsProjectUi.js'), context);
  vm.runInContext(source('SettingsProject.jsx'), context);
  function render(page = 'main') {
    cursor = 0; nodes = []; effects = [];
    context.SettingsProjectView({ projectDir, chatId, from, page });
    first = false;
    return nodes;
  }
  async function load() {
    effects.forEach(effect => effect());
    for (let i = 0; i < 30; i++) {
      if (states.some(state => state?.text === 'loaded')) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Project settings failed to load');
  }
  return { render, load, requests };
}

for (const [project, summary] of [
  [{}, ''], [{ hideFileContent: null }, ''], [{ hideFileContent: {} }, ''],
  [{ hideFileContent: [] }, ''],
  [{ hideFileContent: [{ path: 'a.txt', ranges: [{ start: 1, end: 1 }] }] }, '1 file'],
  [{ hideFileContent: [{ path: 'a.txt', ranges: [{ start: 1, end: 1 }] }, { path: 'b.txt', ranges: [{ start: 2, end: 3 }] }] }, '2 files']
]) {
  const view = createView(project);
  const before = view.render();
  assert.ok(before.some(node => node.tag === 'h2' && node.children.includes('Project settings')));
  await view.load();
  const after = view.render();
  const link = after.find(node => node.attrs['aria-label'] === 'Hide file content');
  assert.ok(link, 'parent page includes hidden-content navigation');
  // The drill-down keeps the chat and the origin it was opened from, so a
  // round-trip through a sub-page can return to the chat/chat list instead
  // of degrading to the Settings root.
  assert.equal(link.attrs.href, '#/settings/project/hide?projectDir=' + encodeURIComponent(projectDir)
    + '&chatId=' + encodeURIComponent(chatId) + '&from=' + encodeURIComponent(from));
  const detail = link.children.find(node => node.attrs?.class === 'group__row-detail');
  assert.equal(detail.children[0], summary);
  assert.equal(view.requests.some(url => url.includes('/hide-file-content')), false, 'summary reuses loaded project settings');
  for (const [page, title] of [['output', 'File tool options'], ['preview', 'Web preview'], ['technical', 'Technical details']]) {
    const nodes = view.render(page);
    assert.ok(nodes.some(node => node.tag === 'h2' && node.children.includes(title)));
    // Every sub-page's Back arrow returns to project settings, carrying the
    // chat and origin with it.
    const back = nodes.find(node => node.attrs.class === 'view-back');
    assert.equal(back.attrs.href, '#/settings/project?projectDir=' + encodeURIComponent(projectDir)
      + '&chatId=' + encodeURIComponent(chatId) + '&from=' + encodeURIComponent(from), page + ' back link');
    assert.equal(back.attrs['aria-label'], 'Back to project settings');
  }
  // With a chat in context the project page's own Back arrow returns to it.
  const mainBack = view.render().find(node => node.attrs.class === 'view-back');
  assert.equal(mainBack.attrs['aria-label'], 'Back to chat');
  assert.equal(mainBack.attrs.href, '#/chat/' + chatId + '?projectDir=' + encodeURIComponent(projectDir));
}
console.log('PASS project settings initial/loaded renders, hidden-file counts, scoped links, sibling pages and Back targets');

// ---- Read tools / Edit tools rows over one family ----------------------
//
// With a file-tool catalog present, the Tools tree must render TWO rows
// instead of the old single "File tools" group, and both segments must
// target the shared `tools.file` family. The ToolTree component is stubbed
// to the string 'tool-tree', so its `groups` prop is inspectable.
{
  const catalog = [
    { name: 'read_file', kind: 'native', source: 'files', description: 'Read a text file.' },
    { name: 'list_files', kind: 'native', source: 'files', description: 'List files under the project.' },
    { name: 'search_files', kind: 'native', source: 'files', description: 'Search project files.' },
    { name: 'write_file', kind: 'native', source: 'files', description: 'Create or overwrite a file.' },
    { name: 'edit_file', kind: 'native', source: 'files', description: 'Replace one block in a file.' }
  ];
  const view = createView({ tools: { file: { mode: 'ask' } } }, catalog);
  view.render();
  await view.load();
  const nodes = view.render();
  const tree = nodes.find((node) => node.tag === 'tool-tree');
  assert.ok(tree, 'tools tree is rendered');
  const groups = tree.attrs.groups;
  const read = groups.find((g) => g.id === 'files-read');
  const edit = groups.find((g) => g.id === 'files-edit');
  assert.ok(read, 'Read tools group exists');
  assert.ok(edit, 'Edit tools group exists');
  assert.equal(read.name, 'Read tools');
  assert.equal(edit.name, 'Edit tools');
  assert.deepEqual(JSON.parse(JSON.stringify(read.tools.map((t) => t.id))), ['read_file', 'list_files', 'search_files']);
  assert.deepEqual(JSON.parse(JSON.stringify(edit.tools.map((t) => t.id))), ['write_file', 'edit_file']);
  assert.equal(groups.some((g) => g.id === 'files'), false, 'the old single File tools group is gone');
  // With the family on `ask`, both rows start checked and their segments
  // point at the same family control.
  assert.equal(read.checked, true);
  assert.equal(edit.checked, true);
  assert.equal(read.control.attrs.name, 'Read tools');
  assert.equal(edit.control.attrs.name, 'Edit tools');
  // The two segments must not share a radio group.
  assert.notEqual(read.control.attrs.tool, edit.control.attrs.tool);
}
console.log('PASS Read tools and Edit tools render as two rows over the shared file family');
