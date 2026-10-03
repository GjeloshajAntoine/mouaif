'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-working-folder-test-'));
process.env.MOUAIF_HOME = home;
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');
const { runAppTool, SPECS } = require('../src/tools/mouaif.js');
const workspace = require('../src/chatWorkingFolder.js');
const { streamChat } = require('../src/ai-stream.js');
const { handleTools } = require('../src/server-handlers-tools.js');
const originalFetch = global.fetch;
const projectDir = path.join(home, 'project with spaces');
fs.mkdirSync(projectDir);
const git = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' }).trim();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGvCAAxBgMBAJ2DqQAAAAAASUVORK5CYII=', 'base64');
let id = 0;

async function modelCalls(chat, calls, decision) {
  let round = 0;
  const events = [];
  const bodies = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const next = calls[round++];
    const delta = next ? { tool_calls: [{ index: 0, id: 'call-' + ++id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { content: 'Done' };
    return new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const out = await streamChat({
    model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
    projectDir, chatId: chat.id, chat, enabledTools: calls.map((c) => c.name), promptSize: 'average',
    messages: [{ role: 'user', content: 'Work in isolation' }],
    onEvent(name, data) {
      events.push({ name, data });
      if (name === 'authorization_required') authz.recordDecision(projectDir, chat.id, data.callId, decision || 'allow-once');
    }
  });
  assert.equal(out.ok, true);
  return { results: events.filter((e) => e.name === 'tool_result').map((e) => e.data), events, bodies };
}

async function main() {
  assert.equal(SPECS.change_working_folder.function.parameters.properties.directory.type, 'string');
  assert.equal(authz.effectiveConfig(projectDir, 'change_working_folder').mode, 'ask');
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'committed\nprivate-token\n');
  fs.writeFileSync(path.join(projectDir, 'shot.png'), image);
  git('add', 'notes.txt', 'shot.png');
  git('commit', '-qm', 'Fixture');
  const initialBranch = git('branch', '--show-current');
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'parent dirty\nprivate-token\n');
  fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'parent only');
  const chat = chats.createChat(projectDir, { title: 'Partial development' });
  const other = chats.createChat(projectDir, {});
  settings.getDb().exec('ALTER TABLE chat_store DROP COLUMN working_dir');
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, null, 'existing databases receive the additive migration');
  assert.equal(chats.getChat(projectDir, other.id).id, other.id, 'migration preserves existing chats');
  assert.equal(workspace.resolve(projectDir, chat.id), projectDir);
  const call = (args, chatId = chat.id) => runAppTool('change_working_folder', args, { projectDir, chatId });
  assert.equal((await call({ directory: 1 })).result.code, 'EBADINPUT');
  assert.equal((await call({}, 'missing')).result.code, 'ENOTFOUND');
  assert.equal((await call({ directory: 'missing' })).result.code, 'ENOENT');
  assert.equal((await call({ directory: 'notes.txt' })).result.code, 'ENOTDIR');
  if (process.env.MOUAIF_ALLOW_ANY_ROOT !== '1') {
    assert.equal((await call({ directory: os.tmpdir() })).result.code, 'EOUTSIDE_HOME');
    fs.symlinkSync(os.tmpdir(), path.join(projectDir, 'outside-link'));
    assert.equal((await call({ directory: 'outside-link' })).result.code, 'EOUTSIDE_HOME');
  }
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, null);

  // Denial/off never creates a workspace or changes metadata.
  const denied = await modelCalls(chat, [{ name: 'change_working_folder', args: {} }], 'deny');
  assert.equal(denied.results[0].ok, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false);
  authz.setAuthorization(projectDir, { tools: { change_working_folder: { mode: 'off' } } });
  const off = await modelCalls(chat, [{ name: 'change_working_folder', args: {} }]);
  assert.equal(off.results[0].ok, false);
  assert.equal(off.events.some((e) => e.name === 'authorization_required'), false);

  settings.setProject(projectDir, { hideFileContent: [{ path: 'notes.txt', ranges: [{ start: 2, end: 2 }] }] });
  authz.setAuthorization(projectDir, { tools: {
    change_working_folder: { mode: 'allow' }, shell: { mode: 'allow' }, file: { mode: 'allow' }
  } });
  const target = path.join(projectDir, '.mouaif', 'workspaces', chat.id);
  const flow = await modelCalls(chat, [
    { name: 'change_working_folder', args: {} },
    { name: 'shell', args: { cmd: 'pwd' } },
    { name: 'read_file', args: { path: 'notes.txt' } },
    { name: 'search_files', args: { query: 'private-token' } },
    { name: 'group_read', args: { files: [{ path: 'notes.txt' }] } },
    { name: 'edit_file', args: { path: 'notes.txt', oldText: 'committed', newText: 'workspace edit' } }
  ]);
  assert.ok(flow.results.every((r) => r.ok), JSON.stringify(flow.results));
  assert.equal(flow.results[0].result.created, true);
  assert.equal(flow.results[0].result.branch, 'mouaif/chat-' + chat.id);
  assert.equal(flow.results[1].result.stdout.trim(), target);
  assert.equal(flow.results[2].result.body.includes('private-token'), false, 'original project redaction follows worktree reads');
  assert.equal(flow.results[3].result.matches.length, 0, 'original project redaction follows search');
  assert.equal(flow.results[4].result.results[0].result.body.includes('private-token'), false, 'group reads keep redaction');
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'workspace edit\nprivate-token\n');
  assert.equal(fs.readFileSync(path.join(projectDir, 'notes.txt'), 'utf8'), 'parent dirty\nprivate-token\n');
  assert.equal(fs.existsSync(path.join(target, 'untracked.txt')), false);
  assert.equal(git('branch', '--show-current'), initialBranch);
  assert.equal(workspace.resolve(projectDir, other.id), projectDir, 'other chats are unaffected');
  assert.equal(chats.listChats(projectDir).find((c) => c.id === chat.id).workingDir, target);
  chats.updateChat(projectDir, chat.id, { title: 'Keep folder' });
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, target);
  assert.equal((await runAppTool('get_chat', {}, { projectDir, chatId: chat.id })).result.chat.workingDir, target);
  assert.equal((await call({})).result.created, false, 'retries reuse without resetting edits');
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8').startsWith('workspace edit'), true);
  const later = await modelCalls(chat, [{ name: 'read_file', args: { path: 'notes.txt' } }]);
  assert.ok(later.bodies[0].messages.some((m) => m.role === 'system' && m.content.includes(target)), 'subsequent turns know the working folder');
  authz.setAuthorization(projectDir, { tools: { subagent: { mode: 'allow' } } });
  const delegated = await modelCalls(chat, [
    { name: 'subagent', args: { task: 'Read notes.txt in the current workspace' } },
    { name: 'read_file', args: { path: 'notes.txt' } }
  ]);
  assert.equal(delegated.results[0].ok, true);
  const nestedRead = delegated.results[0].result.toolEvents.find((e) => e.name === 'tool_result' && e.data.name === 'read_file');
  assert.ok(nestedRead.data.result.body.startsWith('workspace edit'), 'delegated tools inherit the live folder');
  fs.writeFileSync(path.join(target, 'new-shot.png'), image);
  assert.equal((await runAppTool('attach_chat_image', { path: 'new-shot.png' }, { projectDir, chatId: chat.id })).ok, true);
  assert.equal(chats.getChat(projectDir, chat.id).draftAttachments.length, 1, 'images are read in workspace but saved to original chat');

  // Composer @shell takes the same cwd while keeping original auth keys.
  const body = { projectDir, chatId: chat.id, callId: 'direct-test', cmd: 'pwd' };
  const req = { on(name, callback) {
    if (name === 'data') process.nextTick(() => callback(Buffer.from(JSON.stringify(body))));
    if (name === 'end') process.nextTick(callback);
  } };
  const res = { data: '', writeHead(status) { this.status = status; }, write(chunk) { this.data += chunk; }, end(chunk) { this.data += chunk || ''; } };
  req.method = 'POST';
  await handleTools(req, res, new URL('http://fixture/api/tools/shell'), null);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.data.trim().split('\n').at(-1)).result.stdout.trim(), target);

  fs.mkdirSync(path.join(projectDir, 'subfolder'));
  assert.equal((await call({ directory: 'subfolder' })).result.workingDir, path.join(projectDir, 'subfolder'));
  assert.equal((await call({ directory: home })).result.workingDir, home);
  assert.equal((await call({ directory: '' })).result.workingDir, projectDir);
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, null);
  assert.equal((await call({ chatId: other.id })).ok, true, 'explicit target creates its own workspace');
  chats.deleteChat(projectDir, other.id);
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif', 'workspaces', other.id)), true, 'deleting chats never deletes work');

  const deletedFolder = chats.createChat(projectDir, {});
  chats.updateChat(projectDir, deletedFolder.id, { workingDir: path.join(home, 'no-longer-present') });
  const missingFolder = await modelCalls(deletedFolder, [{ name: 'shell', args: { cmd: 'pwd' } }]);
  assert.equal(missingFolder.results[0].ok, false, 'missing folder fails rather than writing to the original project');
  const conflict = chats.createChat(projectDir, {});
  fs.mkdirSync(path.join(projectDir, '.mouaif', 'workspaces', conflict.id));
  assert.equal((await call({}, conflict.id)).ok, false, 'arbitrary existing folder is not treated as a worktree');
  const cancelled = new AbortController();
  cancelled.abort();
  const abort = await runAppTool('change_working_folder', {}, { projectDir, chatId: conflict.id, signal: cancelled.signal });
  assert.equal(abort.result.code, 'EABORTED');
  const busy = chats.createChat(projectDir, {});
  const firstChange = call({}, busy.id);
  assert.equal((await call({}, busy.id)).result.code, 'EBUSY', 'concurrent changes to one chat are serialized');
  assert.equal((await firstChange).ok, true);
  const collision = chats.createChat(projectDir, {});
  git('branch', 'mouaif/chat-' + collision.id);
  assert.equal((await call({}, collision.id)).result.code, 'EGIT', 'branch collisions never force/reset an existing branch');
  assert.equal(chats.getChat(projectDir, collision.id).workingDir, null);
  const plain = path.join(home, 'plain');
  fs.mkdirSync(plain);
  const plainChat = chats.createChat(plain, {});
  const empty = await runAppTool('change_working_folder', {}, { projectDir: plain, chatId: plainChat.id });
  assert.equal(empty.ok, true);
  assert.equal(empty.result.branch, null);
  assert.equal(fs.readdirSync(empty.result.workingDir).length, 0);
  const unborn = path.join(home, 'unborn');
  fs.mkdirSync(unborn);
  execFileSync('git', ['init', '-q'], { cwd: unborn });
  const unbornChat = chats.createChat(unborn, {});
  assert.equal((await runAppTool('change_working_folder', {}, { projectDir: unborn, chatId: unbornChat.id })).result.code, 'EGIT');
  assert.equal(chats.getChat(unborn, unbornChat.id).workingDir, null, 'Git errors do not change cwd');
  const redirected = path.join(home, 'redirected');
  fs.mkdirSync(redirected);
  fs.symlinkSync(plain, path.join(redirected, '.mouaif'));
  const redirectChat = chats.createChat(redirected, {});
  assert.equal((await runAppTool('change_working_folder', {}, { projectDir: redirected, chatId: redirectChat.id })).result.code, 'EOUTSIDE_PROJECT');
  // Serve smoke test in isolation; never start/restart the managed app.
  const server = require('../src/index.js').createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  global.fetch = originalFetch;
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const entry = (await page.text()).match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
    assert.equal((await fetch(base + entry)).status, 200);
    const catalog = await (await fetch(base + '/api/tools/list')).json();
    assert.ok(catalog.tools.some((t) => t.name === 'change_working_folder' && t.source === 'chats'));
    const patched = await fetch(base + '/api/chats/' + chat.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, workingDir: '/outside-home', title: 'HTTP title' })
    });
    assert.equal(patched.status, 200);
    const updated = (await patched.json()).chat;
    assert.equal(updated.workingDir, null, 'generic REST patch cannot bypass folder validation');
    assert.equal(updated.title, 'HTTP title');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log('PASS chat working folder: migration, worktree isolation, retry, persistence, schema, paths, denial/off, shell/file/group/search redaction, delegation, direct HTTP shell, attachments, reset, Git errors, safe lifecycle and serve smoke');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  settings.getDb().close();
  fs.rmSync(home, { recursive: true, force: true });
});
