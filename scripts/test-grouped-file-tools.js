'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-grouped-files-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
const files = require('../src/tools/files.js');
const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');
const run = (name, args, extra = {}) => files.runFileTool(name, { projectDir, args, ...extra });
const write = (name, text) => fs.writeFileSync(path.join(projectDir, name), text);

async function main() {
  for (const name of ['group_read', 'group_edit']) {
    assert.ok(files.isFileToolName(name));
    assert.ok(authz.FILE_FAMILY_TOOLS.has(name));
    assert.equal(files.SPECS[name].function.name, name);
    const key = name === 'group_read' ? 'files' : 'edits';
    assert.equal((await run(name, {})).result.error.code, 'EBADINPUT');
    assert.equal((await run(name, { [key]: [] })).result.error.code, 'EBADINPUT');
    assert.equal((await run(name, { [key]: Array(files.MAX_BATCH_ENTRIES + 1).fill({ path: 'a.txt' }) })).result.error.code, 'ETOOL_CAP');
  }
  write('a.txt', 'first\nprivate\nlast');
  write('b.txt', 'one\r\ntwo\r\n');
  settings.setProject(projectDir, {
    hideFileContent: [{ path: 'a.txt', ranges: [{ start: 2, end: 2 }] }],
    tools: { file: { mode: 'allow' } }
  });
  let batch = await run('group_read', { files: [
    { path: 'a.txt', startLine: 2, endLine: 3 },
    { path: 'missing.txt' }, { path: '../escape.txt' }, { path: 'b.txt' }, null
  ] });
  assert.equal(batch.ok, false, 'partial failure is visible to the pipeline');
  assert.equal(batch.result.succeededCount, 2);
  assert.equal(batch.result.failedCount, 3);
  assert.equal(batch.result.results[0].result.body, '[hidden]\nlast');
  assert.equal(batch.result.results[1].result.error.code, 'ENOENT');
  assert.equal(batch.result.results[2].result.error.code, 'EOUTSIDE_PROJECT');
  assert.equal(batch.result.results[4].result.error.code, 'EBADINPUT');
  assert.equal(JSON.parse(batch.content).results[3].result.body, 'one\r\ntwo\r\n');
  assert.ok(!batch.content.includes('private'));

  fs.writeFileSync(path.join(root, 'outside.txt'), 'test');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(projectDir, 'link.txt'));
  batch = await run('group_read', { files: [{ path: 'link.txt' }] });
  assert.equal(batch.result.results[0].result.error.code, 'EOUTSIDE_PROJECT');
  write('large.txt', 'x'.repeat(2 * 1024 * 1024));
  batch = await run('group_read', { files: [{ path: 'large.txt' }, { path: 'a.txt' }] });
  assert.equal(batch.result.results[0].ok, true);
  assert.equal(batch.result.results[1].result.error.code, 'ETOOL_CAP');
  batch = await run('group_read', { files: [{ path: 'a.txt' }] }, { settings: { fileReadMaxLines: 1 } });
  assert.equal(batch.result.results[0].result.error.code, 'ETOOL_CAP');

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  write('pixel.png', Buffer.from(png, 'base64'));
  batch = await run('group_read', { files: [{ path: 'pixel.png' }] });
  assert.equal(batch.ok, true);
  assert.equal(batch.result.content[0].type, 'image');
  assert.equal(batch.result.results[0].result.content[0].data, png);
  assert.ok(!batch.content.includes(png), 'pixels never become model-facing text');

  batch = await run('group_edit', { edits: [
    { path: 'b.txt', oldText: 'one\ntwo', newText: 'three\nfour' },
    { file: 'b.txt', oldText: 'three', newText: 'five' },
    { path: 'a.txt', oldText: 'not present', newText: 'bad' },
    { path: '../escape.txt', oldText: 'x', newText: 'y' },
    { path: 'a.txt', oldText: 'last', newText: 'end' }
  ] });
  assert.equal(batch.result.succeededCount, 3);
  assert.equal(batch.result.failedCount, 2);
  assert.equal(fs.readFileSync(path.join(projectDir, 'b.txt'), 'utf8'), 'five\r\nfour\r\n');
  assert.equal(fs.readFileSync(path.join(projectDir, 'a.txt'), 'utf8'), 'first\nprivate\nend');
  assert.ok(JSON.parse(batch.content).results[0].result.diff.includes('+three'));
  write('ambiguous.txt', 'same\nsame');
  batch = await run('group_edit', { edits: [{ path: 'ambiguous.txt', oldText: 'same', newText: 'changed' }] });
  assert.equal(batch.result.results[0].result.error.code, 'EMULTI_MATCH');
  assert.equal(fs.readFileSync(path.join(projectDir, 'ambiguous.txt'), 'utf8'), 'same\nsame');
  const controller = new AbortController();
  controller.abort();
  batch = await run('group_edit', { edits: [{ path: 'b.txt', oldText: 'five', newText: 'bad' }] }, { signal: controller.signal });
  assert.equal(batch.result.results[0].result.error.code, 'EABORTED');

  let call = 0;
  const authorize = (tool, args) => authz.authorize({ projectDir, chatId: 'batch-test', callId: 'batch-' + ++call, tool, args, summary: 'a.txt' });
  for (const tool of ['group_read', 'group_edit']) {
    settings.setProject(projectDir, { tools: { file: { mode: 'off' } } });
    await assert.rejects(authorize(tool, {}), { code: 'ETOOL_DISABLED' });
    settings.setProject(projectDir, { tools: { file: { mode: 'allow' }, [tool]: { mode: 'off' } } });
    await assert.rejects(authorize(tool, {}), { code: 'ETOOL_DISABLED' });
    settings.setProject(projectDir, { tools: { file: { mode: 'allowlist', allowlist: ['a\\.txt', 'b\\.txt'] } } });
    const key = tool === 'group_read' ? 'files' : 'edits';
    assert.equal((await authorize(tool, { [key]: [{ path: 'a.txt' }, { file: 'b.txt' }] })).decision, 'allow');
    const asked = await authorize(tool, { [key]: [{ path: 'a.txt' }, { path: 'unlisted.txt' }] });
    assert.equal(asked.decision, 'prompt', 'one allowed path must not approve an entire group');
    authz.recordDecision(projectDir, 'batch-test', 'batch-' + call, 'allow-once');
    await asked.wait;
  }

  // Exercise the actual multi-turn dispatcher against a local SSE fixture.
  settings.setProject(projectDir, { tools: { file: { mode: 'allow' } } });
  const originalFetch = global.fetch;
  let rounds = 0;
  const events = [];
  try {
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.tools.some(tool => tool.function.name === 'group_read'));
      assert.ok(body.tools.some(tool => tool.function.name === 'group_edit'));
      let delta;
      if (rounds++ === 0) {
        delta = { tool_calls: [
          { index: 0, id: 'group-read', type: 'function', function: { name: 'group_read', arguments: JSON.stringify({ files: [{ path: 'a.txt' }] }) } },
          { index: 1, id: 'group-edit', type: 'function', function: { name: 'group_edit', arguments: JSON.stringify({ edits: [{ path: 'b.txt', oldText: 'five', newText: 'six' }] }) } }
        ] };
      } else {
        assert.ok(body.messages.some(message => message.role === 'tool' && message.name === 'group_read'));
        delta = { content: 'Done' };
      }
      return new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const streamed = await require('../src/ai-stream.js').streamChat({
      model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
      projectDir, chatId: 'batch-stream', promptSize: 'average', messages: [{ role: 'user', content: 'Read and edit' }],
      onEvent: (type, payload) => events.push({ type, payload })
    });
    assert.equal(streamed.ok, true);
    assert.equal(events.filter(event => event.type === 'tool_result' && event.payload.ok).length, 2);
    assert.equal(fs.readFileSync(path.join(projectDir, 'b.txt'), 'utf8'), 'six\r\nfour\r\n');
  } finally { global.fetch = originalFetch; }

  // Isolated serve smoke test: catalog grouping and existing web routes.
  const server = require('../src/index.js').createServer(0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const catalogResponse = await fetch(base + '/api/tools/list');
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()).tools;
    for (const name of ['group_read', 'group_edit']) {
      assert.ok(catalog.some(tool => tool.name === name && tool.source === 'files'));
    }
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const entry = (await page.text()).match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
    assert.equal((await fetch(base + entry)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }

  // Load real frontend helpers without an additional test dependency.
  const context = vm.createContext({ Set, console });
  const load = (file) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/', file), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  vm.runInContext(load('chat/tools.js'), context);
  vm.runInContext(load('ToolTree.jsx'), context);
  context.catalog = files.FILE_TOOL_NAMES.map(name => ({ name, kind: 'native', source: 'files' }));
  const groups = vm.runInContext('buildToolGroups(catalog, [], null)', context);
  assert.ok(groups.find(g => g.id === 'files').tools.some(t => t.id === 'group_read'));
  assert.ok(groups.find(g => g.id === 'files').tools.some(t => t.id === 'group_edit'));
  assert.equal(vm.runInContext("formatToolArgs({ files: [{ path: 'a.txt' }, { path: 'b.txt' }] }, 'group_read')", context), 'a.txt, b.txt');
  context.batchContent = batch.content;
  assert.equal(vm.runInContext("coerceToolResult(batchContent, 'group_edit').failedCount", context), 1);
  assert.equal(vm.runInContext("formatResultSummary('group_edit', { succeededCount: 2, failedCount: 1 })", context), '2 succeeded · 1 failed');
  const agentGroups = vm.runInContext('buildAgentToolGroups({ choices: catalog.map(t => ({ value: t.name, label: t.name })), restricted: false, selected: () => true })', context);
  assert.ok(agentGroups.find(group => group.id === 'files').tools.some(tool => tool.id === 'group_edit'));
  function node(tag) {
    return { tag, children: [], classList: { add() {} }, textContent: '',
      appendChild(child) { this.children.push(child); }, closest() { return null; }, querySelector() { return null; } };
  }
  context.document = { createElement: node };
  vm.runInContext(load('chat/toolRender.js'), context);
  const preview = node('div');
  context.preview = preview;
  context.result = { succeededCount: 1, failedCount: 1, results: [
    { path: 'a.txt', ok: true, result: { relPath: 'a.txt', body: 'safe <script> text', startLine: 1, endLine: 1 } },
    { path: 'missing.txt', ok: false, result: { error: { code: 'ENOENT', message: 'not found' } } }
  ] };
  vm.runInContext("renderToolResultBody(preview, { name: 'group_read', result }, () => false)", context);
  const textOf = (item) => [item.textContent, ...item.children.map(textOf)].join(' ');
  assert.ok(textOf(preview).includes('safe <script> text'), 'file bodies are rendered as text');
  assert.ok(textOf(preview).includes('missing.txt'));
  assert.ok(textOf(preview).includes('not found'));
  const editPreview = node('div');
  context.preview = editPreview;
  context.result = { succeededCount: 1, failedCount: 0, results: [
    { path: 'b.txt', ok: true, result: { relPath: 'b.txt', diff: '-old\n+new', addedChars: 3, removedChars: 3 } }
  ] };
  vm.runInContext("renderFileBatchToolResult(preview, result, 'group_edit')", context);
  assert.ok(textOf(editPreview).includes('-old'));
  assert.ok(textOf(editPreview).includes('+new'));
  console.log('Grouped file tools: runners, safety, caps, authorization, stream/serve and preview checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  settings.close();
  fs.rmSync(root, { recursive: true, force: true });
});
