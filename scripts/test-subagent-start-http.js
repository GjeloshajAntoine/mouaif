'use strict';
// Direct dispatch uses the real handler/dispatcher and a held mock upstream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-subagent-start-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleTools } = require('../src/server-handlers-tools.js');
function request(body, streaming) {
  return { method: 'POST', headers: { accept: streaming ? 'application/x-ndjson' : 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
    }
  };
}
function response() {
  return { body: '', statusCode: 0, headers: {}, ended: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    write(chunk) { this.body += chunk; },
    end(chunk) { this.body += chunk || ''; this.ended = true; },
    setHeader() {}, getHeader() {}
  };
}
async function main() {
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir);
  const seen = [];
  let resolveRequest;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { seen.push(JSON.parse(raw)); resolveRequest(res); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }] });
  settings.setProject(projectDir, { models: [{ id: 'mock', provider: 'openai-compatible' }], agents: [{ name: 'Search', content: 'EXACT_SEARCH_PROMPT' }], tools: { subagent: { mode: 'allow' } } });
  const chat = chats.createChat(projectDir, {});
  chats.updateChat(projectDir, chat.id, { modelId: 'mock', providerId: 'openai-compatible' });
  try {
    for (const streaming of [true, false]) {
      const arrived = new Promise((resolve) => { resolveRequest = resolve; });
      const res = response();
      const running = handleTools(request({ projectDir, chatId: chat.id, task: 'Review', context: 'Evidence', agent: 'Search' }, streaming), res, { pathname: '/api/tools/subagent' });
      let timer;
      const upstream = await Promise.race([arrived, running.then(() => { throw new Error('Dispatch ended before upstream: ' + res.body); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No upstream request: ' + res.body)), 3000); })
      ]).finally(() => clearTimeout(timer));
      if (streaming) {
        const frames = res.body.trim().split('\n').map((line) => JSON.parse(line));
        const start = frames.find((f) => f.name === 'subagent_event' && f.data.kind === 'start');
        assert.ok(start, 'prompt sent before nested provider answers');
        assert.equal(start.data.data.chat[0].content[0].text, 'EXACT_SEARCH_PROMPT');
        assert.equal(start.data.data.chat[1].content, 'Task:\nReview\n\nContext:\nEvidence');
        assert.equal(start.data.data.agent, 'Search');
        assert.deepEqual(start.data.data.chat, seen.at(-1).messages.slice(0, 2), 'live instructions match the nested request exactly');
        assert.equal(start.data.parentCallId, frames.find((f) => f.name === 'tool_call').data.id);
        assert.equal(res.ended, false);
      }
      upstream.writeHead(200, { 'Content-Type': 'text/event-stream' });
      upstream.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      await running;
      const result = streaming ? JSON.parse(res.body.trim().split('\n').at(-1)).result : JSON.parse(res.body);
      assert.equal(result.ok, true);
      assert.equal(result.result.text, 'Done');
      assert.equal(result.result.chat[0].content[0].text, 'EXACT_SEARCH_PROMPT');
      assert.equal(seen.length, streaming ? 1 : 2, 'direct dispatch never asks a parent model to delegate');
    }
    settings.setProject(projectDir, { tools: { subagent: { mode: 'off' } } });
    const denied = response();
    await handleTools(request({ projectDir, chatId: chat.id, task: 'Review' }, true), denied, { pathname: '/api/tools/subagent' });
    const frames = denied.body.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.at(-1).result.ok, false);
    assert.equal(frames.some((f) => f.name === 'subagent_event' && f.data.kind === 'start'), false, 'disabled tools do not expose a prompt or execute');
    assert.equal(seen.length, 2);
    console.log('direct subagent: early prompt, exact agent/context, JSON compatibility and disabled authorization passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    settings.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
