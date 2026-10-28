'use strict';
require('./lib/test-home.js').isolate('mouaif-shell-async-');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runShell, SPEC } = require('../src/tools/shell.js');
const jobs = require('../src/tools/backgroundJobs.js');
const { cancelBackgroundJob } = require('../src/tools/groupCli.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-async-'"));
  const scope = { projectDir: root, chatId: 'shell-async-test' };
  let out;
  try {
    assert.equal(SPEC.function.parameters.properties.async.type, 'boolean');
    out = await runShell({ ...scope, async: true, cmd: 'echo ready; sleep 30' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.async, true);
    assert.ok(Number.isInteger(out.pid));
    assert.ok(out.logPath.startsWith('.mouaif/logs/'));
    assert.equal(out.absoluteLogPath, path.resolve(root, out.logPath));
    const internal = jobs.list(scope).find((job) => job.pid === out.pid);
    assert.ok(internal);
    assert.equal(out.jobId, undefined);
    out.internalJobId = internal.jobId;
    assert.throws(() => jobs.get({ ...scope, chatId: 'foreign' }, out.internalJobId), /Unknown/);
    if (process.platform !== 'win32') {
      let log = '';
      for (let i = 0; i < 100 && !log.includes('ready'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      log = execFileSync('/bin/sh', ['-c', out.commands.inspect], { encoding: 'utf8' });
      }
      assert.match(log, /ready/);
      assert.match(out.commands.wait, /setInterval/);
      assert.match(out.commands.stop, /SIGTERM/);
      execFileSync('/bin/sh', ['-c', out.commands.stop]);
      execFileSync('/bin/sh', ['-c', out.commands.wait], { timeout: 5000 });
      execFileSync('/bin/sh', ['-c', out.commands.stop]);
    }
    // Exercise the actual model dispatcher, not only the low-level runner.
    const settings = require('../src/settings.js');
    settings.setProject(root, { tools: { shell: { mode: 'allow' } } });
    const originalFetch = global.fetch;
    let round = 0;
    const events = [];
    try {
      global.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: round++ === 0
        ? { tool_calls: [{ index: 0, id: 'bg', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ cmd: 'echo dispatched', async: true }) } }] }
        : { content: 'Started.' } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      await require('../src/ai-stream.js').streamChat({ projectDir: root, chatId: scope.chatId,
        model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
        messages: [{ role: 'user', content: 'start it' }], onEvent: (type, payload) => events.push({ type, payload }) });
      const result = events.find((event) => event.type === 'tool_result').payload.result;
      assert.equal(result.async, true, JSON.stringify(result));
      assert.ok(result.commands.inspect);
      assert.equal(result.jobId, undefined);
      for (let i = 0; i < 100 && jobs.list(scope).some((job) => job.state === 'running'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally { global.fetch = originalFetch; }
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await runShell({ ...scope, async: true, cmd: 'sleep 30', signal: aborted.signal })).code, 'EABORTED');
    assert.equal((await runShell({ ...scope, async: true, cmd: '' })).code, 'EBADINPUT');
  } finally {
    if (out && out.internalJobId) {
      cancelBackgroundJob(scope, out.internalJobId);
      for (let i = 0; i < 100 && jobs.get(scope, out.internalJobId).state === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.notEqual(jobs.get(scope, out.internalJobId).state, 'running');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('shell async: background lifecycle, scope, paths, quoting and validation passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
