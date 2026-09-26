#!/usr/bin/env node
// Minimal stdio MCP server for scripts/test-mcp-cancel.js.
// Tools:
//   hang       — never replies (a slow/stuck tool).
//   cancelled  — replies with the request ids this server received a
//                notifications/cancelled for, so the test can prove the
//                client told the server to stop.
'use strict';

const readline = require('readline');

const TOOLS = [
  { name: 'hang', description: 'Never replies.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cancelled', description: 'List cancelled request ids.', inputSchema: { type: 'object', properties: {} } }
];
const cancelledIds = [];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'cancel-test', version: '1.0.0' }, capabilities: { tools: {} } } });
  } else if (method === 'notifications/cancelled') {
    if (params && params.requestId !== undefined) cancelledIds.push(params.requestId);
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (name === 'hang') return; // never reply
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(cancelledIds) }], isError: false } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
