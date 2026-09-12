// Dictation over the real serve handlers, on an ephemeral port.
//
// Never starts/stops the host-managed CLI and never touches user settings:
// MOUAIF_HOME points at a temp directory, the "project" is a temp folder, and
// the provider is a mock upstream this script runs itself. What is exercised
// is the whole path — settings → model resolution → request build → upstream
// fetch → response parse — because the parts that break (field name, auth
// header, status mapping) only exist once the server is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-dictation-http-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir, { recursive: true });

const require = createRequire(import.meta.url);

// ---- Mock upstream ------------------------------------------------------
// Records what the proxy actually sent, so the assertions are about the wire
// shape and not about our own parsing of it.
const upstream = { requests: [], reply: { status: 200, body: { text: 'hello from the mock' } } };
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    upstream.requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks)
    });
    res.writeHead(upstream.reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(upstream.reply.body));
  });
});
await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const mockBase = 'http://127.0.0.1:' + mockServer.address().port + '/v1';

const server = require('../src/index.js').createServer(0);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

async function request(endpoint, init) {
  const response = await fetch(base + endpoint, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || '{}'); } catch { body = text; }
  return { status: response.status, body };
}
const jsonInit = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

try {
  // ---- Configure the provider and the project's models ------------------
  const provider = await request('/api/settings/app', jsonInit('PUT', {
    providers: [{ id: 'openai-compatible', baseUrl: mockBase, apiKey: 'test-key', auth: 'apikey' }]
  }));
  assert.equal(provider.status, 200, 'provider connection saves');

  const project = await request('/api/settings/project', jsonInit('PUT', {
    projectDir,
    models: [
      // A chat model that cannot transcribe, to prove the candidate filter is
      // real and not "everything in the project".
      { id: 'gpt-5', provider: 'openai-compatible' },
      { id: 'whisper-1', provider: 'openai-compatible' },
      // A marked model on the Gemini shape, with a per-model language default.
      { id: 'gemini-2.5-flash', provider: 'openai-compatible', transcription: { kind: 'gemini', language: 'fr' } }
    ]
  }));
  assert.equal(project.status, 200, 'project models save');
  // The transcription descriptor has to survive the settings round trip; it is
  // the only thing that distinguishes a Gemini model from an OpenAI one here.
  assert.deepEqual(
    project.body.project.models.find((m) => m.id === 'gemini-2.5-flash').transcription,
    { kind: 'gemini', language: 'fr' }
  );

  // ---- Catalog ----------------------------------------------------------
  const catalog = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.models.map((m) => m.id), ['whisper-1', 'gemini-2.5-flash']);
  assert.equal(catalog.body.models.find((m) => m.id === 'whisper-1').kind, 'openai-compatible');
  assert.equal(catalog.body.models.find((m) => m.id === 'gemini-2.5-flash').kind, 'gemini');
  assert.ok(catalog.body.models.every((m) => m.connected), 'the provider connection is reported');
  assert.deepEqual(catalog.body.kinds.map((k) => k.id), ['openai-compatible', 'gemini']);
  assert.equal(catalog.body.total, 3, 'the filter is reported against the full model list');

  const noProject = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(root));
  assert.deepEqual(noProject.body.models, [], 'a project with no models offers none');

  // ---- A successful transcription --------------------------------------
  const audio = Buffer.from('not-really-audio-but-bytes-are-bytes');
  const ok = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir,
    modelId: 'whisper-1',
    providerId: 'openai-compatible',
    audioBase64: audio.toString('base64'),
    mimeType: 'audio/webm',
    filename: 'take.webm',
    language: 'en'
  }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.text, 'hello from the mock');
  assert.equal(ok.body.kind, 'openai-compatible');
  assert.equal(ok.body.bytes, audio.length);
  assert.deepEqual(ok.body.model, { id: 'whisper-1', provider: 'openai-compatible' });

  const sent = upstream.requests[upstream.requests.length - 1];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/audio/transcriptions');
  assert.equal(sent.headers.authorization, 'Bearer test-key');
  assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/);
  const sentBody = sent.body.toString('binary');
  assert.ok(sentBody.includes('name="model"\r\n\r\nwhisper-1\r\n'), 'the model reaches the provider');
  assert.ok(sentBody.includes('name="file"; filename="take.webm"'), 'the audio is a file part');
  assert.ok(sentBody.includes('audio/webm'), 'the content type is declared');
  assert.ok(sentBody.includes('name="language"\r\n\r\nen\r\n'));
  assert.ok(sent.body.includes(audio), 'the audio bytes are sent verbatim');

  // ---- The Gemini family takes the other branch ------------------------
  upstream.reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] } };
  const gemini = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir,
    modelId: 'gemini-2.5-flash',
    audioBase64: audio.toString('base64'),
    mimeType: 'audio/webm'
  }));
  assert.equal(gemini.status, 200, JSON.stringify(gemini.body));
  assert.equal(gemini.body.text, 'bonjour');
  assert.equal(gemini.body.kind, 'gemini');
  const geminiSent = upstream.requests[upstream.requests.length - 1];
  assert.equal(geminiSent.url, '/v1/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(geminiSent.headers['x-goog-api-key'], 'test-key', 'the provider credential is reused for Gemini');
  const geminiBody = JSON.parse(geminiSent.body.toString('utf8'));
  assert.equal(geminiBody.contents[0].parts[1].inline_data.data, audio.toString('base64'));
  // The per-model language default applies when the request does not set one.
  assert.ok(geminiBody.contents[0].parts.some((p) => typeof p.text === 'string' && p.text.includes('"fr"')));

  // ---- Failures ---------------------------------------------------------
  const noAudio = await request('/api/ai/transcribe', jsonInit('POST', { projectDir, modelId: 'whisper-1' }));
  assert.equal(noAudio.status, 400);
  assert.equal(noAudio.body.code, 'EBADINPUT');

  const badAudio = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir, modelId: 'whisper-1', audioBase64: 'not base64!!'
  }));
  assert.equal(badAudio.status, 400);
  assert.equal(badAudio.body.code, 'EBADINPUT');

  const unknown = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir, modelId: 'nope', audioBase64: audio.toString('base64')
  }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'EMODEL_NOT_FOUND');

  const noModel = await request('/api/ai/transcribe', jsonInit('POST', { projectDir, audioBase64: audio.toString('base64') }));
  assert.equal(noModel.status, 400, 'a missing modelId is a client error');

  // The provider rejecting the credential has to come back as 401 with the
  // provider's own words, not as a generic 502.
  upstream.reply = { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
  const rejected = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir, modelId: 'whisper-1', audioBase64: audio.toString('base64')
  }));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.code, 'ENOAUTH');
  assert.equal(rejected.body.error, 'Incorrect API key provided');
  assert.equal(rejected.body.upstreamStatus, 401);

  // An unreachable provider is a 502, and it must not hang.
  upstream.reply = { status: 200, body: { text: 'recovered' } };
  await request('/api/settings/app', jsonInit('PUT', {
    providers: [{ id: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', auth: 'apikey' }]
  }));
  const unreachable = await request('/api/ai/transcribe', jsonInit('POST', {
    projectDir, modelId: 'whisper-1', audioBase64: audio.toString('base64')
  }));
  assert.equal(unreachable.status, 502, JSON.stringify(unreachable.body));
  assert.equal(unreachable.body.code, 'EUNREACHABLE');

  console.log('PASS dictation: catalog, multipart + Gemini request shapes, transcript, 400/404/401/502 mapping');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  mockServer.closeAllConnections();
  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
