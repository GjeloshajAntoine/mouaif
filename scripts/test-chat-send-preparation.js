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
(async () => {
  await checkFailure('network draft failure preserves composer and unlocks retry', async () => true, async () => { throw new Error('offline'); });
  await checkFailure('HTTP draft rejection preserves composer', async () => true, async () => false);
  await checkFailure('network model failure resets streaming', async () => { throw new Error('offline'); }, async () => true, 'old|model');
  await checkFailure('HTTP model rejection resets streaming', async () => false, async () => true, 'old|model');
})().catch((error) => { console.error(error); process.exitCode = 1; });
