'use strict';

// Regression test: a nested subagent's `report_progress` must surface as a
// `progress_update` event on the PARENT chat stream (so the chat's push layer
// and transcript progress card both fire) — not be swallowed by the subagent's
// internal event wrapper.
//
// History: the nested streamChat's onEvent pushed every event into a local
// `nestedEvents` array for transcript reconstruction, but only forwarded
// `tool_call` / `tool_result` / `message` / `authorization_required` /
// `ask_user_required` to the parent's onEvent. `progress_update` was dropped,
// so `report_progress` / `task` progress from inside a subagent never sent a
// push nor rendered a progress card on the parent chat.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-subprogress-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const ai = require('../src/ai.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
// subagent is allow so the nested run does not block on an authorization
// prompt; report_progress bypasses the prompt regardless of mode.
settings.setProject(projectDir, {
  tools: { shell: { enabled: true, mode: 'allow' }, subagent: { enabled: true, mode: 'allow' } }
});

function serve(perRequest) {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const script = perRequest[Math.min(count, perRequest.length - 1)];
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
const toolStop = () => ({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] });
const toolCall = (id, name, argsObj) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }] }, index: 0 }]
});

async function main() {
  // Parent turn 1 -> subagent tool call.
  //   The parent runs the nested subagent (dispatchTool 'subagent'):
  // Nested turn A -> report_progress tool call (the subagent reports progress).
  //   The nested loop runs report_progress, which must forward a
  //   progress_update to the parent onEvent.
  // Nested turn B -> stop (subagent's final answer).
  // Parent turn 2 -> stop (parent's final answer).
  const events = [];
  const { server, port, requests } = await serve([
    // parent turn 1
    [delta('Delegating.'), toolCall('call_parent', 'subagent', { task: 'report progress twice', context: 'use report_progress' }), toolStop()],
    // nested turn A
    [toolCall('call_nested', 'report_progress', { title: 'Building', current: 3, total: 10, status: 'running', message: 'compiling' }), toolStop()],
    // nested turn B (final answer after the progress tool resolved)
    [delta('Nested done.'), stop()],
    // parent turn 2 (final answer)
    [delta('Parent done.'), stop()]
  ]);

  const model = { id: 'mock', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', auth: 'apikey' };
  const result = await ai.streamChat({
    model,
    messages: [{ role: 'user', content: 'please subagent' }],
    projectDir,
    chatId: 'subprog1',
    onEvent: (name, data) => events.push({ name, data })
  });
  server.close();

  check('stream ok', result.ok === true, JSON.stringify(result.error || {}));
  check('four upstream requests (parent, nested x2, parent final)', requests() === 4, 'got ' + requests());

  const progress = events.filter((e) => e.name === 'progress_update');
  check('a progress_update reached the parent onEvent', progress.length === 1, 'got ' + progress.length);
  check('progress_update carries the nested report_progress payload',
    progress[0] && progress[0].data.title === 'Building' && progress[0].data.current === 3 && progress[0].data.total === 10,
    JSON.stringify(progress[0] && progress[0].data));
  check('no tool_call/tool_result for report_progress leaked to the parent transcript',
    events.filter((e) => e.name === 'tool_call' && e.data && e.data.name === 'report_progress').length === 0
      && events.filter((e) => e.name === 'tool_result' && e.data && e.data.name === 'report_progress').length === 0,
    'internal subagent tool frames must not corrupt the parent transcript');

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });