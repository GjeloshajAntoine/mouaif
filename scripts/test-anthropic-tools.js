// Verify Anthropic native tool calling + prompt-cache markers.
//
// Covers three layers:
//   1. buildAnthropicRequest converts OpenAI-shaped specs to Anthropic
//      `tools` and marks the LAST tool (and the system block) with
//      cache_control — the documented pattern that pushes the cached
//      prefix past the per-model minimum cacheable length (1024 tokens
//      for Sonnet 3.5/3.7, 4096 for Sonnet 4 / Opus 4 / Haiku 4.5),
//      below which the API silently ignores cache_control entirely.
//   2. parseAnthropicSSE accumulates input_json_delta frames and emits
//      OpenAI-shaped tool_call_delta events for tool_use blocks.
//   3. streamChat runs the full multi-turn loop against a mocked
//      Anthropic SSE stream: tool_use round -> tool_result round ->
//      final text, with cache read/write counts folded into `done`.
'use strict';

const path = require('path');
const { BUILDERS, PARSERS } = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));
const { streamChat } = require(path.resolve(__dirname, '..', 'src', 'ai-stream.js'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const SPECS = [
  { type: 'function', function: { name: 'shell', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'report_progress', description: 'Report progress', parameters: { type: 'object', properties: { title: { type: 'string' }, current: { type: 'number' }, total: { type: 'number' }, status: { type: 'string' } }, required: ['title', 'current', 'total'] } } }
];
const MODEL = { id: 'claude-sonnet-4-5', provider: 'anthropic', maxTokens: 4096, auth: 'apikey', apiKey: 'sk-test' };

// ---- 1. Request builder -------------------------------------------------

{
  const messages = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Run something' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01abc', type: 'function', function: { name: 'report_progress', arguments: '{"title":"T","current":1,"total":2,"status":"running"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_01abc', name: 'report_progress', content: '{"ok":true}' },
    { role: 'user', content: 'ok thanks' }
  ];
  const req = BUILDERS.anthropic(MODEL, messages, true, SPECS);

  check('builder: tools array present', Array.isArray(req.body.tools) && req.body.tools.length === SPECS.length);
  check('builder: tools converted to Anthropic shape', req.body.tools[0].name === 'shell' && req.body.tools[0].input_schema.type === 'object' && req.body.tools[0].input_schema.properties.cmd);
  check('builder: cache_control on LAST tool only', !('cache_control' in req.body.tools[0]) && req.body.tools[1].cache_control && req.body.tools[1].cache_control.type === 'ephemeral', JSON.stringify(req.body.tools));
  check('builder: system block cacheable', req.body.system[0].cache_control && req.body.system[0].cache_control.type === 'ephemeral');
  check('builder: assistant tool_calls -> tool_use block', req.body.messages[1].role === 'assistant' && req.body.messages[1].content[0].type === 'tool_use' && req.body.messages[1].content[0].id === 'toolu_01abc' && req.body.messages[1].content[0].input.title === 'T');
  check('builder: tool role -> user tool_result', req.body.messages[2].role === 'user' && req.body.messages[2].content[0].type === 'tool_result' && req.body.messages[2].content[0].tool_use_id === 'toolu_01abc');
  // The penultimate message (the deepest stable, replayed point) carries
  // the breakpoint that guarantees the cached prefix clears the per-model
  // minimum cacheable length even when the system + tools prefix is short.
  check('builder: penultimate message cacheable (tool_result block)',
    req.body.messages.length === 4 && req.body.messages[2].content[0].cache_control
      && req.body.messages[2].content[0].cache_control.type === 'ephemeral',
    JSON.stringify(req.body.messages));
  check('builder: final message never marked',
    !req.body.messages[req.body.messages.length - 1].cache_control
      && !(req.body.messages[req.body.messages.length - 1].content && req.body.messages[req.body.messages.length - 1].content[0] && req.body.messages[req.body.messages.length - 1].content[0].cache_control));

  // Prompt caching is generally available and works alongside OAuth's beta gate.
  const oauthReq = BUILDERS.anthropic(Object.assign({}, MODEL, { auth: 'oauth' }), messages, true, SPECS);
  const oauthBody = JSON.stringify(oauthReq.body);
  check('builder: OAuth model carries cache_control', oauthBody.indexOf('cache_control') >= 0);

  // Empty specs -> no tools field at all (system-only request stays valid).
  const noToolsReq = BUILDERS.anthropic(MODEL, [{ role: 'user', content: 'hi' }], true, undefined);
  check('builder: no specs -> no tools field', !('tools' in noToolsReq.body));
  check('builder: single-message request has no message marker',
    typeof noToolsReq.body.messages[0].content === 'string'
      || !('cache_control' in (Array.isArray(noToolsReq.body.messages[0].content) ? noToolsReq.body.messages[0].content[0] : {})));

  // With NO tools and a short system block, the penultimate-message
  // breakpoint is what makes the cache engage — the exact "every tool
  // switched off" case.
  const bareReq = BUILDERS.anthropic(MODEL, [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'run the tools' }
  ], true, undefined);
  check('builder: no-tools request marks the penultimate message',
    !('tools' in bareReq.body) && bareReq.body.messages.length === 3
      && bareReq.body.messages[1].content[0].cache_control
      && bareReq.body.messages[1].content[0].cache_control.type === 'ephemeral',
    JSON.stringify(bareReq.body.messages));
  // A plain-text penultimate message is wrapped into an object text block
  // so the cache_control field is honored.
  const textReq = BUILDERS.anthropic(MODEL, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' }
  ], true, undefined);
  check('builder: plain-text penultimate wrapped as text block',
    textReq.body.messages.length === 3
      && textReq.body.messages[1].content[0].type === 'text'
      && textReq.body.messages[1].content[0].text === 'answer'
      && textReq.body.messages[1].content[0].cache_control,
    JSON.stringify(textReq.body.messages[1]));
}

