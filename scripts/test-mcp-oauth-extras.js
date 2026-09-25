'use strict';

// MCP OAuth gaps (docs/features/mcp-oauth.md): legacy SSE transport,
// client_credentials grant, confidential-client secrets, and RFC 7009 remote
// revocation on Disconnect. Real SDK discovery / token / transport code runs
// against a local fixture authorization server + MCP server; only the OS
// keychain is replaced with an in-memory map.

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-oauth-x-'));
process.env.MOUAIF_HOME = home;

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
const { createServer } = require('../src/index.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const settings = require('../src/settings.js');

const CC_ID = 'machine-client';
const CC_SECRET = 'machine-secret-' + crypto.randomBytes(4).toString('hex');
const CONF_ID = 'confidential-client';
const CONF_SECRET = 'conf-secret';
let origin;
let tokenCounter = 0;
const validTokens = new Set();
const revoked = [];
const tokenRequests = [];
let challenge;
const httpTransports = [];
const sseTransports = new Map();

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req) { let t = ''; for await (const c of req) t += c; return t; }
function basic(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const [id, secret] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return { id, secret };
}
function mint(prefix) { const t = prefix + '-' + (++tokenCounter); validTokens.add(t); return t; }
function newMcp() {
  const server = new McpServer({ name: 'x', version: '1.0' });
  server.registerTool('ping', { description: 'Ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}
function authorized(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (validTokens.has(token)) return true;
  res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + origin + '/prm"');
  json(res, {}, 401);
  return false;
}

const upstream = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/prm') return json(res, { resource: origin + '/mcp', authorization_servers: [origin] });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, { resource: origin + url.pathname.replace('/.well-known/oauth-protected-resource', ''), authorization_servers: [origin] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(res, {
      issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
      revocation_endpoint: origin + '/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
    });
    if (url.pathname === '/token') {
      const params = new URLSearchParams(await readBody(req));
      const b = basic(req);
      const id = b ? b.id : params.get('client_id');
      const secret = b ? b.secret : params.get('client_secret');
      tokenRequests.push({ grant: params.get('grant_type'), id, viaBasic: !!b });
      if (params.get('grant_type') === 'client_credentials') {
        if (id !== CC_ID || secret !== CC_SECRET) return json(res, { error: 'invalid_client' }, 401);
        return json(res, { access_token: mint('cc'), token_type: 'Bearer', expires_in: 3600 });
      }
      if (params.get('grant_type') === 'authorization_code') {
        if (id !== CONF_ID || secret !== CONF_SECRET) return json(res, { error: 'invalid_client' }, 401);
        assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
        return json(res, { access_token: mint('ac'), refresh_token: 'rt-' + tokenCounter, token_type: 'Bearer', expires_in: 3600 });
      }
      return json(res, { error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/revoke') {
      const params = new URLSearchParams(await readBody(req));
      const b = basic(req);
      revoked.push({ token: params.get('token'), hint: params.get('token_type_hint'), id: b ? b.id : params.get('client_id'), viaBasic: !!b });
      validTokens.delete(params.get('token'));
      res.writeHead(200).end();
      return;
    }
    if (url.pathname === '/mcp') {
      if (!authorized(req, res)) return;
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      httpTransports.push(t);
      await newMcp().connect(t);
      await t.handleRequest(req, res);
      return;
    }
    // Legacy HTTP+SSE: GET /sse opens the stream, POST /messages?sessionId=…
    if (url.pathname === '/sse' && req.method === 'GET') {
      if (!authorized(req, res)) return;
      const t = new SSEServerTransport('/messages', res);
      sseTransports.set(t.sessionId, t);
      res.on('close', () => sseTransports.delete(t.sessionId));
      await newMcp().connect(t);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      if (!authorized(req, res)) return;
      assert.equal(req.headers['x-sse-extra'], 'kept', 'custom header reaches the SSE message endpoint');
      const t = sseTransports.get(url.searchParams.get('sessionId'));
      if (!t) return json(res, {}, 404);
      await t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  } catch (e) { console.error(e); if (!res.headersSent) json(res, { error: 'fixture failure' }, 500); }
});

