'use strict';

// MCP call cancellation and timeouts:
//   - aborting the chat's AbortSignal (Stop) rejects an in-flight
//     tools/call at once with EABORTED and the server receives
//     notifications/cancelled for that request;
//   - an already-aborted signal never reaches the server;
//   - the MCP authorization block's defaultTimeoutMs bounds a call and
//     expiry surfaces as the typed EMCP_TIMEOUT, not a generic EMCP_RPC;
//   - maxTimeoutMs caps the 60 s default;
//   - end to end, ai.streamChat forwards the chat's signal to the call.

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-cancel-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-cancel-proj-'));

const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function attempt(fn) {
  const started = Date.now();
  try { await fn(); return { error: null, ms: Date.now() - started }; }
  catch (e) { return { error: e, ms: Date.now() - started }; }
}

function writeMcpAuthorization(auth) {
  const file = mcp.getMcpPath(projectDir);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.authorization = auth;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

async function main() {
  const server = mcp.addServer(projectDir, {
    name: 'Cancel',
    command: process.execPath,
    args: [path.join(__dirname, 'test-mcp-cancel-server.js')]
  });
  await mcp.startServer(projectDir, server.id);

  // 1) Stop mid-call.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new Error('user stopped')), 150);
  const stopped = await attempt(() => mcp.callTool(projectDir, 'cancel', 'hang', {}, { signal: ctl.signal }));
  check('abort rejects the in-flight call', !!stopped.error);
  check('abort is typed EABORTED', stopped.error && stopped.error.code === 'EABORTED', stopped.error && stopped.error.code);
  check('abort returns promptly (< 2 s)', stopped.ms < 2000, stopped.ms + ' ms');

  // The cancellation notification is fire-and-forget; give it a tick.
  await new Promise(r => setTimeout(r, 100));
  const seen = await mcp.callTool(projectDir, 'cancel', 'cancelled', {});
  const ids = JSON.parse(seen.content[0].text);
  check('server received notifications/cancelled', Array.isArray(ids) && ids.length === 1, seen.content[0].text);
  check('session stays ready after a cancel', mcp.getServer(projectDir, server.id).status === 'ready');

  // 2) Already-aborted signal: rejected before anything is sent.
  const pre = new AbortController();
  pre.abort();
  const early = await attempt(() => mcp.callTool(projectDir, 'cancel', 'hang', {}, { signal: pre.signal }));
  check('pre-aborted signal rejects with EABORTED', early.error && early.error.code === 'EABORTED');
  const after = JSON.parse((await mcp.callTool(projectDir, 'cancel', 'cancelled', {})).content[0].text);
  check('pre-aborted call never reached the server', after.length === 1, JSON.stringify(after));

  // 3) defaultTimeoutMs from the MCP authorization block bounds the call.
  writeMcpAuthorization({ mode: 'allow', servers: { cancel: { mode: 'allow', defaultTimeoutMs: 300 } } });
  const timed = await attempt(() => mcp.callTool(projectDir, 'cancel', 'hang', {}));
  check('server defaultTimeoutMs applies', timed.ms >= 250 && timed.ms < 2000, timed.ms + ' ms');
  check('timeout is typed EMCP_TIMEOUT', timed.error && timed.error.code === 'EMCP_TIMEOUT',
    timed.error && (timed.error.code + ' ' + timed.error.message));

  // 4) maxTimeoutMs caps the 60 s default.
  writeMcpAuthorization({ mode: 'allow', maxTimeoutMs: 300 });
  const capped = await attempt(() => mcp.callTool(projectDir, 'cancel', 'hang', {}, undefined));
  check('maxTimeoutMs caps the 60 s default', capped.ms < 2000 && capped.error && capped.error.code === 'EMCP_TIMEOUT',
    capped.ms + ' ms ' + (capped.error && capped.error.code));

  // 5) No configuration: the 60 s default stands (checked by resolution,
  //    not by waiting a minute).
  writeMcpAuthorization({ mode: 'allow' });
  const quick = await attempt(() => mcp.callTool(projectDir, 'cancel', 'cancelled', {}));
  check('unconfigured call still succeeds', !quick.error, quick.error && quick.error.message);

  // 6) End to end through ai.streamChat: the chat's AbortSignal reaches
  //    the MCP call. A mock OpenAI-compatible upstream asks for the
  //    hanging tool; Stop is pressed 200 ms into the call.
  writeMcpAuthorization({ mode: 'allow' });
  const ai = require('../src/ai.js');
  const http = require('node:http');
  const chatId = 'c0ffee01';
  settings.setProject(projectDir, { chats: [{ id: chatId, title: 'MCP cancel', trace: false }] });
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamRequests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const lines = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_hang', function: { name: 'mcp__cancel__hang', arguments: '{}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }] }
      ];
      for (const l of lines) res.write('data: ' + JSON.stringify(l) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const chatCtl = new AbortController();
  const events = [];
  const turnStarted = Date.now();
  const turn = ai.streamChat({
    model: { id: 'mock', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'k', auth: 'apikey' },
    messages: [{ role: 'user', content: 'hang please' }],
    projectDir,
    chatId,
    signal: chatCtl.signal,
    onEvent: (name, data) => {
      events.push({ name, data });
      if (name === 'tool_call') setTimeout(() => chatCtl.abort(new Error('user stopped')), 200);
    }
  });
  await Promise.race([turn, new Promise(r => setTimeout(r, 10000))]);
  const turnMs = Date.now() - turnStarted;
  upstream.close();
  const toolResult = events.find(e => e.name === 'tool_result');
  const resultText = JSON.stringify(toolResult && toolResult.data);
  check('streamChat: Stop ends the turn promptly (< 5 s)', turnMs < 5000, turnMs + ' ms');
  check('streamChat: MCP tool result is EABORTED', /EABORTED/.test(resultText || ''), resultText);
  check('streamChat: no further upstream round after Stop', upstreamRequests === 1, String(upstreamRequests));

  await mcp.stopAll();
  settings.close();
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
