// Regression test: a no-text tool round's usage snapshot must not leak
// into the NEXT round's assistant segment.
//
// handleChatStream keeps one `pendingRoundUsage` slot. When a round ends
// with tool calls and no assistant text, the slot used to stay populated;
// the next round that DID produce text then got charged with the stale
// round's tokens. The chat total double-counted those prompt tokens
// (once via the final `done` aggregate, once via the segment).
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

// Three upstream rounds:
//   1. tool call only, NO text   (usage 100/20)
//   2. text + tool call          (usage 150/30)
//   3. final text                (usage 200/10)
// The segment persisted at the end of round 2 must carry round 2's
// usage (150/30) — NOT round 1's (100/20) and NOT a sum.
function serve() {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"echo one\\"}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0011}}\n\n');
        res.write('data: [DONE]\n\n');
      } else if (count === 2) {
        res.write('data: {"choices":[{"delta":{"content":"Running the second check."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"shell","arguments":"{\\"cmd\\":\\"echo two\\"}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":150,"completion_tokens":30,"cost":0.0009}}\n\n');
        res.write('data: [DONE]\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"All done."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":200,"completion_tokens":10,"cost":0.0006}}\n\n');
        res.write('data: [DONE]\n\n');
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

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-dblcost-'));
  process.env.MOUAIF_HOME = path.join(tmp, 'home');
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  const { server, port } = await serve();
  // Project model (identity only) + app-level provider connection
  // (transport + credentials) — resolveModel merges the two.
  settings.setProject(projectDir, {
    models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
    tools: { shell: { enabled: true, mode: 'allow' } }
  });
  settings.setApp({
    providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
  });
  const created = chats.createChat(projectDir, { title: 'double-count test' });
  const chatId = created.id;

  const req = mockReq({ projectDir, modelId: 'mock', content: 'run two things' });
  const res = mockRes();
  await handleChatStream(req, res, chatId, null);
  server.close();

  check('stream completed with 200', res.statusCode === 200, 'status=' + res.statusCode);

  const msgs = messages.listMessages(projectDir, chatId);
  const assistant = msgs.filter((m) => m && m.role === 'assistant');
  // Round 2's text segment + round 3's final message = 2 assistant rows.
  check('two assistant messages persisted', assistant.length === 2, 'got ' + assistant.length);

  const seg = assistant[0];
  const fin = assistant[1];
  check('segment is the round-2 text', seg && seg.content === 'Running the second check.', JSON.stringify(seg && seg.content));
  check('segment usage is round 2 only (150/30)',
    seg && seg.usage && seg.usage.promptTokens === 150 && seg.usage.completionTokens === 30,
    JSON.stringify(seg && seg.usage));

  // The final row now carries ONLY its own round's usage (200/10), not
  // the turn aggregate. Segments + final partition the turn's completion
  // tokens with no overlap: 30 (segment) + 10 (final) = 40, and rounds
  // without text are folded into the final row's cost via turnCost.
  check('final message usage is its own round only (200 prompt, 10 completion)',
    fin && fin.usage && fin.usage.promptTokens === 200 && fin.usage.completionTokens === 10,
    JSON.stringify(fin && fin.usage));

  // Completion tokens on the visible rows sum to 40 (30 segment + 10
  // final). Round 1's 20 completions belonged to a no-text tool round
  // and are not displayed, but their COST is folded into the final row
  // (see below) — before this fix they vanished from the total.
  const completionSum = assistant.reduce((s, m) => s + (m.usage && m.usage.completionTokens || 0), 0);
  check('visible completion tokens sum to 40 (segment 30 + final 10)',
    completionSum === 40, 'got ' + completionSum);

  // Cost: per-round provider costs are 0.0011 (round 1, no text) +
  // 0.0009 (round 2, segment) + 0.0006 (round 3, final). The chat total
  // must equal 0.0026 exactly once:
  //   - segment row carries round 2's 0.0009
  //   - final row carries the remainder 0.0026 − 0.0009 = 0.0017, which
  //     folds in round 1's no-text cost (0.0011) that used to vanish.
  check('segment cost is round 2 only (0.0009)',
    seg && seg.cost && Math.abs(seg.cost.total - 0.0009) < 1e-9,
    JSON.stringify(seg && seg.cost));
  check('final cost is the remainder 0.0017 (incl. no-text round 1)',
    fin && fin.cost && Math.abs(fin.cost.total - 0.0017) < 1e-9,
    JSON.stringify(fin && fin.cost));
  const costSum = assistant.reduce((s, m) => s + (m.cost && m.cost.known ? m.cost.total : 0), 0);
  check('chat cost total is 0.0026 exactly once',
    Math.abs(costSum - 0.0026) < 1e-9, 'got ' + costSum);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
