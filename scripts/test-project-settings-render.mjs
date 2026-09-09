// Render the real project settings component before and after loading.
// A Vite build cannot catch references to deleted state in render expressions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = (file) => fs.readFileSync(new URL('../frontend/src/components/' + file, import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const projectDir = '/fixture/project & name';
const from = 'settings/projects';

function createView(project) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [];
  const requests = [];
  const context = vm.createContext({
    URLSearchParams, TextEncoder, setTimeout, clearTimeout,
    activeProject: { value: { dir: '' } }, setActiveProject() {},
    Fragment: 'fragment', ToolTree: 'tool-tree', McpAuthSeg: 'mcp-auth',
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
        '/api/tools/list': { tools: [] },
        '/api/mcp/servers': { servers: [] },
        '/api/prompts': { prompts: [] },
        '/api/agents': { agents: [] }
      };
      assert.ok(endpoint in bodies, 'unexpected settings dependency: ' + endpoint);
      return { status: 200, body: bodies[endpoint] };
    }
  });
  vm.runInContext(source('settingsProjectUi.js'), context);
  vm.runInContext(source('SettingsProject.jsx'), context);
  function render(page = 'main') {
    cursor = 0; nodes = []; effects = [];
    context.SettingsProjectView({ projectDir, from, page });
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
  assert.equal(link.attrs.href, '#/settings/project/hide?projectDir=' + encodeURIComponent(projectDir) + '&from=' + encodeURIComponent(from));
  const detail = link.children.find(node => node.attrs?.class === 'group__row-detail');
  assert.equal(detail.children[0], summary);
  assert.equal(view.requests.some(url => url.includes('/hide-file-content')), false, 'summary reuses loaded project settings');
  for (const [page, title] of [['output', 'File tool options'], ['preview', 'Web preview'], ['technical', 'Technical details']]) {
    assert.ok(view.render(page).some(node => node.tag === 'h2' && node.children.includes(title)));
  }
}
console.log('PASS project settings initial/loaded renders, hidden-file counts, scoped links and all sibling pages');
