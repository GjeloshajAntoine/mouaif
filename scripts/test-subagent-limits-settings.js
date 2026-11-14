'use strict';
// subagentLimits as a stored setting:
//   - an invalid stored limit never fails a turn: that field runs on its
//     default and one warning is logged
//   - the subagent tool description states the turn's depth budget, and with
//     maxDepth 1 does not say that subagents can delegate
//   - PUT /api/settings/app|project and update_settings refuse a bad limit
// Upstream is a stubbed fetch; all configuration is temporary.
//
// Run: node scripts/test-subagent-limits-settings.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-subagent-limits-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const settings = require('../src/settings.js');
const { streamChat } = require('../src/ai-stream.js');
const { resolveLimits, DEFAULT_LIMITS } = require('../src/tools/subagent-orchestration.js');
const subagentTool = require('../src/tools/subagent.js');

const model = { id: 'parent', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' };
const realFetch = global.fetch;
const realWarn = console.warn;
const requests = [];
const warnings = [];
// script(request) -> delta for the next upstream reply.
let script = () => ({ content: 'Done' });
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const users = body.messages.filter((m) => m.role === 'user');
  const lastUser = users.length ? users.at(-1).content : '';
  const request = {
    url, body, task: typeof lastUser === 'string' ? lastUser : '',
    system: (body.messages.find((m) => m.role === 'system') || {}).content,
    toolResults: body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
  };
  requests.push(request);
  const delta = script(request);
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })
    + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
const launch = (id, args) => ({ tool_calls: [{ index: 0, id, function: { name: 'subagent', arguments: JSON.stringify(args) } }] });
const describedTool = (request) => (request.body.tools || []).find((t) => t.function.name === 'subagent');
const turn = () => streamChat({ projectDir, chatId: 'limits', model, messages: [{ role: 'user', content: 'root task' }], enabledTools: ['subagent'], onEvent() {} });
const writeProject = (doc) => fs.writeFileSync(path.join(projectDir, '.mouaif.json'), JSON.stringify(doc));

