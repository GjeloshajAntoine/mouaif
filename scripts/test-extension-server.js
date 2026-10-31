#!/usr/bin/env node
// Minimal MCP server for the extension tests (scripts/test-extensions.js).
// Tools:
//   ci_summary  answers a hook event with { context } as structuredContent
//   deny        answers with { decision: "block", reason } when args.tool is shell
//   fail        returns isError
//   echo_args   returns the arguments it got, as text
// Resources: ui://ci/dock and ui://ci/sheet (single-file HTML for surfaces).
// Talks MCP over stdio (newline-delimited JSON-RPC).
'use strict';

const readline = require('readline');

const TOOLS = [
  { name: 'ci_summary', description: 'CI state as hook context.', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'deny', description: 'Block shell calls.', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'echo_args', description: 'Echo the arguments.', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'ci_status', description: 'CI state for the dock.', inputSchema: { type: 'object', additionalProperties: true },
    _meta: { ui: { resourceUri: 'ui://ci/dock', visibility: ['app'] } } }
];

const HTML = (title) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  + '<title>' + title + '</title></head><body><h1>' + title + '</h1><p id="state">waiting</p></body></html>';
const RESOURCES = [
  { uri: 'ui://ci/dock', name: 'CI dock', mimeType: 'text/html;profile=mcp-app' },
  { uri: 'ui://ci/sheet', name: 'CI sheet', mimeType: 'text/html;profile=mcp-app' }
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }

function callTool(name, args) {
  if (name === 'ci_summary') {
    return { content: [{ type: 'text', text: 'CI green' }], structuredContent: { context: 'CI green (' + (args && args.event) + ')' } };
  }
  if (name === 'deny') {
    return args && args.tool === 'shell'
      ? { content: [{ type: 'text', text: 'no' }], structuredContent: { decision: 'block', reason: 'the CI extension blocks shell' } }
      : { content: [{ type: 'text', text: '' }] };
  }
  if (name === 'fail') return { content: [{ type: 'text', text: 'server-side failure' }], isError: true };
  if (name === 'echo_args') return { content: [{ type: 'text', text: JSON.stringify({ context: JSON.stringify(args) }) }] };
  if (name === 'ci_status') return { content: [{ type: 'text', text: 'green' }], structuredContent: { status: 'green' } };
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
    reply(id, { protocolVersion: '2024-11-05', serverInfo: { name: 'mouaif-test-extension', version: '1.0.0' }, capabilities: { tools: {}, resources: {} } });
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // no-op
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    reply(id, callTool(params && params.name, params && params.arguments));
  } else if (method === 'resources/list') {
    reply(id, { resources: RESOURCES });
  } else if (method === 'resources/read') {
    const uri = params && params.uri;
    const r = RESOURCES.find((x) => x.uri === uri);
    if (!r) send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'not found: ' + uri } });
    else reply(id, { contents: [{ uri, mimeType: r.mimeType, text: HTML(r.name) }] });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
});
