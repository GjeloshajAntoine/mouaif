'use strict';

// Smoke test for the native shell tool (src/tools/shell.js) and the
// multi-turn tool loop in ai.streamChat (src/ai.js). No real provider
// is contacted: a local HTTP server mocks an OpenAI-compatible upstream
// that asks for a `shell` tool call on the first request, then answers
// with text on the second (after seeing the tool result). Prints a
// pass/fail summary and exits non-zero on any failure.

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const shell = require('../src/tools/shell.js');
const ai = require('../src/ai.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function sse(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const l of lines) res.write('data: ' + JSON.stringify(l) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

async function main() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-shell-project-'));
  const chatId = 'a1b2c3d4';
  settings.setProject(projectDir, {
    chats: [{ id: chatId, title: 'Shell tool test', trace: false }],
    tools: {
      shell: { enabled: true, mode: 'allow' },
      subagent: { enabled: true, mode: 'allow' },
      file: { enabled: true, mode: 'allow' }
    }
  });
  // ---- Part 1: runShell directly ----------------------------------
  const echoCmd = process.platform === 'win32' ? 'echo hello-shell' : 'echo hello-shell';
  const r1 = await shell.runShell({ projectDir: process.cwd(), cmd: echoCmd });
  check('runShell ok on echo', r1.ok === true, JSON.stringify(r1));
  check('runShell captured stdout', /hello-shell/.test(r1.stdout || ''), JSON.stringify(r1.stdout));
  check('runShell exitCode 0', r1.exitCode === 0, String(r1.exitCode));
  check('runShell reports durationMs', typeof r1.durationMs === 'number', String(r1.durationMs));

  const r2 = await shell.runShell({ projectDir: process.cwd(), cmd: '' });
  check('runShell rejects empty cmd', r2.ok === false && r2.code === 'EBADINPUT', JSON.stringify(r2));

  const r3 = await shell.runShell({ projectDir: os.tmpdir() + '/does-not-exist-xyz', cmd: 'echo x' });
  check('runShell rejects missing dir', r3.ok === false, JSON.stringify(r3));

  // A non-zero exit is ok:false but not an error.
  const failCmd = process.platform === 'win32' ? 'exit 3' : 'exit 3';
  const r4 = await shell.runShell({ projectDir: process.cwd(), cmd: failCmd });
  check('runShell surfaces non-zero exit', r4.ok === false && r4.exitCode === 3, JSON.stringify(r4));

  // Truncation.
  const s = shell.truncate('x'.repeat(1000), 100);
  check('truncate caps output', s.length < 1000 && /truncated/.test(s), String(s.length));

  // SPEC shape.
  check('SPEC advertises shell', shell.SPEC && shell.SPEC.function && shell.SPEC.function.name === 'shell', JSON.stringify(shell.SPEC && shell.SPEC.function && shell.SPEC.function.name));

  // ---- Part 2: multi-turn loop via a mock upstream ----------------
  let requestCount = 0;
  let sawToolMessage = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requestCount++;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (requestCount === 1) {
        // First turn: ask for a shell tool call.
        check('first request advertises shell tool',
          Array.isArray(parsed.tools) && parsed.tools.some(t => t.function && t.function.name === 'shell'),
          JSON.stringify(parsed.tools));
        sse(res, [
          { choices: [{ delta: { content: 'I will run the command.' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"echo loop-works"}' } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }] },
          { usage: { prompt_tokens: 10, completion_tokens: 2 } }
        ]);
      } else {
        // Second turn: the conversation must now contain the tool result.
        sawToolMessage = msgs.some(m => m.role === 'tool');
        sse(res, [
          { choices: [{ delta: { content: 'The command output was captured.' } }] },
          { choices: [{ finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 20, completion_tokens: 6 } }
        ]);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const events = [];
  const model = {
    id: 'mock-model',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:' + port,
    apiKey: 'test-key',
    auth: 'apikey'
  };
  const result = await ai.streamChat({
    model,
    messages: [{ role: 'user', content: 'run echo loop-works' }],
    projectDir,
    chatId,
    shellEnabled: true,
    onEvent: (name, data) => events.push({ name, data })
  });

  server.close();

  check('loop returned ok', result.ok === true, JSON.stringify(result));
  check('loop made two upstream requests', requestCount === 2, String(requestCount));
  check('loop fed tool result back to model', sawToolMessage === true);

  const names = events.map(e => e.name);
  check('emitted a tool_call event', names.includes('tool_call'));
  check('emitted a tool_result event', names.includes('tool_result'));
  check('assistant segment closes before tool call',
    names.indexOf('assistant_turn_end') !== -1 && names.indexOf('assistant_turn_end') < names.indexOf('tool_call'),
    JSON.stringify(names));
  const boundary = events.find(e => e.name === 'assistant_turn_end');
  check('assistant boundary carries pre-tool text',
    boundary && boundary.data.content === 'I will run the command.', JSON.stringify(boundary));
  check('post-tool assistant text follows tool result',
    names.lastIndexOf('message') > names.indexOf('tool_result'), JSON.stringify(names));
  check('tool call immediately precedes its result when authorized',
    names.indexOf('tool_result') === names.indexOf('tool_call') + 1, JSON.stringify(names));
  check('emitted exactly one done event', names.filter(n => n === 'done').length === 1, JSON.stringify(names));

  const toolCall = events.find(e => e.name === 'tool_call');
  check('tool_call names shell', toolCall && toolCall.data.name === 'shell', JSON.stringify(toolCall && toolCall.data));
  check('tool_call carries cmd arg', toolCall && toolCall.data.args && toolCall.data.args.cmd === 'echo loop-works', JSON.stringify(toolCall && toolCall.data.args));

  const toolResult = events.find(e => e.name === 'tool_result');
  check('tool_result ok', toolResult && toolResult.data.ok === true, JSON.stringify(toolResult && toolResult.data));
  check('tool_result carries stdout', toolResult && /loop-works/.test((toolResult.data.result && toolResult.data.result.stdout) || ''), JSON.stringify(toolResult && toolResult.data.result));

  const finalMsg = events.filter(e => e.name === 'message').map(e => e.data.delta).join('');
  check('final assistant text present', /output was captured/.test(finalMsg), finalMsg);

  // ---- Part 2b: model feedback is capped, SSE result stays complete --
  let cappedRequests = 0;
  let cappedToolBytes = 0;
  const serverCapped = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      cappedRequests++;
      const parsed = JSON.parse(body);
      if (cappedRequests === 1) {
        sse(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_big', function: { name: 'shell', arguments: JSON.stringify({ cmd: 'node -e "process.stdout.write(\'x\'.repeat(10000))"' }) } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }] }
        ]);
      } else {
        const toolMessage = (parsed.messages || []).find((m) => m.role === 'tool' && m.name === 'shell');
        cappedToolBytes = toolMessage ? Buffer.byteLength(toolMessage.content, 'utf8') : 0;
        sse(res, [
          { choices: [{ delta: { content: 'Large output handled.' } }] },
          { choices: [{ finish_reason: 'stop' }] }
        ]);
      }
    });
  });
  await new Promise((resolve) => serverCapped.listen(0, '127.0.0.1', resolve));
  const cappedEvents = [];
  const cappedResult = await ai.streamChat({
    model: Object.assign({}, model, { baseUrl: 'http://127.0.0.1:' + serverCapped.address().port }),
    messages: [{ role: 'user', content: 'produce a large result' }],
    projectDir,
    chatId,
    appSettings: { toolFeedbackMaxBytes: 4096 },
    onEvent: (name, data) => cappedEvents.push({ name, data })
  });
  serverCapped.close();
  const cappedRichResult = cappedEvents.find((e) => e.name === 'tool_result' && e.data.name === 'shell');
  check('large live tool loop returned ok', cappedResult.ok && cappedRequests === 2, JSON.stringify(cappedResult));
  check('large model-facing tool result is capped', cappedToolBytes > 0 && cappedToolBytes <= 4096, String(cappedToolBytes));
  check('large SSE tool result stays complete', cappedRichResult && cappedRichResult.data.result.stdout.length === 10000, JSON.stringify(cappedRichResult && cappedRichResult.data.result));

  // ---- Part 3: subagent usage is counted in parent totals ------------
  let subagentRequests = 0;
  let subagentParentFeedback = null;
  const serverSubagent = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      subagentRequests++;
      if (subagentRequests === 1) {
        sse(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sub_1', function: { name: 'subagent', arguments: JSON.stringify({ task: 'answer briefly' }) } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }] },
          { usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } }
        ]);
      } else if (subagentRequests === 2) {
        sse(res, [
          { choices: [{ delta: { content: 'Nested answer.' } }] },
          { choices: [{ finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 30, completion_tokens: 5, cost: 0.0003 } }
        ]);
      } else {
        const parsed = JSON.parse(body);
        const toolMessage = (parsed.messages || []).find((m) => m.role === 'tool' && m.name === 'subagent');
        try { subagentParentFeedback = toolMessage ? JSON.parse(toolMessage.content) : null; } catch { /* assertion reports failure */ }
        sse(res, [
          { choices: [{ delta: { content: 'Parent final.' } }] },
          { choices: [{ finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.002 } }
        ]);
      }
    });
  });
  await new Promise((resolve) => serverSubagent.listen(0, '127.0.0.1', resolve));
  const subagentEvents = [];
  const subagentResult = await ai.streamChat({
    model: Object.assign({}, model, { baseUrl: 'http://127.0.0.1:' + serverSubagent.address().port }),
    messages: [{ role: 'user', content: 'delegate once' }],
    projectDir,
    chatId,
    onEvent: (name, data) => subagentEvents.push({ name, data })
  });
  serverSubagent.close();
  const subagentDone = subagentEvents.find((e) => e.name === 'done');
  const subagentToolResult = subagentEvents.find((e) => e.name === 'tool_result' && e.data && e.data.name === 'subagent');
  check('subagent loop returned ok', subagentResult.ok === true && subagentRequests === 3, JSON.stringify(subagentResult));
  check('subagent tool result carries nested usage', subagentToolResult && subagentToolResult.data.result && subagentToolResult.data.result.usage && subagentToolResult.data.result.usage.promptTokens === 30, JSON.stringify(subagentToolResult && subagentToolResult.data));
  check('subagent parent feedback keeps final text', subagentParentFeedback && subagentParentFeedback.text === 'Nested answer.', JSON.stringify(subagentParentFeedback));
  check('subagent parent feedback omits nested transcript', subagentParentFeedback && !Object.hasOwn(subagentParentFeedback, 'chat') && !Object.hasOwn(subagentParentFeedback, 'toolEvents'), JSON.stringify(subagentParentFeedback));
  check('subagent prompt usage added to final done', subagentDone && subagentDone.data.usage.promptTokens === 230, JSON.stringify(subagentDone && subagentDone.data));
  check('subagent completion usage added to final done', subagentDone && subagentDone.data.usage.completionTokens === 35, JSON.stringify(subagentDone && subagentDone.data));
  check('subagent provider cost added to final done', subagentDone && subagentDone.data.providerCost === 0.0033, JSON.stringify(subagentDone && subagentDone.data));
  check('streamChat result includes subagent usage', subagentResult.usage.promptTokens === 230 && subagentResult.usage.completionTokens === 35, JSON.stringify(subagentResult.usage));

  // ---- Part 4: retry an empty response after a tool result ------------
  let emptyReplyRequests = 0;
  let emptyReplySawReminder = false;
  const serverEmptyReply = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      emptyReplyRequests++;
      const parsed = JSON.parse(body);
      if (emptyReplyRequests === 1) {
        sse(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_empty', function: { name: 'search_files', arguments: '{"query":"needle"}' } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }] }
        ]);
      } else if (emptyReplyRequests === 2) {
        // Reproduce providers that acknowledge the tool result with an
        // empty `stop` response instead of answering the user.
        sse(res, [{ choices: [{ finish_reason: 'stop' }] }]);
      } else {
        emptyReplySawReminder = parsed.messages.some((m) => m.role === 'system' && /final user-facing answer now/.test(m.content || ''));
        sse(res, [
          { choices: [{ delta: { content: 'The search found no matches.' } }] },
          { choices: [{ finish_reason: 'stop' }] }
        ]);
      }
    });
  });
  await new Promise((resolve) => serverEmptyReply.listen(0, '127.0.0.1', resolve));
  const emptyReplyEvents = [];
  const emptyReplyResult = await ai.streamChat({
    model: Object.assign({}, model, { baseUrl: 'http://127.0.0.1:' + serverEmptyReply.address().port }),
    messages: [{ role: 'user', content: 'find needle' }],
    projectDir,
    chatId,
    onEvent: (name, data) => emptyReplyEvents.push({ name, data })
  });
  serverEmptyReply.close();
  check('empty post-tool answer is retried', emptyReplyResult.ok && emptyReplyRequests === 3, JSON.stringify(emptyReplyResult));
  check('post-tool retry includes an answer reminder', emptyReplySawReminder === true);
  check('post-tool retry emits the final answer', emptyReplyEvents.some((e) => e.name === 'message' && /no matches/.test(e.data.delta)));
  check('post-tool retry still emits one done', emptyReplyEvents.filter((e) => e.name === 'done').length === 1);

  // ---- Part 4: MiniMax text-serialized tool calls via OpenRouter -----
  let minimaxRequests = 0;
  let minimaxSawToolMessage = false;
  const serverMiniMax = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      minimaxRequests++;
      const parsed = JSON.parse(body);
      if (minimaxRequests === 1) {
        sse(res, [
          { choices: [{ delta: { content: 'Searching now.\n]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name="search_files">\n]<]minimax[>[<query>providersRef</query>\n]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>' } }] },
          { choices: [{ finish_reason: 'stop' }] }
        ]);
      } else {
        minimaxSawToolMessage = parsed.messages.some((m) => m.role === 'tool' && m.name === 'search_files');
        sse(res, [
          { choices: [{ delta: { content: 'Search completed.' } }] },
          { choices: [{ finish_reason: 'stop' }] }
        ]);
      }
    });
  });
  await new Promise((resolve) => serverMiniMax.listen(0, '127.0.0.1', resolve));
  const minimaxEvents = [];
  const minimaxResult = await ai.streamChat({
    model: Object.assign({}, model, { provider: 'openrouter', baseUrl: 'http://127.0.0.1:' + serverMiniMax.address().port }),
    messages: [{ role: 'user', content: 'find providersRef' }],
    projectDir,
    chatId,
    onEvent: (name, data) => minimaxEvents.push({ name, data })
  });
  serverMiniMax.close();
  check('MiniMax text tool call continues the loop', minimaxResult.ok && minimaxRequests === 2, JSON.stringify(minimaxResult));
  check('MiniMax text tool call is dispatched', minimaxEvents.some((e) => e.name === 'tool_call' && e.data.name === 'search_files'));
  check('MiniMax XML argument is decoded', minimaxEvents.some((e) => e.name === 'tool_call' && e.data.args.query === 'providersRef'));
  check('MiniMax tool result is fed upstream', minimaxSawToolMessage === true);
  check('MiniMax private markers are hidden', !minimaxEvents.some((e) => e.name === 'message' && /minimax|tool_call|invoke/.test(e.data.delta)));
  check('MiniMax final answer is emitted', minimaxEvents.some((e) => e.name === 'message' && e.data.delta === 'Search completed.'));

  // ---- Part 5: specs stay advertised; authorization gates execution ----
  let advertisedWhenDisabled = null;
  const server2 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      advertisedWhenDisabled = Array.isArray(parsed.tools) && parsed.tools.some(t => t.function && t.function.name === 'shell');
      sse(res, [
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 1, completion_tokens: 1 } }
      ]);
    });
  });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const port2 = server2.address().port;
  await ai.streamChat({
    model: Object.assign({}, model, { baseUrl: 'http://127.0.0.1:' + port2 }),
    messages: [{ role: 'user', content: 'hi' }],
    projectDir: process.cwd(),
    shellEnabled: false,
    onEvent: () => {}
  });
  server2.close();
  check('shell remains advertised for authorization gating', advertisedWhenDisabled === true, String(advertisedWhenDisabled));

  // Non-OpenAI providers use different tool declaration schemas. Until
  // their native loops are implemented, they must not receive the OpenAI
  // `type:function` specs collected above or strict APIs return HTTP 400.
  let anthropicBody = null;
  const serverAnthropic = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      anthropicBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: content_block_delta\n');
      res.write('data: {"delta":{"type":"text_delta","text":"ok"}}\n\n');
      res.write('event: message_stop\n');
      res.write('data: {}\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => serverAnthropic.listen(0, '127.0.0.1', resolve));
  const anthropicResult = await ai.streamChat({
    model: {
      id: 'mock-claude', provider: 'anthropic', auth: 'apikey', apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:' + serverAnthropic.address().port
    },
    messages: [{ role: 'user', content: 'hi' }],
    projectDir,
    chatId,
    onEvent: () => {}
  });
  serverAnthropic.close();
  check('Anthropic request succeeds without OpenAI tool specs', anthropicResult.ok === true, JSON.stringify(anthropicResult));
  check('Anthropic request omits OpenAI tool specs', anthropicBody && !Object.hasOwn(anthropicBody, 'tools'), JSON.stringify(anthropicBody && anthropicBody.tools));

  fs.rmSync(projectDir, { recursive: true, force: true });
  settings.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
