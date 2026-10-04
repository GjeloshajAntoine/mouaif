'use strict';

// Native tool calling on the four cloud OpenAI-shaped providers.
//
// The tool loop's advertisement gate used to be an ad-hoc provider check that
// named only `openai-compatible`, `openrouter`, and `github-copilot`. Azure,
// Mistral, Groq, and DeepSeek reuse the exact same `buildOpenAIRequest` /
// `parseOpenAISSE` pair, but they were not in that list, so a chat on any of
// them silently advertised **no tools at all** — the model never saw `shell`,
// `read_file`, or an MCP tool, and nothing in the UI said why.
//
// The answer now lives in one place, `src/providerShapes.js` →
// `supportsOpenAIToolLoop()`, read by both the advertisement gate
// (src/ai-stream.js) and the history-reconstruction mirror
// (src/server-handlers-chats.js) so the two cannot drift again.
//
// This test pins three things:
//   1. the function's membership, in both directions (the four are in; the
//      deliberately-excluded providers are out, with the reason);
//   2. that a real streamed turn on each of the four attaches `body.tools`;
//   3. that Ollama still does NOT, because its `/api/chat` function-result
//      shape (`tool_name`, no call id) is not what the loop appends.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store before requiring any src module: settings.js captures
// MOUAIF_HOME at require time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cloud-tools-home-'));
process.env.MOUAIF_HOME = home;

const shapes = require(path.resolve(__dirname, '..', 'src', 'providerShapes.js'));
const { streamChat } = require(path.resolve(__dirname, '..', 'src', 'ai-stream.js'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const CLOUD = ['azure', 'mistral', 'groq', 'deepseek'];

// A tool the model can actually call. `report_progress` is answered without an
// approval card by the loop (see NO_PROMPT_TOOLS), so the test exercises the
// real dispatch path instead of stopping at an authorization prompt.
const SPECS = [
  { type: 'function', function: { name: 'report_progress', description: 'Report progress',
    parameters: { type: 'object', properties: { title: { type: 'string' }, current: { type: 'number' },
      total: { type: 'number' }, status: { type: 'string' } }, required: ['title', 'current', 'total'] } } }
];

// ---- 1. Membership ------------------------------------------------------

check('the four cloud providers are in the tool-loop list',
  CLOUD.every((p) => shapes.supportsOpenAIToolLoop(p)), CLOUD.join(','));

check('the original three OpenAI-shaped chat providers are still in it',
  shapes.supportsOpenAIToolLoop('openai-compatible')
  && shapes.supportsOpenAIToolLoop('openrouter')
  && shapes.supportsOpenAIToolLoop('github-copilot'));

check('Ollama is excluded — its /api/chat tool-result shape is not the loop\'s',
  shapes.supportsOpenAIToolLoop('ollama') === false,
  'ollama keyless OpenAI shape is for dictation; chat tools go through /v1 openai-compatible');

check('Gemini is excluded — per-model generateContent tool shape',
  shapes.supportsOpenAIToolLoop('gemini') === false);

check('Codex and Anthropic are excluded — their own builders convert the specs',
  shapes.supportsOpenAIToolLoop('codex') === false
  && shapes.supportsOpenAIToolLoop('anthropic') === false);

check('an unknown or absent provider is not in the loop',
  shapes.supportsOpenAIToolLoop('custom-gateway') === false
  && shapes.supportsOpenAIToolLoop('') === false
  && shapes.supportsOpenAIToolLoop(null) === false
  && shapes.supportsOpenAIToolLoop(undefined) === false);

check('the list is frozen so a consumer cannot mutate the shared answer',
  Object.isFrozen(shapes.OPENAI_CHAT_TOOL_PROVIDERS));

// The list must stay a subset of the OpenAI-shaped list: a provider that is
// not OpenAI-shaped cannot be chatting at /chat/completions.
check('every tool-loop provider is also OpenAI-shaped',
  shapes.OPENAI_CHAT_TOOL_PROVIDERS.every((p) => shapes.isOpenAIShaped(p)),
  shapes.OPENAI_CHAT_TOOL_PROVIDERS.join(','));

// ---- 2. A real streamed turn on each cloud provider ---------------------

// OpenAI-shaped SSE: first turn asks for the tool, second turn answers with
// text. Two turns is enough to prove the loop ran the call and fed the result
// back — a provider with no tools advertised ends after turn one with the
// literal text and no tool_call event.
const sseText = (...frames) => frames.map((f) => 'data: ' + f).join('\n\n') + '\n\n';
const turn1 = sseText(
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_cloud_1","type":"function","function":{"name":"report_progress","arguments":"{\\"title\\":\\"Cloud tools\\",\\"current\\":1,\\"total\\":2,\\"status\\":\\"running\\"}"}}]}}]}',
  '{"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
  '[DONE]'
);
const turn2 = sseText(
  '{"choices":[{"delta":{"content":"Tool ran."}}]}',
  '{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3}}',
  '[DONE]'
);

async function runCloud(provider) {
  const capturedBodies = [];
  const responses = [turn1, turn2];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    const text = responses.shift();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
    });
    return { ok: true, status: 200, statusText: 'OK', body: stream, text: async () => text, json: async () => ({}) };
  };
  const events = [];
  let result;
  try {
    result = await streamChat({
      model: { id: 'test-model', provider, apiKey: 'sk-test' },
      messages: [{ role: 'user', content: 'go' }],
      onEvent: (name, data) => events.push({ name, data })
    });
  } finally {
    global.fetch = realFetch;
  }
  return { capturedBodies, events, result };
}

