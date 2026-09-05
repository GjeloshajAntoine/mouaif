'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-oauth-'));
process.env.MOUAIF_HOME = home;

// CI has no keychain daemon. Replace only the keychain adapter; exercise the
// actual SDK discovery, DCR, PKCE, refresh, HTTP transport, and REST handlers.
const credentials = new Map();
const keyringPath = require.resolve('@napi-rs/keyring');
require.cache[keyringPath] = { id: keyringPath, filename: keyringPath, loaded: true, exports: {
  Entry: class {
    constructor(service, account) { this.key = service + '/' + account; }
    getPassword() { if (!credentials.has(this.key)) throw new Error('not found'); return credentials.get(this.key); }
    setPassword(value) { credentials.set(this.key, value); }
    deletePassword() { credentials.delete(this.key); }
  }
} };
const mcp = require('../src/mcp.js');
const oauth = require('../src/oauth-mcp.js');
const { createServer } = require('../src/index.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const settings = require('../src/settings.js');
const registered = new Map();
let challenge;
let acceptedToken = 'initial-access';
let refreshes = 0;
let callbackOrigin;
const transports = [];
let upstreamOrigin;
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req) { let text = ''; for await (const chunk of req) text += chunk; return text; }
const upstream = http.createServer(async (req, res) => {
  try {
    if (req.url === '/protected-resource') return json(res, { resource: upstreamOrigin + '/mcp', authorization_servers: [upstreamOrigin] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return json(res, {
      issuer: upstreamOrigin, authorization_endpoint: upstreamOrigin + '/authorize', token_endpoint: upstreamOrigin + '/token',
      registration_endpoint: upstreamOrigin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    });
    if (req.url === '/register') {
      assert.equal(req.headers['x-mcp-secret'], undefined);
      const metadata = JSON.parse(await readBody(req));
      assert.deepEqual(metadata.redirect_uris, [callbackOrigin + '/oauth/mcp/callback']);
      assert.equal(metadata.token_endpoint_auth_method, 'none');
      const client = { ...metadata, client_id: 'client-' + registered.size };
      registered.set(client.client_id, client);
      return json(res, client, 201);
    }
    if (req.url === '/token') {
      assert.equal(req.headers['x-mcp-secret'], undefined);
      const params = new URLSearchParams(await readBody(req));
      if (params.get('grant_type') === 'refresh_token') {
        assert.equal(params.get('refresh_token'), 'refresh-secret');
        refreshes++;
        return json(res, { access_token: acceptedToken, token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(params.get('code'), 'valid-code');
      assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      assert.equal(params.get('redirect_uri'), callbackOrigin + '/oauth/mcp/callback');
      return json(res, { access_token: acceptedToken, refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.url === '/mcp') {
      if (req.headers.authorization !== 'Bearer ' + acceptedToken) {
        res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + upstreamOrigin + '/protected-resource", scope="tools:read"');
        return json(res, {}, 401);
      }
      assert.equal(req.headers['x-mcp-secret'], 'local-only');
      const server = new McpServer({ name: 'oauth-test', version: '1.0' });
      server.registerTool('hello', { description: 'Hello', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'OAuth works' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.push(transport);
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404).end();
  } catch (e) { console.error(e); json(res, { error: 'test failure' }, 500); }
});
const app = createServer({ authEnabled: false });
let base;
async function request(route, method = 'GET', body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function main() {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  base = callbackOrigin = 'http://127.0.0.1:' + app.address().port;
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const entry = mcp.addServer(project, { name: 'OAuth', transport: 'http', url: upstreamOrigin + '/mcp', oauth: { enabled: true }, headers: { Authorization: 'must-not-win', 'X-Mcp-Secret': 'local-only' } });
  const route = '/api/mcp/servers/' + entry.id + '/oauth';
  const qs = '?projectDir=' + encodeURIComponent(project);
  assert.equal((await request(route + qs)).data.connected, false);
  assert.equal((await request(route + '/start', 'POST', { projectDir: project }, { Origin: 'https://evil.example' })).status, 403);
  const started = await request(route + '/start', 'POST', { projectDir: project });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const authorization = new URL(started.data.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'tools:read');
  challenge = authorization.searchParams.get('code_challenge');
  const state = authorization.searchParams.get('state');
  assert.ok(state.length >= 32);
  assert.equal((await request('/oauth/mcp/callback?state=bad&code=valid-code')).status, 400);
  const callback = '/oauth/mcp/callback?state=' + state + '&code=valid-code';
  const finished = await request(callback, 'GET', undefined, { Origin: 'https://identity.example' });
  assert.equal(finished.status, 200);
  assert.equal(finished.headers.get('cache-control'), 'no-store');
  assert.equal((await request(callback)).status, 400, 'callback cannot be replayed');
  assert.equal((await request(route + qs)).data.connected, true);
  assert.equal((await mcp.startServer(project, entry.id)).status, 'ready');
  const output = await mcp.callTool(project, entry.slug, 'hello', {});
  assert.equal(output.content[0].text, 'OAuth works');
  acceptedToken = 'refreshed-access';
  const refreshed = await mcp.callTool(project, entry.slug, 'hello', {});
  assert.equal(refreshed.content[0].text, 'OAuth works');
  assert.equal(refreshes, 1);
  const stored = JSON.stringify([...credentials.values()]);
  assert.ok(stored.includes('refresh-secret'), 'refresh token survives a refresh response without rotation');
  const config = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
  assert.ok(!config.includes('access_token') && !config.includes('refresh-secret'));
  assert.ok(!JSON.stringify((await request('/api/mcp/servers' + qs)).data).includes('refreshed-access'));
  const context = mcp.getOAuthContext(project, entry.id);
  const other = { ...context, projectDir: path.join(home, 'other') };
  assert.notEqual(oauth.identity(context), oauth.identity(other));
  assert.equal(oauth.identity({ ...context, scope: 'app' }), oauth.identity({ ...other, scope: 'app' }));
  const oldProvider = oauth.provider(context);
  assert.equal((await request(route + qs, 'DELETE')).status, 200);
  assert.equal((await request(route + qs)).data.connected, false);
  assert.equal(mcp._sessions.size, 0);
  assert.throws(() => oldProvider.saveTokens({ access_token: 'late' }), /cancelled/);
  const second = await request(route + '/start', 'POST', { projectDir: project });
  const secondState = new URL(second.data.authorizationUrl).searchParams.get('state');
  assert.equal((await request('/oauth/mcp/callback?state=' + secondState + '&error=access_denied')).status, 400);
  assert.equal((await request(route + qs)).data.pending, false);
  const third = await request(route + '/start', 'POST', { projectDir: project });
  const thirdState = new URL(third.data.authorizationUrl).searchParams.get('state');
  mcp.updateServer(project, entry.id, { oauth: { enabled: true, clientId: 'public-client' } });
  assert.equal((await request('/oauth/mcp/callback?state=' + thirdState + '&code=valid-code')).status, 400);
  const registrationsBefore = registered.size;
  const manual = await request(route + '/start', 'POST', { projectDir: project });
  assert.equal(manual.status, 200);
  assert.equal(new URL(manual.data.authorizationUrl).searchParams.get('client_id'), 'public-client');
  assert.equal(registered.size, registrationsBefore, 'public client ID skips dynamic registration');
  const manualState = new URL(manual.data.authorizationUrl).searchParams.get('state');
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try { assert.equal((await request('/oauth/mcp/callback?state=' + manualState + '&code=valid-code')).status, 400); }
  finally { Date.now = realNow; }
  const fourth = await request(route + '/start', 'POST', { projectDir: project });
  const fourthState = new URL(fourth.data.authorizationUrl).searchParams.get('state');
  mcp.removeServer(project, entry.id);
  assert.equal((await request('/oauth/mcp/callback?state=' + fourthState + '&code=valid-code')).status, 400);
  assert.equal((await request(route + qs)).status, 404);
  const unavailable = oauth.createManager({
    storage: { read: () => { throw Object.assign(new Error('Keychain unavailable'), { code: 'EKEYRING' }); } },
    resolveContext: () => context
  });
  assert.throws(() => unavailable.status(context), { code: 'EKEYRING' });
  assert.throws(() => oauth.safeUrl('http://example.com/mcp'), /HTTPS/);
  assert.throws(() => oauth.safeUrl('https://user:pass@example.com/mcp'), /without credentials/);
  assert.equal((await request('/')).status, 200, 'serve UI still works');
  console.log('MCP OAuth: discovery, DCR, PKCE, state/replay, tool call, refresh, redaction, scope isolation, cancellation, configuration changes, CSRF and serve smoke passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await mcp.stopAll();
  for (const transport of transports) await transport.close();
  app.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  settings.close();
});
