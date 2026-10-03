import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../frontend/src/components/chat/meta.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function applyMouaifToolResult(');
const end = source.indexOf('// renameChat(state, refs)', start);
const requests = [];
const reload = { value: 0 };
let navigation = 0, resized = 0, promptRefresh = 0;
const context = vm.createContext({
  fetchJson: (url) => new Promise((resolve) => requests.push({ url, resolve })),
  projectsReload: reload,
  back: () => navigation++,
  autoresize: () => resized++,
  refreshSystemPrompt: () => promptRefresh++,
  clearTimeout, encodeURIComponent
});
vm.runInContext(source.slice(start, end).replace('export async function', 'async function') + '; this.apply = applyMouaifToolResult;', context);
const image = { name: 'shot.png', dataUrl: 'data:image/png;base64,fixture' };
let nextId = 0;
function fixture() {
  const state = { props: { projectDir: '/project', chatId: 'host' }, session: {},
    chat: { id: 'host', title: 'Before', modelId: 'old', providerId: 'old', draft: 'local' }, imageAttachments: [] };
  const refs = { promptInput: { current: { value: 'local' } }, chatName: { current: { textContent: 'Before' } }, draftSaveTimer: { current: null } };
  state._setComposerText = (text) => { state.composerText = text; };
  state._setImageAttachments = (images) => { state.imageAttachments = images; };
  state._onChatChanged = () => { state.changed = (state.changed || 0) + 1; };
  return { state, refs };
}
const event = (result) => ({ id: 'call-' + ++nextId,
  name: result.deleted ? 'delete_chat' : result.attached ? 'attach_chat_image' : result.url ? 'create_chat' : 'update_chat',
  ok: true, result: { ok: true, ...result } });
const reply = (chat, index = requests.length - 1) => requests[index].resolve({ status: 200, body: { chat } });

{
  const { state, refs } = fixture();
  const update = event({ chat: { id: 'host' }, updated: ['title', 'draft', 'modelId', 'providerId', 'promptSize'] });
  const pending = context.apply(update, state, refs);
  assert.ok(requests.at(-1).url.includes('/api/chats/host?projectDir='));
  reply({ id: 'host', title: 'Renamed', draft: 'From the tool', modelId: 'new', providerId: 'openai-compatible', promptSize: 'chat' });
  await pending;
  assert.equal(refs.chatName.current.textContent, 'Renamed');
  assert.equal(refs.promptInput.current.value, 'From the tool');
  assert.equal(state.composerText, 'From the tool');
  assert.equal(state._persistedModelPair, 'openai-compatible|new');
  assert.equal(state.changed, 1);
  assert.equal(resized, 1);
  assert.equal(promptRefresh, 1);
  const before = requests.length;
  await context.apply(update, state, refs);
  assert.equal(requests.length, before, 'SSE/tail duplicates do not refetch');
}
{
  const { state, refs } = fixture();
  const pending = context.apply(event({ target: 'draft', chatId: 'host', attached: { name: 'shot.png' } }), state, refs);
  reply({ id: 'host', draftAttachments: [image], modelId: 'stale' });
  await pending;
  assert.equal(state.imageAttachments[0].name, 'shot.png');
  assert.equal(state.chat.modelId, 'old', 'unrelated stale metadata is ignored');
}
{
  const { state, refs } = fixture();
  const pending = context.apply(event({ chat: { id: 'host' }, updated: ['draft', 'draftAttachments'] }), state, refs);
  refs.promptInput.current.value = 'Typed while loading';
  const localImages = [{ name: 'new-local.png' }];
  state.imageAttachments = localImages;
  reply({ id: 'host', draft: 'Server draft', draftAttachments: [image] });
  await pending;
  assert.equal(refs.promptInput.current.value, 'Typed while loading');
  assert.equal(state.imageAttachments, localImages);
}
for (const change of [
  (state) => { state.props.chatId = 'different'; },
  (state) => { state.props.projectDir = '/different'; },
  (state) => { state.session = {}; }
]) {
  const { state, refs } = fixture();
  const pending = context.apply(event({ chat: { id: 'host' }, updated: ['title'] }), state, refs);
  change(state);
  reply({ id: 'host', title: 'Must not appear' });
  await pending;
  assert.equal(refs.chatName.current.textContent, 'Before');
}
{
  const { state, refs } = fixture();
  const first = context.apply(event({ chat: { id: 'host' }, updated: ['title'] }), state, refs);
  const firstIndex = requests.length - 1;
  const second = context.apply(event({ target: 'draft', chatId: 'host', attached: { name: 'shot.png' } }), state, refs);
  reply({ id: 'host', title: 'Newest', draftAttachments: [image] });
  await second;
  reply({ id: 'host', title: 'Old response' }, firstIndex);
  await first;
  assert.equal(refs.chatName.current.textContent, 'Newest', 'overlapping mutations coalesce fields and ignore older responses');
  assert.equal(state.imageAttachments[0].name, 'shot.png');
}
{
  const { state, refs } = fixture();
  const before = requests.length;
  const reloadBefore = reload.value;
  await context.apply(event({ chat: { id: 'other' }, updated: ['title'] }), state, refs);
  assert.equal(requests.length, before);
  assert.equal(reload.value, reloadBefore + 1);
  await context.apply(event({ chat: { id: 'host' } }), state, refs); // read-only get
  await context.apply({ ...event({ chat: { id: 'host' }, updated: ['title'] }), ok: false }, state, refs);
  assert.equal(requests.length, before, 'reads and failures do not trigger synchronization');
  await context.apply(event({ deleted: 'other' }), state, refs);
  assert.equal(navigation, 0);
  await context.apply(event({ deleted: 'host' }), state, refs);
  assert.equal(navigation, 1);
}

{
  const { state, refs } = fixture();
  const before = requests.length;
  const reloadBefore = reload.value;
  await context.apply({ name: 'start_chat', id: 'started', ok: true,
    result: { ok: true, started: true, chat: { id: 'other' }, url: '#/chat/other' } }, state, refs);
  assert.equal(reload.value, reloadBefore + 1, 'background starts refresh the project chat list');
  assert.equal(requests.length, before, 'starting another chat does not overwrite the mounted chat');
}

// A failed delegate may already have attached an image successfully. Its
// settled tool events must refresh the mounted draft and dedupe live replay.
{
  const { state, refs } = fixture();
  const attach = event({ target: 'draft', chatId: 'host', attached: { name: 'shot.png' } });
  const delegate = { name: 'subagent', ok: false, result: { ok: false, toolEvents: [
    { name: 'tool_call', data: attach }, { name: 'tool_result', data: attach }
  ] } };
  const pending = context.apply(delegate, state, refs);
  reply({ id: 'host', draftAttachments: [image] });
  await pending;
  assert.equal(state.imageAttachments[0].name, 'shot.png');
  const before = requests.length;
  await context.apply(delegate, state, refs);
  assert.equal(requests.length, before, 'settled delegates dedupe their nested results');
}

const stream = fs.readFileSync(new URL('../frontend/src/components/chat/stream.js', import.meta.url), 'utf8');
// Exercise the real SSE handler, not only the metadata helper.
{
  const { state, refs } = fixture();
  let rendered = 0;
  const ctx = vm.createContext({ state, refs,
    handleSubagentStreamEvent: () => rendered++, applyMouaifToolResult: context.apply });
  const start = stream.indexOf('  function handleStreamEvent(ev, data) {');
  const end = stream.indexOf('\n  try {\n    for (;;) {', start);
  vm.runInContext(stream.slice(start, end) + '; this.handle = handleStreamEvent;', ctx);
  ctx.handle({ eventName: 'subagent_event' }, { kind: 'tool_result', parentCallId: 'delegate',
    data: event({ target: 'draft', chatId: 'host', attached: { name: 'shot.png' } }) });
  reply({ id: 'host', draftAttachments: [image] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendered, 1);
  assert.equal(state.imageAttachments[0].name, 'shot.png', 'nested SSE refreshes the composer immediately');
}
assert.ok(stream.includes("if (data.kind === 'tool_result') applyMouaifToolResult(data.data, state, refs)"));
assert.ok(stream.includes("applyMouaifToolResult({ name: 'subagent', result: body.result || body }, state, refs)"));
assert.ok(stream.includes('if (data) applyMouaifToolResult(data, state, refs)'));
assert.ok(stream.includes('applyMouaifToolResult({ id: row.toolCallId'));
const hook = fs.readFileSync(new URL('../frontend/src/components/chat/useChatState.js', import.meta.url), 'utf8');
assert.ok(hook.includes('state._setComposerText = setComposerText'));
assert.ok(hook.includes('state._setImageAttachments = setImageAttachments'));
console.log('mouaif tool sync: mounted metadata, drafts, images, deduplication, navigation, concurrent edits, and stale-response guards passed');
