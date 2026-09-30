'use strict';
// Execute the production send function with isolated network/UI dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
const sendSource = source.slice(source.indexOf('export async function send('), source.indexOf('async function recoverFromDisk('));

async function checkFailure(name, modelSave, draftSave, pair = 'provider|model') {
  let requests = 0;
  let appended = 0;
  const context = vm.createContext({
    toPublicImageAttachments: (items) => items,
    newClientId: (prefix) => (prefix || 'c') + '_test',
    parseAtInvocation: () => null,
    parseDirectRestartInvocation: () => null,
    updateChat: modelSave,
    setChatStatus: (refs, text) => { refs.status.current.textContent = text; },
    fetch: () => { requests++; throw new Error('must not send'); },
    appendMessageToTranscript: () => { appended++; }
  });
  vm.runInContext(sendSource.replace('export async function', 'async function') + '; this.send = send;', context);
  const attachments = [{ type: 'image', dataUrl: 'data:image/png;base64,draft' }];
  const state = {
    props: { projectDir: '/test', chatId: 'test' },
    chat: { providerId: 'provider', modelId: 'model' },
    providers: [{}], imageAttachments: attachments, messages: [],
    _persistedModelPair: pair, streaming: false,
    _setRunningVisible(value) { this.runningVisible = value; }
  };
  const refs = {
    promptInput: { current: { value: '  original draft\n' } },
    sendBtn: { current: { disabled: false } },
    status: { current: { textContent: '' } },
    imageInput: { current: { value: 'attached.png' } },
    _autoresize() {}
  };
  await context.send(state, refs, { clearComposerDraft: draftSave, setImageAttachments: () => assert.fail('attachments cleared') });
  assert.equal(refs.promptInput.current.value, '  original draft\n');
  assert.equal(state.imageAttachments, attachments);
  assert.equal(refs.imageInput.current.value, 'attached.png');
  assert.equal(state.streaming, false);
  assert.equal(state.runningVisible, false);
  assert.equal(refs.sendBtn.current.disabled, false);
  assert.match(refs.status.current.textContent, /draft is unchanged/);
  assert.equal(requests, 0);
  assert.equal(appended, 0);
  // A subsequent attempt must reach preparation again, not the busy guard.
  let retried = false;
  await context.send(state, refs, { clearComposerDraft: async () => { retried = true; return false; } });
  if (pair === 'provider|model') assert.equal(retried, true);
  console.log('PASS ' + name);
}
async function checkEditedDraft(name, edit, retry = false) {
  let finishPreparation;
  let requests = 0;
  let appended = 0;
  const saves = [];
  const original = { type: 'image', dataUrl: 'original' };
  const state = {
    props: { projectDir: '/test', chatId: 'test' },
    chat: { providerId: 'provider', modelId: 'model' },
    _persistedModelPair: 'provider|model', imageAttachments: [original], messages: [],
    _setRunningVisible(value) { this.runningVisible = value; },
    _updateChat: async (patch) => { saves.push(patch); return true; }
  };
  const refs = {
    promptInput: { current: { value: '  original draft\n' } },
    sendBtn: { current: { disabled: false } }, status: { current: {} },
    imageInput: { current: { value: 'original.png' } }, draftSaveTimer: { current: null },
    _autoresize() {}
  };
  const context = vm.createContext({
    AbortController,
    toPublicImageAttachments: (items) => items,
    newClientId: (prefix) => (prefix || 'c') + '_test',
    parseAtInvocation: () => null, parseDirectRestartInvocation: () => null,
    setChatStatus: (refs, text) => { refs.status.current.textContent = text; },
    saveComposerDraftNow: async (text, refs, save, extra) => save({ ...extra, draft: text }),
    fetch: async () => {
      requests++;
      return { ok: false, status: 400, text: async () => '{}' };
    },
    createCounter: () => ({}), appendErrorCard() {}, maybeAutoRetry() {},
    appendMessageToTranscript: () => { appended++; }
  });
  vm.runInContext(sendSource.replace('export async function', 'async function') + '; this.send = send;', context);
  const options = retry
    ? { retry: true, content: 'retry payload', attachments: [], setImageAttachments: () => assert.fail('retry cleared draft') }
    : { clearComposerDraft: () => new Promise((resolve) => { finishPreparation = resolve; }), setImageAttachments: () => assert.fail('edited attachments cleared') };
  if (retry) {
    await context.send(state, refs, options);
    assert.equal(refs.promptInput.current.value, '  original draft\n');
    assert.equal(state.imageAttachments[0], original);
    assert.equal(requests, 1);
  } else {
    const sending = context.send(state, refs, options);
    edit(state, refs);
    const draft = refs.promptInput.current.value;
    const images = state.imageAttachments.slice();
    finishPreparation(true);
    await sending;
    assert.equal(refs.promptInput.current.value, draft);
    assert.deepEqual(state.imageAttachments, images);
    assert.equal(requests, 0);
    assert.equal(appended, 0);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].draft, draft);
    assert.deepEqual(saves[0].draftAttachments, images);
    assert.match(refs.status.current.textContent, /nothing sent/);
    assert.equal(state.streaming, false);
    assert.equal(state.runningVisible, false);
    assert.equal(refs.sendBtn.current.disabled, false);
  }
  console.log('PASS ' + name);
}
(async () => {
  await checkEditedDraft('typing during preparation preserves and saves the draft', (state, refs) => { refs.promptInput.current.value += 'new text'; });
  await checkEditedDraft('adding an image during preparation preserves the draft', (state) => { state.imageAttachments = state.imageAttachments.concat({ type: 'image', dataUrl: 'new' }); });
  await checkEditedDraft('removing an image during preparation preserves the draft', (state) => { state.imageAttachments = []; });
  await checkEditedDraft('editing an image during preparation preserves the draft', (state) => { state.imageAttachments = [{ type: 'image', dataUrl: 'edited' }]; });
  await checkEditedDraft('retry sends its payload without clearing a newer draft', () => {}, true);
  await checkFailure('network draft failure preserves composer and unlocks retry', async () => true, async () => { throw new Error('offline'); });
  await checkFailure('HTTP draft rejection preserves composer', async () => true, async () => false);
  await checkFailure('network model failure resets streaming', async () => { throw new Error('offline'); }, async () => true, 'old|model');
  await checkFailure('HTTP model rejection resets streaming', async () => false, async () => true, 'old|model');
})().catch((error) => { console.error(error); process.exitCode = 1; });
