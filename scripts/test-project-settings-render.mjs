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

function createView(project, catalog = [], { saveStatus = 200, saveError = '', authorization = { tools: {}, mcp: {} }, servers = [] } = {}) {
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
    AgentFilePicker: 'file-picker', WebpreviewModal: 'preview-modal', PreviewUrlPrompt: 'preview-prompt',
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useRef: (initial) => {
    const i = cursor++;
    if (first) states[i] = { current: initial };
    return states[i];
    },
    useEffect: (effect) => { effects.push(effect); },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url, init) => {
      if (init?.method === 'PUT') {
      const patch = JSON.parse(init.body);
      requests.push(patch);
      if (saveError) throw new Error(saveError);
      if (saveStatus !== 200) return { status: saveStatus, body: {} };
      if (url === '/api/tools/authorization') {
      Object.assign(authorization.tools, patch.tools);
      for (const key of ['servers', 'tools']) {
      for (const [name, entry] of Object.entries(patch.mcp?.[key] || {})) {
        authorization.mcp[key] ||= {};
        if (entry == null) delete authorization.mcp[key][name];
        else authorization.mcp[key][name] = entry;
      }
      }
      return { status: 200, body: authorization };
      }
      const { projectDir: scope, unset = [], ...values } = patch;
      assert.equal(scope, projectDir);
      project = { ...project, ...values };
      for (const key of unset) delete project[key];
      return { status: 200, body: { project } };
      }
      assert.equal(init?.method, undefined, 'render/load must not write settings');
      requests.push(url);
      const endpoint = new URL(url, 'http://fixture').pathname;
      const bodies = {
        '/api/settings/project': { project, path: projectDir + '/.mouaif.json' },
        '/api/settings/resolved': { resolved: { toolOutput: project.toolOutput } },
        '/api/tools/authorization': authorization,
        '/api/tools/list': { tools: catalog },
        '/api/mcp/servers': { servers },
        '/api/prompts': { prompts: [] },
        '/api/agents': { agents: [{ name: 'Search', modelId: '' }] }
      };
      assert.ok(endpoint in bodies, 'unexpected settings dependency: ' + endpoint);
      return { status: 200, body: bodies[endpoint] };
    }
  });
  const PROJECT_NAV = source('settings/projectNavigation.js');
  vm.runInContext(PROJECT_NAV, context);
  const AGENT_NAV = source('settings/agentNavigation.js');
  vm.runInContext(AGENT_NAV, context);
  vm.runInContext(source('ToolTree.jsx'), context);
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
  return { render, load, requests, agentEditorPath: context.agentEditorPath, agentBackPath: context.agentBackPath, agentQuery: context.agentQuery };
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

  // The Agents card links into the agent editor. Those hrefs go through the
  // shared `agentEditorPath`, which the render above evaluates — asserting the
  // value is what stops the helper from being swapped for a hand-built string
  // (the links carry `returnTo=project`, so the editor's Back comes here).
  const agents = after;
  const agentScope = { projectDir, chatId, from, returnTo: 'project' };
  const defaultLink = agents.find(node => node.attrs.href === '#/' + view.agentEditorPath('_default', agentScope));
  assert.ok(defaultLink, 'the default-subagent link uses the shared path helper');
  const namedLink = agents.find(node => node.attrs.href === '#/' + view.agentEditorPath('Search', agentScope));
  assert.ok(namedLink, 'a named agent link uses the shared path helper');
  // The editor must be told how to come back, or its Back degrades to the
  // Settings root instead of this page. `agentBackPath` drops `returnTo` from
  // the query it re-emits (the path itself is the answer to "where to").
  assert.equal(view.agentBackPath(agentScope), 'settings/project?' + view.agentQuery(Object.assign({}, agentScope, { returnTo: '' })), 'the agent editor returns to project settings');
}
const actionView = createView({}, [
  { name: 'list_chats', kind: 'native', source: 'chats' },
  { name: 'delete_chat', kind: 'native', source: 'chats' },
  { name: 'get_settings', kind: 'native', source: 'mouaif' }
]);
actionView.render();
await actionView.load();
let tree = actionView.render().find((node) => typeof node.attrs.onToggleTool === 'function');
tree.attrs.onToggleTool('chats', 'list_chats', false);
await new Promise(resolve => setImmediate(resolve));
tree = actionView.render().find((node) => typeof node.attrs.onToggleTool === 'function');
const actionRows = tree.attrs.groups.filter((g) => ['chats', 'mouaif-settings'].includes(g.id));
assert.equal(actionRows.flatMap((g) => g.tools).filter((t) => t.checked).length, 2, 'project checkbox only disables its tool');
assert.equal(actionRows[0].tools[0].checked, false);
assert.equal(actionRows[1].checked, true, 'other category remains selected');
assert.ok(actionView.requests.some((request) => request.tools?.list_chats?.mode === 'off'), 'action mode is saved independently');

