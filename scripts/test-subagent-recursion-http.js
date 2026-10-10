'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recursive-http-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const { streamChat } = require('../src/ai-stream.js');
const counts = { root: 0, child: 0, grandchild: 0 };
let concurrent = 0, peak = 0, useGroup = false;
const server = http.createServer((req, res) => {
  concurrent++; peak = Math.max(peak, concurrent);
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const role = body.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('grandchild task')) ? 'grandchild' : body.messages.some((m) => m.role === 'user' && m.content === 'child task') ? 'child' : 'root';
    const n = ++counts[role];
    assert.ok(!body.tools.some((t) => t.function.name === 'shell'));
    let delta;
    if (role === 'root' && n === 1) delta = { tool_calls: [{ index: 0, id: 'child', function: { name: 'subagent', arguments: JSON.stringify({ task: 'child task' }) } }] };
    else if (role === 'child' && n === 1) {
      assert.ok(body.tools.some((t) => t.function.name === 'subagent'));
      if (!useGroup) delta = { tool_calls: [{ index: 0, id: 'grandchild', function: { name: 'subagent', arguments: JSON.stringify({ task: 'grandchild task' }) } }] };
      else delta = { tool_calls: [{ index: 0, id: 'group', function: { name: 'subagent_group_create', arguments: JSON.stringify({ name: 'nested', objective: 'recursive goal', members: [{ memberId: 'worker', role: 'review', workspace: tmp }] }) } }] };
    } else if (role === 'child' && n === 2 && useGroup) {
      const groupId = JSON.parse(body.messages.filter((m) => m.role === 'tool').at(-1).content).groupId;
      assert.ok(groupId);
      delta = { tool_calls: [{ index: 0, id: 'grandchild', function: { name: 'subagent', arguments: JSON.stringify({ task: 'grandchild task', groupId, memberId: 'worker', background: true }) } }] };
    } else if (role === 'child' && n === 3 && useGroup) {
      // Delay only the fixture provider, never production status, until the background member settles.
      const respond = () => {
      if (counts.grandchild < 2) return setTimeout(respond, 5);
      concurrent--; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'child final' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
      };
      return respond();
    } else if (role === 'grandchild' && n === 1) {
      // Forged call outside inherited surface must fail without shell execution.
      delta = { tool_calls: [{ index: 0, id: 'forged', function: { name: 'shell', arguments: JSON.stringify({ cmd: 'echo forbidden' }) } }] };
    } else {
      if (role === 'grandchild') assert.equal(JSON.parse(body.messages.filter((m) => m.role === 'tool').at(-1).content).error.code, 'ETOOL_DISABLED');
      delta = { content: role + ' final' };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    concurrent--;
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, cost: 0.01 }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    settings.setProject(tmp, { subagentLimits: { maxDepth: 3, maxConcurrent: 1, maxRuns: 8 }, tools: { subagent: { mode: 'allow' }, shell: { mode: 'allow' } } });
    for (useGroup of [false, true]) {
    counts.root = counts.child = counts.grandchild = 0; peak = 0;
    settings.setProject(tmp, { subagentLimits: { maxDepth: 3, maxConcurrent: useGroup ? 2 : 1, maxRuns: 8 }, tools: { subagent: { mode: 'allow' }, shell: { mode: 'allow' } } });
    const events = [];
    const out = await streamChat({ projectDir: tmp, chatId: 'recursive', model: { id: 'mock', pricing: { inputPer1K: 2, outputPer1K: 4 }, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }, messages: [{ role: 'user', content: 'root task' }], enabledTools: ['subagent', 'subagent_group_create'], onEvent: (name, data) => events.push({ name, data }) });
    assert.equal(out.ok, true);
    assert.deepEqual(counts, { root: 2, child: useGroup ? 3 : 2, grandchild: 2 });
    assert.equal(peak, useGroup ? 2 : 1, 'single-slot synchronous recursion cannot deadlock');
    assert.ok(Math.abs(out.totalCost - (useGroup ? 0.2 : 0.18)) < 1e-9, JSON.stringify(out));
    assert.equal(out.usage.completionTokens, useGroup ? 35 : 30);
    assert.equal(out.usage.promptTokens, 30);
    const child = events.find((e) => e.name === 'tool_result' && e.data.name === 'subagent').data.result;
    assert.equal(child.depth, 1);
    assert.ok(Math.abs(child.totalCost - (useGroup ? 0.14 : 0.12)) < 1e-9);
    const grandchild = child.toolEvents.find((e) => e.name === 'tool_result' && e.data.name === 'subagent').data.result;
    assert.equal(grandchild.depth, 2); assert.equal(grandchild.parentCallId, child.callId); assert.equal(grandchild.rootId, child.rootId);
    const deltas = events.filter((e) => e.name === 'usage_update').reduce((n, e) => n + e.data.cost.total, 0);
    assert.ok(Math.abs(deltas - (useGroup ? 0.14 : 0.12)) < 1e-9, 'descendant live billing exactly once');
    }
    console.log('recursive HTTP: synchronous nested delegation, inherited surface/forged-call rejection, rooted results and descendant live/final billing exactly once passed');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); settings.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
