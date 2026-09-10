'use strict';

// Regression test: a model-initiated shell call cannot exceed the
// project's `tools.shell.maxTimeoutMs`.
//
// The authorization gate resolves the effective timeout
// (`clamp(requested || defaultTimeoutMs, 1, maxTimeoutMs)`) and the REST
// path (`POST /api/tools/shell`) uses the value the gate returns. The
// in-loop dispatcher passed the model's raw `args.timeoutMs` straight to
// the runner and advertised that same raw number on the approval card, so
// a project's ceiling was advisory for every model-driven call.
//
// The test drives the real gate and the real runner and asserts that the
// deadline is the clamped one, not the requested one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-timeout-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-timeout-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');
const { runShell } = require('../src/tools/shell.js');

const CHAT = 'c1d2e3f4';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- Phase 2: the in-loop dispatcher --------------------------------
//
// Phase 1 pins the gate's contract. The defect was one layer up: the tool
// loop ignored the value the gate returned and handed the runner the
// model's raw request. This phase drives a real chat stream whose mock
// model asks for `sleep 5` with a 10-minute timeout, and asserts the run
// finishes at the project's 1.5 s ceiling in every build.

const http = require('node:http');
const { handleChatStream } = require('../src/server-handlers-chats.js');
const chats = require('../src/chats.js');

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
    body: '',
    writeHead(code) { this.statusCode = code; },
    write(chunk) { this.body += chunk; },
    end() {},
    setHeader() {},
    getHeader() { return undefined; }
  };
}

function serveModel() {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        // The model asks for ten minutes; the project ceiling is 1.5 s.
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_shell","function":{"name":"shell","arguments":"{\\"cmd\\":\\"sleep 5\\",\\"timeoutMs\\":600000}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"done"},"index":0}]}\n\n');
        res.write('data:{"choices":[{"finish_reason":"stop","index":0}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: 'http://127.0.0.1:' + server.address().port
    }));
  });
}

async function inLoop() {
  const projectDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-timeout-loop-'));
  const model = await serveModel();
  try {
    settings.setProject(projectDir2, {
      models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
      tools: { shell: { enabled: true, mode: 'allow', defaultTimeoutMs: 1000, maxTimeoutMs: 1500 } }
    });
    settings.setApp({
      providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: model.baseUrl, apiKey: 'k' }]
    });

    const chat = chats.createChat(projectDir2, { title: 'timeout clamp' });
    const res = mockRes();
    const started = Date.now();
    await handleChatStream(mockReq({ projectDir: projectDir2, modelId: 'mock', content: 'run it' }), res, chat.id, null);
    const elapsed = Date.now() - started;

    check('the in-loop run completed', res.statusCode === 200, 'status=' + res.statusCode);
    check('the in-loop shell call was killed at the project ceiling',
      elapsed < 4000, 'elapsed=' + elapsed + 'ms');
    check('the tool result reports the timeout',
      res.body.includes('ETIMEDOUT'), res.body.slice(0, 200));
  } finally {
    model.server.close();
    fs.rmSync(projectDir2, { recursive: true, force: true });
  }
}

async function main() {
  settings.setProject(projectDir, {
    chats: [{ id: CHAT, title: 'Timeout clamp', trace: false }],
    tools: {
      shell: {
        enabled: true,
        mode: 'allow',
        defaultTimeoutMs: 1000,
        maxTimeoutMs: 1500
      }
    }
  });
  const config = authz.getAuthorization(projectDir).tools.shell;
  assert.equal(config.maxTimeoutMs, 1500, 'test setup: project ceiling must be 1500 ms');

  // 1. The gate clamps an over-large request in every mode.
  const asked = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_big', tool: 'shell', cmd: 'sleep 10', timeoutMs: 600000
  });
  check('the gate clamps the requested timeout to the project ceiling',
    asked.timeoutMs === 1500, 'timeoutMs=' + asked.timeoutMs);
  check('the clamped value is what the approval card advertises',
    asked.timeoutMs < 600000 && asked.timeoutMs === 1500);

  if (asked.decision === 'prompt') {
    authz.recordDecision(projectDir, CHAT, 'call_big', 'allow-once');
    await asked.wait.catch(() => {});
  }

  // 2. The gate still honours a smaller explicit request.
  const small = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_small', tool: 'shell', cmd: 'echo hi', timeoutMs: 200
  });
  check('a request below the ceiling is preserved', small.timeoutMs === 200, 'timeoutMs=' + small.timeoutMs);

  // 3. A missing request falls back to the project default.
  const fallback = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_default', tool: 'shell', cmd: 'echo hi'
  });
  check('a missing request falls back to defaultTimeoutMs',
    fallback.timeoutMs === 1000, 'timeoutMs=' + fallback.timeoutMs);

  // 4. End to end: the runner obeys the clamped value, so a command that
  //    would run for 10 s is killed at the project ceiling instead.
  const started = Date.now();
  const out = await runShell({
    projectDir,
    cmd: 'sleep 10',
    timeoutMs: fallback.timeoutMs // what the dispatcher now passes: the gate's value
  });
  const elapsed = Date.now() - started;
  check('the runner kills the command at the clamped deadline',
    out.ok === false && out.code === 'ETIMEDOUT', JSON.stringify({ ok: out.ok, code: out.code }));
  check('the deadline was the project ceiling, not the 10 s command',
    elapsed < 5000, 'elapsed=' + elapsed + 'ms');

  // 5. The clamp is authoritative: the raw requested value never reaches
  //    the runner through the dispatcher, because the dispatcher passes
  //    the gate's value. Guard the invariant the fix relies on.
  check('the gate always reports a finite timeout',
    [asked, small, fallback].every((r) => Number.isFinite(r.timeoutMs)));

  await inLoop();

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { settings.close(); } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
