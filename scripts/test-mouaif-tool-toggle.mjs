// A `mouaif` child row selects its action, not every action in both categories.
//
// Two categories expose independent action selections while sharing one
// model-facing function. Canonical selection keys are `mouaif:<action>`;
// the category prefix in a tree id is presentation-only. Tests cover single
// action and category toggles, legacy family selections, Off-to-Ask saves,
// errors, and the narrowed schema actually sent to the model.
//
// Runs the real `groupToolNames` / `childToolName` / `buildToolGroups` from
// frontend/src/components/ToolTree.jsx and the real `toggleToolGroup` from
// frontend/src/components/chat/cards.js, evaluated the way the sibling tests
// do (strip imports, run in a vm context).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// ---- ToolTree: the shape and the shared name resolvers -------------------
const treeSource = fs.readFileSync('frontend/src/components/ToolTree.jsx', 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const treeContext = vm.createContext({
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: new Set() }),
  h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(9).filter((c) => c != null && c !== false) })
});
vm.runInContext(treeSource, treeContext);
const { buildToolGroups, groupToolNames, childToolName, toolPermission } =
  vm.runInContext('({ buildToolGroups, groupToolNames, childToolName, toolPermission })', treeContext);

// Values built inside the VM realm carry that realm's Array prototype, so
// `deepStrictEqual` would compare prototypes and fail on identical contents.
// Compare the serialized form instead — the shape is what this file asserts.
// (Same convention as scripts/test-mouaif-tool-categories.mjs.)
const same = (actual, expected, what) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what);

const catalog = [
  { name: 'shell', description: 'Run a shell command in the project directory.' },
  ...vm.runInContext('MOUAIF_TOOL_GROUPS', treeContext).flatMap((group) => group.tools.map((name) => ({ name, kind: 'native', source: group.source }))),
  { name: 'read_file', kind: 'native', source: 'files', description: 'Read a file.' }
];
const groups = buildToolGroups(catalog, [], null);
const byId = (id) => groups.find((g) => g.id === id);
const chats = byId('chats');
const settings = byId('mouaif-settings');
const shell = byId('shell');
const files = byId('files');

// ---- 1. groupToolNames: a category writes its tool, a leaf its id --------
same(
  groupToolNames(chats), chats.tools.map((t) => t.id),
  'a category row selects only its own actions'
);
same(
  groupToolNames(settings), settings.tools.map((t) => t.id),
  'the second category selects its own actions'
);
same(groupToolNames(shell), ['shell'], 'a one-tool group writes its tool name');
same(
  groupToolNames(files), ['read_file'],
  'a catalog group keeps its children ids (which ARE tool names)'
);
same(groupToolNames(null), [], 'a missing group resolves to nothing');
same(groupToolNames({ tools: null }), [], 'a group with no tools resolves to nothing');
// Dedupe: a category whose children somehow carried one tool still writes it once.
same(
  groupToolNames({ tools: [{ id: 'a' }, { id: 'a' }] }),
  ['a'],
  'names are deduped'
);

// ---- 2. childToolName: a category child resolves to the tool -------------
assert.equal(childToolName(chats, 'list_chats'), 'list_chats', 'a category child is an ordinary tool');
assert.equal(childToolName(settings, 'get_app_info'), 'get_app_info', 'settings leaves are ordinary tools too');
assert.equal(childToolName(shell, 'shell'), 'shell', 'a catalog leaf is its own name');
assert.equal(childToolName(files, 'read_file'), 'read_file', 'including a file-tool leaf');
// An unknown row still round-trips instead of becoming `undefined`.
assert.equal(childToolName(chats, 'mouaif:gone'), 'mouaif:gone', 'an unknown id falls through unchanged');
assert.equal(childToolName(null, 'shell'), 'shell', 'and so does a missing group');
// The pushed id is never a raw tree key: the exact bug.
for (const tool of chats.tools) {
  assert.equal(childToolName(chats, tool.id), tool.id, 'each leaf uses its function name');
}
assert.ok(chats.tools.every((t) => !t.id.includes(':')), 'no synthetic action keys');

