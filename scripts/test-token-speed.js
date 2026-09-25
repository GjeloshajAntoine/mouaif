// Regression test: tok/s is measured per round and saved on every row.
//
// Each assistant row (intermediate tool-round segment AND final message)
// must carry `streamingMs` for its OWN round — the window from that
// round's first delta to its end — so `completionTokens / streamingMs`
// on the row is that round's real speed, now and after a reload.
//
// Before the fix, segments saved no `streamingMs` (so they showed no
// tok/s at all), and the final row saved the sum of every round's window
// next to only the final round's completionTokens, which under-reported
// its speed. The tool run between rounds must never count as streaming.
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store BEFORE any src module is required (see
// test-round-cost-doublecount.js for why).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tokspeed-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const { handleChatStream } = require('../src/server-handlers-chats.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const ROUND1_MS = 400;   // round 1 streams for ~400 ms, then calls a tool
const TOOL_MS = 1200;    // the tool runs ~1.2 s (not streaming time)
const ROUND2_MS = 300;   // round 2 streams for ~300 ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        res.write('data: {"choices":[{"delta":{"content":"Checking. "},"index":0}]}\n\n');
        await sleep(ROUND1_MS);
        res.write('data: {"choices":[{"delta":{"content":"Running it."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"sleep ' + (TOOL_MS / 1000) + '\\"}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":40}}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"All "},"index":0}]}\n\n');
        await sleep(ROUND2_MS);
        res.write('data: {"choices":[{"delta":{"content":"done."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":200,"completion_tokens":30}}\n\n');
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

function sseFrames(body, name) {
  const out = [];
  for (const block of body.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (ev && data && ev[1] === name) { try { out.push(JSON.parse(data[1])); } catch { /* skip */ } }
  }
  return out;
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
  const chatId = chats.createChat(projectDir, { title: 'token speed test' }).id;

  const res = mockRes();
  await handleChatStream(mockReq({ projectDir, modelId: 'mock', content: 'go' }), res, chatId, null);
  server.close();

  check('stream completed with 200', res.statusCode === 200, 'status=' + res.statusCode);

  const assistant = messages.listMessages(projectDir, chatId).filter((m) => m && m.role === 'assistant');
  check('two assistant rows persisted', assistant.length === 2, 'got ' + assistant.length);
  const [seg, fin] = assistant;

  // Segment: its own ~400 ms window, saved on the row.
  check('segment row saves its streamingMs',
    seg && typeof seg.streamingMs === 'number', JSON.stringify(seg && seg.streamingMs));
  check('segment streamingMs is round 1 only (no tool time)',
    seg && seg.streamingMs >= ROUND1_MS - 50 && seg.streamingMs < ROUND1_MS + TOOL_MS / 2,
    'got ' + (seg && seg.streamingMs));

  // Final: round 2's ~300 ms window only — not round 1's window added on.
  check('final row saves its streamingMs',
    fin && typeof fin.streamingMs === 'number', JSON.stringify(fin && fin.streamingMs));
  check('final streamingMs is round 2 only (not the whole turn)',
    fin && fin.streamingMs >= ROUND2_MS - 50 && fin.streamingMs < ROUND1_MS + ROUND2_MS - 50,
    'got ' + (fin && fin.streamingMs));
  check('final row keeps its own round tokens (30)',
    fin && fin.usage && fin.usage.completionTokens === 30, JSON.stringify(fin && fin.usage));

  // Live frames carry the same numbers the rows save.
  const turnEnd = sseFrames(res.body, 'assistant_turn_end')[0];
  check('assistant_turn_end frame carries the segment streamingMs',
    turnEnd && seg && turnEnd.streamingMs === seg.streamingMs,
    JSON.stringify(turnEnd && turnEnd.streamingMs));
  const done = sseFrames(res.body, 'done').pop();
  check('done frame carries the final round streamingMs',
    done && fin && done.streamingMs === fin.streamingMs, JSON.stringify(done && done.streamingMs));
  check('done frame carries the final round completionTokens',
    done && done.roundCompletionTokens === 30, JSON.stringify(done && done.roundCompletionTokens));

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
