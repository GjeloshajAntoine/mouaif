#!/usr/bin/env node
// Minimal stdio MCP server for scripts/test-mcp-tool-names.js. Advertises
// tool names that providers reject verbatim (dots, slashes, > 64 chars
// once prefixed) plus one plain name. Every call echoes the raw name it
// received so the test can prove the sanitized name was mapped back.
'use strict';

const readline = require('readline');

const NAMES = [
  'plain_tool',
  'a.b',
  'some.dotted/tool_with_a_rather_long_name_that_keeps_going_and_going'
];
const TOOLS = NAMES.map((name) => ({ name, description: 'probe', inputSchema: { type: 'object', properties: {} } }));

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'names-test', version: '1.0.0' }, capabilities: { tools: {} } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (!NAMES.includes(name)) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'called:' + name }], isError: false } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
