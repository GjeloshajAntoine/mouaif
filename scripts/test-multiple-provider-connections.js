'use strict';

// Several connections of one provider type.
//
// A connection's id used to be its type, so a second OpenAI-compatible server
// overwrote the first. Now the id names the connection and `type` names the wire
// shape. These tests pin what must stay separate (credential, base URL, model
// list, balance) and what must stay compatible (records saved before `type`
// existed, and clients that post `{ id: <type> }`).
//
// Two local HTTP servers stand in for two OpenAI-compatible upstreams, so a
// request that reaches the wrong connection fails on its URL and its key.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-multi-provider-'));
process.env.MOUAIF_ALLOW_ANY_ROOT = '1'; // the test project lives in the temp dir

const { createServer } = require('../src/index.js');
const settings = require('../src/settings.js');
const auth = require('../src/auth.js');
const shared = require('../src/server-shared.js');
const tools = require('../src/tools/mouaif.js');
const { nextConnectionId, connectionType } = require('../src/providerConnections.js');

function fakeUpstream(modelId) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization || '', body: raw });
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: modelId }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from ' + modelId } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
}

async function main() {
  const one = fakeUpstream('model-one');
  const two = fakeUpstream('model-two');
  const oneUrl = await listen(one.server) + '/v1';
  const twoUrl = await listen(two.server) + '/v1';
  const app = createServer(0, {});
  const origin = await listen(app);

  const request = async (method, url, body) => {
    const res = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an SSE stream stays text */ }
    return { status: res.status, body: json, text };
  };
  const post = (body) => request('POST', '/api/settings/app/providers', body);
  const stored = (id) => settings.getApp().providers.find((p) => p.id === id);

  try {
    // ---- Adding ------------------------------------------------------------
    let r = await post({ type: 'openai-compatible', baseUrl: oneUrl, apiKey: 'key-one' });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.id, 'openai-compatible', 'the first of a type takes the type name');
    assert.equal(r.body.provider.apiKey, undefined, 'the key never comes back');

    r = await post({ type: 'openai-compatible', name: '  Second server ', baseUrl: twoUrl, apiKey: 'key-two' });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.id, 'openai-compatible-2', 'the second gets its own id');
    assert.equal(r.body.provider.name, 'Second server');
    assert.equal(r.body.providers.length, 2, 'adding does not overwrite the first');
    assert.equal(stored('openai-compatible').apiKey, 'key-one');
    assert.equal(stored('openai-compatible-2').apiKey, 'key-two');

    assert.equal((await post({ type: 'nope' })).status, 400, 'an unknown type is refused');
    assert.equal((await post({})).status, 400, 'neither id nor type is refused');
    assert.equal((await post({ id: 'my-own-id', type: 'ollama' })).status, 400, 'the server picks new ids');
    assert.equal((await post({ type: 'ollama', name: 'x'.repeat(81) })).status, 400, 'an overlong name is refused');

    // ---- Updating ----------------------------------------------------------
    r = await post({ id: 'openai-compatible-2', name: 'Renamed' });
    assert.equal(r.status, 200);
    assert.equal(stored('openai-compatible-2').name, 'Renamed');
    assert.equal(stored('openai-compatible-2').apiKey, 'key-two', 'a save without a key keeps it');
    assert.equal(stored('openai-compatible-2').baseUrl, twoUrl);
    assert.equal(stored('openai-compatible').name, undefined, 'the sibling is untouched');

    assert.equal((await post({ id: 'openai-compatible-2', type: 'anthropic' })).status, 400, 'the type is fixed');
    assert.equal(stored('openai-compatible-2').type, 'openai-compatible');

    r = await post({ id: 'openai-compatible-2', name: '' });
    assert.equal(stored('openai-compatible-2').name, undefined, 'an empty name clears it');
    await post({ id: 'openai-compatible-2', name: 'Second server' });

    // ---- Requests go to the right connection -------------------------------
    const model = shared.resolveModel('anything', null, 'openai-compatible-2');
    assert.equal(model.provider, 'openai-compatible', 'builders branch on the type');
    assert.equal(model.providerId, 'openai-compatible-2', 'callers can still name the connection');
    assert.equal(model.apiKey, 'key-two');
    assert.equal(model.baseUrl, twoUrl);
    assert.equal(model.id, 'anything');
    assert.equal(model.name, undefined, 'the connection name stays off the model');
    assert.equal(model.type, undefined, 'the connection type stays off the model');

    r = await request('POST', '/api/ai/chat', {
      modelId: 'model-two', providerId: 'openai-compatible-2',
      messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(r.status, 200);
    assert.match(r.text, /hi from model-two/);
    const chatCall = two.seen.find((c) => c.url.endsWith('/chat/completions'));
    assert.ok(chatCall, 'the chat reached the second server');
    assert.equal(chatCall.authorization, 'Bearer key-two');
    assert.equal(one.seen.filter((c) => c.url.endsWith('/chat/completions')).length, 0, 'and not the first');

    // A project model refers to a connection by id.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-multi-provider-project-'));
    settings.setProject(projectDir, { models: [
      { id: 'pinned', provider: 'openai-compatible-2', label: 'Pinned', baseUrl: 'http://attacker.invalid', apiKey: 'nope' }
    ] });
    const pinned = shared.resolveModel('pinned', projectDir);
    assert.equal(pinned.provider, 'openai-compatible');
    assert.equal(pinned.baseUrl, twoUrl, 'a project file still cannot move a credential');
    assert.equal(pinned.apiKey, 'key-two');

    // ---- Model lists -------------------------------------------------------
    r = await request('GET', '/api/ai/models/live?provider=openai-compatible');
    assert.deepEqual(r.body.models.map((m) => m.id), ['model-one']);
    r = await request('GET', '/api/ai/models/live?provider=openai-compatible-2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.models.map((m) => m.id), ['model-two'], 'each connection lists its own server');
    assert.equal(two.seen.find((c) => c.url.endsWith('/models')).authorization, 'Bearer key-two');
    assert.equal((await request('GET', '/api/ai/models/live?provider=missing')).status, 400);

    r = await request('GET', '/api/ai/models/providers');
    assert.deepEqual(r.body.providers, [
      { id: 'openai-compatible', type: 'openai-compatible' },
      { id: 'openai-compatible-2', type: 'openai-compatible', name: 'Second server' }
    ]);

    // ---- Balance -----------------------------------------------------------
    // Asked of a connection id, so it must resolve the type before deciding the
    // provider has a balance route at all. A local server has none to report.
    r = await request('GET', '/api/ai/provider-credit?provider=openai-compatible-2');
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'openai-compatible-2');
    assert.equal(r.body.supported, false);
    assert.ok(two.seen.some((c) => c.url.includes('/dashboard/billing')), 'the second connection was the one asked');

    // ---- Dictation catalog -------------------------------------------------
    // The request family comes from the type, while the row must keep the
    // connection id or the picker's selection would resolve to the wrong one.
    settings.setProject(projectDir, { models: [
      { id: 'whisper-1', provider: 'openai-compatible-2' }
    ] });
    r = await request('GET', '/api/ai/transcribe/models?projectDir=' + encodeURIComponent(projectDir));
    assert.equal(r.status, 200);
    const whisper = r.body.models.find((m) => m.id === 'whisper-1' && m.source === 'project');
    assert.equal(whisper.provider, 'openai-compatible-2');
    assert.equal(whisper.kind, 'openai-compatible');
    assert.equal(whisper.connected, true);

    // ---- The mouaif tool ---------------------------------------------------
    const search = await tools.runMouaif({ action: 'model_search', providerId: 'openai-compatible-2', query: 'model-two' }, { projectDir });
    assert.ok(search.ok, search.content);
    assert.deepEqual(search.result.models.map((m) => m.providerId), ['openai-compatible-2']);

    // ---- OAuth: one account per connection ---------------------------------
    await auth.setToken('anthropic', 'a@example.com', JSON.stringify({ accessToken: 'token-a' }));
    await auth.setToken('anthropic', 'b@example.com', JSON.stringify({ accessToken: 'token-b' }));
    r = await post({ type: 'anthropic', auth: 'oauth', oauthAccount: 'a@example.com' });
    assert.equal(r.body.provider.id, 'anthropic');
    r = await post({ type: 'anthropic', auth: 'oauth', oauthAccount: 'b@example.com', name: 'Work' });
    assert.equal(r.body.provider.id, 'anthropic-2');
    assert.equal(shared.credentialForProvider('anthropic'), 'token-a');
    assert.equal(shared.credentialForProvider('anthropic-2'), 'token-b', 'the token namespace comes from the type');

    // ---- Records from before `type` ----------------------------------------
    settings.setApp({ providers: [{ id: 'ollama', baseUrl: 'http://127.0.0.1:1' }, { id: 'groq', apiKey: 'old-key' }] });
    assert.equal(connectionType(stored('groq')), 'groq');
    assert.equal(shared.resolveModel('llama', null, 'groq').provider, 'groq');
    assert.equal(shared.resolveModel('llama', null, 'groq').apiKey, 'old-key');
    assert.equal((await post({ id: 'groq', baseUrl: 'https://example.invalid/v1' })).status, 200, 'an old record can be updated');
    assert.equal(stored('groq').apiKey, 'old-key');
    r = await post({ id: 'mistral', apiKey: 'm' });
    assert.equal(r.status, 200, 'a client posting { id: <type> } still adds a connection');
    assert.equal(r.body.provider.id, 'mistral');
    assert.equal((await post({ id: 'not-a-type' })).status, 400);

    // ---- Deleting ----------------------------------------------------------
    await post({ type: 'groq', apiKey: 'groq-2' });
    r = await request('DELETE', '/api/settings/app/providers/groq');
    assert.equal(r.status, 200);
    assert.equal(stored('groq'), undefined);
    assert.equal(stored('groq-2').apiKey, 'groq-2', 'deleting one leaves its sibling');

    // ---- Ids ---------------------------------------------------------------
    assert.equal(nextConnectionId('groq', []), 'groq');
    assert.equal(nextConnectionId('groq', [{ id: 'groq' }]), 'groq-2');
    assert.equal(nextConnectionId('groq', [{ id: 'groq' }, { id: 'groq-2' }, { id: 'groq-4' }]), 'groq-3');
    assert.equal(nextConnectionId('groq', [{ id: 'groq-2' }]), 'groq', 'a freed type name is reused');

    console.log('ok - several connections of one provider type');
  } finally {
    await Promise.all([one.server, two.server, app].map((s) => new Promise((resolve) => {
      if (s.closeAllConnections) s.closeAllConnections();
      s.close(resolve);
    })));
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