// ---- 3. The names survive toggleToolGroup (the real write path) ----------
// Load the real toggleToolGroup. It reaches for DOM + the Preact tree only
// through `updateToolsCard`, which this state keeps inert (`refs.toolsCard`
// has no element), so the pure filter math is what runs.
// A minimal but faithful element: buildToolsCard sets className, dataset, id,
// attributes and appends children, and the vnode's `class` is what carries the
// card's layout class.
function fakeElement(tag) {
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, attrs: {}, id: '',
    textContent: '', hidden: false,
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, remove() {}, querySelector: () => null, querySelectorAll: () => []
  };
}

const cardsSource = fs.readFileSync('frontend/src/components/chat/cards.js', 'utf8');
const cardsContext = vm.createContext({
  document: { createElement: fakeElement },
  requestAnimationFrame: (fn) => fn(),
  window: {},
  console,
  fetchJson: async () => ({ status: 200, body: {} }),
  h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(9) }),
  // Captured rather than stubbed away: `buildToolsCard` hands the real
  // ToolTree vnode (and therefore the real onToggleGroup / onToggleTool
  // closures) to `render`, tagged with the `h()` element the card passes.
  render: (vnode, host) => { rendered.push({ vnode, host }); },
  afterTranscriptAppend: () => {},
  placeHeaderCard: () => {},
  HEADER_CARD_ORDER: [],
  saveSkillSelection: async () => {},
  AuthModelPicker: () => ({}),
  ToolAuthSeg: () => ({}),
  McpAuthSeg: () => ({}),
  TOOL_MODE_CHOICES: [],
  ASK_USER_MODE_CHOICES: [],
  ToolTree: 'tool-tree',
  buildToolGroups,
  groupToolNames,
  childToolName,
  toolPermission
});
const rendered = [];
vm.runInContext(
  cardsSource
    .replace(/^import .*;$/gm, '')
    .replace(/^export \{.*$/gm, '')
    .replace(/^export /gm, '')
  + '\nglobalThis.toggleToolGroup = toggleToolGroup; globalThis.knownToolNames = knownToolNames; globalThis.buildToolsCard = buildToolsCard;',
  cardsContext
);
const { toggleToolGroup, knownToolNames, buildToolsCard } = cardsContext;

// ---- 3a. The card's own handlers resolve (the surface that was broken) ---
// `buildToolsCard` renders the real ToolTree vnode through `render`, so this
// reads the closures the card actually hands the tree — the ones a tap calls.
function cardHandlers(filter) {
  rendered.length = 0;
  const treeState = { tools: { catalog: catalog.map((t) => Object.assign({}, t)), filter: filter === undefined ? null : filter }, mcpServers: [], toolAuth: {} };
  treeState._toggleTool = (name, next) => { treeState._seenTool = { name, next }; };
  treeState._toggleToolGroup = (names, next) => { treeState._seenGroup = { names, next }; };
  buildToolsCard(treeState);
  const entry = rendered.find((r) => r.host && r.host.className.includes('chat-view__tools-tree'));
  assert.ok(entry, 'the card renders the tool tree into its tree host');
  return { props: entry.vnode.props || {}, state: treeState };
}

{
  const { props, state: s } = cardHandlers();
  const leaves = props.groups.filter((g) => ['chats', 'mouaif-settings'].includes(g.id)).flatMap((g) => g.tools);
  assert.ok(leaves.every((tool) => tool.control.props.tool === tool.id), 'each function has its own permission control');
  props.onToggleTool('chats', 'list_chats', false);
  assert.equal(s._seenTool.name, 'list_chats');
  props.onToggleGroup('chats', false);
  assert.equal(s._seenGroup.names.length, 8);
  assert.equal(s._seenGroup.names[0], 'list_chats');
  assert.equal(s._seenGroup.next, false);
  props.onToggleGroup('mouaif-settings', true);
  assert.equal(s._seenGroup.names[0], 'get_settings');
  // A catalog-backed group is untouched: its children ids ARE tool names.
  props.onToggleTool('shell', 'shell', false);
  assert.equal(s._seenTool.name, 'shell', 'a plain tool row keeps its own name');
  props.onToggleGroup('files', false);
  assert.equal(s._seenGroup.names[0], 'read_file', 'a catalog group keeps its children ids');
}

// ---- 3b. Those names survive the real write ------------------------------
const liveCatalog = catalog.map((t) => Object.assign({}, t));
const allNames = knownToolNames({ tools: { catalog: liveCatalog, filter: null } });
assert.ok(!allNames.includes('mouaif'), 'new selections expand the legacy family key');
assert.ok(allNames.includes('list_chats'), 'the catalog exposes ordinary function names');

const patched = [];
const updateChat = async (patch) => { patched.push(patch); };
const state = { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] };
const refs = { toolsCard: { current: null } };

