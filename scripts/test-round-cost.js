// Verify that intermediate assistant segments (persisted at
// assistant_turn_end before tool rounds) carry their own usage + cost.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ai = require('../src/ai.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-test-'));
const projectDir = tmp;
const chatId = 'testcost1';

// Create a minimal project + chat. Shell auto-allowed so the tool
// round does not block on an authorization prompt.
settings.setProject(projectDir, {
  chats: [{ id: chatId, title: 'cost-test', createdAt: new Date().toISOString(), lastOpenedAt: null, trace: false, promptSize: 'average', promptId: null, providerId: null, modelId: null, draft: '' }],
  models: [{ id: 'mock-cost', provider: 'openai-compatible', label: 'Mock', contextWindow: 128000 }],
  tools: { shell: { enabled: true, mode: 'allow' } }
});

// Track rounds
let requestCount = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requestCount++;
    const isFirst = requestCount === 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (isFirst) {
      // Round 1: text + tool call
      res.write('data: {"choices":[{"delta":{"content":"I will run the command."},"index":0}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"echo hi\\"}"}}]},"index":0}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
      // OpenRouter shape: per-request cost + cost_details breakdown.
      res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0011,"cost_details":{"upstream_inference_prompt_cost":0.001,"upstream_inference_completions_cost":0.0001}}}\n\n');
      res.write('data: [DONE]\n\n');
    } else {
      // Round 2: final answer
      res.write('data: {"choices":[{"delta":{"content":"Done!"},"index":0}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":200,"completion_tokens":10,"cost":0.0006,"cost_details":{"upstream_inference_prompt_cost":0.0005,"upstream_inference_completions_cost":0.0001}}}\n\n');
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const events = [];
  const model = {
    id: 'mock-cost',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:' + port,
    apiKey: 'test-key',
    auth: 'apikey'
  };

  const result = await ai.streamChat({
    model,
    messages: [{ role: 'user', content: 'test cost' }],
    projectDir,
    chatId,
    shellEnabled: true,
    onEvent: (name, data) => events.push({ name, data }),
    onRoundUsage: (roundUsage) => {
      events.push({ name: '_roundUsage', data: roundUsage });
    }
  });

  server.close();

  console.log('ok:', result.ok);
  console.log('round usage events:', events.filter(e => e.name === '_roundUsage').map(e => e.data));
  console.log('assistant_turn_end:', events.filter(e => e.name === 'assistant_turn_end').length);
  console.log('done events:', events.filter(e => e.name === 'done').length);

  // Verify round usage was emitted for round 1
  const roundUsages = events.filter(e => e.name === '_roundUsage');
  if (roundUsages.length >= 1) {
    console.log('PASS: round usage emitted for tool round');
  } else {
    console.log('FAIL: no round usage for tool round');
    process.exit(1);
  }

  if (roundUsages.length >= 2) {
    console.log('PASS: round usage emitted for final round');
  } else {
    console.log('FAIL: no round usage for final round');
    process.exit(1);
  }

  // Check the first round's usage matches round 1's tokens
  const r1 = roundUsages[0].data;
  if (r1.promptTokens === 100 && r1.completionTokens === 20) {
    console.log('PASS: round 1 usage matches round 1 tokens');
  } else {
    console.log('FAIL: round 1 usage mismatch', r1);
    process.exit(1);
  }

  const r2 = roundUsages[1].data;
  if (r2.promptTokens === 200 && r2.completionTokens === 10) {
    console.log('PASS: round 2 usage matches round 2 tokens');
  } else {
    console.log('FAIL: round 2 usage mismatch', r2);
    process.exit(1);
  }

  // OpenRouter per-round cost + input/output breakdown rides the snapshot.
  if (r1.providerCost === 0.0011) {
    console.log('PASS: round 1 providerCost captured');
  } else {
    console.log('FAIL: round 1 providerCost mismatch', r1);
    process.exit(1);
  }
  if (r1.providerCostInput === 0.001 && r1.providerCostOutput === 0.0001) {
    console.log('PASS: round 1 cost_details breakdown captured');
  } else {
    console.log('FAIL: round 1 cost breakdown mismatch', r1);
    process.exit(1);
  }

  console.log('All assertions passed.');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
