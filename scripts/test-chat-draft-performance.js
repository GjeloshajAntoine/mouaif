'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/useChatState.js'), 'utf8');
const start = source.indexOf('  const updateChatBound = useCallback(');
const end = source.indexOf('\n  function updateModelTriggerLocal()', start);

async function checkDraftCleanup() {
  const marker = source.indexOf('  // Composer draft is per chat');
  const cleanupStart = source.indexOf('  useEffect(() => {', marker);
  const cleanupEnd = source.indexOf('  useEffect(() => () => {', cleanupStart);
  for (const [name, text, attachments, pending, expected] of [
    ['empty pending draft is flushed on navigation', '', [], 1, 1],
    ['untouched empty composer needs no save', '', [], null, 0],
    ['nonempty text is flushed', 'latest text', [], null, 1],
    ['image draft is flushed', '', [{ type: 'image', dataUrl: 'image' }], null, 1]
  ]) {
    let cleanup;
    const saves = [];
    const cancelled = [];
    const refs = { promptInput: { current: { value: text } } };
    const timer = { current: pending };
    const context = vm.createContext({
      projectDir: '/outgoing', chatId: 'outgoing', refs,
      imageAttachmentsRef: { current: attachments }, draftSaveTimer: timer,
      toPublicImageAttachments: (items) => items,
      useEffect: (fn) => { cleanup = fn(); },
      clearTimeout: (id) => { cancelled.push(id); },
      patchChatDraft: async (...args) => { saves.push(args); },
      autoresize() {}, setComposerText() {}, setImageAttachments() {}
    });
    vm.runInContext(source.slice(cleanupStart, cleanupEnd), context);
    cleanup();
    assert.equal(saves.length, expected);
    if (expected) assert.deepEqual(saves[0], ['/outgoing', 'outgoing', text, attachments]);
    assert.equal(cancelled.length, pending == null ? 0 : 1);
    assert.equal(timer.current, null);
    assert.equal(refs.promptInput.current.value, '');
    console.log('PASS ' + name);
  }
}
(async () => {
  await checkDraftCleanup();
  let credit = 0, picker = 0, meta = 0, requests = 0;
  let response = { status: 200, body: { chat: { providerId: 'old', modelId: 'old', draft: 'saved', draftAttachments: null, title: 'old title' } } };
  const state = { props: { projectDir: '/test', chatId: 'test' }, chat: { providerId: 'new', modelId: 'new', title: 'new title' }, _persistedModelPair: 'new|new' };
  const context = vm.createContext({
    projectDir: '/test', chatId: 'test', state, refs: {}, status: { current: {} },
    useCallback: (fn) => fn,
    toPublicImageAttachments: (attachments) => attachments.map(({ type, dataUrl }) => ({ type, dataUrl })),
    fetchJson: async () => { requests++; return response; },
    updateMetaLine: () => { meta++; }, refreshProviderCredit: () => { credit++; }, syncPickerState: () => { picker++; }
  });
  vm.runInContext(source.slice(start, end) + '; this.save = updateChatBound;', context);
  assert.equal(await context.save({ draft: 'saved' }), true);
  assert.equal(state.chat.draft, 'saved');
  assert.equal(state.chat.modelId, 'new');
  assert.equal(state.chat.title, 'new title');
  assert.equal(state._persistedModelPair, 'new|new');
  assert.equal(await context.save({ draftAttachments: null }), true);
  assert.equal(await context.save({ draft: '', draftAttachments: null }), true);
  assert.equal(requests, 3);
  assert.equal(credit, 0);
  assert.equal(picker, 0);
  assert.equal(meta, 0);
  console.log('PASS text, image and clear-draft saves skip credit and header refreshes; stale metadata is ignored');
  assert.equal(await context.save({ modelId: 'old', providerId: 'old' }), true);
  assert.equal(state.chat.modelId, 'old');
  assert.equal(state._persistedModelPair, 'old|old');
  assert.equal(credit, 1);
  assert.equal(picker, 1);
  assert.equal(meta, 1);
  response.body.chat.trace = true;
  await context.save({ draft: 'saved', trace: true });
  assert.equal(credit, 2);
  console.log('PASS model changes and mixed metadata patches retain normal refresh behavior');
  const previous = state.chat;
  response = { status: 503, body: {} };
  assert.equal(await context.save({ draft: 'failed' }), false);
  assert.equal(state.chat, previous);
  assert.equal(credit, 2);
  console.log('PASS rejected draft saves preserve state and report failure');

  // Use deferred responses to exercise the production PATCH queue.
  const pending = [];
  const orderedState = {
    props: { projectDir: '/test', chatId: 'test' },
    chat: { providerId: 'p', modelId: 'initial', thinkingLevel: 'high' },
    _persistedModelPair: 'p|initial'
  };
  let refreshes = 0;
  const ordered = vm.createContext({
    projectDir: '/test', chatId: 'test', state: orderedState, refs: {}, status: { current: {} },
    useCallback: (fn) => fn, toPublicImageAttachments: (items) => items,
    fetchJson: (url, options) => new Promise((resolve, reject) => {
      pending.push({ patch: JSON.parse(options.body), resolve, reject });
    }),
    updateMetaLine() {}, refreshProviderCredit() {}, syncPickerState() { refreshes++; }
  });
  vm.runInContext(source.slice(start, end) + '; this.save = updateChatBound;', ordered);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const reply = (index, chat) => pending[index].resolve({ status: 200, body: { chat } });
  const first = ordered.save({ providerId: 'p', modelId: 'first' });
  orderedState.chat.modelId = 'second';
  const second = ordered.save({ providerId: 'p', modelId: 'second' });
  await flush();
  assert.equal(pending.length, 1, 'second model write waits for the first');
  reply(0, { providerId: 'p', modelId: 'first', thinkingLevel: 'low' });
  await first;
  assert.equal(orderedState.chat.modelId, 'second', 'old echo cannot replace the optimistic choice');
  assert.equal(refreshes, 0);
  await flush();
  assert.equal(pending.length, 2);
  reply(1, { providerId: 'p', modelId: 'second', thinkingLevel: 'low' });
  await second;
  assert.equal(orderedState.chat.modelId, 'second');
  assert.equal(orderedState.chat.thinkingLevel, 'high', 'model echo cannot reset unrelated metadata');
  assert.equal(orderedState._persistedModelPair, 'p|second');
  console.log('PASS model writes are ordered and old echoes cannot revert newer or unrelated choices');

  const thinking = ordered.save({ thinkingLevel: 'medium' });
  await flush();
  reply(2, { providerId: 'p', modelId: 'initial', thinkingLevel: 'medium' });
  await thinking;
  assert.equal(orderedState.chat.modelId, 'second');
  assert.equal(orderedState._persistedModelPair, 'p|second');
  assert.equal(orderedState.chat.thinkingLevel, 'medium');

  const failed = ordered.save({ trace: true });
  const afterFailure = ordered.save({ draft: 'new draft' });
  await flush();
  pending[3].reject(new Error('offline'));
  await assert.rejects(failed, /offline/);
  await flush();
  reply(4, { draft: 'new draft', modelId: 'initial' });
  assert.equal(await afterFailure, true);
  assert.equal(orderedState.chat.draft, 'new draft');
  assert.equal(orderedState.chat.modelId, 'second');
  console.log('PASS unrelated metadata and draft saves preserve model choice; network failures release the queue');

  const prompt = ordered.save({ promptId: 'preset' });
  await flush();
  reply(5, { promptId: 'preset', promptSnapshot: { content: 'pinned' }, modelId: 'initial' });
  await prompt;
  assert.equal(orderedState.chat.promptSnapshot.content, 'pinned');
  const switched = ordered.save({ modelId: 'late' });
  await flush();
  orderedState.props = { projectDir: '/test', chatId: 'other' };
  reply(6, { modelId: 'late' });
  await switched;
  assert.equal(orderedState.chat.modelId, 'second');
  console.log('PASS prompt snapshots follow prompt writes and acknowledgements stay in their original chat');
})().catch((error) => { console.error(error); process.exitCode = 1; });