// ---- 2. Parser ----------------------------------------------------------

{
  // A shared per-turn accumulator mirrors how src/ai-stream.js drives the
  // parser (one generator per SSE frame).
  const acc = new Map();
  const events = [];
  const frames = [
    '{"type":"message_start","message":{"usage":{"input_tokens":5200,"cache_creation_input_tokens":5000}}}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_xyz","name":"report_progress","input":{}}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"title\\":\\"T\\","}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"current\\":1}"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":60}}',
    '{"type":"message_stop"}'
  ];
  for (const f of frames) {
    for (const ev of PARSERS.anthropic('message', f, acc)) events.push(ev);
  }
  const usageInput = events.find((e) => e.name === 'usage_input');
  const tcd = events.find((e) => e.name === 'tool_call_delta');
  const usageOutput = events.find((e) => e.name === 'usage_output');
  check('parser: usage_input carries cache_creation tokens', usageInput && usageInput.data.cacheCreationTokens === 5000);
  check('parser: prompt total includes uncached and cache-created input', usageInput && usageInput.data.promptTokens === 10200, JSON.stringify(usageInput));
  check('parser: tool_call_delta emitted on block stop', tcd && tcd.data.id === 'toolu_xyz' && tcd.data.function.name === 'report_progress');
  check('parser: input_json_delta frames accumulated', tcd && tcd.data.function.arguments === '{"title":"T","current":1}', tcd && tcd.data.function.arguments);
  check('parser: usage_output from message_delta', usageOutput && usageOutput.data.completionTokens === 60);
  check('parser: done on message_stop', events.some((e) => e.name === 'done' && e.data && typeof e.data === 'object'));
}

// ---- 3. End-to-end multi-turn loop with a mocked upstream ---------------

(async () => {
  const capturedBodies = [];
  const sseText = (...frames) => frames.map((f) => 'data: ' + f).join('\n\n') + '\n\n';
  const turn1 = sseText(
    '{"type":"message_start","message":{"usage":{"input_tokens":5200,"cache_creation_input_tokens":5000}}}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"report_progress","input":{}}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"title\\":\\"Anthropic tools\\",\\"current\\":1,\\"total\\":2,\\"status\\":\\"running\\"}"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}',
    '{"type":"message_stop"}'
  );
  const turn2 = sseText(
    '{"type":"message_start","message":{"usage":{"input_tokens":5600,"cache_read_input_tokens":5200}}}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cache works now."}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
    '{"type":"message_stop"}'
  );
  const responses = [turn1, turn2];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    capturedBodies.push(body);
    const text = responses.shift();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }
    });
    return { ok: true, status: 200, statusText: 'OK', body: stream };
  };
  try {
    const events = [];
    const r = await streamChat({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      onEvent: (name, data) => events.push({ name, data })
    });
    const toolCall = events.find((e) => e.name === 'tool_call');
    const toolResult = events.find((e) => e.name === 'tool_result');
    const text = events.filter((e) => e.name === 'message').map((e) => e.data.delta).join('');
    const done = events.find((e) => e.name === 'done');
    const usage = done && done.data && done.data.usage;

    check('loop: ok', r && r.ok === true);
    check('loop: tool_call emitted', toolCall && toolCall.data.name === 'report_progress' && toolCall.data.id === 'toolu_01');
    check('loop: tool_result emitted', toolResult && toolResult.data.ok === true);
    check('loop: final text streamed', text === 'Cache works now.', text);
    check('loop: request 1 has native tools', Array.isArray(capturedBodies[0].tools) && capturedBodies[0].tools.length > 0);
    check('loop: request 1 last tool cacheable', capturedBodies[0].tools[capturedBodies[0].tools.length - 1].cache_control !== undefined);
    check('loop: request 2 carries tool_use block', capturedBodies[1].messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use' && c.id === 'toolu_01')), JSON.stringify(capturedBodies[1].messages));
    check('loop: request 2 carries tool_result block', capturedBodies[1].messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'toolu_01')), JSON.stringify(capturedBodies[1].messages));
    // Request 2's penultimate message (the assistant tool_use turn) carries
    // the cache breakpoint that guarantees the prefix clears the minimum.
    check('loop: request 2 penultimate message cacheable',
      capturedBodies[1].messages.length === 3
        && capturedBodies[1].messages[1].content[0].cache_control
        && capturedBodies[1].messages[1].content[0].cache_control.type === 'ephemeral',
      JSON.stringify(capturedBodies[1].messages));
    check('loop: cache_creation folded into done usage', usage && usage.cacheCreationTokens === 5000, JSON.stringify(usage));
    check('loop: cache_read folded into done usage', usage && usage.cacheReadTokens === 5200, JSON.stringify(usage));
    check('loop: prompt tokens include uncached and cached input (last round wins)', usage && usage.promptTokens === 10800, JSON.stringify(usage));
    check('loop: completion tokens summed across rounds', usage && usage.completionTokens === 55, JSON.stringify(usage));
  } finally {
    global.fetch = realFetch;
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(1);
});
