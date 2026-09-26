#!/usr/bin/env node
// Minimal stdio MCP server for scripts/test-mcp-crash-midcall.js.
// Tools: `echo` (echoes `text`) and `die` (accepts the call, then exits
// the process without ever replying — a server crashing mid-request).
'use strict';

const readline = require('readline');

const TOOLS = [
  { name: 'echo', description: 'Echo text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'die', description: 'Exit mid-call without replying.', inputSchema: { type: 'object', properties: {} } }
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'crash-test', version: '1.0.0' }, capabilities: { tools: {} } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (name === 'die') { setTimeout(() => process.exit(1), 20); return; }
    const text = params && params.arguments && typeof params.arguments.text === 'string' ? params.arguments.text : '';
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