const rawView = createView({ promptSize: 'extensive', name: 'keep me', tools: { shell: { mode: 'ask' } } });
rawView.render(); await rawView.load();
for (const edited of [{ name: 'keep me' }, {}]) {
  rawView.render('technical').find((n) => n.attrs.id === 'sp-project-editor').attrs.onInput({ target: { value: JSON.stringify(edited) } });
  await rawView.render('technical').find((n) => n.tag === 'button' && n.children.includes('Save file')).attrs.onClick();
  assert.deepEqual(JSON.parse(rawView.render('technical').find((n) => n.attrs.id === 'sp-project-editor').attrs.value), edited, 'removed raw keys stay removed after reload');
}
assert.deepEqual(rawView.requests.filter((r) => r.unset).map((r) => r.unset), [['promptSize', 'tools'], ['name']]);
for (const failure of [{ saveStatus: 503 }, { saveError: 'network unavailable' }]) {
  const view = createView({ name: 'original' }, [], failure);
  view.render(); await view.load();
  view.render('technical').find((n) => n.attrs.id === 'sp-project-editor').attrs.onInput({ target: { value: '{}' } });
  await view.render('technical').find((n) => n.tag === 'button' && n.children.includes('Save file')).attrs.onClick();
  assert.equal(view.render('technical').find((n) => n.tag === 'button' && n.children.includes('Save file')).attrs.disabled, false, 'failed raw saves can be retried');
  assert.equal(view.render('technical').find((n) => n.attrs.id === 'sp-project-editor').attrs.value, '{}', 'failure keeps editor contents');
}

const outputView = createView({ toolOutput: { size: 'full', structure: 'json' } });
outputView.render(); await outputView.load();
const outputControl = (view, id) => view.render('output').find((n) => n.attrs.id === id);
assert.equal(outputControl(outputView, 'sp-output-size').attrs.value, 'full', 'stored sizes remain selected');
assert.equal(outputControl(outputView, 'sp-output-size').children[0].length, 4, 'all backend sizes are available');
for (const size of ['very-small', 'average', 'full', 'extensive']) {
  await outputControl(outputView, 'sp-output-size').attrs.onChange({ target: { value: size } });
  assert.deepEqual(outputView.requests.filter((r) => r.toolOutput).at(-1).toolOutput, { size, structure: 'json' }, 'size edits preserve layout');
  assert.equal(outputControl(outputView, 'sp-output-size').attrs.value, size);
}
await outputControl(outputView, 'sp-output-structure').attrs.onChange({ target: { value: 'tree' } });
assert.deepEqual(outputView.requests.filter((r) => r.toolOutput).at(-1).toolOutput, { size: 'extensive', structure: 'tree' }, 'layout edits preserve size');
for (const failure of [{ saveStatus: 503 }, { saveError: 'network unavailable' }]) {
  const view = createView({ toolOutput: { size: 'full', structure: 'json' } }, [], failure);
  view.render(); await view.load();
  await outputControl(view, 'sp-output-size').attrs.onChange({ target: { value: 'average' } });
  assert.equal(outputControl(view, 'sp-output-size').attrs.value, 'full', 'failed output saves preserve size');
  assert.equal(outputControl(view, 'sp-output-structure').attrs.value, 'json');
  assert.equal(outputControl(view, 'sp-output-size').attrs.disabled, false, 'output saves remain retryable');
}

const permissionCatalog = [
  { name: 'shell', kind: 'native', source: 'shell' },
  { name: 'read_file', kind: 'native', source: 'files' },
  { name: 'write_file', kind: 'native', source: 'files' },
  { name: 'ask_user', kind: 'native' },
  { name: 'list_chats', kind: 'native', source: 'chats' },
  { name: 'mcp__fixture__read', kind: 'mcp', source: 'fixture' }
];
const treeFor = (view) => view.render().find((node) => typeof node.attrs.onToggleTool === 'function');
for (const failure of [{ saveStatus: 503 }, { saveError: 'network unavailable' }]) {
  const view = createView({}, permissionCatalog, { ...failure, servers: [{ id: 'fixture', slug: 'fixture' }] });
  view.render(); await view.load();
  for (const [groupId, toolId] of [['shell', 'shell'], ['files', 'read_file'], ['chats', 'list_chats'], ['ask_user', 'ask_user'], ['mcp-fixture', 'mcp__fixture__read']]) {
    treeFor(view).attrs.onToggleTool(groupId, toolId, false);
    await new Promise(resolve => setImmediate(resolve));
    const group = treeFor(view).attrs.groups.find((g) => g.id === groupId);
    assert.equal(group.tools.find((t) => t.id === toolId).checked, true, 'failed leaf save preserves ' + toolId);
    assert.ok(group.extra?.children[0].includes(failure.saveError || 'HTTP 503'), 'failed save is visible for ' + toolId);
  }
  for (const groupId of ['shell', 'files', 'chats', 'ask_user', 'mcp-fixture']) {
    treeFor(view).attrs.onToggleGroup(groupId, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(treeFor(view).attrs.groups.find((g) => g.id === groupId).checked, true, 'failed group save preserves ' + groupId);
  }
}
const queued = createView({}, permissionCatalog);
queued.render(); await queued.load();
let queuedTree = treeFor(queued);
queuedTree.attrs.onToggleGroup('shell', false);
queuedTree.attrs.onToggleGroup('shell', true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(treeFor(queued).attrs.groups.find((g) => g.id === 'shell').checked, true, 'rapid saves finish in tap order');
assert.deepEqual(queued.requests.filter((r) => r.tools?.shell).map((r) => r.tools.shell.mode), ['off', 'ask']);

console.log('PASS project settings renders, confirmed permission saves, failure recovery, scoped links and Back targets');