const app = createServer({ authEnabled: false });
let base;
async function request(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function main() {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + app.address().port;
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const qs = '?projectDir=' + encodeURIComponent(project);

  // ---- client_credentials --------------------------------------------------
  const missing = await request('/api/mcp/servers', 'POST', { projectDir: project, scope: 'project', name: 'CC', transport: 'http', url: origin + '/mcp',
    oauth: { enabled: true, grant: 'client_credentials', clientId: CC_ID } });
  assert.equal(missing.status, 400, 'client credentials without a secret are rejected');

  const created = await request('/api/mcp/servers', 'POST', { projectDir: project, scope: 'project', name: 'CC', transport: 'http', url: origin + '/mcp',
    oauth: { enabled: true, grant: 'client_credentials', clientId: CC_ID, clientSecret: CC_SECRET } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const cc = created.data.server;
  assert.equal(cc.oauth.grant, 'client_credentials');
  assert.equal(cc.oauth.secretConfigured, true);
  assert.ok(!JSON.stringify(created.data).includes(CC_SECRET), 'secret never returned');
  assert.ok(!fs.readFileSync(path.join(project, '.mcp.json'), 'utf8').includes(CC_SECRET), 'secret never in .mcp.json');
  assert.ok([...credentials.values()].some((v) => v.includes(CC_SECRET)), 'secret stored in keychain');

  const route = '/api/mcp/servers/' + cc.id + '/oauth';
  const st0 = await request(route + qs);
  assert.equal(st0.data.grant, 'client_credentials');
  assert.equal(st0.data.connected, false);
  const connected = await request(route + '/start', 'POST', { projectDir: project });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  assert.equal(connected.data.connected, true);
  assert.ok(!('authorizationUrl' in connected.data), 'no browser step');
  const ccReq = tokenRequests.find((t) => t.grant === 'client_credentials');
  assert.ok(ccReq && ccReq.viaBasic && ccReq.id === CC_ID, 'client_secret_basic used');
  assert.equal((await mcp.startServer(project, cc.id)).status, 'ready');
  assert.equal((await mcp.callTool(project, cc.slug, 'ping', {})).content[0].text, 'pong');

  // An expired/revoked token is replaced without user action.
  validTokens.clear();
  await mcp.stopServer(project, cc.id);
  assert.equal((await mcp.startServer(project, cc.id)).status, 'ready', 'a 401 mints a new client-credentials token');

  // Disconnect revokes remotely, keeps the secret.
  const beforeRevoke = revoked.length;
  const dis = await request(route + qs, 'DELETE');
  assert.equal(dis.status, 200);
  assert.equal(dis.data.revoked, 'revoked');
  assert.ok(revoked.length > beforeRevoke && revoked[revoked.length - 1].viaBasic, 'revocation authenticates the confidential client');
  assert.equal((await request(route + qs)).data.connected, false);
  assert.equal((await request(route + qs)).data.secretConfigured, true, 'Disconnect keeps the client secret');

  // ---- confidential authorization_code client ----------------------------
  const conf = (await request('/api/mcp/servers', 'POST', { projectDir: project, scope: 'project', name: 'Conf', transport: 'http', url: origin + '/mcp',
    oauth: { enabled: true, clientId: CONF_ID, clientSecret: CONF_SECRET } })).data.server;
  assert.equal(conf.oauth.secretConfigured, true);
  const croute = '/api/mcp/servers/' + conf.id + '/oauth';
  const started = await request(croute + '/start', 'POST', { projectDir: project });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const au = new URL(started.data.authorizationUrl);
  assert.equal(au.searchParams.get('client_id'), CONF_ID);
  challenge = au.searchParams.get('code_challenge');
  const done = await request('/oauth/mcp/callback?state=' + au.searchParams.get('state') + '&code=good');
  assert.equal(done.status, 200, 'confidential exchange succeeds with the stored secret');
  const acReq = tokenRequests.find((t) => t.grant === 'authorization_code');
  assert.ok(acReq.viaBasic && acReq.id === CONF_ID);
  assert.equal((await request(croute + qs)).data.connected, true);

  // Revocation sends the refresh token first, then the access token.
  const n = revoked.length;
  const cdis = await request(croute + qs, 'DELETE');
  assert.equal(cdis.data.revoked, 'revoked');
  const hints = revoked.slice(n).map((r) => r.hint);
  assert.deepEqual(hints, ['refresh_token', 'access_token']);

  // Skip remote revocation on request.
  const n2 = revoked.length;
  assert.equal((await request(croute + qs + '&revoke=0', 'DELETE')).data.revoked, 'skipped');
  assert.equal(revoked.length, n2);

  // Clearing the secret; then turning OAuth off removes it from the keychain.
  const cleared = await request('/api/mcp/servers/' + conf.id + qs, 'PATCH', { oauth: { enabled: true, clientId: CONF_ID, clearClientSecret: true } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.server.oauth.secretConfigured, false);
  // CC server removal drops its secret.
  assert.equal((await request('/api/mcp/servers/' + cc.id + qs, 'DELETE')).status, 200);
  assert.ok(![...credentials.values()].some((v) => v.includes(CC_SECRET)), 'removing the server removes its secret');

  // ---- legacy SSE transport ------------------------------------------------
  const sse = (await request('/api/mcp/servers', 'POST', { projectDir: project, scope: 'project', name: 'Legacy', transport: 'sse', url: origin + '/sse',
    headers: { 'X-Sse-Extra': 'kept' },
    oauth: { enabled: true, grant: 'client_credentials', clientId: CC_ID, clientSecret: CC_SECRET } })).data.server;
  assert.equal(sse.transport, 'sse');
  const sseStart = await request('/api/mcp/servers/' + sse.id + '/oauth/start', 'POST', { projectDir: project });
  assert.equal(sseStart.data.connected, true);
  assert.equal((await mcp.startServer(project, sse.id)).status, 'ready', 'SSE transport connects');
  assert.equal((await mcp.callTool(project, sse.slug, 'ping', {})).content[0].text, 'pong', 'tool call over SSE');

  assert.throws(() => mcp.addServer(project, { scope: 'project', name: 'NoUrl', transport: 'sse' }), /url is required/);

  console.log('MCP OAuth extras: client credentials, confidential client secret, RFC 7009 revocation, secret lifecycle, and legacy SSE transport passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await mcp.stopAll();
  for (const t of httpTransports) { try { await t.close(); } catch { /* ignore */ } }
  for (const t of sseTransports.values()) { try { await t.close(); } catch { /* ignore */ } }
  app.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((r) => app.close(r)), new Promise((r) => upstream.close(r))]);
  settings.close();
});
