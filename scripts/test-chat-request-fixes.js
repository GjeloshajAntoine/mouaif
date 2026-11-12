// Regression checks for the chat model-request review
// (docs/agent/plans/chat-model-request-tools-review.md).
//
//   S1  a reply cut at max_tokens while writing a tool call is not dispatched
//   S2  streamChat never writes per-run fields onto the caller's model
//   S3  a tool round with thinking replays the signed thinking block
//   S4  persisted ⚠ error rows stay out of the replayed history
//   S5  keep-alive chunks reach the idle watchdog
//   S6  tool-call deltas without `index` stay separate calls
//   F3  a retry re-runs the saved prompt instead of saving a copy
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-request-fixes-home-'));

const { streamChat, readSSE } = require('../src/ai-stream.js');
const messages = require('../src/messages.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const sse = (...frames) => frames.map((f) => 'data: ' + JSON.stringify(f)).join('\n\n') + '\n\n';
const streamOf = (text) => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
});

async function withFetch(responses, fn) {
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, statusText: 'OK', body: streamOf(responses.shift()) };
  };
  try { return await fn(bodies); }
  finally { global.fetch = realFetch; }
}

const SPECS = [{ type: 'function', function: { name: 'report_progress', description: 'Report progress', parameters: { type: 'object', properties: { title: { type: 'string' } } } } }];

(async () => {
  // ---- S2: the caller's model object is not mutated ------------------
  await withFetch([sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  )], async () => {
    const model = { id: 'claude-sonnet-4-5', provider: 'anthropic', auth: 'apikey', apiKey: 'sk-test' };
    await streamChat({ model, messages: [{ role: 'user', content: 'x' }], thinkingLevel: 'low', maxOutputTokens: '5000', noTools: true, onEvent: () => {} });
    check('S2: thinkingLevel is not written onto the caller model', !('thinkingLevel' in model), JSON.stringify(model));
    check('S2: maxOutputTokens is not written onto the caller model', !('maxOutputTokens' in model));
    check('S2: noTools is not written onto the caller model', !('noTools' in model));
  });

  // ---- S1: truncated tool call is refused ---------------------------
  await withFetch([sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'report_progress', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"half' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 99 } },
    { type: 'message_stop' }
  )], async (bodies) => {
    const events = [];
    const r = await streamChat({
      model: { id: 'claude-sonnet-4-5', provider: 'anthropic', auth: 'apikey', apiKey: 'sk-test' },
      messages: [{ role: 'user', content: 'x' }], toolSpecs: SPECS,
      onEvent: (name, data) => events.push({ name, data })
    });
    check('S1: the turn fails with ETRUNCATED', r && r.ok === false && r.error && r.error.code === 'ETRUNCATED', JSON.stringify(r && r.error));
    check('S1: the cut-off call is never dispatched', !events.some((e) => e.name === 'tool_call'));
    check('S1: finish max_tokens reaches the client', events.some((e) => e.name === 'finish' && e.data.reason === 'max_tokens'));
    check('S1: one request only', bodies.length === 1);
    check('S1: default max_tokens is no longer 1024', bodies[0].max_tokens === 64000, String(bodies[0].max_tokens));
  });

  // ---- S3: thinking blocks replayed in the tool round ---------------
  await withFetch([
    sse(
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_progress', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"title":"T"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' }
    ),
    sse(
      { type: 'message_start', message: { usage: { input_tokens: 30 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    )
  ], async (bodies) => {
    const r = await streamChat({
      model: { id: 'claude-sonnet-5', provider: 'anthropic', auth: 'apikey', apiKey: 'sk-test' },
      thinkingLevel: 'medium',
      messages: [{ role: 'user', content: 'x' }], toolSpecs: SPECS,
      onEvent: () => {}
    });
    check('S3: the tool loop completes', r && r.ok === true, JSON.stringify(r && r.error));
    check('S3: adaptive thinking is requested', bodies[0].thinking && bodies[0].thinking.type === 'adaptive'
      && bodies[0].output_config && bodies[0].output_config.effort === 'medium', JSON.stringify(bodies[0].thinking));
    const assistant = bodies[1] && bodies[1].messages.find((m) => m.role === 'assistant');
    const types = assistant ? assistant.content.map((b) => b.type) : [];
    check('S3: the follow-up replays thinking before tool_use', JSON.stringify(types) === '["thinking","tool_use"]', JSON.stringify(types));
    check('S3: the signature is sent back unchanged', assistant && assistant.content[0].signature === 'sig-1' && assistant.content[0].thinking === 'plan');
  });

  // ---- S6: unindexed tool-call deltas -------------------------------
  await withFetch([
    sse(
      { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'report_progress', arguments: '{"title":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"a"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'report_progress', arguments: '{"title":"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ) + 'data: [DONE]\n\n',
    sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
  ], async () => {
    const events = [];
    await streamChat({
      model: { id: 'gpt-x', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test' },
      messages: [{ role: 'user', content: 'x' }], toolSpecs: SPECS,
      onEvent: (name, data) => events.push({ name, data })
    });
    const calls = events.filter((e) => e.name === 'tool_call').map((e) => JSON.stringify(e.data.args));
    check('S6: two calls without index stay separate', calls.length === 2 && calls[0] === '{"title":"a"}' && calls[1] === '{"title":"b"}', JSON.stringify(calls));
  });

  // ---- S5: keep-alive comments reach the watchdog -------------------
  {
    let chunks = 0;
    const frames = [];
    for await (const ev of readSSE(streamOf(': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\n'), () => { chunks++; })) frames.push(ev);
    check('S5: readSSE reports raw chunks, comments included', chunks === 1 && frames.length === 1, JSON.stringify({ chunks, frames }));
  }

  // ---- S4: error rows are not replayed ------------------------------
  {
    const history = messages.reconstructUpstreamHistory([
      { role: 'user', content: 'hi' },
      { role: 'system', content: '⚠ EUPSTREAM: Upstream 400 Bad Request' },
      { role: 'user', content: 'hi again' }
    ]);
    check('S4: the ⚠ row is skipped', history.length === 2 && history.every((m) => m.role === 'user'), JSON.stringify(history));
    const kept = messages.reconstructUpstreamHistory([{ role: 'system', content: 'A real system note' }, { role: 'user', content: 'hi' }]);
    check('S4: other system rows are kept', kept.length === 2);
  }

  // ---- F3: retry reuses the saved prompt ----------------------------
  {
    const err = { role: 'system', content: '⚠ EUPSTREAM: boom' };
    const user = { role: 'user', content: 'do it', attachments: [] };
    check('F3: prompt followed only by errors is reused', messages.retryableUserRow([user, err], 'do it', 0) === user);
    check('F3: a different prompt is not reused', messages.retryableUserRow([user, err], 'other', 0) === null);
    check('F3: partial model output means a new row', messages.retryableUserRow([user, { role: 'assistant', content: 'part' }, err], 'do it', 0) === null);
    check('F3: attachment count must match', messages.retryableUserRow([user, err], 'do it', 1) === null);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
