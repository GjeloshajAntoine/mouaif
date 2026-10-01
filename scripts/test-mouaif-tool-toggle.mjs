// A `mouaif` category's child row toggles the TOOL, not the tree row.
//
// The tool renders as two categories whose children are actions, so a child
// row's tree id is `mouaif:list`. The per-chat filter, however, stores tool
// NAMES: `toggleToolGroup` (frontend/src/components/chat/cards.js) filters the
// incoming names through `knownToolNames(state)` and drops anything the catalog
// does not advertise. So a child row that passed its own id wrote a name no
// tool has, the wanted-set came out empty, and the tap was a silent no-op — the
// checkbox snapped back on the next rebuild and the chat was never PATCHed.
//
// The first fix resolved the name inline at the call sites. It landed in the
// composer popup (ToolPopup.jsx) but NOT in the chat Tools card (cards.js),
// which is why the card's action checkboxes did nothing. The resolution now
// lives in one shared helper pair in ToolTree.jsx — `groupToolNames` and
// `childToolName` — and both surfaces call it, so the two cannot drift again.
//
// This asserts the three things that fix could silently lose:
//   * a category child resolves to `mouaif`, a catalog leaf to its own id;
//   * the names a row produces survive `toggleToolGroup` and land in the filter;
//   * both chat surfaces resolve through the shared helper (no local copy).
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
  { name: 'mouaif', description: 'Manage mouaif itself: chats, settings, projects.' },
  { name: 'read_file', kind: 'native', source: 'files', description: 'Read a file.' }
];
const groups = buildToolGroups(catalog, [], null);
const byId = (id) => groups.find((g) => g.id === id);
const chats = byId('mouaif');
const settings = byId('mouaif-settings');
const shell = byId('shell');
const files = byId('files');

// ---- 1. groupToolNames: a category writes its tool, a leaf its id --------
same(
  groupToolNames(chats), ['mouaif'],
  'a category row collapses to the one tool behind its children'
);
same(
  groupToolNames(settings), ['mouaif'],
  'the second category writes the same single tool'
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
  groupToolNames({ tools: [{ id: 'a', toolName: 'mouaif' }, { id: 'b', toolName: 'mouaif' }] }),
  ['mouaif'],
  'names are deduped'
);

// ---- 2. childToolName: a category child resolves to the tool -------------
assert.equal(childToolName(chats, 'mouaif:list'), 'mouaif', 'a category child resolves to its tool');
assert.equal(childToolName(settings, 'mouaif-settings:info'), 'mouaif', 'and so does the settings child');
assert.equal(childToolName(shell, 'shell'), 'shell', 'a catalog leaf is its own name');
assert.equal(childToolName(files, 'read_file'), 'read_file', 'including a file-tool leaf');
// An unknown row still round-trips instead of becoming `undefined`.
assert.equal(childToolName(chats, 'mouaif:gone'), 'mouaif:gone', 'an unknown id falls through unchanged');
assert.equal(childToolName(null, 'shell'), 'shell', 'and so does a missing group');
// The pushed id is never a raw tree key: the exact bug.
for (const tool of chats.tools) {
  assert.equal(childToolName(chats, tool.id), 'mouaif', 'no action leaks its tree id');
}
assert.ok(chats.tools.every((t) => t.id.includes(':')), 'a category child is keyed by action, not by tool');

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
  const categorySegments = props.groups.filter((g) => g.id.startsWith('mouaif')).map((g) => g.control.props.namePrefix);
  assert.equal(new Set(categorySegments).size, 2, 'category segments use independent browser radio groups');
  // Unchecking one Chat action must name the TOOL. The bug pushed `mouaif:list`.
  props.onToggleTool('mouaif', 'mouaif:list', false);
  assert.equal(s._seenTool.name, 'mouaif', 'the card resolves a category child to mouaif');
  // The category checkbox writes the same single tool.
  props.onToggleGroup('mouaif', false);
  assert.equal(s._seenGroup.names.length, 1, 'the category checkbox writes one tool');
  assert.equal(s._seenGroup.names[0], 'mouaif', 'and it is mouaif');
  assert.equal(s._seenGroup.next, false, 'with the tapped state');
  // The second category behaves identically.
  props.onToggleGroup('mouaif-settings', true);
  assert.equal(s._seenGroup.names[0], 'mouaif', 'the settings category writes the same tool');
  // A catalog-backed group is untouched: its children ids ARE tool names.
  props.onToggleTool('shell', 'shell', false);
  assert.equal(s._seenTool.name, 'shell', 'a plain tool row keeps its own name');
  props.onToggleGroup('files', false);
  assert.equal(s._seenGroup.names[0], 'read_file', 'a catalog group keeps its children ids');
}