// Unchecking ONE action of the Chats category writes an explicit filter that
// omits `mouaif` — and the write is not empty, which is what the id produced.
await toggleToolGroup([childToolName(chats, 'list_chats')], false, state, refs, updateChat);
assert.equal(patched.length, 1, 'a category child toggle writes to the chat');
assert.ok(Array.isArray(patched[0].tools), 'and writes an explicit filter');
assert.ok(!patched[0].tools.includes('list_chats'), 'only list_chats is off');
assert.ok(patched[0].tools.includes('get_chat') && patched[0].tools.includes('get_app_info'), 'siblings stay selected');
assert.ok(patched[0].tools.includes('shell'), 'leaving the other tools on');
same(state.tools.filter, patched[0].tools, 'the in-memory filter matches the write');

// A no-op write (the pre-fix behaviour: only an unknown name) is detectable —
// this is the assertion that fails on the old code path.
const before = patched.length;
await toggleToolGroup(['mouaif:missing'], false, { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] }, refs, updateChat);
assert.equal(patched.length, before, 'an unknown name still writes nothing (so the fix must resolve names)');

// Re-checking it collapses back to `null` (all on), the documented filter rule.
await toggleToolGroup([childToolName(chats, 'list_chats')], true, state, refs, updateChat);
assert.equal(patched.at(-1).tools, null, 're-enabling every tool collapses back to null');
assert.equal(state.tools.filter, null, 'and the in-memory filter follows');

// The category checkbox toggles the whole category from either row.
const state2 = { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] };
await toggleToolGroup(groupToolNames(settings), false, state2, refs, updateChat);
assert.ok(!patched.at(-1).tools.includes('get_app_info'), 'the settings category switches its tools off');
assert.ok(patched.at(-1).tools.includes('list_chats'), 'Chats stays selected');

// ---- 4. Selection and authorization agree -------------------------------
const disabledGroups = buildToolGroups(liveCatalog, [], null, new Set(), {
  native: { shell: { mode: 'off' }, list_chats: { mode: 'off' }, file: { mode: 'off' } }
});
assert.ok(disabledGroups.filter((g) => ['shell', 'files'].includes(g.id))
  .every((g) => !g.checked && g.tools.every((t) => !t.checked)), 'Off permissions cannot render as selected tools');
assert.equal(disabledGroups.find((g) => g.id === 'chats').tools.find((t) => t.id === 'list_chats').checked, false);
assert.equal(disabledGroups.find((g) => g.id === 'chats').tools.find((t) => t.id === 'delete_chat').checked, true);

const authWrites = [];
const offState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [], toolAuth: { list_chats: { mode: 'off', allowlist: ['keep'] } },
  _saveToolAuth: async (...args) => { authWrites.push(args); return true; } };
await toggleToolGroup(['list_chats'], true, offState, refs, updateChat);
same(authWrites, [['list_chats', 'ask', ['keep']]], 'checking an Off tool restores its own Ask permission');
assert.ok(offState.tools.filter.includes('list_chats'));
authWrites.length = 0;
offState.toolAuth.list_chats.mode = 'allow';
await toggleToolGroup(['list_chats'], true, offState, refs, updateChat);
assert.equal(authWrites.length, 0, 'an already allowed tool keeps its permission');

