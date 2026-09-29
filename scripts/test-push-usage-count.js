'use strict';

// Regression test: the usage row of the chat status notification
// ("12.4K tok · $0.0312") must count every upstream round exactly once.
//
// handleChatStream used to fold usage into the notification total from
// `onRoundUsage`, a *snapshot* stream: Anthropic fires one snapshot per
// `message_delta` frame (each carrying the round's cumulative numbers), so a
// round with N output deltas was added N times — the prompt tokens and the
// round cost multiplied by the number of deltas. The total now comes from
// `onRoundCommit`, which fires exactly once per finished round.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the app store BEFORE any src module is required (settings.js
// captures MOUAIF_HOME at require time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-push-usage-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const webpush = require('web-push');
const deliveries = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = (subscription, payload) => {
  deliveries.push(JSON.parse(payload));
  return Promise.resolve();
};

const push = require('../src/push.js');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleChatStream } = require('../src/server-handlers-chats.js');

push.ensureTable();
push.ensureVapidKeys();

// Round 1: tool call, two cumulative output deltas (3 then 7).
// Round 2: final text, three cumulative output deltas (2, 4, 5).
// Prompt: 100 in round 1, 150 in round 2.
// Correct turn total: (100 + 7) + (150 + 5) = 262 tokens.
function serve() {
  let count = 0;
  const frames = (list) => list.map((f) => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join('');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        res.write(frames([
          { type: 'message_start', message: { usage: { input_tokens: 100 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } },
          { type: 'message_delta', usage: { output_tokens: 3 } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"echo hi"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' }
        ]));
      } else {
        res.write(frames([
          { type: 'message_start', message: { usage: { input_tokens: 150 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All' } },
          { type: 'message_delta', usage: { output_tokens: 2 } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' done' } },
          { type: 'message_delta', usage: { output_tokens: 4 } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' }
        ]));
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests: () => count }));
  });
}

function mockReq(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
      return this;
    }
  };
}
function mockRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    write(chunk) { this.body += chunk; },
    end() {},
    setHeader() {},
    getHeader() { return undefined; }
  };
}

(async () => {
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const { server, port, requests } = await serve();
  settings.setProject(projectDir, {
    models: [{ id: 'claude-mock', provider: 'anthropic', label: 'Mock' }],
    tools: { shell: { enabled: true, mode: 'allow' } }
  });
  settings.setApp({
    providers: [{ id: 'anthropic', type: 'anthropic', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
  });

  // An expanded desktop surface shows every status fact, usage included.
  const sessionToken = 'session-usage-count';
  push.addSubscription({
    sessionId: push.sessionIdFromToken(sessionToken),
    endpoint: 'https://push.example.test/usage',
    p256dh: 'p', auth: 'a',
    statusBarProfile: { chars: 110, viewportWidth: 1280, os: 'macos', osVersion: 14, style: 'expanded' }
  });

  const chat = chats.createChat(projectDir, { title: 'usage count' });
  const res = mockRes();
  await handleChatStream(mockReq({ projectDir, modelId: 'claude-mock', content: 'run it' }), res, chat.id, sessionToken);
  server.close();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(res.statusCode, 200, 'stream completed');
  assert.equal(requests(), 2, 'two upstream rounds ran');

  const completion = deliveries.find((d) => d.data && d.data.kind === 'completion');
  assert.ok(completion, 'a completion status notification was sent');
  assert.match(completion.body, /(^|\n)262 tok(\n| ·|$)/,
    'the usage row counts each round once (100+7 + 150+5 = 262); body was:\n' + completion.body);

  // Exercise the chat handler's status normalization, not only the body
  // formatter: report_progress carries `status`, while task updates also
  // carry a title with a generic message.
  const ai = require('../src/ai.js');
  const originalStreamChat = ai.streamChat;
  const offset = deliveries.length;
  const bodyResolvers = [];
  const originalSend = push.sendPushToSession;
  push.sendPushToSession = (sid, payload) => {
    bodyResolvers.push({ kind: payload.data.kind, bodyFor: payload.bodyFor });
    return originalSend(sid, payload);
  };
  ai.streamChat = async ({ onEvent }) => {
    onEvent('tool_call', { id: 'progress-call', name: 'report_progress', args: {} });
    onEvent('progress_update', { title: 'Build project', current: 2, total: 5, status: 'running' });
    onEvent('progress_update', { title: 'Run tests', current: 2, total: 5, status: 'failed' });
    onEvent('progress_update', { kind: 'task', title: 'Lint project', message: 'Task complete', current: 2, total: 5, status: 'completed' });
    onEvent('done', { usage: { promptTokens: 0, completionTokens: 0 } });
    return { ok: true };
  };
  try {
    const statusRes = mockRes();
    await handleChatStream(mockReq({ projectDir, modelId: 'claude-mock', content: 'show status' }), statusRes, chat.id, sessionToken);
    assert.equal(statusRes.statusCode, 200, 'status stream completed');
    const progress = deliveries.slice(offset).filter((d) => d.data.kind === 'progress');
    assert.equal(progress.length, 3, 'every progress state sent a status');
    assert.match(progress[0].body, /40%\nBuild project/, 'running status retains its operation title');
    assert.match(progress[1].body, /^\[-+\]\nFailed: Run tests/, 'failure has no misleading percentage and retains its state');
    assert.match(progress[2].body, /100%\nCompleted: Lint project/, 'completed status is full even if counts lag');
    assert.ok(!progress[2].body.includes('2 of 5'), 'completed status omits stale counts');
    assert.ok(progress.every((d) => d.title === chat.title && d.tag === 'chat-' + chat.id + '-status'),
      'status titles and the replacement slot remain stable');
    const sub = push.listSubscriptions(push.sessionIdFromToken(sessionToken))[0];
    for (let i = 0; i < bodyResolvers.length; i++) {
    assert.equal(bodyResolvers[i].bodyFor(sub), deliveries[offset + i].body,
      'a deferred ' + bodyResolvers[i].kind + ' resolver keeps its context after the turn resets');
    }

    // Both error paths keep the last tool and elapsed time, including a
    // throw from streamChat (whose cleanup used to erase those facts first).
    for (const throws of [false, true]) {
    const errorOffset = deliveries.length;
    const resolverOffset = bodyResolvers.length;
    ai.streamChat = async ({ onEvent }) => {
      onEvent('tool_call', { id: 'shell-call', name: 'shell', args: {} });
      if (throws) throw new Error('mock stream failure');
      return { ok: false, error: { code: 'EMOCK', message: 'mock upstream failure' } };
    };
    await handleChatStream(mockReq({ projectDir, modelId: 'claude-mock', content: 'show error' }), mockRes(), chat.id, sessionToken);
    const failure = deliveries[errorOffset];
    assert.equal(failure.data.kind, 'error', 'the failure sends an error status');
    assert.match(failure.body, /\n\d+s\nshell(?:\n|$)/, 'error status retains elapsed time and tool context');
    assert.equal(bodyResolvers[resolverOffset].bodyFor(sub), failure.body, 'error rendering remains stable after cleanup');
    }
  } finally {
    ai.streamChat = originalStreamChat;
    push.sendPushToSession = originalSend;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('push usage count and status content: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
