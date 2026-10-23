import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { saveSkillSelection, skillStateFromResponse } from '../frontend/src/components/chat/skillState.js';

const initial = () => ({ enabled: true, projectLocked: false, items: [
  { id: 'one', name: 'one' }, { id: 'two', name: 'two' }, { id: 'locked', disabled: true }
] });
const source = fs.readFileSync('frontend/src/components/chat/cards.js', 'utf8')
  .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ saveSkillSelection, Promise, Set, Object, Array, console });
vm.runInContext(source + ';globalThis.toggleSkill = toggleSkill; globalThis.toggleSkills = toggleSkills;', context);
const refs = { skillsCard: { current: null } };
const state = () => ({ props: { projectDir: '/project', chatId: 'one' }, skills: initial() });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

{
  const s = state(); let renders = 0; let patch;
  s._onSkillsChanged = () => renders++;
  await context.toggleSkill('one', false, s, refs, async (p) => { patch = p; return true; });
  assert.deepEqual(Array.from(patch.disabledSkills), ['one']);
  assert.equal(s.skills.items[1].chatDisabled, false);
  assert.equal(renders, 1);
  assert.equal(s._skillSavePending, false);
  assert.equal(await context.toggleSkill('locked', true, s, refs, () => assert.fail('locked save')), false);
  assert.equal(await context.toggleSkill('missing', true, s, refs, () => assert.fail('unknown save')), false);
}
{
  const s = state(); const before = s.skills; let renders = 0;
  s._onSkillsChanged = () => renders++;
  assert.equal(await context.toggleSkill('one', false, s, refs, async () => false), false);
  assert.equal(s.skills, before);
  assert.equal(renders, 2, 'optimistic update and rollback both rerender Preact');
  let error;
  s._onSkillSaveError = (message) => { error = message; };
  assert.equal(await context.toggleSkills(false, s, refs, async () => { throw Error('offline'); }), false);
  assert.equal(s.skills, before);
  assert.match(error, /Could not save/);
}
{
  const s = state(); const first = defer(); const second = defer(); const patches = [];
  const update = (patch) => { patches.push(patch); return patches.length === 1 ? first.promise : second.promise; };
  const a = context.toggleSkill('one', false, s, refs, update);
  await Promise.resolve();
  const b = context.toggleSkill('two', false, s, refs, update);
  assert.equal(patches.length, 1, 'second PATCH waits for first');
  first.resolve(true); await a; await Promise.resolve();
  assert.equal(patches.length, 2);
  assert.deepEqual(Array.from(patches[1].disabledSkills), ['one', 'two']);
  second.resolve(false); await b;
  assert.equal(s.skills.items[0].chatDisabled, true);
  assert.equal(s.skills.items[1].chatDisabled, false, 'failed second save rolls back to acknowledged first choice');
}
{
  const s = state(); const before = s.skills; const first = defer();
  const a = context.toggleSkill('one', false, s, refs, () => first.promise);
  const b = context.toggleSkill('two', false, s, refs, async () => false);
  first.resolve(false); await Promise.all([a, b]);
  assert.equal(s.skills, before, 'two failed saves restore original state');
}
{
  const s = state(); const pending = defer(); let refreshes = 0;
  const save = context.toggleSkill('one', false, s, refs, () => pending.promise, () => refreshes++);
  s.props = { projectDir: '/project', chatId: 'other' }; const other = initial(); s.skills = other;
  pending.resolve(false); await save;
  assert.equal(s.skills, other);
  assert.equal(refreshes, 0, 'old chat save cannot refresh new chat');
}
{
  const body = { projectSkills: true, skillsEnabled: false, skills: initial().items };
  assert.equal(skillStateFromResponse(body, { skills: true }).enabled, false, 'server preset wins');
  assert.equal(skillStateFromResponse({ ...body, projectSkills: false, skillsEnabled: true }).enabled, false);
  const metaSource = fs.readFileSync('frontend/src/components/chat/meta.js', 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '').replace(/^export /gm, '');
  let rendered = 0; let pending = null; let response = { status: 200, body };
  const metaContext = vm.createContext({
    fetchJson: async () => pending ? pending.promise : response,
    skillStateFromResponse, updateSkillsCard: () => rendered++, renderSystemPromptMessage() {}, setChatStatus() {}, encodeURIComponent
  });
  vm.runInContext(metaSource + ';globalThis.refresh = refreshSystemPrompt;', metaContext);
  const s = state(); s.chat = { skills: true }; s._onSkillsChanged = () => rendered++;
  await metaContext.refresh(s, refs);
  assert.equal(s.skills.enabled, false);
  assert.equal(rendered, 2, 'refresh updates transcript and popup');
  pending = defer(); const before = s.skills;
  const refresh = metaContext.refresh(s, refs); s.skills = initial(); const next = s.skills;
  pending.resolve(response); await refresh;
  assert.equal(s.skills, next, 'stale response cannot overwrite newer selection');
  assert.notEqual(s.skills, before);
}
// Render the real popup with minimal hooks; inspect its ToolTree contract.
{
  let nodes = [];
  const popupContext = vm.createContext({
    h: (tag, props, ...children) => { const node = { tag, props: props || {}, children }; nodes.push(node); return node; },
    useState: (initial) => [typeof initial === 'boolean' ? true : initial, () => {}],
    useRef: () => ({ current: null }), useCallback: (fn) => fn, useEffect() {},
    useClickOutside() {}, useVisualViewport() {}, buildToolGroups: () => [], ToolTree: 'tree'
  });
  const popup = fs.readFileSync('frontend/src/components/chat/ToolPopup.jsx', 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '').replace(/^export /gm, '');
  vm.runInContext(popup, popupContext);
  const skills = initial(); skills.items[0].chatDisabled = true;
  let row; let group;
  popupContext.ToolPopup({ skills, onToggleSkill: (...args) => { row = args; }, onToggleSkills: (...args) => { group = args; } });
  const tree = nodes.find((node) => node.tag === 'tree');
  const sk = tree.props.groups.find((g) => g.id === 'skills');
  assert.equal(sk.checked, false, 'partial selection does not check the all-on box');
  assert.equal(sk.tools[0].checked, false);
  assert.equal(sk.tools[1].checked, true);
  assert.equal(sk.tools[2].disabled, true);
  tree.props.onToggleTool('skills', 'one', true); assert.deepEqual(row, ['one', true]);
  tree.props.onToggleGroup('skills', true); assert.deepEqual(group, [true]);
  nodes = [];
  popupContext.ToolPopup({ skills: { ...skills, items: [{ id: 'locked', disabled: true }] } });
  assert.equal(nodes.find((node) => node.tag === 'tree').props.groups[0].disabled, true);
}
// Transcript Agent files and Skills cards use inert div rows (not <label>),
// matching ToolTree's click discipline so only the checkbox toggles.
{
  const created = [];
  const doc = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(), className: '', dataset: {}, textContent: '',
        children: [], setAttribute() {}, addEventListener() {},
        appendChild(child) { this.children.push(child); return child; }
      };
      created.push(el);
      return el;
    }
  };
  const cardCtx = vm.createContext({ document: doc, saveSkillSelection, Promise, Set, Object, Array, console });
  vm.runInContext(source + ';globalThis.buildAgentFilesCard = buildAgentFilesCard; globalThis.buildSkillsCard = buildSkillsCard;', cardCtx);
  const afCard = cardCtx.buildAgentFilesCard({ agentFiles: { files: ['AGENTS.md'], enabled: true, projectLocked: false } });
  const afRows = created.filter((el) => el.className === 'chat-view__agent-files-row');
  assert.equal(afRows.length, 1);
  assert.equal(afRows[0].tagName, 'DIV', 'agent-files row is a div, not a <label>');
  const skCard = cardCtx.buildSkillsCard({ skills: initial() });
  const skRows = created.filter((el) => el.className === 'chat-view__skills-row');
  assert.equal(skRows.length, 3);
  assert.ok(skRows.every((el) => el.tagName === 'DIV'), 'skills rows are divs, not <label>s');
  assert.ok(afCard && skCard);
}
// Agent editor ToolTree: MCP child toggles expand/collapse server slug and
// native leaf rows carry catalog descriptions.
{
  const strip = (s) => s.replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export \{.*?\};$/gms, '').replace(/^export /gm, '');
  const agentCtx = vm.createContext({ Set, Object, Array, String, console });
  vm.runInContext(
    strip(fs.readFileSync('frontend/src/toolGroups.js', 'utf8')) + '\n' +
    strip(fs.readFileSync('frontend/src/components/ToolTree.jsx', 'utf8')) + '\n' +
    strip(fs.readFileSync('frontend/src/components/SettingsAgents.jsx', 'utf8')) +
    '\nglobalThis.buildAgentToolGroups = buildAgentToolGroups; globalThis.toggleToolInList = toggleToolInList; globalThis.toggleGroupInList = toggleGroupInList; globalThis.toolChoicesWithMcp = toolChoicesWithMcp;',
    agentCtx
  );
  const servers = [{ id: 'srv', slug: 'srv', name: 'Srv', status: 'ready', tools: [{ name: 'alpha', description: 'Alpha tool.' }, { name: 'beta', description: 'Beta tool.' }] }];
  const choices = agentCtx.toolChoicesWithMcp(servers);
  const catalog = [{ name: 'read_file', kind: 'native', source: 'files', description: 'Read a text file from the project.' }];
  let agentTools = undefined;
  const buildGroups = () => agentCtx.buildAgentToolGroups({
    choices,
    restricted: agentTools !== undefined,
    selected: (v) => (agentTools || []).includes(v),
    mcpServers: servers,
    catalog
  });
  let groups = buildGroups();
  const filesGroup = groups.find((g) => g.id === 'files');
  const readLeaf = filesGroup.tools.find((t) => t.id === 'read_file');
  assert.equal(readLeaf.description, 'Read a text file from the project.', 'native leaf in agent editor carries shortDesc');
  assert.equal(readLeaf.title, 'Read a text file from the project.', 'native leaf in agent editor carries title');

  let mcpGroup = groups.find((g) => g.id === 'mcp__srv');
  assert.equal(mcpGroup.checked, true);
  assert.equal(mcpGroup.tools.length, 2);
  // Uncheck one MCP child from inherit-all state.
  let r = agentCtx.toggleToolInList(agentTools, 'mcp__srv__alpha', false, choices, groups);
  agentTools = r.tools;
  assert.ok(Array.isArray(agentTools), 'unchecking one MCP child creates an explicit allowlist');
  assert.ok(!agentTools.includes('mcp__srv'), 'server slug is expanded');
  assert.ok(!agentTools.includes('mcp__srv__alpha'), 'unchecked MCP child is omitted');
  assert.ok(agentTools.includes('mcp__srv__beta'), 'remaining MCP child stays selected');
  groups = buildGroups();
  mcpGroup = groups.find((g) => g.id === 'mcp__srv');
  assert.equal(mcpGroup.checked, false, 'MCP group is no longer fully checked');
  assert.equal(mcpGroup.tools[0].checked, false);
  assert.equal(mcpGroup.tools[1].checked, true);

  // Re-check the child -> collapses back to server slug and inherit-all.
  r = agentCtx.toggleToolInList(agentTools, 'mcp__srv__alpha', true, choices, groups);
  agentTools = r.tools;
  assert.equal(agentTools, undefined, 're-checking all MCP children collapses back to inherit-all');
  groups = buildGroups();
  assert.equal(groups.find((g) => g.id === 'mcp__srv').checked, true);

  // Uncheck every group -> stays explicitly empty (not inherit-all).
  for (const g of groups) {
    r = agentCtx.toggleGroupInList(agentTools, g, false, choices);
    agentTools = r.tools;
  }
  assert.ok(Array.isArray(agentTools) && agentTools.length === 0, 'unchecking all groups keeps an empty allowlist');
  assert.deepEqual(Array.from(r.send), ['__none__'], 'empty allowlist sends __none__ sentinel');
  groups = buildGroups();
  assert.ok(groups.every((g) => !g.checked && g.tools.every((t) => !t.checked)), 'every group and leaf stays unchecked');
}
console.log('agent skills UI: popup rendering, scoped toggles, rollback, ordering, navigation, and preset reconciliation passed');
