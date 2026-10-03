'use strict';

// Native provider artwork through the real subagent loop; no paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-subagent-images-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const ai = require('../src/ai.js');
const { projectModelRecord } = require('../src/util.js');
const { handleTools } = require('../src/server-handlers-tools.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGvCAAxBgMBAJ2DqQAAAAAASUVORK5CYII=';
const image = { type: 'image', data: png, mimeType: 'image/png' };
const realFetch = global.fetch;
const requests = [];
const sse = (obj) => new Response('data: ' + JSON.stringify(obj) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const record = { id: 'fixture-image', provider: 'openrouter', outputModalities: ['image'], imageEndpoint: 'images' };
let reply = () => json({ data: [{ b64_json: png, media_type: 'image/png' }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.04 } });
const catalog = [{ id: 'fixture-image', architecture: { output_modalities: ['image'] } },
  { id: 'live-art', architecture: { output_modalities: ['image'] } }];
const chatCatalog = [{ id: 'chat-only-art', architecture: { output_modalities: ['text', 'image'] } }];
global.fetch = async (url, init = {}) => {
  if (!init.method || init.method === 'GET') return json({ data: url.endsWith('/images/models') ? catalog : chatCatalog });
  const body = JSON.parse(init.body);
  requests.push({ url, body, signal: init.signal, headers: init.headers });
  return reply(url, body);
};

async function delegate(model, extra = {}) {
  const events = [];
  const out = await ai.runSingleToolCall({ id: 'draw', name: 'subagent', arguments: JSON.stringify({ task: 'Draw a bird', context: 'Use blue', ...extra }) }, {
    opts: { model, projectDir, chatId: host.id, enabledTools: ['subagent', 'read_file'] },
    onEvent: (name, data) => events.push({ name, data })
  });
  return { ...out, events };
}
let host;
async function main() {
  settings.setApp({ providers: [{ id: 'openrouter', type: 'openrouter', apiKey: 'fixture' }, { id: 'gemini', type: 'gemini', apiKey: 'fixture' }] });
  settings.setProject(projectDir, { tools: { subagent: { mode: 'allow' }, file: { mode: 'allow' } },
    models: [record], agents: [
    { name: 'Artist', content: 'DRAW_INSTRUCTIONS', modelId: 'fixture-image', providerId: 'openrouter' },
    { name: 'LiveArtist', content: 'LIVE_INSTRUCTIONS', modelId: 'live-art', providerId: 'openrouter' },
    { name: 'ChatArtist', content: 'CHAT_INSTRUCTIONS', modelId: 'chat-only-art', providerId: 'openrouter' }
    ] });
  host = chats.createChat(projectDir, {});
  chats.updateChat(projectDir, host.id, { modelId: record.id, providerId: 'openrouter' });
  const or = { ...record, apiKey: 'fixture' };
  const dedicated = await delegate(or);
  assert.equal(dedicated.exec.ok, true);
  assert.deepEqual(dedicated.exec.result.content, [image]);
  assert.deepEqual(dedicated.imageParts[0].image_url.url, 'data:image/png;base64,' + png);
  assert.equal(dedicated.exec.result.text, '');
  assert.equal(dedicated.exec.result.chat.at(-1).images[0].data, png);
  assert.equal(dedicated.exec.result.providerCost, 0.04);
  assert.ok(dedicated.events.some((ev) => ev.name === 'subagent_event' && ev.data.kind === 'image'));
  assert.match(requests.at(-1).url, /\/images$/);
  assert.match(requests.at(-1).body.prompt, /Task:\nDraw a bird\n\nContext:\nUse blue/);
  assert.equal(requests.at(-1).body.stream, false);
  assert.equal(requests.at(-1).body.tools, undefined);

  // Live pins have only identity; their cached image slice determines API.
  const named = await delegate({ id: 'parent', provider: 'openrouter', apiKey: 'fixture' }, { agent: 'Artist' });
  assert.equal(named.exec.ok, true);
  assert.match(requests.at(-1).url, /\/images$/);
  assert.match(requests.at(-1).body.prompt, /DRAW_INSTRUCTIONS/);
  const live = await delegate({ id: 'parent', provider: 'openrouter', apiKey: 'fixture' }, { agent: 'LiveArtist' });
  assert.equal(live.exec.ok, true);
  assert.match(requests.at(-1).url, /\/images$/);
  assert.equal(requests.at(-1).body.model, 'live-art');
  assert.match(requests.at(-1).body.prompt, /LIVE_INSTRUCTIONS/);
  const metadata = projectModelRecord({ ...record, baseUrl: 'https://bad.invalid', apiKey: 'bad' });
  assert.equal(metadata.imageEndpoint, 'images');
  assert.equal(metadata.baseUrl, undefined);
  assert.equal(metadata.apiKey, undefined);

  // A chat-image delta is forwarded and duplicate final frames are deduped.
  reply = () => sse({ choices: [{ delta: { images: [{ image_url: { url: 'data:image/png;base64,' + png } }] }, finish_reason: 'stop' }], usage: { cost: 0.02 } });
  const chatPin = await delegate({ id: 'parent', provider: 'openrouter', apiKey: 'fixture' }, { agent: 'ChatArtist' });
  assert.equal(chatPin.exec.ok, true);
  assert.deepEqual(requests.at(-1).body.modalities, ['text', 'image']);
  const chatImage = await delegate({ id: 'chat-image', provider: 'openrouter', apiKey: 'fixture', outputModalities: ['text', 'image'] });
  assert.equal(chatImage.exec.ok, true);
  assert.deepEqual(chatImage.exec.result.content, [image]);
  assert.deepEqual(requests.at(-1).body.modalities, ['text', 'image']);
  assert.equal(requests.at(-1).body.tools, undefined);
  const messageImages = [...ai.PARSERS.openrouter('', JSON.stringify({ choices: [{ message: { content: 'Here', images: [{ image_url: { url: 'data:image/png;base64,' + png } }] } }] }))];
  assert.equal(messageImages.find((ev) => ev.name === 'image').data.data, png);
  assert.equal(messageImages.find((ev) => ev.name === 'message').data.delta, 'Here');

  reply = () => sse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } });
  const gemini = await delegate({ id: 'gemini-2.5-flash-image', provider: 'gemini', apiKey: 'fixture' });
  assert.equal(gemini.exec.ok, true);
  assert.deepEqual(gemini.exec.result.content, [image]);
  assert.deepEqual(requests.at(-1).body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.match(requests.at(-1).url, /:streamGenerateContent/);
  assert.equal([...ai.PARSERS.gemini('', JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, inlineData: { data: png, mimeType: 'image/png' } }] } }] }))].filter((ev) => ev.name === 'image').length, 0);

  reply = () => json({ predictions: [{ bytesBase64Encoded: png, mimeType: 'image/png' }] });
  const imagen = await delegate({ id: 'imagen-4.0-generate-001', provider: 'gemini', apiKey: 'fixture' });
  assert.equal(imagen.exec.ok, true);
  assert.deepEqual(imagen.exec.result.content, [image]);
  assert.match(requests.at(-1).url, /:predict$/);
  assert.equal(requests.at(-1).body.parameters.sampleCount, 1);
  assert.match(requests.at(-1).body.instances[0].prompt, /Draw a bird/);

  reply = () => json({ data: [] });
  const empty = await delegate(or);
  assert.equal(empty.exec.ok, false);
  assert.equal(empty.exec.result.error.code, 'ENO_IMAGE');
  reply = () => json({ data: [{ url: 'https://bad.invalid/image.png' }] });
  const remote = await delegate(or);
  assert.equal(remote.exec.result.error.code, 'EIMAGE_FORMAT');
  reply = () => json({ error: { message: 'blocked' } });
  const blocked = await delegate(or);
  assert.equal(blocked.exec.result.error.code, 'EUPSTREAM');
  const before = requests.length;
  const refs = await delegate({ ...or, supportedParameters: { input_references: { min: 1 } } });
  assert.equal(refs.exec.result.error.code, 'EBADINPUT');
  assert.equal(requests.length, before, 'reference-only models fail before spending');

  // Deduplicate repeated full-image frames, but cap genuinely new images.
  reply = () => sse({ choices: [{ delta: { images: Array(2).fill({ image_url: { url: 'data:image/png;base64,' + png } }) }, finish_reason: 'stop' }] });
  const duplicate = await delegate({ id: 'chat-image', provider: 'openrouter', apiKey: 'fixture', outputModalities: ['image'] });
  assert.equal(duplicate.exec.result.content.length, 1);
  reply = () => json({ data: Array.from({ length: 9 }, (_, i) => ({ b64_json: png + 'A'.repeat(i), media_type: 'image/png' })) });
  assert.equal((await delegate(or)).exec.result.error.code, 'ETOOLARGE');
  assert.equal([...ai.PARSERS.openrouter('', JSON.stringify({ data: [{ b64_json: 'A'.repeat(12 * 1024 * 1024 + 1) }] }))][0].data.code, 'ETOOLARGE');

  // One-shot JSON reads honor cancellation too.
  reply = (url, body) => new Response(new ReadableStream({ start(controller) {
    const signal = requests.at(-1).signal;
    signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'application/json' } });
  const ctl = new AbortController();
  const pending = ai.streamChat({ model: or, signal: ctl.signal, projectDir, chatId: host.id,
    messages: [{ role: 'user', content: 'Draw' }], onEvent() {} });
  setImmediate(() => ctl.abort());
  assert.equal((await pending).error.code, 'EABORTED');

  // Parent receives pixels separately, not base64 in tool text.
  let round = 0;
  reply = (url, body) => {
    if (url.endsWith('/images')) return json({ data: [{ b64_json: png, media_type: 'image/png' }], usage: { cost: 0.04 } });
    if (!round++) return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'delegate', function: { name: 'subagent', arguments: JSON.stringify({ task: 'Draw', agent: 'Artist' }) } }] }, finish_reason: 'tool_calls' }] });
    const tool = body.messages.find((m) => m.role === 'tool');
    assert.ok(!tool.content.includes(png));
    assert.equal(body.messages.at(-1).content[1].image_url.url, 'data:image/png;base64,' + png);
    return sse({ choices: [{ delta: { content: 'Nice bird' }, finish_reason: 'stop' }] });
  };
  const parent = await ai.streamChat({ model: { id: 'parent', provider: 'openrouter', apiKey: 'fixture' }, projectDir, chatId: host.id,
    enabledTools: ['subagent'], messages: [{ role: 'user', content: 'Draw' }], onEvent() {} });
  assert.equal(parent.ok, true);
  assert.equal(round, 2);

  // Existing read_file images still return through delegation.
  fs.writeFileSync(path.join(projectDir, 'bird.png'), Buffer.from(png, 'base64'));
  round = 0;
  reply = () => !round++ ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read_file', arguments: '{"path":"bird.png"}' } }] }, finish_reason: 'tool_calls' }] })
    : sse({ choices: [{ delta: { content: 'Read it' }, finish_reason: 'stop' }] });
  const read = await delegate({ id: 'parent', provider: 'openai-compatible' });
  assert.equal(read.exec.result.content[0].data, png);

  // Direct HTTP image-only results remain in the transcript and own cost once.
  reply = () => json({ data: [{ b64_json: png, media_type: 'image/png' }], usage: { cost: 0.04 } });
  const res = { body: '', writeHead(code) { this.statusCode = code; }, write(chunk) { this.body += chunk; }, end(chunk) { this.body += chunk || ''; }, setHeader() {}, getHeader() {} };
  const req = { method: 'POST', headers: {}, on(event, callback) {
    if (event === 'data') process.nextTick(() => callback(Buffer.from(JSON.stringify({ projectDir, chatId: host.id, agent: 'Artist', task: 'Draw' }))));
    if (event === 'end') process.nextTick(callback);
  } };
  await handleTools(req, res, { pathname: '/api/tools/subagent', query: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  const stored = messages.listMessages(projectDir, host.id);
  assert.equal(JSON.parse(stored.at(-2).content).content[0].data, png);
  assert.equal(stored.at(-1).content, 'Generated image.');
  assert.equal(stored.at(-1).cost.total, 0.04);
  console.log('subagent images: dedicated/chat OpenRouter, Gemini/Imagen, vision forwarding, errors, tool compatibility, and HTTP persistence passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = realFetch;
  settings.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
