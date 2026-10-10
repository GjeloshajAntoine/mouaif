'use strict';
const readline = require('readline');
const uri = 'ui://fixture/view';
let revision = 1;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'apps-fixture', version: '1' }, capabilities: { tools: {}, resources: { listChanged: true } } });
  else if (method === 'tools/list') reply({ tools: [
    { name: 'view', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: uri } } },
    { name: 'edit', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
    { name: 'model', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } }
  ] });
  else if (method === 'resources/read') {
    const result = { contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: process.argv[2] ? require('node:fs').readFileSync(process.argv[2], 'utf8') : '<!doctype html><p>' + revision + '</p>', _meta: { ui: { csp: { connectDomains: [] } } } }] };
    if (params.uri.endsWith('/race')) {
      send({ method: 'notifications/resources/updated', params: { uri: params.uri } });
      setTimeout(() => reply(result), 40);
    } else if (params.uri.endsWith('/slow')) setTimeout(() => reply(result), 200);
    else reply(result);
  } else if (method === 'tools/call') {
    if (params.name === 'view') {
      revision++;
      send({ method: 'notifications/resources/updated', params: { uri } });
    }
    reply({ content: [{ type: 'text', text: 'text fallback' }] });
  } else if (method === 'ping') reply({});
  else if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } });
});
