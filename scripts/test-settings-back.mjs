// Settings Back arrows and the drill-down context they carry.
//
// The bug this pins: the settings sub-pages used to compose their Back link
// and their outgoing links by hand (`projectQS(dir) + '&from=…'`), which
//
//   1. dropped the `&chatId=…` context at the first sub-page, so pressing
//      Back twice from a chat ended on the Settings root instead of the
//      chat, and
//   2. built `#/settings/mcp&from=…` whenever there was no projectDir,
//      which is not a route at all — the router silently fell back to the
//      chat list, so Back from the app-scoped pages landed on the Chats tab.
//
// The link builder is pure (`frontend/src/components/settings/projectNavigation.js`)
// and every settings page is driven through it, so this test exercises the
// helper directly AND renders the real components (imports stripped, the way
// scripts/test-project-settings-render.mjs does) to read the hrefs they emit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const readFront = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
// Strip imports (the harness supplies the names), including multi-line ones.
const strip = (text) => text
  .replace(/^import\s+[\s\S]*?from\s+'[^']*';?\s*$/gm, '')
  .replace(/^import\s+'[^']*';\s*$/gm, '')
  .replace(/^export /gm, '');
const load = (file) => import('data:text/javascript;base64,' + Buffer.from(readFront(file)).toString('base64'));

const { settingsLink, navTarget, backTarget, backHref, scopedParams } = await load('components/settings/projectNavigation.js');
const { parseHash } = await load('routes.js');
const { hiddenContentPath } = await load('components/settings/hiddenRanges.js');
const { agentBackPath, agentEditorPath } = await load('components/settings/agentNavigation.js');

const PROJECT = '/fixture/project & name';
const CHAT = 'chat-1';
const FROM = 'projects';

// ---- the pure builder ----------------------------------------------------

