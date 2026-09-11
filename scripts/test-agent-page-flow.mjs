import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// Import browser ESM explicitly so this test also runs on Node 18 in a CJS package.
async function loadBrowserModule(name) {
  const source = fs.readFileSync(new URL('../frontend/src/components/settings/' + name + '.js', import.meta.url), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const { createAgentAutosave } = await loadBrowserModule('agentAutosave');
const { agentQuery, agentEditorPath, agentBackPath } = await loadBrowserModule('agentNavigation');

const context = { projectDir: '/projects/a & b', from: 'settings/projects', chatId: 'chat-1', returnTo: 'project' };
// The hash → route table lives in frontend/src/routes.js (pure, no imports);
// router.js is only the browser wiring. Loading the table directly means this
// test needs no window/route stubs.
const routesSource = fs.readFileSync(new URL('../frontend/src/routes.js', import.meta.url), 'utf8');
const routes = await import('data:text/javascript;base64,' + Buffer.from(routesSource).toString('base64'));
function routeFor(hash) {
return routes.parseHash(hash);
}
for (const from of ['projects', 'settings/projects', '']) {
  for (const returnTo of ['project', '']) {
    const ctx = { ...context, from, returnTo };
    const route = routeFor('#/' + agentEditorPath('reviewer', ctx));
    assert.equal(route.projectDir, ctx.projectDir);
    assert.equal(route.from, from);
    assert.equal(route.chatId, ctx.chatId);
    assert.equal(route.returnTo, returnTo);
    assert.equal(route.isNew, false);
    assert.equal(routeFor('#/' + agentBackPath(ctx)).name, returnTo ? 'settingsProject' : 'settingsAgents');
  }
}
assert.equal(routeFor('#/settings/agents/new?' + agentQuery(context)).isNew, true);
assert.equal(routeFor('#/' + agentEditorPath('new', context)).isNew, false);
assert.equal(routeFor('#/settings/agents/%72eviewer?' + agentQuery(context)).id, 'reviewer');
const legacy = routeFor('#/settings/project/agents/reviewer?' + agentQuery(context));
assert.equal(legacy.returnTo, 'project');
assert.equal(legacy.chatId, context.chatId);
assert.equal(legacy.from, context.from);
console.log('PASS agent routes preserve caller, project, chat and reserved-name editing');

let record = { name: 'reviewer', content: 'initial' };
const requests = [];
const snapshots = [];
const statuses = [];
let release;
let offline = false;
let hold = false;
const queue = createAgentAutosave({
  name: record.name,
  delay: 60000,
  save: async (name, patch) => {
    requests.push({ name, patch });
    if (hold) await new Promise(resolve => { release = resolve; });
    if (offline) throw new Error('offline');
    assert.equal(name, record.name, 'PATCH uses latest persisted name');
    record = { ...record, ...patch };
    return record;
  },
  onStatus: status => statuses.push(status),
  onSaved: agent => snapshots.push(agent)
});
queue.enqueue({ name: 'writer' });
queue.enqueue({ content: 'both fields' });
assert.equal(requests.length, 0);
assert.equal(await queue.flush(), true);
assert.deepEqual(requests[0].patch, { name: 'writer', content: 'both fields' });
assert.equal(queue.name, 'writer');
console.log('PASS debounce merges name and instructions; Back flushes pending edits');

hold = true;
queue.enqueue({ name: 'new' });
const saving = queue.flush();
queue.enqueue({ content: 'typed while renaming' });
queue.enqueue({ thinkingLevel: 'high' }, true);
assert.equal(requests.length, 2, 'only one request in flight');
assert.equal(snapshots.length, 1);
hold = false;
release();
assert.equal(await saving, true);
assert.equal(requests[2].name, 'new');
assert.equal(record.content, 'typed while renaming');
assert.equal(record.thinkingLevel, 'high');
assert.equal(snapshots.length, 2, 'no stale snapshot published between writes');
console.log('PASS serialized saves preserve edits during rename and picker changes');

offline = true;
queue.enqueue({ content: 'retained after failure' });
assert.equal(await queue.flush(), false);
assert.equal(queue.failed, true);
assert.equal(statuses.at(-1).kind, 'error');
offline = false;
queue.enqueue({ thinkingLevel: 'low' });
assert.equal(await queue.flush(), true);
assert.equal(record.content, 'retained after failure');
assert.equal(record.thinkingLevel, 'low');
console.log('PASS failed writes retain all fields for retry');

// An isolated server exercises the existing serve implementation without
// starting, stopping or restarting the host-managed app or touching user data.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-flow-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
const require = createRequire(import.meta.url);
const settings = require('../src/settings.js');
settings.setProject(projectDir, { models: [{ id: 'fixture-model', provider: 'ollama' }] });
const server = require('../src/index.js').createServer(0);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
async function request(method, endpoint, body) {
  const response = await fetch(url + endpoint, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}
const payload = { projectDir, name: 'new', content: 'Review carefully', modelId: 'fixture-model', providerId: 'ollama', thinkingLevel: 'high', tools: ['read_file'] };
try {
  const created = await request('POST', '/api/agents', payload);
  assert.equal(created.status, 201);
  for (const key of ['name', 'content', 'modelId', 'providerId', 'thinkingLevel', 'tools']) assert.deepEqual(created.body.agent[key], payload[key]);
  const renamed = await request('PATCH', '/api/agents/new', { projectDir, name: 'reviewer', content: 'updated' });
  assert.equal(renamed.status, 200);
  const loaded = await request('GET', '/api/agents/reviewer?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(loaded.body.agent.content, 'updated');
  assert.deepEqual(loaded.body.agent.tools, ['read_file']);
  const index = await fetch(url + '/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<html/i);
  console.log('PASS existing serve flow: page, create with all options, rename and reload');
} finally {
  if (!process.argv.includes('--browser')) {
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--browser')) {
  fs.writeFileSync(new URL('../tmp/subagent-flow-fixture.json', import.meta.url), JSON.stringify({ url, projectDir }));
  console.log('Browser fixture: ' + url);
  setTimeout(() => { server.close(); server.closeAllConnections(); }, 600000).unref();
}
