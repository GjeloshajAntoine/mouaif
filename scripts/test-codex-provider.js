'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-codex-'));
const auth = require('../src/auth.js');
const ai = require('../src/ai.js');
const { requireApiKey } = require('../src/ai-endpoints.js');
const oauth = require('../src/oauth-codex.js');
const jwt = (claims) => 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
const accessToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-1' } });
const idToken = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-1' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const event = (type, body) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...body }) + '\n\n';
const parse = (type, body) => [...ai.PARSERS.codex(type, JSON.stringify({ type, ...body }))];
const realFetch = global.fetch;
const realToken = auth.tokenForModel;
const realResolve = auth.resolveAccount;
const realSet = auth.setToken;

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('Timed out waiting for mock device flow');
}

(async () => {
  let server;
  try {
    assert.ok(auth.SUPPORTED_PROVIDERS.includes('codex'));
    assert.equal(auth.authProviderFor({ provider: 'codex' }), 'codex');
    oauth.register();
    assert.equal(auth.getRefresher('codex'), oauth.refresh);
    await assert.rejects(requireApiKey({ provider: 'codex', id: 'test', apiKey: 'not-chatgpt' }, ai.ENDPOINTS.codex), { code: 'ENOAUTH' });
    assert.equal(oauth.accountIdFor('not-a-token'), null);
    assert.equal(oauth.accountIdFor(jwt(null)), null);
    const handler = fs.readFileSync(path.join(__dirname, '../src/server-handlers-chats.js'), 'utf8');
    const historyCheck = handler.match(/const supportsOpenAIToolHistory = ([\s\S]*?);/)[1];
    // The expression calls the shared supportsOpenAIToolLoop() helper, so the
    // eval scope supplies the real one from src/providerShapes.js rather than
    // stubbing the answer — this pins that the mirror resolves through it.
    const { supportsOpenAIToolLoop } = require('../src/providerShapes.js');
    assert.equal(Function('model', 'supportsOpenAIToolLoop', 'return ' + historyCheck)({ provider: 'codex' }, supportsOpenAIToolLoop), true,
    'Codex chat resumes must include historical tool calls/results');
    assert.equal(Function('model', 'supportsOpenAIToolLoop', 'return ' + historyCheck)({ provider: 'mistral' }, supportsOpenAIToolLoop), true,
    'a cloud provider chat resumes with its historical tool calls/results');
    assert.equal(Function('model', 'supportsOpenAIToolLoop', 'return ' + historyCheck)({ provider: 'ollama' }, supportsOpenAIToolLoop), false,
    'Ollama history stays free of tool records the native /api/chat misreads');
    const replay = require('../src/messages.js').reconstructUpstreamHistory([
    { role: 'user', content: 'Inspect' },
    { role: 'tool', phase: 'call', toolCallId: 'history-1', name: 'list_features', args: {} },
    { role: 'tool', phase: 'result', toolCallId: 'history-1', name: 'list_features', content: '{"ok":true}' },
    { role: 'tool', phase: 'call', toolCallId: 'orphan', name: 'list_features', args: {} }
    ]);
    const replayBody = ai.BUILDERS.codex({ id: 'test' }, replay, true).body;
    assert.equal(replayBody.input[1].type, 'function_call');
    assert.equal(replayBody.input[2].type, 'function_call_output');
    assert.equal(replayBody.input[1].call_id, replayBody.input[2].call_id);
    assert.equal(replayBody.input.length, 3, 'orphan calls are excluded');

    const steps = [];
    const stored = [];
    let polls = 0;
    const deviceFetch = async (url, init) => {
      steps.push({ url, init });
      if (url.endsWith('/usercode')) return json({ device_auth_id: 'PRIVATE_DEVICE', usercode: 'ABCD-EFGH', interval: '1' });
      if (url.endsWith('/deviceauth/token')) return ++polls === 1 ? json({}, 403)
        : json({ authorization_code: 'AUTH_CODE', code_verifier: 'PKCE_VERIFIER' });
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('client_id'), oauth.CLIENT_ID);
      assert.equal(params.get('code_verifier'), 'PKCE_VERIFIER');
      assert.equal(params.get('redirect_uri'), oauth.ISSUER + '/deviceauth/callback');
      return json({ access_token: accessToken, refresh_token: 'REFRESH', id_token: idToken, expires_in: 3600 });
    };
    const flow = await oauth.startDeviceFlow({ fetchImpl: deviceFetch, sleep: async () => {},
      setToken: async (...args) => stored.push(args) });
    assert.equal(flow.verificationUri, 'https://auth.openai.com/codex/device');
    assert.equal(flow.userCode, 'ABCD-EFGH');
    assert.ok(!JSON.stringify(flow).includes('PRIVATE_DEVICE'));
    await waitFor(() => oauth.getDeviceFlow(flow.id).status === 'ok');
    assert.equal(stored[0][0], 'codex');
    assert.equal(stored[0][1], 'me@example.com (workspace-1)');
    assert.equal(JSON.parse(stored[0][2]).chatgptAccountId, 'workspace-1');
    assert.ok(!JSON.stringify(oauth.getDeviceFlow(flow.id)).includes(accessToken));

    let release;
    const cancelled = await oauth.startDeviceFlow({ fetchImpl: deviceFetch,
      sleep: () => new Promise((r) => { release = r; }), setToken: async () => { throw new Error('must not store'); } });
    assert.equal(oauth.cancelDeviceFlow(cancelled.id), true);
    release();
    assert.equal(oauth.getDeviceFlow(cancelled.id).status, 'cancelled');
    assert.equal(oauth.getDeviceFlow('missing'), null);
    await assert.rejects(oauth.startDeviceFlow({ fetchImpl: async () => json({}, 404) }), { code: 'EOAUTH' });
    await assert.rejects(oauth.startDeviceFlow({ fetchImpl: async () => json({}) }), { code: 'EPARSE' });
    const failed = await oauth.startDeviceFlow({ fetchImpl: async (url) => url.endsWith('/usercode')
      ? json({ device_auth_id: 'private', user_code: 'XYZ' }) : json({}, 500), sleep: async () => {} });
    await waitFor(() => oauth.getDeviceFlow(failed.id).status === 'error');

    let refreshCalls = 0;
    global.fetch = async (_url, init) => {
      refreshCalls++;
      assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
      return json({ access_token: accessToken, refresh_token: 'ROTATED', expires_in: 3600 });
    };
    await Promise.all([oauth.refresh({ refreshToken: 'SHARED' }), oauth.refresh({ refreshToken: 'SHARED' })]);
    assert.equal(refreshCalls, 1, 'concurrent rotating refresh is deduplicated');
    auth.resolveAccount = () => 'me@example.com (workspace-1)';
    auth.tokenForModel = () => JSON.stringify({ accessToken: 'old', refreshToken: 'OLD', chatgptAccountId: 'workspace-1', expiresAt: 0 });
    auth.setToken = async (...args) => stored.push(args);
    const model = { id: 'gpt-codex', provider: 'codex', auth: 'oauth', thinkingLevel: 'high' };
    await requireApiKey(model, ai.ENDPOINTS.codex);
    assert.equal(model.__accessToken, accessToken);
    assert.equal(model.__chatgptAccountId, 'workspace-1');
    assert.equal(JSON.parse(stored.at(-1)[2]).refreshToken, 'ROTATED');
    assert.equal(stored.at(-1)[1], 'me@example.com (workspace-1)');

    const specs = [require('../src/tools/progress.js').SPEC];
    const request = ai.BUILDERS.codex(model, [
      { role: 'system', content: 'Be helpful.' }, { role: 'developer', content: 'Keep it short.' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } }] },
      { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'call-1', function: { name: 'report_progress', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' }
    ], true, specs, { promptCacheKey: 'chat-stable' });
    assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(request.headers['ChatGPT-Account-Id'], 'workspace-1');
    assert.equal(request.headers.Authorization, 'Bearer ' + accessToken);
    assert.equal(request.body.store, false);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.instructions, 'Be helpful.\n\nKeep it short.');
    assert.equal(request.body.tools[0].name, 'report_progress');
    assert.equal(request.body.tools[0].function, undefined);
    assert.equal(request.body.input[0].content[1].type, 'input_image');
    assert.equal(request.body.input[1].content[0].type, 'output_text');
    assert.equal(request.body.input[2].call_id, 'call-1');
    assert.equal(request.body.input[3].type, 'function_call_output');
    assert.equal(request.body.reasoning.effort, 'high');
    assert.equal(request.body.prompt_cache_key, 'chat-stable');
    assert.equal(ai.BUILDERS.codex({ ...model, maxOutputTokens: '123' }, [], true).body.max_output_tokens, undefined);

    assert.equal(parse('response.output_text.delta', { delta: 'Hi' })[0].data.delta, 'Hi');
    assert.equal(parse('response.reasoning_summary_text.delta', { delta: 'Think' })[0].name, 'reasoning');
    assert.equal(parse('response.function_call_arguments.delta', { delta: '{}' }).length, 0);
    assert.equal(parse('response.output_item.done', { output_index: 2, item: { type: 'function_call', call_id: 'call', name: 'fn', arguments: '{}' } })[0].data.index, 2);
    assert.equal(parse('response.completed', { response: { usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 7 } } } })[0].data.usage.cacheReadTokens, 7);
    assert.equal(parse('response.failed', { response: { error: { message: 'Denied' } } })[0].data.message, 'Denied');
    assert.equal(parse('response.incomplete', {})[0].name, 'error');

    global.fetch = async (url, init) => {
      assert.ok(url.includes('/models?client_version='));
      assert.equal(init.headers['ChatGPT-Account-Id'], 'workspace-1');
      return json({ models: [{ slug: 'gpt-codex', display_name: 'Codex', context_window: 200000, visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], input_modalities: ['text', 'image'] },
      { slug: 'hidden', visibility: 'hide' }] });
    };
    const models = await ai.listModels('codex', accessToken);
    assert.equal(models.length, 1);
    assert.equal(models[0].contextWindow, 200000);
    assert.deepEqual(models[0].thinking.levels, ['low', 'high']);
    await assert.rejects(ai.listModels('codex', null), { code: 'ENO_APIKEY' });
    global.fetch = async () => json({}, 401);
    await assert.rejects(ai.listModels('codex', accessToken), { code: 'EUPSTREAM', status: 401 });

    // Exercise the real shared loop: function_call -> dispatch -> Responses
    // function_call_output -> final answer. No separate Codex executor.
    auth.tokenForModel = () => JSON.stringify({ accessToken, chatgptAccountId: 'workspace-1', expiresAt: Date.now() + 3600000 });
    let rounds = 0;
    const events = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tools[0].name, 'list_features');
      const stream = ++rounds === 1
        ? event('response.output_item.done', { output_index: 0, item: { type: 'function_call', call_id: 'features-1', name: 'list_features', arguments: '{}' } })
        : event('response.output_text.delta', { delta: 'Codex works.' });
      if (rounds === 2) assert.ok(body.input.some((i) => i.type === 'function_call_output' && i.call_id === 'features-1'));
      return new Response(stream + event('response.completed', { response: { usage: { input_tokens: 20, output_tokens: 5 } } }),
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const result = await ai.streamChat({ model: { ...model }, messages: [{ role: 'user', content: 'Hello' }],
      enabledTools: ['list_features'], onEvent: (name, data) => events.push({ name, data }) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(rounds, 2);
    assert.ok(events.some((e) => e.name === 'tool_result'));
    assert.ok(events.some((e) => e.name === 'message' && e.data.delta === 'Codex works.'));

    // Isolated HTTP server tests startup/route registration; never run serve
    // or alter the host app's running server.
    global.fetch = realFetch;
    server = require('../src/index.js').createServer(0);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const routeFlow = await oauth.startDeviceFlow({ fetchImpl: deviceFetch,
    sleep: () => new Promise((r) => { release = r; }) });
    const oldStart = oauth.startDeviceFlow;
    oauth.startDeviceFlow = async () => oauth.getDeviceFlow(routeFlow.id);
    try {
    const response = await fetch(base + '/api/auth/device/codex', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');
    assert.equal((await fetch(base + '/api/auth/device/codex?id=' + routeFlow.id)).status, 200);
    assert.equal((await fetch(base + '/api/auth/device/codex?id=missing')).status, 404);
    assert.equal((await fetch(base + '/api/auth/device/codex')).status, 400);
    assert.equal((await (await fetch(base + '/api/auth/device/codex?id=' + routeFlow.id, { method: 'DELETE' })).json()).ok, true);
    } finally { oauth.startDeviceFlow = oldStart; oauth.cancelDeviceFlow(routeFlow.id); release(); }
    console.log('PASS Codex: OAuth device flow/cancel/errors, refresh, catalog, Responses shapes, streaming tools, HTTP startup/routes');
  } finally {
    global.fetch = realFetch;
    auth.tokenForModel = realToken;
    auth.resolveAccount = realResolve;
    auth.setToken = realSet;
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    require('../src/settings.js').close();
    fs.rmSync(process.env.MOUAIF_HOME, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
