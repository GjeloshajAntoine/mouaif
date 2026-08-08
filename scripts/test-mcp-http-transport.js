'use strict';

// Smoke test for MCP Streamable HTTP transport support in src/mcp.js.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { z } = require('zod');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-http-transport-'));
process.env.MOUAIF_HOME = TMP;

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const mcp = require('../src/mcp.js');
const settings = require('../src/settings.js');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-http-proj-'));
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function startHttpMcp() {
  const server = new McpServer({ name: 'http-test', version: '1.0.0' });
  server.registerTool('add', {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() }
  }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));

  const transports = new Map();
  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const sid = req.headers['mcp-session-id'];
    let transport = sid && transports.get(sid);
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => transports.set(sessionId, transport)
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, url: `http://127.0.0.1:${httpServer.address().port}/mcp` };
}

async function main() {
  const { httpServer, url } = await startHttpMcp();
  try {
    const server = mcp.addServer(projectDir, {
      name: 'HTTP Test',
      transport: 'http',
      url,
      headers: { 'X-Test': 'ok' }
    });
    check('addServer accepts http transport', server && server.transport === 'http' && server.url === url);
    check('headers are redacted', server && server.headers && server.headers['X-Test'] && server.headers['X-Test'].configured === true);

    const started = await mcp.startServer(projectDir, server.id);
    check('startServer http ready', started.status === 'ready', 'got: ' + started.status);
    check('startServer http discovers tools', Array.isArray(started.tools) && started.tools.some(t => t.name === 'add'));

    const out = await mcp.callTool(projectDir, started.slug, 'add', { a: 20, b: 22 });
    check('callTool over http works', out && out.ok === true && out.content[0].text === '42', JSON.stringify(out));

    await mcp.stopServer(projectDir, server.id);
    mcp.removeServer(projectDir, server.id);
  } finally {
    await mcp.stopAll();
    await new Promise((resolve) => httpServer.close(resolve));
    settings.close();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
