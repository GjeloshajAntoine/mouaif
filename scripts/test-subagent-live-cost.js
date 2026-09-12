'use strict';

// Regression test: a delegated subagent's cost must reach the parent chat's
// live "Total" while the subagent is still working — per nested round — and
// not only once the whole delegated run returns.
//
// History: ai-stream reported the nested run to the parent exactly once, from
// the single-tool-call runner that ran *after* the nested loop finished. A
// subagent that used tools (the interesting case: several billed upstream
// rounds) left the header Total frozen for the whole run and then jumped.
// Billing now happens per nested round through streamChat's onRoundCommit,
// with the completion report adding only what the round reports did not
// already cover — so the deltas still sum to the same total as before and no
// round is ever counted twice.
//
// Two scenarios: provider-reported cost (OpenRouter-shaped `usage.cost`) and
// estimate-only pricing (app pricing table), because the incremental value is
// resolved differently in each.
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-subagent-live-cost-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const { handleChatStream } = require('../src/server-handlers-chats.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Upstream rounds, in request order:
//   1. parent  — asks for the `subagent` tool
//   2. nested  — subagent asks for `report_progress`, so the delegated run
//                has more than one billed round (the case that used to leave
//                the Total frozen until the run returned)
//   3. nested  — subagent answers
//   4. parent  — parent answers with the summarized result
//
// `costed` controls whether each round reports a provider cost. Without it the
// cost has to be estimated from the app pricing table.
function serve(seen, costed) {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const n = count++;
      seen.requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const usage = (prompt, completion, cost) => {
        const u = { prompt_tokens: prompt, completion_tokens: completion };
        if (costed) u.cost = cost;
        return { usage: u };
      };
      if (n === 0) {
        write({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sub', function: { name: 'subagent', arguments: '{"task":"research"}' } }] }, index: 0 }] });
        write({ choices: [{ finish_reason: 'tool_calls', index: 0 }] });
        write(usage(100, 10, 0.001));
      } else if (n === 1) {
        write({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_prog', function: { name: 'report_progress', arguments: '{"title":"Work","current":1,"total":3}' } }] }, index: 0 }] });
        write({ choices: [{ finish_reason: 'tool_calls', index: 0 }] });
        write(usage(300, 20, 0.002));
      } else if (n === 2) {
        // The subagent's second (and final) round. Round 1 has already been
        // billed, so the parent stream must carry exactly one subagent
        // usage_update right now — while the delegated run is still going.
        seen.bodyAtSecondNestedRound = seen.body();
        write({ choices: [{ delta: { content: 'Nested answer' }, index: 0 }] });
        write({ choices: [{ finish_reason: 'stop', index: 0 }] });
        write(usage(400, 5, 0.003));
      } else {
        write({ choices: [{ delta: { content: 'Parent answer' }, index: 0 }] });
        write({ choices: [{ finish_reason: 'stop', index: 0 }] });
        write(usage(200, 10, 0.0005));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

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

// parseEvents(sse) -> [{ name, data }] in arrival order.
function parseEvents(sse) {
  const out = [];
  for (const frame of String(sse).split('\n\n')) {
    const name = /^event: (.*)$/m.exec(frame);
    const data = /^data: (.*)$/m.exec(frame);
    if (!name || !data) continue;
    let parsed = null;
    try { parsed = JSON.parse(data[1]); } catch { parsed = null; }
    out.push({ name: name[1], data: parsed });
  }
  return out;
}

// runScenario(name, { costed, pricing, label, roundCosts, delegatedCost, persistedTotal, midRunCost })
async function runScenario(opts) {
  const projectDir = path.join(tmp, 'project-' + opts.label);
  fs.mkdirSync(projectDir, { recursive: true });
  const res = mockRes();
  const seen = { requests: 0, body: () => res.body, bodyAtSecondNestedRound: '' };
  const { server, port } = await serve(seen, opts.costed);
  settings.setProject(projectDir, {
    models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
    tools: { subagent: { enabled: true, mode: 'allow' } }
  });
  const app = {
    providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
  };
  if (opts.pricing) app.modelPricing = { mock: opts.pricing };
  settings.setApp(app);
  const chat = chats.createChat(projectDir, { title: 'subagent live cost test' });
  await handleChatStream(
    mockReq({ projectDir, modelId: 'mock', content: 'delegate this' }),
    res,
    chat.id,
    null
  );
  server.close();

  const events = parseEvents(res.body);
  const updates = events.filter((e) => e.name === 'usage_update' && e.data && e.data.source === 'subagent');
  const doneIndex = events.findIndex((e) => e.name === 'done');
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

  check(opts.label + ': four upstream rounds ran', seen.requests === 4, 'got ' + seen.requests);
  check(opts.label + ': stream completed', res.statusCode === 200, 'status=' + res.statusCode);
  check(opts.label + ': one usage_update per nested round', updates.length === 2, 'got ' + updates.length);
  const totals = updates.map((e) => e.data && e.data.cost && e.data.cost.total);
  check(opts.label + ': usage_update carries per-round deltas', near(totals[0], opts.roundCosts[0]) && near(totals[1], opts.roundCosts[1]), JSON.stringify(totals));
  check(opts.label + ': deltas sum to the delegated cost', near(totals.reduce((a, b) => a + b, 0), opts.delegatedCost), JSON.stringify(totals));
  check(opts.label + ': every usage_update precedes the final done', doneIndex > 0 && updates.every((u) => events.indexOf(u) < doneIndex));

  const midRun = parseEvents(seen.bodyAtSecondNestedRound).filter((e) => e.name === 'usage_update' && e.data && e.data.source === 'subagent');
  check(opts.label + ': round 1 is billed while the subagent is still running', midRun.length === 1, midRun.length + ' updates by the start of nested round 2');
  check(opts.label + ': the mid-run update carries round 1\'s cost', !!midRun[0] && near(midRun[0].data.cost.total, opts.midRunCost), midRun[0] && JSON.stringify(midRun[0].data.cost));

  const assistant = messages.listMessages(projectDir, chat.id).filter((m) => m && m.role === 'assistant');
  check(opts.label + ': one final parent message persisted', assistant.length === 1, 'got ' + assistant.length);
  const total = assistant[0] && assistant[0].cost && assistant[0].cost.total;
  check(opts.label + ': persisted total is parent rounds + delegated', near(total, opts.persistedTotal), 'got ' + total);
  const chatTotal = chats.chatTotalCost(projectDir, chat.id);
  check(opts.label + ': chat aggregate includes the live-billed subagent cost', chatTotal.known && near(chatTotal.total, opts.persistedTotal), JSON.stringify(chatTotal));

  const doneEvent = events.find((e) => e.name === 'done');
  const doneUsage = doneEvent && doneEvent.data && doneEvent.data.usage;
  check(opts.label + ': done usage keeps the last-round-wins prompt rule (parent 200 + nested 400)', doneUsage && doneUsage.promptTokens === 600, doneUsage && JSON.stringify(doneUsage));
  check(opts.label + ': done usage sums nested completion tokens (10 + 20 + 5 + 10 = 45)', doneUsage && doneUsage.completionTokens === 45, doneUsage && JSON.stringify(doneUsage));
  check(opts.label + ': done carries the delegated cost exactly once', doneEvent && near(doneEvent.data.delegatedCost, opts.delegatedCost), doneEvent && String(doneEvent.data.delegatedCost));
}

(async function main() {
  // Provider-reported cost (OpenRouter-shaped `usage.cost`): every round bills
  // its own reported amount, so the deltas are the rounds' costs.
  await runScenario({
    label: 'provider cost',
    costed: true,
    midRunCost: 0.002,
    roundCosts: [0.002, 0.003],
    delegatedCost: 0.005,
    persistedTotal: 0.0065 // parent 0.001 + 0.0005, delegated 0.005
  });

  // Estimate-only: the app pricing table drives both the live and the final
  // number, so the incremental estimate must converge on the run's own
  // aggregate estimate (prompt tokens are last-round-wins, completion sums).
  // mock pricing: $3 / 1K input, $6 / 1K output.
  //   nested round 1: 300 in / 20 out = 0.9 + 0.12 = 1.02
  //   nested run    : 400 in / 25 out = 1.2 + 0.15 = 1.35  (delta 0.33)
  //   parent rounds : 0.36 + 0.66 = 1.02
  await runScenario({
    label: 'estimated cost',
    costed: false,
    pricing: { inputPer1K: 3, outputPer1K: 6 },
    midRunCost: 1.02,
    roundCosts: [1.02, 0.33],
    delegatedCost: 1.35,
    persistedTotal: 2.37
  });

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
