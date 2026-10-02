'use strict';

// Default subagent: a `subagent` call without `agent` runs the project's
// `defaultAgent` config (instructions, tool allowlist, thinking). Real
// REST/SSE handler + a local mock provider; never starts the mouaif CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-default-subagent-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleChats, handleChatStream } = require('../src/server-handlers-chats.js');

function request(body) {
  return {
    method: 'POST', headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
    }
  };
}
function response() {
  return {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    write(chunk) { this.body += chunk; },
    end(chunk) { this.body += chunk || ''; },
    setHeader() {}, getHeader() {}, on() {}, off() {}
  };
}
function skillNames(req) {
  return req.tools?.find((s) => s.function.name === 'activate_skill')?.function.parameters.properties.name.enum || [];
}
function activationFeedback(req) {
  return req.messages.filter((m) => m.role === 'tool' && m.name === 'activate_skill').map((m) => m.content).join('\n');
}

async function main() {
  let seen = [];
  let steps = [];
  let currentResponse;
  let initialFrame;
  let replayFrame;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      if (seen.length === 2) {
      // Observe the prompt while the first nested request is still open,
      // not after the delegated run returns.
      initialFrame = currentResponse.body.split('\n\n').map((frame) => {
      const data = /^data: (.*)$/m.exec(frame);
      return data ? JSON.parse(data[1]) : null;
      }).find((data) => data && data.kind === 'start');
      const replay = response();
      require('../src/live-chat.js').addSubscriber(currentResponse.runKey, null, replay);
      replayFrame = replay.body.includes('"kind":"start"');
      }
      const step = steps.shift();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (step) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + seen.length, function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        write({ choices: [{ index: 0, finish_reason: 'tool_calls' }] });
      } else {
        write({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }] });
  const delegate = { name: 'subagent', args: { task: 'Review' } };
  let count = 0;
  const system = (req) => {
    const m = req.messages.find((x) => x.role === 'system');
    return Array.isArray(m && m.content) ? m.content.map((b) => b.text).join('') : String(m && m.content || '');
  };
  const toolNames = (req) => (req.tools || []).map((s) => s.function.name);
  try {
    async function run(projectPatch) {
      const projectDir = path.join(tmp, 'project-' + count++);
      fs.mkdirSync(projectDir, { recursive: true });
      settings.setProject(projectDir, Object.assign({ models: [{ id: 'mock', provider: 'openai-compatible' }], tools: { subagent: { mode: 'allow' }, shell: { mode: 'allow' } } }, projectPatch));
      const chat = chats.createChat(projectDir, {});
      seen = []; steps = [delegate, null, null];
      const out = response();
      currentResponse = out;
      out.runKey = require('../src/server-shared.js').runningKey(projectDir, chat.id);
      await handleChatStream(request({ projectDir, modelId: 'mock', content: 'Go' }), out, chat.id, null);
      assert.equal(out.statusCode, 200);
      assert.equal(steps.length, 0);
      assert.ok(initialFrame, 'prompt must arrive before the first nested upstream request completes');
      assert.equal(system({ messages: initialFrame.data.chat }), system(seen[1]), 'live prompt matches dispatched instructions');
      assert.equal(initialFrame.data.chat[1].content, 'Review');
      assert.equal(initialFrame.data.model.id, 'mock');
      assert.equal(replayFrame, true, 'a returning tab receives the initial prompt');
      return seen.slice();
    }

    const builtin = await run({});
    assert.match(system(builtin[1]), /You are a focused subagent/);

    const custom = await run({ defaultAgent: { content: 'DEFAULT_PERSONA', tools: ['shell'], thinkingLevel: 'low' } });
    assert.equal(system(custom[1]), 'DEFAULT_PERSONA');
    assert.deepEqual(toolNames(custom[1]), ['shell']);
    assert.ok(toolNames(custom[0]).length > 1, 'parent keeps its full tool surface');
    console.log('default subagent stream: built-in fallback and project default config passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    settings.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
