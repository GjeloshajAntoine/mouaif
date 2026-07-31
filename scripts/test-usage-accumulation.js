// Regression test: usage on EVERY streamed chunk must not double-count.
//
// OpenAI emits a single usage object on the final chunk (with
// stream_options.include_usage), but some OpenAI-compatible gateways stamp
// a running total on every chunk. The accumulator must take the LAST report
// of a round, not sum them. Across tool rounds the outputs are genuinely
// new and DO sum.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ai = require('../src/ai.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-usage-acc-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
settings.setProject(projectDir, { tools: { shell: { enabled: true, mode: 'allow' } } });

// Each script is an array of SSE payloads (objects) sent one data: line
// each, terminated by [DONE].
function serve(scriptPerRequest) {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const script = scriptPerRequest[Math.min(count, scriptPerRequest.length - 1)];
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const payload of script) res.write('data: ' + JSON.stringify(payload) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests: () => count }));
  });
}

const delta = (content) => ({ choices: [{ delta: { content }, index: 0 }] });
const stop = () => ({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] });
const usage = (p, c, extra) => ({ usage: Object.assign({ prompt_tokens: p, completion_tokens: c }, extra || {}) });

async function run(port, opts) {
  const events = [];
  const model = { id: 'mock', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', auth: 'apikey' };
  const result = await ai.streamChat(Object.assign({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    projectDir,
    chatId: 'usageacc1',
    onEvent: (name, data) => events.push({ name, data }),
    onRoundUsage: (ru) => events.push({ name: '_roundUsage', data: ru })
  }, opts || {}));
  return { result, events };
}

async function main() {
  // 1) Cumulative running-total usage on every chunk (the reported bug).
  {
    const { server, port } = await serve([[
      Object.assign(delta('Hello'), usage(100, 2)),
      Object.assign(delta(' world'), usage(100, 4)),
      Object.assign(stop(), usage(100, 5))
    ]]);
    const { result } = await run(port);
    server.close();
    check('cumulative chunks: ok', result.ok === true, JSON.stringify(result.error || {}));
    check('cumulative chunks: completionTokens is the last report (5), not the sum (11)',
      result.usage.completionTokens === 5, 'got ' + result.usage.completionTokens);
    check('cumulative chunks: promptTokens is the last report (100)',
      result.usage.promptTokens === 100, 'got ' + result.usage.promptTokens);
  }

  // 2) OpenAI-standard single final usage chunk still works.
  {
    const { server, port } = await serve([[
      delta('Hello'), delta(' world'), stop(), usage(100, 5)
    ]]);
    const { result } = await run(port);
    server.close();
    check('single final usage: completionTokens 5', result.usage.completionTokens === 5, 'got ' + result.usage.completionTokens);
    check('single final usage: promptTokens 100', result.usage.promptTokens === 100, 'got ' + result.usage.promptTokens);
  }

  // 3) Repeated providerCost on intermediate chunks is not summed within a round.
  {
    const { server, port } = await serve([[
      Object.assign(delta('a'), usage(10, 1, { cost: 0.001 })),
      Object.assign(stop(), usage(10, 2, { cost: 0.002 }))
    ]]);
    const { result } = await run(port);
    server.close();
    check('cumulative cost: providerCost is the last report (0.002), not the sum (0.003)',
      result.providerCost === 0.002, 'got ' + result.providerCost);
  }

  // 4) Tool rounds still sum completion tokens across rounds (genuinely new output),
  //    while prompt stays last-round-wins.
  {
    const toolCall = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"echo hi"}' } }] }, index: 0 }] };
    const toolStop = { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] };
    const { server, port, requests } = await serve([
      [delta('running.'), toolCall, toolStop, usage(100, 20, { cost: 0.001 })],
      [delta('done.'), stop(), usage(200, 10, { cost: 0.0005 })]
    ]);
    const { result, events } = await run(port);
    server.close();
    check('tool loop made two requests', requests() === 2, 'got ' + requests());
    check('tool rounds: completionTokens sum across rounds (20 + 10 = 30)',
      result.usage.completionTokens === 30, 'got ' + result.usage.completionTokens);
    check('tool rounds: promptTokens is the final round footprint (200)',
      result.usage.promptTokens === 200, 'got ' + result.usage.promptTokens);
    check('tool rounds: providerCost sums across rounds (0.0015)',
      Math.abs(result.providerCost - 0.0015) < 1e-9, 'got ' + result.providerCost);
    const roundUsages = events.filter(e => e.name === '_roundUsage');
    check('tool rounds: one round-usage snapshot per round', roundUsages.length === 2, 'got ' + roundUsages.length);
    check('tool rounds: round 1 snapshot carries its own usage',
      roundUsages[0] && roundUsages[0].data.promptTokens === 100 && roundUsages[0].data.completionTokens === 20,
      JSON.stringify(roundUsages[0] && roundUsages[0].data));
  }

  // 5) Zero-usage intermediate chunks (some gateways send usage: {prompt:0, completion:0}
  //    until the final chunk) must not clobber the real final numbers.
  {
    const { server, port } = await serve([[
      Object.assign(delta('x'), usage(0, 0)),
      Object.assign(stop(), usage(50, 7))
    ]]);
    const { result } = await run(port);
    server.close();
    check('zero intermediate usage: final numbers win',
      result.usage.promptTokens === 50 && result.usage.completionTokens === 7,
      JSON.stringify(result.usage));
  }

  // 6) Anthropic path: usage arrives as message_start (input) + several
  //    message_delta (output) frames. The repeated output commits must not
  //    sum, and the single round snapshot must carry the final numbers.
  {
    const { server, port } = await serve([[
      { type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 90, cache_creation_input_tokens: 30 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' }
    ]]);
    const events = [];
    const model = { id: 'claude-mock', provider: 'anthropic', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', auth: 'apikey' };
    const result = await ai.streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      projectDir,
      chatId: 'usageacc1',
      onEvent: (name, data) => events.push({ name, data }),
      onRoundUsage: (ru) => events.push({ name: '_roundUsage', data: ru })
    });
    server.close();
    check('anthropic: ok', result.ok === true, JSON.stringify(result.error || {}));
    check('anthropic: repeated message_delta usage not summed (7, not 10)',
      result.usage.completionTokens === 7, 'got ' + result.usage.completionTokens);
    check('anthropic: promptTokens from message_start (120)',
      result.usage.promptTokens === 120, 'got ' + result.usage.promptTokens);
    const roundUsages = events.filter(e => e.name === '_roundUsage');
    check('anthropic: one snapshot per usage_output delta', roundUsages.length === 2, 'got ' + roundUsages.length);
    check('anthropic: last snapshot carries the cumulative round total',
      roundUsages.length && roundUsages[roundUsages.length - 1].data.promptTokens === 120 &&
        roundUsages[roundUsages.length - 1].data.completionTokens === 7,
      JSON.stringify(roundUsages[roundUsages.length - 1] && roundUsages[roundUsages.length - 1].data));
  }

  // 7) Anthropic prompt-cache metrics flow from message_start into the
  //    round snapshots and the final turn usage (for cache-aware cost).
  {
    const { server, port } = await serve([[
      { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', usage: { output_tokens: 50 } },
      { type: 'message_stop' }
    ]]);
    const events = [];
    const model = { id: 'claude-mock', provider: 'anthropic', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', auth: 'apikey' };
    const result = await ai.streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      projectDir,
      chatId: 'usageacc1',
      onEvent: (name, data) => events.push({ name, data }),
      onRoundUsage: (ru) => events.push({ name: '_roundUsage', data: ru })
    });
    server.close();
    check('anthropic cache: ok', result.ok === true, JSON.stringify(result.error || {}));
    check('anthropic cache: final usage carries cacheReadTokens (400)',
      result.usage.cacheReadTokens === 400, 'got ' + result.usage.cacheReadTokens);
    check('anthropic cache: final usage carries cacheCreationTokens (100)',
      result.usage.cacheCreationTokens === 100, 'got ' + result.usage.cacheCreationTokens);
    const roundUsages = events.filter(e => e.name === '_roundUsage');
    check('anthropic cache: round snapshot carries cacheReadTokens',
      roundUsages.length && roundUsages[roundUsages.length - 1].data.cacheReadTokens === 400,
      JSON.stringify(roundUsages[roundUsages.length - 1] && roundUsages[roundUsages.length - 1].data));
    check('anthropic cache: round snapshot carries cacheCreationTokens',
      roundUsages.length && roundUsages[roundUsages.length - 1].data.cacheCreationTokens === 100,
      JSON.stringify(roundUsages[roundUsages.length - 1] && roundUsages[roundUsages.length - 1].data));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
