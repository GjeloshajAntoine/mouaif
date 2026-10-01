'use strict';

// Real HTTP routing + tool authorization, with a local model fixture and a
// Web Push recorder. No real credentials, push endpoints, or CLI server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-attention-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const deliveries = [];
let onDelivery = () => {};
require('web-push').sendNotification = (subscription, payload) => {
  const notification = JSON.parse(payload);
  deliveries.push(notification);
  onDelivery(notification);
  return Promise.resolve();
};
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const push = require('../src/push.js');
const auth = require('../src/tools/authorization.js');
const mcp = require('../src/mcp.js');
const { handleRequest } = require('../src/http-server.js');
const { notifyAttention } = require('../src/attention-push.js');
const token = 'test-attention-session';
const sessionId = push.sessionIdFromToken(token);
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
push.ensureTable();
push.ensureVapidKeys();
push.addSubscription({ sessionId, endpoint: 'https://push.test/device', p256dh: 'test', auth: 'test' });

function route(url, body, disconnected = false) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST'; req.url = url;
    req.headers = { accept: 'application/x-ndjson' };
    const res = new EventEmitter();
    Object.assign(res, {
      status: 0, body: '',
      writeHead(status) { this.status = status; this.headersSent = true; },
      setHeader() {}, getHeader() {},
      write(chunk) {
        if (disconnected && this.body) throw new Error('page left the chat');
        this.body += chunk;
      },
      end(chunk) { this.body += chunk || ''; resolve(this); },
      destroy() { reject(new Error('request failed')); }
    });
    handleRequest(req, res, 5732, token);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
}

async function main() {
  let tool = null;
  let modelCallSequence = 0;
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
      const next = tool; tool = null;
      if (next) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'model-call-' + (++modelCallSequence), function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] });
        write({ choices: [{ index: 0, finish_reason: 'tool_calls' }] });
      } else write({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + provider.address().port }] });
  settings.setProject(projectDir, { models: [{ id: 'mock', provider: 'openai-compatible' }],
    tools: { shell: { mode: 'ask' }, subagent: { mode: 'ask' }, webpreview: { mode: 'ask' } } });
  const originalGetServer = mcp.getServer;
  const originalCallTool = mcp.callTool;
  try {
    const chat = chats.createChat(projectDir, {});
    chats.updateChat(projectDir, chat.id, { modelId: 'mock', providerId: 'openai-compatible' });
    const body = { projectDir, chatId: chat.id };
    for (const [name, args] of [['shell', { cmd: 'echo test' }], ['webpreview', { url: 'https://example.test' }]]) {
      const offset = deliveries.length;
      const callId = 'direct-' + name;
      const res = await route('/api/tools/' + name, { ...body, ...args, callId });
      assert.equal(res.status, 409);
      assert.equal(deliveries.length, offset + 1, name + ' dispatches its approval through the router');
      assert.equal(deliveries.at(-1).data.callId, callId);
      assert.equal(deliveries.at(-1).data.tool, name);
      auth.recordDecision(projectDir, chat.id, callId, 'deny');
    }
    mcp.getServer = () => ({ slug: 'fixture' });
    mcp.callTool = () => { throw new Error('unapproved MCP tool executed'); };
    const mcpOffset = deliveries.length;
    const mcpRes = await route('/api/mcp/call', { ...body, serverId: 'fixture', toolName: 'read', callId: 'mcp-call', args: {} });
    assert.equal(mcpRes.status, 409);
    assert.equal(deliveries.length, mcpOffset + 1, 'MCP dispatch receives the session and pushes');
    assert.equal(deliveries.at(-1).data.tool, 'mcp__fixture__read');
    auth.recordDecision(projectDir, chat.id, 'mcp-call', 'deny');
    mcp.getServer = originalGetServer; mcp.callTool = originalCallTool;

    const question = { name: 'ask_user', args: { question: 'Choose?', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] } };
    // Approve only via the recorded push, not via any page response reader.
    onDelivery = (notification) => {
      if (!['tool_authorization', 'ask_user'].includes(notification.data.kind)) return;
      const data = notification.data;
      queueMicrotask(() => auth.recordDecision(projectDir, chat.id, data.callId,
        data.tool === 'shell' ? 'deny' : 'allow-once',
        data.kind === 'ask_user' ? { choice: 'one', extra: '' } : undefined));
    };
    for (const next of [{ name: 'shell', args: { cmd: 'echo test' } }, question]) {
      const offset = deliveries.length;
      tool = next;
      const res = await route('/api/chats/' + chat.id + '/messages/stream', { ...body, modelId: 'mock', content: 'Run test' }, true);
      assert.equal(res.status, 200);
      const attention = deliveries.slice(offset).filter((n) => n.data.kind !== 'completion');
      assert.equal(attention.length, 1, 'normal model call sends exactly one attention push after the response disconnects');
      assert.equal(attention[0].data.tool, next.name);
    }
    const offset = deliveries.length;
    tool = question;
    const direct = await route('/api/tools/subagent', { ...body, task: 'Ask a question' }, true);
    assert.equal(direct.status, 200);
    const nested = deliveries.slice(offset);
    assert.deepEqual(nested.map((n) => n.data.kind), ['tool_authorization', 'ask_user'], 'direct agent and nested question both push after the page leaves');
    assert.equal(nested[0].data.tool, 'subagent');
    assert.equal(nested[1].actions[0].action, 'answer-0');
    assert.equal(nested[1].data.options[0].value, 'one');
    const approvalOffset = deliveries.length;
    tool = { name: 'shell', args: { cmd: 'echo test' } };
    await route('/api/tools/subagent', { ...body, task: 'Run a tool' }, true);
    assert.deepEqual(deliveries.slice(approvalOffset).map((n) => n.data.tool), ['subagent', 'shell'],
    'nested tool approvals from a direct agent also reach push');
    assert.ok(deliveries.every((n) => n.data.kind === 'completion' || (n.tag === 'chat-' + chat.id + '-attention' && n.requireInteraction === true)));
    assert.ok(deliveries.every((n) => n.data.url.includes(encodeURIComponent(projectDir))));

    onDelivery = () => {};
    const before = deliveries.length;
    settings.setApp({ notifications: { authorization: false } });
    await route('/api/tools/shell', { ...body, cmd: 'echo test', callId: 'silenced' });
    assert.equal(deliveries.length, before, 'direct approvals respect the authorization preference');
    auth.recordDecision(projectDir, chat.id, 'silenced', 'deny');
    notifyAttention({ sessionId, ...body, name: 'progress_update', data: {} });
    assert.equal(deliveries.length, before, 'the attention helper ignores ordinary events');
    settings.setApp({ notifications: { authorization: true, quickActions: false } });
    notifyAttention({ sessionId, ...body, name: 'authorization_required', data: { callId: 'actions-off', tool: 'shell' } });
    assert.deepEqual(deliveries.at(-1).actions, [{ action: 'open', title: 'Open chat' }]);
    console.log('attention push: regular and direct approvals, nested questions, disconnected pages, routing, preferences and actions passed');
  } finally {
    mcp.getServer = originalGetServer; mcp.callTool = originalCallTool;
    await new Promise((resolve) => provider.close(resolve));
    settings.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
