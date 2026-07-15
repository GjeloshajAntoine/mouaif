#!/usr/bin/env node
// Minimal MCP server for testing the mouaif MCP client.
// Exposes one tool: `echo` (echoes the `text` arg), and one tool:
// `add` (adds two numbers). Talks MCP over stdio.
'use strict';

const readline = require('readline');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the text argument verbatim.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend.' },
        b: { type: 'number', description: 'Second addend.' }
      },
      required: ['a', 'b'],
      additionalProperties: false
    }
  }
];

const SERVER_INFO = { name: 'mouaif-test-mcp', version: '1.0.0' };
const CAPABILITIES = { tools: {} };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function callTool(name, args) {
  if (name === 'echo') {
    const text = (args && typeof args.text === 'string') ? args.text : '';
    return { content: [{ type: 'text', text: text }], isError: false };
  }
  if (name === 'add') {
    const a = Number(args && args.a);
    const b = Number(args && args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { content: [{ type: 'text', text: 'add: a and b must be numbers' }], isError: true };
    }
    return { content: [{ type: 'text', text: String(a + b) }], isError: false };
  }
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, { protocolVersion: '2024-11-05', serverInfo: SERVER_INFO, capabilities: CAPABILITIES });
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // no-op
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const result = callTool(params && params.name, params && params.arguments);
    reply(id, result);
  } else {
    if (id !== undefined) error(id, -32601, 'Method not found: ' + method);
  }
});
