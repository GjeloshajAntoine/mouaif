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

function createView(project, catalog = []) {
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
    useEffect: (effect) => { effects.push(effect); },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url, init) => {
      if (init?.method === 'PUT') {
      requests.push(JSON.parse(init.body));
      return { status: 200, body: {} };
      }
      assert.equal(init?.method, undefined, 'render/load must not write settings');
      requests.push(url);
      const endpoint = new URL(url, 'http://fixture').pathname;
      const bodies = {
        '/api/settings/project': { project, path: projectDir + '/.mouaif.json' },
        '/api/settings/resolved': { resolved: {} },
        '/api/tools/authorization': { tools: {}, mcp: {} },
        '/api/tools/list': { tools: catalog },
        '/api/mcp/servers': { servers: [] },
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
const actionView = createView({}, [{ name: 'mouaif' }]);
actionView.render();
await actionView.load();
let tree = actionView.render().find((node) => typeof node.attrs.onToggleTool === 'function');
tree.attrs.onToggleTool('mouaif', 'mouaif:list', false);
tree = actionView.render().find((node) => typeof node.attrs.onToggleTool === 'function');
const actionRows = tree.attrs.groups.filter((g) => g.id.startsWith('mouaif'));
assert.equal(actionRows.flatMap((g) => g.tools).filter((t) => t.checked).length, 11, 'project checkbox only disables its action');
assert.equal(actionRows[0].tools[0].checked, false);
assert.equal(actionRows[1].checked, true, 'other category remains selected');
assert.ok(actionView.requests.some((request) => request.tools?.['mouaif:list']?.mode === 'off'), 'action mode is saved independently');

console.log('PASS project settings initial/loaded renders, independent action checkboxes, hidden-file counts, scoped links, sibling pages, agent links and Back targets');
