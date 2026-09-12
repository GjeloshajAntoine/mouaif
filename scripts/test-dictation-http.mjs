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
    // The OpenAI-shaped model list the live catalog reads. It intentionally
    // contains chat models too: the dictation filter has to drop them.
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'gpt-4o' },
          { id: 'whisper-1' },
          { id: 'gpt-4o-mini' }
        ]
      }));
      return;
    }
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

  // ---- The catalog merges the providers' live lists ---------------------
  //
  // This is the fresh-install path: no project models at all, one connected
  // provider. Without the live merge the Dictate tab is unusable until the
  // user hand-edits .mouaif.json, because the app has no model editor.
  //
  // `ai.listModels` is stubbed for this section rather than answered by the
  // mock server: the shipped adapters fetch a *hard-coded* base URL for the
  // OpenAI-shaped providers (see the note in the summary), so the mock
  // upstream's connection address is not what they would talk to. The merge
  // logic under test is the handler's, and it is reached the same way either
  // way.
  const ai = require('../src/ai.js');
  const realListModels = ai.listModels;
  ai.listModels = async (provider) => {
    if (provider !== 'openai-compatible') {
      const e = new Error('fetch failed');
      e.code = 'EUNREACHABLE';
      throw e;
    }
    // Intentionally includes chat models: the dictation filter must drop them.
    return [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'whisper-1', label: 'Whisper 1' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' }
    ];
  };
  try {
    const live = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(root)
      + '&refresh=1');
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(live.body.providers, ['openai-compatible']);
    const liveIds = live.body.models.map((m) => m.id);
    assert.deepEqual(liveIds, ['whisper-1'], 'only transcribable live models are offered: ' + liveIds);
    const liveRow = live.body.models[0];
    assert.equal(liveRow.source, 'live');
    assert.equal(liveRow.provider, 'openai-compatible');
    assert.equal(liveRow.kind, 'openai-compatible');
    assert.equal(liveRow.connected, true, 'a live row implies a connection');
    assert.equal(liveRow.label, 'Whisper 1', 'the upstream label is carried through');
    assert.equal(live.body.total, 0, 'total still counts project models, not live rows');

    // `live=0` is the fast first paint: project models only, no upstream call.
    let upstreamCalls = 0;
    ai.listModels = async () => { upstreamCalls++; return []; };
    const fast = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(root) + '&live=0');
    assert.equal(fast.status, 200);
    assert.deepEqual(fast.body.models, [], 'live=0 serves the project models alone');
    assert.equal(upstreamCalls, 0, 'live=0 makes no upstream request');
    assert.deepEqual(fast.body.providers, ['openai-compatible'], 'the provider list is still reported');

    // A project model of the same id wins over the live row, and keeps its
    // descriptor (a hand-configured model must not be shadowed by the catalog).
    ai.listModels = realListModels;
    ai.listModels = async () => [
      { id: 'whisper-1', label: 'Whisper 1' },
      { id: 'gpt-4o', label: 'GPT-4o' }
    ];
    await request('/api/settings/project', jsonInit('PUT', {
      projectDir: root,
      models: [
        { id: 'whisper-1', provider: 'openai-compatible', transcription: { language: 'fr' } },
        { id: 'gpt-5', provider: 'openai-compatible' }
      ]
    }));
    const merged = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(root) + '&refresh=1');
    const whisperRows = merged.body.models.filter((m) => m.id === 'whisper-1');
    assert.equal(whisperRows.length, 1, 'the project row replaces the live row for the same id');
    assert.equal(whisperRows[0].source, 'project', 'the project record wins');
    assert.ok(merged.body.models.every((m) => m.id !== 'gpt-5'), 'a non-transcribing project model is filtered out');
    assert.equal(merged.body.total, 2, 'total is the raw project model count');

    // An unreachable provider is reported per-provider and does not empty the
    // catalog: the still-good rows stay.
    ai.listModels = async (provider) => {
      if (provider === 'gemini') { const e = new Error('fetch failed'); e.code = 'EUNREACHABLE'; throw e; }
      return [{ id: 'whisper-large-v3', label: 'Whisper large v3' }];
    };
    await request('/api/settings/app', jsonInit('PUT', {
      providers: [
        { id: 'openai-compatible', baseUrl: mockBase, apiKey: 'test-key', auth: 'apikey' },
        { id: 'gemini', baseUrl: 'http://127.0.0.1:1', apiKey: 'AIza-bad', auth: 'apikey' }
      ]
    }));
    const partial = await request('/api/ai/transcribe/models?projectDir=' + encodeURIComponent(root) + '&refresh=1');
    assert.equal(partial.status, 200, 'one bad provider must not fail the catalog');
    assert.ok(partial.body.models.some((m) => m.id === 'whisper-1'), 'the reachable provider still contributes');
    assert.equal(partial.body.liveFailures.length, 1, 'the failure is reported');
    assert.equal(partial.body.liveFailures[0].provider, 'gemini');
    assert.equal(partial.body.liveFailures[0].code, 'EUNREACHABLE');
    await request('/api/settings/app', jsonInit('PUT', {
      providers: [{ id: 'openai-compatible', baseUrl: mockBase, apiKey: 'test-key', auth: 'apikey' }]
    }));
    // Put the project back to no models so the transcription cases below start
    // from a known state.
    await request('/api/settings/project', jsonInit('PUT', { projectDir: root, models: [] }));
  } finally {
    ai.listModels = realListModels;
  }

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