const failedState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [] };
const previousTools = failedState.tools;
await toggleToolGroup(['shell'], true, failedState, refs, async () => false);
assert.equal(failedState.tools, previousTools, 'a failed selection save restores the prior checkbox state');

const fileState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [], toolAuth: { file: { mode: 'off' } },
  _saveToolAuth: async (...args) => { authWrites.push(args); return true; } };
authWrites.length = 0;
await toggleToolGroup(['read_file'], true, fileState, refs, updateChat);
same(authWrites, [['file', 'ask', []]], 'file checkbox restores the shared file permission');

const mcpWrites = [];
const mcpName = 'mcp__fixture__read';
const mcpState = { tools: { catalog: [{ name: mcpName, kind: 'mcp', source: 'fixture' }], filter: [] }, mcpServers: [],
  mcpAuth: { mode: 'off' }, _saveMcpAuth: async (patch) => { mcpWrites.push(patch); return true; } };
await toggleToolGroup([mcpName], true, mcpState, refs, updateChat);
same(mcpWrites, [{ servers: { fixture: { mode: 'ask', allowlist: [] } }, tools: { [mcpName]: { mode: 'ask', allowlist: [] } } }],
  'MCP checkbox restores the server and tool gate without granting Allow');

const failedPermission = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [], toolAuth: { shell: { mode: 'off' } },
  _saveToolAuth: async () => false };
assert.equal(await toggleToolGroup(['shell'], true, failedPermission, refs, updateChat), false);
assert.equal(failedPermission.tools.filter.length, 0, 'failed permission saves cannot leave a checked tool');

const shellOnly = buildToolGroups([{ name: 'shell' }], [], []);
assert.equal(shellOnly[0].checked, false, 'selection off remains off even when permission is Ask');

// ---- 5. Both chat surfaces resolve through the shared helper -------------
for (const relPath of ['frontend/src/components/chat/cards.js', 'frontend/src/components/chat/ToolPopup.jsx']) {
  const src = fs.readFileSync(relPath, 'utf8');
  assert.match(src, /import \{[^}]*groupToolNames[^}]*childToolName[^}]*\} from '\.\.\/ToolTree\.jsx'/, relPath + ' imports the shared resolvers');
  assert.match(src, /groupToolNames\(group\)/, relPath + ' resolves a group row through the helper');
  // The card hands the name to `state._toggleTool`, the popup to its
  // `onToggleTool` prop — both must go through the shared resolver.
  assert.match(src, /(state\._toggleTool|onToggleTool)\(childToolName\(/, relPath + ' resolves a child row through the helper');
  // The inlined copies are gone — a second copy is how the two drifted.
  assert.ok(!/tool\.toolName\s*\)\s*:\s*group\.tools\.map/.test(src), relPath + ' carries no inlined copy of the group resolver');
  assert.ok(!/\.some\(\(t(ool)?\) => t(ool)?\.toolName\)/.test(src), relPath + ' carries no inlined copy of the child resolver');
}

