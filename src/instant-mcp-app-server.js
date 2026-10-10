'use strict';

// Trusted stdio adapter. The supplied JS is browser source, never require()'d
// or evaluated in this process. Only the generated HTML leaves this adapter.
const readline = require('node:readline');
const { readSource, renderHtml } = require('./instant-mcp-apps.js');
const { MIME_TYPE } = require('./mcp-apps.js');
const projectDir = process.argv[2];
const filename = process.argv[3];
const name = process.argv[4] || 'On-the-fly app';
const uri = 'ui://mouaif/instant-app';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message || {};
  if (id === undefined) return;
  try {
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: '2025-06-18', serverInfo: { name, version: '1' }, capabilities: { tools: {}, resources: {} } };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') {
      result = { tools: [{ name: 'view', description: 'Open ' + name + ', a local single-file MCP App.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, _meta: { ui: { resourceUri: uri } } }] };
    } else if (method === 'resources/list') {
      result = { resources: [{ uri, name, mimeType: MIME_TYPE }] };
    } else if (method === 'resources/read') {
      if (params?.uri !== uri) throw new Error('Unknown app resource');
      const { source, kind } = readSource(projectDir, filename);
      result = { contents: [{ uri, mimeType: MIME_TYPE, text: renderHtml(source, kind, name),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
    } else if (method === 'tools/call') {
      if (params?.name !== 'view') throw new Error('Unknown app tool');
      const { source, kind } = readSource(projectDir, filename);
      renderHtml(source, kind, name); // typed fallback if the source is unavailable
      result = { content: [{ type: 'text', text: name + ' is ready. Open its interactive MCP App card.' }] };
    } else {
      send({ id, error: { code: -32601, message: 'Unknown method: ' + method } });
      return;
    }
    send({ id, result });
  } catch (error) {
    if (method === 'tools/call') send({ id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
    else send({ id, error: { code: -32602, message: error.message } });
  }
});
