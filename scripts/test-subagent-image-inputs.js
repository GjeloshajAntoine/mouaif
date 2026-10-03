'use strict';

// Select existing chat images explicitly; never inherit unrelated pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-image-inputs-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const ai = require('../src/ai.js');
const { runAppTool } = require('../src/tools/mouaif.js');
const { SPEC, buildSpec } = require('../src/tools/subagent.js');
const { resolveChatImages } = require('../src/chatImages.js');
const { handleTools } = require('../src/server-handlers-tools.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGvCAAxBgMBAJ2DqQAAAAAASUVORK5CYII=';
const image = (data, name) => ({ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + data, name });
const realFetch = global.fetch;
const requests = [];
const generated = () => new Response(JSON.stringify({ data: [{ b64_json: png, media_type: 'image/png' }] }), { headers: { 'Content-Type': 'application/json' } });
let respond = () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
global.fetch = async (url, init) => { requests.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return respond(); };
let host;
const model = { id: 'vision-fixture', provider: 'openai-compatible' };
async function delegate(args = {}, callModel = model, chatId = host.id) {
  const events = [];
  const result = await ai.runSingleToolCall({ id: 'select', name: 'subagent', arguments: JSON.stringify({ task: 'Describe', context: 'Only selected images', ...args }) }, {
    opts: { model: callModel, projectDir, chatId, enabledTools: ['subagent'] },
    onEvent: (name, data) => events.push({ name, data })
  });
  return { ...result, events };
}
async function main() {
  settings.setProject(projectDir, { tools: { subagent: { mode: 'allow' } } });
  host = chats.createChat(projectDir, {});
  const first = image(png, 'first.png');
  const second = image('AQ==', 'second.png');
  const draft = image('Ag==', 'draft.png');
  const row = messages.appendMessage(projectDir, host.id, { role: 'user', content: 'Two images', attachments: [first, second] });
  chats.updateChat(projectDir, host.id, { draftAttachments: [draft] });
  const inventory = (await runAppTool('list_chat_attachments', {}, { projectDir, chatId: host.id })).result;
  assert.equal(inventory.messages[1].imageRef, 'message:' + row.seq + ':1');
  assert.equal(inventory.messages[1].messageSeq, row.seq);
  assert.match(inventory.drafts[0].imageRef, /^draft:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(inventory).includes(png));
  const messageRef = inventory.messages[1].imageRef;
  const draftRef = inventory.drafts[0].imageRef;
  assert.equal(SPEC.function.parameters.properties.images.maxItems, 8);
  assert.equal(buildSpec(['Artist']).function.parameters.properties.images.items.type, 'string');

  for (const args of [{}, { images: [] }]) {
    const empty = await delegate(args);
    assert.equal(empty.exec.ok, true);
    assert.equal(typeof requests.at(-1).body.messages[1].content, 'string', 'images never inherited');
  }
  const selected = await delegate({ images: [messageRef, draftRef] });
  assert.equal(selected.exec.ok, true);
  const content = requests.at(-1).body.messages[1].content;
  assert.equal(content[0].text, 'Task:\nDescribe\n\nContext:\nOnly selected images');
  assert.deepEqual(content.slice(1).map((part) => part.image_url.url), [second.dataUrl, draft.dataUrl]);
  assert.ok(!JSON.stringify(requests.at(-1).body).includes(first.dataUrl), 'unselected pixels absent');
  assert.deepEqual(selected.exec.result.chat[1].content, content, 'selected inputs persist in nested transcript');
  assert.deepEqual(selected.events.find((ev) => ev.name === 'subagent_event' && ev.data.kind === 'start').data.data.chat[1].content, content);
  assert.equal(selected.exec.result.content, undefined, 'inputs are not mislabeled as generated output');

  // Stable persisted seqs work even beyond the newest inventory page.
  for (let i = 0; i < 210; i++) messages.appendMessage(projectDir, host.id, { role: 'user', content: 'Later' });
  assert.equal(resolveChatImages(projectDir, host.id, [messageRef])[0].dataUrl, second.dataUrl);
  // Reordered drafts keep their content-based references; replaced drafts fail.
  chats.updateChat(projectDir, host.id, { draftAttachments: [first, draft] });
  assert.equal(resolveChatImages(projectDir, host.id, [draftRef])[0].dataUrl, draft.dataUrl);
  chats.updateChat(projectDir, host.id, { draftAttachments: [first] });
  let before = requests.length;
  assert.equal((await delegate({ images: [draftRef] })).exec.result.error.code, 'ENOTFOUND');
  for (const images of [null, 'all', [{}], [first.dataUrl], ['message:-1:0'], ['message:1.5:0'], ['message:9007199254740992:0'], Array(9).fill(messageRef)]) {
    assert.equal((await delegate({ images })).exec.result.error.code, 'EBADINPUT', JSON.stringify(images));
  }
  assert.equal((await delegate({ images: ['message:9999:0'] })).exec.result.error.code, 'ENOTFOUND');
  const other = chats.createChat(projectDir, {});
  assert.equal((await delegate({ images: [messageRef] }, model, other.id)).exec.result.error.code, 'ENOTFOUND', 'references scoped to current chat');
  assert.equal(requests.length, before, 'invalid selections never contact the provider');
  const large = image('A'.repeat(9 * 1024 * 1024), 'large.png');
  const largeRow = messages.appendMessage(projectDir, host.id, { role: 'user', content: '', attachments: [large] });
  assert.equal((await delegate({ images: Array(3).fill('message:' + largeRow.seq + ':0') })).exec.result.error.code, 'ETOOLARGE');

  const input = [{ role: 'user', content: [{ type: 'text', text: 'Edit' }, { type: 'image_url', image_url: { url: second.dataUrl } }] }];
  const anthropic = ai.BUILDERS.anthropic({ id: 'claude', provider: 'anthropic', apiKey: 'fixture' }, input, true, []);
  assert.equal(anthropic.body.messages[0].content[1].source.data, 'AQ==');
  const gemini = ai.BUILDERS.gemini({ id: 'gemini-image', provider: 'gemini', apiKey: 'fixture' }, input, true);
  assert.equal(gemini.body.contents[0].parts[1].inlineData.data, 'AQ==');
  const ollama = ai.BUILDERS.ollama({ id: 'vision', provider: 'ollama' }, input, true);
  assert.equal(ollama.body.messages[0].content, 'Edit');
  assert.deepEqual(ollama.body.messages[0].images, ['AQ==']);
  assert.throws(() => ai.BUILDERS.gemini({ id: 'imagen-4', provider: 'gemini', apiKey: 'fixture' }, input, true), { code: 'EBADINPUT' });
  const or = { id: 'edit', provider: 'openrouter', apiKey: 'fixture', imageEndpoint: 'images', supportedParameters: { input_references: { min: 1, max: 2 } } };
  respond = generated;
  const edited = await delegate({ images: [messageRef] }, or);
  assert.equal(edited.exec.ok, true);
  assert.deepEqual(requests.at(-1).body.input_references, [{ type: 'image_url', image_url: { url: second.dataUrl } }]);
  assert.ok(!requests.at(-1).body.prompt.includes('AQ=='));
  before = requests.length;
  assert.equal((await delegate({}, or)).exec.result.error.code, 'EBADINPUT');
  assert.equal((await delegate({ images: Array(3).fill(messageRef) }, or)).exec.result.error.code, 'EBADINPUT');
  assert.equal((await delegate({ images: [messageRef] }, { ...or, supportedParameters: {} })).exec.result.error.code, 'EBADINPUT');
  assert.equal(requests.length, before);

  // Model-driven parents pass the same reference strings, not inline data.
  let round = 0;
  const events = [];
  respond = () => {
    if (!round++) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'nested', function: { name: 'subagent', arguments: JSON.stringify({ task: 'Describe', images: [messageRef] }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
    if (round === 2) assert.equal(requests.at(-1).body.messages[1].content[1].image_url.url, second.dataUrl);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  };
  const parent = await ai.streamChat({ model, projectDir, chatId: host.id, enabledTools: ['subagent'],
    messages: [{ role: 'user', content: 'Select one image' }], onEvent: (name, data) => events.push({ name, data }) });
  assert.equal(parent.ok, true);
  assert.equal(round, 3);
  assert.ok(!requests.at(-1).body.messages.find((message) => message.role === 'tool').content.includes('AQ=='));

  // REST opts in explicitly; the ordinary composer remains unchanged.
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible' }] });
  settings.setProject(projectDir, { models: [model] });
  chats.updateChat(projectDir, host.id, { modelId: model.id, providerId: model.provider });
  respond = () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  const req = { method: 'POST', headers: {}, on(event, cb) {
    if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify({ projectDir, chatId: host.id, task: 'Describe', images: [messageRef] }))));
    if (event === 'end') process.nextTick(cb);
  } };
  const res = { body: '', writeHead(code) { this.statusCode = code; }, end(chunk) { this.body += chunk || ''; }, write(chunk) { this.body += chunk; }, setHeader() {}, getHeader() {} };
  await handleTools(req, res, { pathname: '/api/tools/subagent', query: {} });
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(requests.at(-1).body.messages[1].content[1].image_url.url, second.dataUrl);
  settings.setProject(projectDir, { tools: { subagent: { mode: 'off' } } });
  before = requests.length;
  assert.equal((await delegate({ images: [messageRef] })).exec.ok, false);
  assert.equal(requests.length, before, 'image transfer cannot bypass delegation authorization');
  console.log('subagent image inputs: explicit selection, no inheritance, references, bounds, provider mappings, parent dispatch, HTTP, and authorization passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = realFetch;
  settings.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