// A checkbox-driven re-enable reaches the actual model request, using an
// isolated store and the production chat filter + authorization resolver.
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-checkbox-test-'));
process.env.MOUAIF_HOME = path.join(home, 'store');
const require = createRequire(import.meta.url);
const settingsStore = require('../src/settings.js');
const chatStore = require('../src/chats.js');
const authorization = require('../src/tools/authorization.js');
const originalFetch = global.fetch;
try {
  settingsStore.setProject(home, { tools: { list_chats: { mode: 'off' } } });
  const host = chatStore.createChat(home, { tools: [] });
  const liveState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [],
    toolAuth: authorization.getAuthorization(home, host.id).tools,
    _saveToolAuth: async (tool, mode, allowlist) => {
      authorization.setChatAuthorization(home, host.id, { native: { [tool]: { mode, allowlist } } });
      liveState.toolAuth = authorization.getAuthorization(home, host.id).tools;
      return true;
    } };
  await toggleToolGroup(['list_chats'], true, liveState, refs, async (patch) => {
    chatStore.updateChat(home, host.id, patch);
    return true;
  });
  assert.equal(settingsStore.getProject(home).tools.list_chats.mode, 'off', 'checkbox never changes project permission');
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const spec = request.tools.find((tool) => tool.function.name === 'list_chats');
    assert.ok(spec, 'the checked function reaches the model');
    assert.equal(spec.function.parameters.properties.action, undefined);
    assert.ok(!request.tools.some((tool) => tool.function.name === 'delete_chat'), 'unchecked native functions stay absent');
    assert.ok(!request.tools.some((tool) => tool.function.name === 'shell'), 'unselected tools stay absent');
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ready' } }] }) + '\n\ndata: [DONE]\n\n');
  };
  const result = await require('../src/ai-stream.js').streamChat({
    model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir: home, chatId: host.id, enabledTools: chatStore.getChat(home, host.id).tools,
    promptSize: 'average', messages: [{ role: 'user', content: 'Ready?' }], onEvent() {}
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  global.fetch = originalFetch;
  const server = require('../src/index.js').createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/chats/' + host.id + '/tool-preview?projectDir=' + encodeURIComponent(home));
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.ok(preview.tools.some((tool) => tool.name === 'list_chats'), 'tool preview includes the selected function');
    assert.ok(!preview.tools.some((tool) => tool.name === 'shell'), 'tool preview respects the selection');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  // Storage conversion runs once, not as an exception in tool dispatch.
  const migration = require('../src/migrateAppTools.js');
  const legacy = { tools: { mouaif: { mode: 'off' }, 'mouaif:list': { mode: 'allow' }, delete_chat: { mode: 'ask' } },
    prompts: [{ preset: { tools: ['mouaif:info'] } }], agents: [{ tools: ['shell', 'mouaif:list'] }],
    defaultAgent: { tools: ['mouaif'] } };
  const converted = migration.config(legacy);
  assert.equal(converted.tools.list_chats.mode, 'off', 'legacy Off is preserved');
  assert.equal(converted.tools.delete_chat.mode, 'ask', 'existing ordinary permissions are untouched');
  same(converted.prompts[0].preset.tools, ['get_app_info']);
  same(converted.agents[0].tools, ['shell', 'list_chats']);
  assert.equal(converted.defaultAgent.tools.length, 12);
  assert.deepEqual(migration.config(converted), converted, 'migration is idempotent');
  settingsStore.setProject(home, legacy);
  settingsStore.setApp({ tools: { mouaif: { mode: 'allow' }, 'mouaif:delete': { mode: 'off' } } });
  chatStore.updateChat(home, host.id, { tools: ['mouaif:list', 'mouaif:info'],
    toolAuth: { native: { mouaif: { mode: 'allow' }, 'mouaif:delete': { mode: 'off' } } },
    promptSnapshot: { content: 'Pinned', preset: { tools: ['mouaif:get'] } } });
  migration.run();
  const migrated = chatStore.getChat(home, host.id);
  assert.deepEqual(migrated.tools, ['list_chats', 'get_app_info']);
  assert.equal(migrated.toolAuth.native.list_chats.mode, 'allow');
  assert.equal(migrated.toolAuth.native.delete_chat.mode, 'off');
  assert.deepEqual(migrated.promptSnapshot.preset.tools, ['get_chat']);
  assert.equal(settingsStore.getApp().tools.delete_chat.mode, 'off');
  assert.equal(settingsStore.getProject(home).tools.list_chats.mode, 'off');
  assert.equal(settingsStore.getProject(home).tools.mouaif, undefined);
  const snapshot = JSON.stringify(migrated);
  migration.run();
  assert.equal(JSON.stringify(chatStore.getChat(home, host.id)), snapshot);
} finally {
  global.fetch = originalFetch;
  settingsStore.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('mouaif tool toggle: category names, Off-to-Ask selection, failures, and model advertisement passed');