async function main() {
  // ---- resolveLimits: the read boundary --------------------------------
  assert.deepEqual(resolveLimits(undefined), { limits: { ...DEFAULT_LIMITS }, invalid: [] });
  assert.deepEqual(resolveLimits({ maxDepth: 20, maxRuns: 5000 }).limits, { maxDepth: 20, maxRuns: 5000 });
  for (const bad of ['3', 0, 2.5, -1, Infinity, NaN, true, [], {}]) {
    const r = resolveLimits({ maxDepth: bad, maxRuns: 7 });
    assert.deepEqual(r.limits, { maxDepth: 3, maxRuns: 7 }, 'maxDepth ' + String(bad));
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0].name, 'maxDepth');
    assert.equal(r.invalid[0].fallback, 3);
  }
  assert.deepEqual(resolveLimits({ maxDepth: 0, maxRuns: 0 }).invalid.map((i) => i.name), ['maxDepth', 'maxRuns']);
  for (const whole of ['3', 3, []]) {
    const r = resolveLimits(whole);
    assert.deepEqual(r.limits, { ...DEFAULT_LIMITS });
    assert.deepEqual(r.invalid.map((i) => i.name), ['subagentLimits']);
  }

  // ---- The description states the depth budget --------------------------
  assert.match(subagentTool.describe(3), /Subagents may delegate further, up to 3 levels deep in total/);
  assert.match(subagentTool.describe(8), /up to 8 levels deep in total/);
  assert.doesNotMatch(subagentTool.describe(1), /may delegate further|levels deep/);
  assert.match(subagentTool.describe(1), /Subagents cannot delegate further/);
  assert.equal(subagentTool.describe('x'), subagentTool.describe(3), 'an unusable depth reads as the default');
  assert.equal(subagentTool.buildSpec([]), subagentTool.SPEC, 'default depth, no agents: the shared spec');
  const shallow = subagentTool.buildSpec(['Reviewer'], { maxDepth: 1 });
  assert.equal(shallow.function.description, subagentTool.describe(1));
  assert.match(shallow.function.parameters.properties.agent.description, /Available agents: Reviewer\./);
  assert.match(subagentTool.SPEC.function.description, /up to 3 levels deep in total/, 'SPEC is never mutated');

  settings.setApp({ providers: [
    { id: 'openai-compatible', baseUrl: 'http://fixture/v1', apiKey: 'fixture-secret' }
  ] });

  // ---- Invalid stored limits: the turn runs, one warning ----------------
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  writeProject({ subagentLimits: { maxDepth: '3', maxRuns: 2.5 }, tools: { subagent: { mode: 'allow' } } });
  for (let i = 0; i < 2; i++) {
    const out = await turn();
    assert.equal(out.ok, true, JSON.stringify(out));
  }
  // A caller that never delegates (the shell reviewer, title generation).
  const plain = await streamChat({ projectDir, chatId: 'limits', model, messages: [{ role: 'user', content: 'title' }], noTools: true, onEvent() {} });
  assert.equal(plain.ok, true);
  const limitWarnings = warnings.filter((w) => w.includes('subagentLimits'));
  assert.equal(limitWarnings.length, 1, 'one warning for the same bad value, not one per turn: ' + JSON.stringify(warnings));
  assert.match(limitWarnings[0], /maxDepth = "3" \(using 3\)/);
  assert.match(limitWarnings[0], /maxRuns = 2\.5 \(using 32\)/);
  assert.ok(limitWarnings[0].includes(projectDir), 'the warning names the project');
  assert.match(describedTool(requests[0]).function.description, /up to 3 levels deep in total/, 'the invalid depth fell back to 3');
  writeProject({ subagentLimits: 'lots', tools: { subagent: { mode: 'allow' } } });
  assert.equal((await turn()).ok, true, 'a non-object value is ignored too');
  assert.equal(warnings.filter((w) => w.includes('subagentLimits')).length, 2);

  // ---- Configured depth reaches the description -------------------------
  requests.length = 0;
  writeProject({ subagentLimits: { maxDepth: 5 }, tools: { subagent: { mode: 'allow' } } });
  await turn();
  assert.match(describedTool(requests[0]).function.description, /up to 5 levels deep in total/);
  requests.length = 0;
  writeProject({ subagentLimits: { maxDepth: 1 }, tools: { subagent: { mode: 'allow' } } });
  script = (r) => (r.task === 'root task' && !r.toolResults.length ? launch('child', { task: 'child task' }) : { content: 'Done' });
  assert.equal((await turn()).ok, true);
  const rootDescription = describedTool(requests[0]).function.description;
  assert.doesNotMatch(rootDescription, /may delegate further|levels deep/);
  assert.match(rootDescription, /Subagents cannot delegate further/);
  const childRequest = requests.find((r) => r.task === 'child task');
  assert.ok(childRequest, 'the child ran');
  assert.equal(describedTool(childRequest), undefined, 'at depth 1 of 1 the child is not offered the subagent tool');
  assert.equal(warnings.filter((w) => w.includes('subagentLimits')).length, 2, 'valid limits do not warn');
  console.warn = realWarn;

  // ---- Writes: the settings routes and update_settings validate ---------
  // Real handlers in-process; no server is started.
  writeProject({ tools: { subagent: { mode: 'allow' } } });
  const { Readable } = require('node:stream');
  const { handleSettings } = require('../src/server-handlers-settings.js');
  async function put(pathname, body) {
    const req = Readable.from([JSON.stringify(body)]);
    req.method = 'PUT';
    req.headers = {};
    const res = { statusCode: 0, body: '', setHeader() {}, writeHead(code) { this.statusCode = code; }, end(value) { this.body += value || ''; } };
    await handleSettings(req, res, { pathname, query: {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  const appWrite = await put('/api/settings/app', { subagentLimits: { maxDepth: 2, maxRuns: 64 } });
  assert.equal(appWrite.status, 200, JSON.stringify(appWrite.body));
  assert.deepEqual(appWrite.body.app.subagentLimits, { maxDepth: 2, maxRuns: 64 }, 'an app-scope write is accepted and returned to the client');
  assert.deepEqual(settings.getResolved(projectDir).subagentLimits, { maxDepth: 2, maxRuns: 64 });
  for (const [pathname, extra] of [['/api/settings/app', {}], ['/api/settings/project', { projectDir }]]) {
    for (const value of [{ maxDepth: '3' }, { maxDepth: 0 }, { maxDepth: 2.5 }, { maxRuns: 0 }]) {
      const refused = await put(pathname, { ...extra, subagentLimits: value });
      assert.equal(refused.status, 400, pathname + ' ' + JSON.stringify(value));
      assert.match(refused.body.error, /^subagentLimits\.max(Depth|Concurrent|Runs) must be a whole number of at least 1$/);
    }
  }
  const projectWrite = await put('/api/settings/project', { projectDir, subagentLimits: { maxDepth: 1 } });
  assert.equal(projectWrite.status, 200, JSON.stringify(projectWrite.body));
  assert.deepEqual(settings.getResolved(projectDir).subagentLimits, { maxDepth: 1, maxRuns: 64 }, 'project overrides app field by field');
  const tools = require('../src/tools/mouaif.js');
  const toolBad = await tools.runAppTool('update_settings', { scope: 'project', patch: { subagentLimits: { maxDepth: 0 } } }, { projectDir });
  assert.equal(toolBad.ok, false, JSON.stringify(toolBad));
  assert.match(JSON.stringify(toolBad), /subagentLimits\.maxDepth must be a whole number of at least 1/);
  const toolGood = await tools.runAppTool('update_settings', { scope: 'app', patch: { subagentLimits: { maxDepth: 4 } } }, { projectDir });
  assert.equal(toolGood.ok, true, JSON.stringify(toolGood));
  assert.deepEqual(settings.getApp().subagentLimits, { maxDepth: 4 });
  assert.equal(settings.getProject(projectDir).subagentLimits.maxDepth, 1, 'refused writes left the project value alone');

  console.log('subagent limits settings: validated writes at both scopes, tolerant read with one warning and depth-aware description passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  console.warn = realWarn;
  global.fetch = realFetch;
  try { settings.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});
