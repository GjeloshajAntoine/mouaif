// GitHub Copilot provider (docs/features/github-copilot.md).
//
// Offline: every GitHub / Copilot endpoint is served by a stubbed global
// fetch. Covers the device-flow sign-in (code request, pending → slow_down →
// token, token stored under the GitHub login), the chat path (GitHub token →
// short-lived Copilot token + per-account API host, request built with the
// Copilot token and editor headers), the live /models list with fallback to
// the curated catalog, and the host allow-list for `endpoints.api`.
'use strict';

const ai = require('../src/ai-endpoints.js');
const copilot = require('../src/oauth-github-copilot.js');
const auth = require('../src/auth.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function jsonRes(status, body, headers) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k) => (headers && headers[k]) || null },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

(async () => {
  try {
    // ---- device flow -------------------------------------------------------
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === copilot.GITHUB_DEVICE_CODE_URL) {
        return jsonRes(200, { device_code: 'DEV123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1 });
      }
      if (String(url) === copilot.GITHUB_TOKEN_URL) {
        polls++;
        if (polls === 1) return jsonRes(200, { error: 'authorization_pending' });
        if (polls === 2) return jsonRes(200, { error: 'slow_down', interval: 1 });
        return jsonRes(200, { access_token: 'gho_TEST', scope: 'read:user', token_type: 'bearer' });
      }
      if (String(url).endsWith('/user')) return jsonRes(200, { login: 'octo' });
      return jsonRes(404, {});
    };
    const stored = [];
    const flow = await copilot.startDeviceFlow({
      fetchImpl,
      setToken: async (p, a, b) => { stored.push({ p, a, b: JSON.parse(b) }); },
      sleep: () => new Promise((r) => setImmediate(r))
    });
    check('device flow returns the user code', flow.userCode === 'ABCD-1234' && flow.status === 'pending');
    check('device_code is not exposed to the browser', !('deviceCode' in flow) && !JSON.stringify(flow).includes('DEV123'));
    const devReq = calls.find((c) => c.url === copilot.GITHUB_DEVICE_CODE_URL);
    check('device code request carries the client id', /client_id=/.test(devReq.init.body));
    for (let i = 0; i < 50 && copilot.getDeviceFlow(flow.id).status === 'pending'; i++) await new Promise((r) => setTimeout(r, 5));
    const done = copilot.getDeviceFlow(flow.id);
    check('device flow resolves after pending + slow_down', done.status === 'ok' && done.account === 'octo', JSON.stringify(done));
    check('token stored under the GitHub login', stored.length === 1 && stored[0].p === 'github-copilot' && stored[0].a === 'octo' && stored[0].b.accessToken === 'gho_TEST');
    const pollReq = calls.find((c) => c.url === copilot.GITHUB_TOKEN_URL);
    check('poll uses the device_code grant', /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/.test(pollReq.init.body));

    // denied
    const deniedFetch = async (url) => String(url) === copilot.GITHUB_DEVICE_CODE_URL
      ? jsonRes(200, { device_code: 'D2', user_code: 'WXYZ-0000', expires_in: 60, interval: 1 })
      : jsonRes(200, { error: 'access_denied' });
    const f2 = await copilot.startDeviceFlow({ fetchImpl: deniedFetch, setToken: async () => {}, sleep: () => new Promise((r) => setImmediate(r)) });
    for (let i = 0; i < 50 && copilot.getDeviceFlow(f2.id).status === 'pending'; i++) await new Promise((r) => setTimeout(r, 5));
    check('declined sign-in reports denied', copilot.getDeviceFlow(f2.id).status === 'denied');

    // cancel
    const f3 = await copilot.startDeviceFlow({ fetchImpl: async (url) => String(url) === copilot.GITHUB_DEVICE_CODE_URL
      ? jsonRes(200, { device_code: 'D3', user_code: 'QQQQ-1111', expires_in: 60, interval: 1 })
      : jsonRes(200, { error: 'authorization_pending' }), setToken: async () => {}, sleep: () => new Promise((r) => setTimeout(r, 5)) });
    check('cancel works', copilot.cancelDeviceFlow(f3.id) === true && copilot.getDeviceFlow(f3.id).status === 'cancelled');

    // device flow disabled on a custom app
    let disabledErr = null;
    try { await copilot.requestDeviceCode({ fetchImpl: async () => jsonRes(400, { error: 'device_flow_disabled' }) }); }
    catch (e) { disabledErr = e; }
    check('device_flow_disabled is a typed error', disabledErr && disabledErr.code === 'EDEVICE_DISABLED');

    // ---- api host allow-list ----------------------------------------------
    check('business host accepted', ai.safeCopilotApiBase('https://api.business.githubcopilot.com') === 'https://api.business.githubcopilot.com');
    check('foreign host rejected', ai.safeCopilotApiBase('https://evil.example.com') === null);
    check('lookalike host rejected', ai.safeCopilotApiBase('https://githubcopilot.com.evil.io') === null);
    check('http rejected', ai.safeCopilotApiBase('http://api.githubcopilot.com') === null);

    // ---- chat path + live models ------------------------------------------
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      if (String(url) === copilot.COPILOT_TOKEN_URL) {
        return jsonRes(200, { token: 'tid=COPILOT', expires_at: Math.floor(Date.now() / 1000) + 1800, endpoints: { api: 'https://api.business.githubcopilot.com' } });
      }
      if (String(url) === 'https://api.business.githubcopilot.com/models') {
        return jsonRes(200, { data: [
          { id: 'gpt-4o', name: 'GPT-4o', capabilities: { type: 'chat', limits: { max_context_window_tokens: 128000 } }, model_picker_enabled: true },
          { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', capabilities: { type: 'chat' }, policy: { state: 'enabled' } },
          { id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } },
          { id: 'o-disabled', capabilities: { type: 'chat' }, policy: { state: 'disabled' } }
        ] });
      }
      return jsonRes(404, {});
    };
    const origToken = auth.tokenForModel;
    const origResolve = auth.resolveAccount;
    auth.tokenForModel = () => JSON.stringify({ accessToken: 'gho_TEST', refreshToken: null, expiresAt: null });
    auth.resolveAccount = () => 'octo';
    try {
      ai.copilotCacheClear();
      const model = { id: 'gpt-4o', provider: 'github-copilot', auth: 'oauth', baseUrl: 'https://api.githubcopilot.com' };
      await ai.requireApiKey(model, ai.ENDPOINTS['github-copilot']);
      check('chat uses the short-lived Copilot token', model.__accessToken === 'tid=COPILOT');
      check('chat uses the per-account API host', model.baseUrl === 'https://api.business.githubcopilot.com');
      const exReq = seen.find((c) => c.url === copilot.COPILOT_TOKEN_URL);
      check('exchange authenticates with the GitHub token', exReq && exReq.init.headers.Authorization === 'Bearer gho_TEST');
      const req = ai.BUILDERS['github-copilot'](model, [{ role: 'user', content: 'hi' }], true, [], {});
      check('request goes to <host>/chat/completions', req.url === 'https://api.business.githubcopilot.com/chat/completions', req.url);
      check('request carries Copilot bearer + editor headers', req.headers.Authorization === 'Bearer tid=COPILOT' && !!req.headers['Editor-Version'] && !!req.headers['Copilot-Integration-Id']);

      const pinned = { id: 'gpt-4o', provider: 'github-copilot', auth: 'oauth', baseUrl: 'https://proxy.githubcopilot.com' };
      await ai.requireApiKey(pinned, ai.ENDPOINTS['github-copilot']);
      check('a custom base URL on the record is kept', pinned.baseUrl === 'https://proxy.githubcopilot.com');

      const live = await ai.listModels('github-copilot', 'gho_TEST');
      const ids = live.map((m) => m.id);
      check('live list includes enabled chat models', ids.includes('gpt-4o') && ids.includes('claude-sonnet-4.5'));
      check('live list drops embeddings and disabled models', !ids.includes('text-embedding-3-small') && !ids.includes('o-disabled'));
      check('live list keeps context windows', live.find((m) => m.id === 'gpt-4o').contextWindow === 128000);
      check('claude rows get a thinking budget', (live.find((m) => m.id === 'claude-sonnet-4.5').thinking || {}).kind === 'budget');

      const noCred = await ai.listModels('github-copilot', null);
      check('no credential falls back to the curated catalog', noCred.length === ai.COPILOT_MODEL_CATALOG.length);
    } finally {
      globalThis.fetch = realFetch;
      auth.tokenForModel = origToken;
      auth.resolveAccount = origResolve;
    }
  } catch (e) {
    failed++;
    console.log('FAIL  unexpected error  ' + ((e && e.stack) || e));
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
