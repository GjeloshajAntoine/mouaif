// Server round trip for chat row client ids
// (docs/features/chat-client-row-ids.md).
//
// The chat UI draws some rows before the server saves them. Each such row
// carries a `clientId`; the server must store it, echo it on every read, and
// put the id of each row IT creates (assistant segments, the final answer)
// on the SSE frame that announces the row — so the UI can swap its unsaved
// copy for the saved one by id instead of by position or content.
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store BEFORE requiring src modules (settings.js captures
// MOUAIF_HOME at require time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-client-id-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const { handleChatStream } = require('../src/server-handlers-chats.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');
const liveChat = require('../src/live-chat.js');
const serverShared = require('../src/server-shared.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Two upstream rounds: text + tool call, then the final answer. Both produce
// assistant text, so both persist a row.
function serve() {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        res.write('data: {"choices":[{"delta":{"content":"First segment."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"echo one\\"}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"Final answer."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function mockReq(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
    }
  };
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.body += chunk; },
    end() {},
    setHeader() {},
    getHeader() { return undefined; }
  };
}

// Capture what the run broadcasts to a follower: subscribe a fake SSE
// response to the live registry BEFORE the turn starts, and parse the
// `assistant_turn_end` frames out of it.
function collectLiveFrames(runKey) {
  const frames = [];
  liveChat.ensureLiveChat(runKey);
  const sub = {
    _chunks: [],
    writeHead() { return this; },
    write(c) { this._chunks.push(c); return true; },
    end() {},
    on() {}
  };
  liveChat.addSubscriber(runKey, null, sub);
  return {
    sub,
    turnEnds() {
      return sub._chunks.join('').split('\n\n').filter(Boolean)
        .map((f) => {
          let name = 'message', data = '';
          for (const line of f.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6) + '\n';
          }
          let parsed = null;
          try { parsed = JSON.parse(data.trim()); } catch { /* keep null */ }
          return { name, data: parsed };
        })
        .filter((f) => f.name === 'assistant_turn_end');
    }
  };
}


// Parse the owner's SSE response into { name, data } frames.
function ownerFrames(res) {
  return res.body.split('\n\n').filter(Boolean).map((f) => {
    let name = 'message', data = '';
    for (const line of f.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6) + '\n';
    }
    let parsed = null;
    try { parsed = JSON.parse(data.trim()); } catch { /* keep null */ }
    return { name, data: parsed };
  });
}

(async function main() {
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const { server, port } = await serve();
  settings.setProject(projectDir, {
    models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
    tools: { shell: { enabled: true, mode: 'allow' } }
  });
  settings.setApp({
    providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
  });

  // ---- store level ------------------------------------------------------
  const plain = chats.createChat(projectDir, { title: 'store' });
  const a = messages.appendMessage(projectDir, plain.id, { role: 'user', content: 'x', clientId: 'u_abc' });
  check('appendMessage stores and returns clientId', a.clientId === 'u_abc', JSON.stringify(a));
  const bad = messages.appendMessage(projectDir, plain.id, { role: 'user', content: 'y', clientId: 'has space' });
  check('an unsafe clientId is dropped', bad.clientId === undefined, JSON.stringify(bad));
  const dup = messages.appendMessage(projectDir, plain.id, { role: 'user', content: 'z', clientId: 'u_abc' });
  check('a taken clientId is replaced, never shared by two rows',
    typeof dup.clientId === 'string' && dup.clientId !== 'u_abc', JSON.stringify(dup));
  const legacy = messages.appendMessage(projectDir, plain.id, { role: 'user', content: 'w' });
  check('a row without clientId stays without one', legacy.clientId === undefined, JSON.stringify(legacy));
  const read = messages.listMessages(projectDir, plain.id);
  check('listMessages echoes clientId', read[0].clientId === 'u_abc', JSON.stringify(read[0]));

  // ---- stream level -----------------------------------------------------
  const chat = chats.createChat(projectDir, { title: 'stream' });
  const req = mockReq({ projectDir, modelId: 'mock', content: 'run it', clientId: 'u_fromclient1' });
  const res = mockRes();
  await handleChatStream(req, res, chat.id, null);
  server.close();
  check('stream completed with 200', res.statusCode === 200, 'status=' + res.statusCode);

  const rows = messages.listMessages(projectDir, chat.id);
  const user = rows.find((m) => m.role === 'user');
  check('the user row keeps the id the client sent', user && user.clientId === 'u_fromclient1', JSON.stringify(user));
  const assistants = rows.filter((m) => m.role === 'assistant');
  check('both assistant rows got a server id',
    assistants.length === 2 && assistants.every((m) => typeof m.clientId === 'string' && m.clientId),
    JSON.stringify(assistants.map((m) => m.clientId)));
  const ids = rows.filter((m) => m.clientId).map((m) => m.clientId);
  check('ids are unique within the chat', new Set(ids).size === ids.length, JSON.stringify(ids));
  const tools = rows.filter((m) => m.role === 'tool');
  check('tool rows keep toolCallId identity and get no clientId',
    tools.length === 2 && tools.every((m) => !m.clientId), JSON.stringify(tools.map((m) => m.clientId)));

  const frames = ownerFrames(res);
  const turnEnd = frames.find((f) => f.name === 'assistant_turn_end');
  check('assistant_turn_end carries the saved segment id',
    turnEnd && turnEnd.data && turnEnd.data.clientId === assistants[0].clientId,
    JSON.stringify(turnEnd && turnEnd.data && turnEnd.data.clientId) + ' vs ' + assistants[0].clientId);
  const done = frames.find((f) => f.name === 'done');
  check('done carries the saved final answer id',
    done && done.data && done.data.clientId === assistants[1].clientId,
    JSON.stringify(done && done.data && done.data.clientId) + ' vs ' + assistants[1].clientId);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