// ---- 3b. Those names survive the real write ------------------------------
const liveCatalog = catalog.map((t) => Object.assign({}, t));
const allNames = knownToolNames({ tools: { catalog: liveCatalog, filter: null } });
assert.ok(allNames.includes('mouaif'), 'the catalog advertises mouaif');
assert.ok(!allNames.includes('mouaif:list'), 'the catalog never advertises a tree key');

const patched = [];
const updateChat = async (patch) => { patched.push(patch); };
const state = { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] };
const refs = { toolsCard: { current: null } };

// Unchecking ONE action of the Chats category writes an explicit filter that
// omits `mouaif` — and the write is not empty, which is what the id produced.
await toggleToolGroup([childToolName(chats, 'mouaif:list')], false, state, refs, updateChat);
assert.equal(patched.length, 1, 'a category child toggle writes to the chat');
assert.ok(Array.isArray(patched[0].tools), 'and writes an explicit filter');
assert.ok(!patched[0].tools.includes('mouaif'), 'with mouaif off');
assert.ok(patched[0].tools.includes('shell'), 'leaving the other tools on');
same(state.tools.filter, patched[0].tools, 'the in-memory filter matches the write');

// A no-op write (the pre-fix behaviour: only an unknown name) is detectable —
// this is the assertion that fails on the old code path.
const before = patched.length;
await toggleToolGroup(['mouaif:list'], false, { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] }, refs, updateChat);
assert.equal(patched.length, before, 'an unknown name still writes nothing (so the fix must resolve names)');

// Re-checking it collapses back to `null` (all on), the documented filter rule.
await toggleToolGroup([childToolName(chats, 'mouaif:list')], true, state, refs, updateChat);
assert.equal(patched.at(-1).tools, null, 're-enabling every tool collapses back to null');
assert.equal(state.tools.filter, null, 'and the in-memory filter follows');

// The category checkbox toggles the whole category from either row.
const state2 = { tools: { catalog: liveCatalog, filter: null }, mcpServers: [] };
await toggleToolGroup(groupToolNames(settings), false, state2, refs, updateChat);
assert.ok(!patched.at(-1).tools.includes('mouaif'), 'the settings category writes the same tool');

// ---- 4. Selection and authorization agree -------------------------------
const disabledGroups = buildToolGroups(liveCatalog, [], null, new Set(), {
  native: { shell: { mode: 'off' }, mouaif: { mode: 'off' }, file: { mode: 'off' } }
});
assert.ok(disabledGroups.filter((g) => ['shell', 'mouaif', 'mouaif-settings', 'files'].includes(g.id))
  .every((g) => !g.checked && g.tools.every((t) => !t.checked)), 'Off permissions cannot render as selected tools');

const authWrites = [];
const offState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [], toolAuth: { mouaif: { mode: 'off', allowlist: ['keep'] } },
  _saveToolAuth: async (...args) => { authWrites.push(args); return true; } };
await toggleToolGroup(['mouaif'], true, offState, refs, updateChat);
same(authWrites, [['mouaif', 'ask', ['keep']]], 'checking an Off tool restores Ask without granting Allow');
assert.ok(offState.tools.filter.includes('mouaif'), 'the enabled tool also enters the chat selection');
authWrites.length = 0;
offState.toolAuth.mouaif.mode = 'allow';
await toggleToolGroup(['mouaif'], true, offState, refs, updateChat);
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
  settingsStore.setProject(home, { tools: { mouaif: { mode: 'off' } } });
  const host = chatStore.createChat(home, { tools: [] });
  const liveState = { tools: { catalog: liveCatalog, filter: [] }, mcpServers: [],
    toolAuth: authorization.getAuthorization(home, host.id).tools,
    _saveToolAuth: async (tool, mode, allowlist) => {
      authorization.setChatAuthorization(home, host.id, { native: { [tool]: { mode, allowlist } } });
      liveState.toolAuth = authorization.getAuthorization(home, host.id).tools;
      return true;
    } };
  await toggleToolGroup(['mouaif'], true, liveState, refs, async (patch) => {
    chatStore.updateChat(home, host.id, patch);
    return true;
  });
  assert.equal(settingsStore.getProject(home).tools.mouaif.mode, 'off', 'checkbox never changes the project gate');
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.ok(request.tools.some((tool) => tool.function.name === 'mouaif'), 'the checked tool reaches the model');
    assert.ok(!request.tools.some((tool) => tool.function.name === 'shell'), 'unselected tools stay absent');
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ready' } }] }) + '\n\ndata: [DONE]\n\n');
  };
  const result = await require('../src/ai-stream.js').streamChat({
    model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir: home, chatId: host.id, enabledTools: chatStore.getChat(home, host.id).tools,
    promptSize: 'average', messages: [{ role: 'user', content: 'Ready?' }], onEvent() {}
  });
  assert.equal(result.ok, true, JSON.stringify(result));
} finally {
  global.fetch = originalFetch;
  settingsStore.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('mouaif tool toggle: category names, Off-to-Ask selection, failures, and model advertisement passed');
