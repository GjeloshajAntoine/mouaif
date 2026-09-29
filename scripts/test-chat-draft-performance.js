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
  await context.save({ draft: 'saved', trace: true });
  assert.equal(credit, 2);
  console.log('PASS model changes and mixed metadata patches retain normal refresh behavior');
  const previous = state.chat;
  response = { status: 503, body: {} };
  assert.equal(await context.save({ draft: 'failed' }), false);
  assert.equal(state.chat, previous);
  assert.equal(credit, 2);
  console.log('PASS rejected draft saves preserve state and report failure');
})().catch((error) => { console.error(error); process.exitCode = 1; });