(async () => {
  for (const provider of CLOUD) {
    const { capturedBodies, events, result } = await runCloud(provider);
    const toolCall = events.find((e) => e.name === 'tool_call');
    const toolResult = events.find((e) => e.name === 'tool_result');
    const text = events.filter((e) => e.name === 'message').map((e) => e.data.delta).join('');
    check(provider + ': the request advertises tools',
      Array.isArray(capturedBodies[0] && capturedBodies[0].tools) && capturedBodies[0].tools.length > 0,
      JSON.stringify(capturedBodies[0] && capturedBodies[0].tools));
    check(provider + ': the loop ran the tool call',
      toolCall && toolCall.data.name === 'report_progress' && toolCall.data.id === 'call_cloud_1',
      JSON.stringify(toolCall && toolCall.data));
    check(provider + ': the tool result came back ok',
      !!(toolResult && toolResult.data && toolResult.data.ok));
    check(provider + ': a second upstream turn carried the tool history',
      capturedBodies.length === 2 && capturedBodies[1].messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)),
      JSON.stringify(capturedBodies[1] && capturedBodies[1].messages));
    check(provider + ': the tool result message is OpenAI-shaped (tool_call_id)',
      capturedBodies.length === 2 && capturedBodies[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_cloud_1'),
      JSON.stringify(capturedBodies[1] && capturedBodies[1].messages));
    check(provider + ': the final answer streamed', text === 'Tool ran.', text);
    check(provider + ': the turn reported ok', !!(result && result.ok === true), JSON.stringify(result));
  }

  // ---- 3. Ollama keeps its own shape: no `tools` on the wire ------------
  {
    const capturedBodies = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      const text = '{"model":"x","message":{"role":"assistant","content":"hi"},"done":true}\n';
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
      });
      return { ok: true, status: 200, statusText: 'OK', body: stream, text: async () => text, json: async () => ({}) };
    };
    try {
      await streamChat({
        model: { id: 'llama3', provider: 'ollama' },
        messages: [{ role: 'user', content: 'go' }],
        onEvent: () => {}
      });
    } finally {
      global.fetch = realFetch;
    }
    check('ollama: no `tools` field is attached (native /api/chat is a different contract)',
      capturedBodies.length === 1 && !('tools' in capturedBodies[0]),
      JSON.stringify(capturedBodies[0]));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
