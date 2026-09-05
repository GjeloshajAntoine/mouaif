'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/useChatState.js'), 'utf8');
const start = source.indexOf('  const updateChatBound = useCallback(');
const end = source.indexOf('\n  function updateModelTriggerLocal()', start);

(async () => {
  let credit = 0, picker = 0, meta = 0, requests = 0;
  let response = { status: 200, body: { chat: { providerId: 'old', modelId: 'old', draft: 'saved', draftAttachments: null, title: 'old title' } } };
  const state = { chat: { providerId: 'new', modelId: 'new', title: 'new title' }, _persistedModelPair: 'new|new' };
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