assert.equal(settingsLink('settings/project'), '#/settings/project', 'no context, no query');
assert.equal(
  settingsLink('settings/project', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
  '#/settings/project?projectDir=%2Ffixture%2Fproject%20%26%20name&chatId=chat-1&from=projects',
  'project + chat + origin'
);
assert.equal(settingsLink('settings/mcp', {}, { scope: 'app' }), '#/settings/mcp?scope=app', 'extra params survive an empty context');
assert.equal(settingsLink('settings/mcp', { from: FROM }, { scope: 'app' }), '#/settings/mcp?scope=app&from=projects',
  'the app-scoped link is a real route (the old builder emitted #/settings/mcp&from=…)');
assert.equal(navTarget('settings/mcp', { projectDir: '/p' }), 'settings/mcp?projectDir=%2Fp', 'navTarget drops the #/ for nav()');
assert.deepEqual([...scopedParams({ projectDir: '', chatId: '', from: '' }).keys()], [], 'blank values are dropped, not emitted');

// Every link the pages can build has to resolve to a real route — the old
// malformed `#/settings/mcp&from=…` resolved to the chat list.
for (const href of [
  settingsLink('settings/project', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
  settingsLink('settings/project/output', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
  settingsLink('settings/project/preview', { projectDir: PROJECT }),
  settingsLink('settings/project/hide', { projectDir: PROJECT, chatId: CHAT }, { file: 'src/a.js' }),
  settingsLink('settings/mcp', { from: FROM }, { scope: 'app' }),
  settingsLink('settings/mcp', { projectDir: PROJECT, chatId: CHAT }, { scope: 'project' }),
  settingsLink('settings/mcp/new', { projectDir: PROJECT, chatId: CHAT, from: FROM }, { scope: 'project' }),
  settingsLink('settings/mcp/registry', { projectDir: PROJECT, chatId: CHAT }),
  settingsLink('settings/actions', { from: FROM }, { scope: 'app' }),
  settingsLink('settings/actions/lint', { projectDir: PROJECT, chatId: CHAT, from: FROM }, { scope: 'project' }),
  settingsLink('settings/prompts', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
  settingsLink('settings/agents', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
  settingsLink('settings/tags', { projectDir: PROJECT, from: FROM }),
  '#/' + hiddenContentPath({ projectDir: PROJECT, chatId: CHAT, from: FROM, filePath: 'src/a.js' }),
  '#/' + agentEditorPath('reviewer', { projectDir: PROJECT, chatId: CHAT, from: FROM, returnTo: 'project' }),
  '#/' + agentBackPath({ projectDir: PROJECT, chatId: CHAT, from: FROM, returnTo: 'project' })
]) {
  const route = parseHash(href);
  assert.notEqual(route.name, 'chats', href + ' must be a known settings route, not the chat-list fallback');
}

// ---- the Back chain ------------------------------------------------------

assert.deepEqual(backTarget({ projectDir: PROJECT, chatId: CHAT, from: FROM }),
  { path: 'chat/' + CHAT + '?projectDir=' + encodeURIComponent(PROJECT), label: 'Back to chat' },
  'a chat in context wins');
assert.deepEqual(backTarget({ projectDir: PROJECT, from: FROM }),
  { path: 'settings/project?projectDir=%2Ffixture%2Fproject%20%26%20name&from=projects', label: 'Back to project settings' },
  'no chat: project settings, keeping the origin');
assert.deepEqual(backTarget({ from: 'projects' }), { path: 'projects', label: 'Back to projects' }, 'the project list origin');
assert.deepEqual(backTarget({ from: 'settings/projects' }), { path: 'settings/projects', label: 'Back to project list' });
assert.deepEqual(backTarget({}), { path: 'settings', label: 'Back to settings' }, 'nothing in context');
assert.deepEqual(backTarget({ returnTo: 'project' }),
  { path: 'settings/project', label: 'Back to project settings' },
  'the agent editor reached from the project page goes back to it even without a dir');
assert.equal(backHref({ projectDir: '/p' }), '#/settings/project?projectDir=%2Fp');

// ---- the rendered pages --------------------------------------------------

// A tiny hook harness: effects are collected and run on demand, and every
// render starts from slot 0 so state survives across renders like React.
function harness(globals) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [];
  const context = vm.createContext({
    URLSearchParams, TextEncoder, setTimeout, clearTimeout,
    window: {}, document: {},
    nav() {},
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (effect) => { effects.push(effect); },
    useRef: (value) => { const i = cursor++; if (first) states[i] = { current: value }; return states[i]; },
    useMemo: (fn) => fn(),
    ...globals
  });
  return {
    context,
    evalFile(file) { vm.runInContext(strip(readFront(file)), context, { filename: file }); },
    // `fresh` starts a new component instance (its own hook slots); plain
    // renders re-render the one already mounted, like React.
    renderView(name, props, { fresh = false } = {}) {
      cursor = 0; nodes = []; effects = [];
      if (fresh) { first = true; states.length = 0; }
      const out = context[name](props);
      first = false;
      return { out, nodes, runEffects: () => effects.forEach((effect) => effect()) };
    }
  };
}

// --- project sub-pages (SettingsProject) ---------------------------------

{
  const h = harness({
    activeProject: { value: { dir: '' } }, setActiveProject() {},
    Fragment: 'fragment', ToolTree: 'tree', McpAuthSeg: 'seg', ToolAuthSeg: 'seg',
    TOOL_MODE_CHOICES: [], ASK_USER_MODE_CHOICES: [], segMode: (m) => m,
    AgentFilePicker: 'picker', WebpreviewModal: 'modal', PreviewUrlPrompt: 'prompt',
    projectsReload: { value: 0 }, getProjectStorage() {}, setProjectStorage() {}, requestWebpreview() {},
    sectionIcon: () => null, toolModeSegs: () => [], shortDesc: () => '',
    fetchJson: async () => ({ status: 200, body: {} })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/settings/hiddenRanges.js');
  h.evalFile('components/settings/agentNavigation.js');
  h.evalFile('components/settingsProjectUi.js');
  h.evalFile('components/SettingsProject.jsx');
  const context = { projectDir: PROJECT, chatId: CHAT, from: FROM };
  const expectedBack = settingsLink('settings/project', context);
  for (const [page, title] of [['output', 'File tool options'], ['preview', 'Web preview'], ['technical', 'Technical details']]) {
    const { nodes } = h.renderView('SettingsProjectView', { ...context, page }, { fresh: true });
    assert.ok(nodes.some((n) => n.tag === 'h2' && n.children.includes(title)), page + ' renders');
    const back = nodes.find((n) => n.attrs.class === 'view-back');
    assert.equal(back.attrs.href, expectedBack, page + ' Back keeps projectDir + chatId + from');
    assert.equal(back.attrs['aria-label'], 'Back to project settings');
  }
  const { nodes } = h.renderView('SettingsProjectView', { ...context, page: 'main' }, { fresh: true });
  const back = nodes.find((n) => n.attrs.class === 'view-back');
  assert.equal(back.attrs.href, '#/chat/' + CHAT + '?projectDir=' + encodeURIComponent(PROJECT), 'the project page returns to its chat');
  assert.equal(back.attrs['aria-label'], 'Back to chat');
  // The Hide file content row forwards the same context.
  const row = nodes.find((n) => n.attrs['aria-label'] === 'Hide file content');
  assert.equal(row.attrs.href, settingsLink('settings/project/hide', context));
}

// --- hide file content list ----------------------------------------------

{
  const h = harness({
    activeProject: { value: { dir: '' } }, nav() {},
    Fragment: 'fragment', AgentFilePicker: 'picker', HiddenContentEditor: 'editor',
    AbortController,
    fetchJson: async () => ({ status: 200, body: { rules: [] } })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/settings/hiddenRanges.js');
  h.evalFile('components/SettingsHiddenContent.jsx');
  const props = { projectDir: PROJECT, chatId: CHAT, from: FROM, filePath: '' };
  const { nodes } = h.renderView('SettingsHiddenContentView', props);
  const back = nodes.find((n) => n.attrs.class === 'view-back');
  assert.equal(back.attrs.href, settingsLink('settings/project', props), 'hide list Back keeps the chat');
  // The row link into the per-file editor keeps it too.
  const link = nodes.find((n) => n.tag === 'a' && String(n.attrs.href || '').includes('&file='));
  if (link) {
    assert.ok(link.attrs.href.includes('chatId=' + CHAT), 'per-file link keeps the chat: ' + link.attrs.href);
  }
}

// --- MCP list (both scopes) ----------------------------------------------

{
  const h = harness({
    activeProject: { value: { dir: '' } }, setActiveProject() {}, nav() {},
    Fragment: 'fragment', McpErrorModal: 'modal',
    fetchJson: async () => ({ status: 200, body: { servers: [] } })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/SettingsMcp.jsx');
  const project = h.renderView('SettingsMcpView', { projectDir: PROJECT, chatId: CHAT, from: FROM });
  const projectBack = project.nodes.find((n) => n.attrs.class === 'view-back');
  assert.equal(projectBack.attrs.href, settingsLink('settings/project', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
    'project MCP list Back goes to project settings with the chat');
  // The app-wide list (no projectDir) is the App-defaults sibling: Back is
  // the Settings root, never a project page.
  const app = h.renderView('SettingsMcpView', {}, { fresh: true });
  assert.equal(app.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/settings',
    'app MCP list Back is the Settings root');
}

// --- custom actions (list + editor) --------------------------------------

{
  const h = harness({
    nav() {}, Fragment: 'fragment',
    fetchJson: async () => ({ status: 200, body: { actions: [], servers: [] } })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/settings/actionSchema.js');
  h.evalFile('components/SettingsActions.jsx');
  const projectList = h.renderView('SettingsActionsView', { projectDir: PROJECT, chatId: CHAT, from: FROM, scope: 'project' }, { fresh: true });
  assert.equal(projectList.nodes.find((n) => n.attrs.class === 'view-back').attrs.href,
    settingsLink('settings/actions', { projectDir: PROJECT, chatId: CHAT, from: FROM }, { scope: 'project' }));
  const appList = h.renderView('SettingsActionsView', { from: FROM, scope: 'app' }, { fresh: true });
  assert.equal(appList.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/settings/actions?scope=app&from=projects',
    'the app-scoped actions list links projectDir-less — the old builder emitted #/settings/project&from=…');
  const editor = h.renderView('SettingsActionEditView', { id: 'lint', projectDir: PROJECT, chatId: CHAT, from: FROM, scope: 'project' }, { fresh: true });
  assert.equal(editor.nodes.find((n) => n.attrs.class === 'view-back').attrs.href,
    settingsLink('settings/actions', { projectDir: PROJECT, chatId: CHAT, from: FROM }, { scope: 'project' }));
}

// --- agents (list + editor) ----------------------------------------------

{
  const h = harness({
    nav() {}, Fragment: 'fragment', ToolTree: 'tree',
    activeProject: { value: { dir: '' } },
    AgentFilePicker: 'picker', ModelPickerField: 'model', ThinkingSelectField: 'thinking',
    fetchJson: async () => ({ status: 200, body: { agents: [], servers: [], tools: [], prompts: [] } })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/settings/agentNavigation.js');
  h.evalFile('components/settings/agentAutosave.js');
  h.evalFile('components/ToolTree.jsx');
  h.evalFile('components/SettingsAgents.jsx');
  const list = h.renderView('SettingsAgentsView', { projectDir: PROJECT, chatId: CHAT, from: FROM }, { fresh: true });
  assert.equal(list.nodes.find((n) => n.attrs.class === 'view-back').attrs.href,
    backHref({ projectDir: PROJECT, chatId: CHAT, from: FROM }),
    'the agents list follows the shared chain (chat first)');
  // The editor opened from the project's Agents row goes back to project
  // settings (its immediate caller), not straight to the chat.
  const editor = h.renderView('SettingsAgentEditView', { id: 'reviewer', projectDir: PROJECT, chatId: CHAT, from: FROM, returnTo: 'project' }, { fresh: true });
  assert.equal(editor.nodes.find((n) => n.attrs.class === 'view-back').attrs.href,
    backHref({ projectDir: PROJECT, chatId: CHAT, from: FROM, returnTo: 'project' }));
}

// --- custom prompts (both scopes) ----------------------------------------

{
  const h = harness({
    nav() {}, Fragment: 'fragment', ToolTree: 'tree', PromptIcon: 'icon',
    PROMPT_ICONS: [], buildToolGroups: () => [], presetToolSelection: () => null, applyToolToggle: (s) => s,
    PROFILE_PREFIX: 'profile:',
    readLaunchers: () => ({}), launcherSource: () => '', effectiveLauncher: (l) => l || {}, withLauncher: (l) => l,
    activeProject: { value: { dir: '' } },
    fetchJson: async () => ({ status: 200, body: { prompts: [], profiles: [] } })
  });
  h.evalFile('components/settings/projectNavigation.js');
  h.evalFile('components/settings/presetTools.js');
  h.evalFile('components/settings/profileLaunchers.js');
  h.evalFile('components/SettingsPrompts.jsx');
  const project = h.renderView('SettingsPromptsView', { scope: 'project', projectDir: PROJECT, chatId: CHAT, from: FROM }, { fresh: true });
  assert.equal(project.nodes.find((n) => n.attrs.class === 'view-back').attrs.href,
    settingsLink('settings/project', { projectDir: PROJECT, chatId: CHAT, from: FROM }),
    'project prompts Back goes to project settings');
  // The App-defaults scope must never adopt the active project: its Back is
  // the Settings root even when a project is active.
  const app = h.renderView('SettingsPromptsView', { scope: 'app' }, { fresh: true });
  assert.equal(app.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/settings',
    'app-defaults prompts Back is the Settings root');
}

// --- file tags ------------------------------------------------------------

{
  const h = harness({ Fragment: 'fragment', createVirtualList: () => ({ destroy() {} }), render() {}, fetchJson: async () => ({ status: 200, body: {} }) });
  h.evalFile('components/SettingsTags.jsx');
  const fromProject = h.renderView('SettingsTagsView', { projectDir: PROJECT, from: 'settings/projects' }, { fresh: true });
  assert.equal(fromProject.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/settings/projects',
    'File tags from Settings → Projects returns to that list, not the legacy #/projects');
  const fromProjects = h.renderView('SettingsTagsView', { projectDir: PROJECT, from: 'projects' }, { fresh: true });
  assert.equal(fromProjects.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/projects');
  const bare = h.renderView('SettingsTagsView', { projectDir: PROJECT }, { fresh: true });
  assert.equal(bare.nodes.find((n) => n.attrs.class === 'view-back').attrs.href, '#/settings');
}

console.log('PASS settings Back arrows keep projectDir/chatId/from and every link resolves to a real route');
