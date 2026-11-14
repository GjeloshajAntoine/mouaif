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

// The window must also be honest in three cases that used to over-report:
//   - OpenRouter, whose text is buffered and replayed at round end (the
//     window was the few ms between the replay and `done`);
//   - reasoning tokens counted but never streamed (all tokens were divided
//     by the answer-only window);
//   - a reply that arrives in one chunk (tokens over a few ms).
const HIDDEN_THINK_MS = 600;

function serve() {
  let count = 0;
  let scenario = 'tool';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = (t) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t }, index: 0 }] }) + '\n\n');
      const stop = () => res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
      if (scenario === 'buffered') {
        content('Hello ');
        await sleep(ROUND1_MS);
        content('world.');
        stop();
        res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":40}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (scenario === 'hidden') {
        await sleep(HIDDEN_THINK_MS);
        content('Hello ');
        await sleep(ROUND2_MS);
        content('world.');
        stop();
        res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":1000,"completion_tokens_details":{"reasoning_tokens":990}}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (scenario === 'single') {
        content('One chunk.');
        stop();
        res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":40}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      count++;
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, use: (s) => { scenario = s; } }));
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

  const { server, port, use } = await serve();
  settings.setProject(projectDir, {
    models: [
      { id: 'mock', provider: 'openai-compatible', label: 'Mock' },
      { id: 'mock-or', provider: 'openrouter', label: 'Mock OpenRouter' }
    ],
    tools: { shell: { enabled: true, mode: 'allow' } }
  });
  settings.setApp({
    providers: [
      { id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' },
      { id: 'openrouter', type: 'openrouter', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }
    ]
  });
  // runOne(scenario, modelId) -> the single assistant row of a one-round turn.
  async function runOne(scenario, modelId) {
    use(scenario);
    const id = chats.createChat(projectDir, { title: scenario }).id;
    const r = mockRes();
    await handleChatStream(mockReq({ projectDir, modelId, content: 'go' }), r, id, null);
    const rows = messages.listMessages(projectDir, id).filter((m) => m && m.role === 'assistant');
    return { row: rows[rows.length - 1], done: sseFrames(r.body, 'done').pop() };
  }
  const chatId = chats.createChat(projectDir, { title: 'token speed test' }).id;

  const res = mockRes();
  await handleChatStream(mockReq({ projectDir, modelId: 'mock', content: 'go' }), res, chatId, null);

  const buffered = await runOne('buffered', 'mock-or');
  const hidden = await runOne('hidden', 'mock');
  const single = await runOne('single', 'mock');
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

  // OpenRouter: the text reaches the handler in one burst at round end,
  // but the window is the upstream's real ~400 ms.
  check('buffered OpenRouter text keeps its real window',
    buffered.row && buffered.row.streamingMs >= ROUND1_MS - 50 && buffered.row.streamingMs < ROUND1_MS + 400,
    'got ' + (buffered.row && buffered.row.streamingMs));

  // Hidden reasoning: 990 of 1000 tokens were never streamed, so the
  // row marks them and the window stays the visible ~300 ms.
  check('unstreamed reasoning tokens are saved as hiddenReasoningTokens',
    hidden.row && hidden.row.usage && hidden.row.usage.hiddenReasoningTokens === 990
      && hidden.row.usage.completionTokens === 1000,
    JSON.stringify(hidden.row && hidden.row.usage));
  check('hidden-reasoning window is the visible stream only',
    hidden.row && hidden.row.streamingMs >= ROUND2_MS - 50 && hidden.row.streamingMs < HIDDEN_THINK_MS,
    'got ' + (hidden.row && hidden.row.streamingMs));
  check('done frame carries roundHiddenReasoningTokens',
    hidden.done && hidden.done.roundHiddenReasoningTokens === 990,
    JSON.stringify(hidden.done && hidden.done.roundHiddenReasoningTokens));

  // One chunk: the window is saved as measured (a few ms); the UI's
  // minimum window is what keeps it from being shown as a rate.
  check('single-chunk reply saves a tiny window, below the display minimum',
    single.row && typeof single.row.streamingMs === 'number' && single.row.streamingMs < 250,
    'got ' + (single.row && single.row.streamingMs));

  // The display rule itself (frontend/src/usage.js).
  const fe = await import('../frontend/src/usage.js');
  check('usageRate leaves hidden reasoning tokens out',
    fe.usageRate({ completionTokens: 1000, hiddenReasoningTokens: 990 }, 500) === 20,
    String(fe.usageRate({ completionTokens: 1000, hiddenReasoningTokens: 990 }, 500)));
  check('usageRate gives no rate below the minimum window',
    fe.usageRate({ completionTokens: 40 }, 5) === null && fe.usageRate({ completionTokens: 40 }, 0) === null);
  check('usageRate is tokens over the window otherwise',
    fe.usageRate({ completionTokens: 40 }, 400) === 100);
  const counter = fe.createCounter();
  check('live counter gives no rate before its window is long enough', counter.rate() === null);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
