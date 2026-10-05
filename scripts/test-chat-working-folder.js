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
      if (name === 'authorization_required') {
      const pending = authz.listPending(projectDir, chat.id).find(request => request.callId === data.callId);
      assert.equal(pending.summary, data.summary, 'live and recovered approval details agree');
      authz.recordDecision(projectDir, chat.id, data.callId, decision || 'allow-once');
      }
    }
  });
  assert.equal(out.ok, true);
  return { results: events.filter((e) => e.name === 'tool_result').map((e) => e.data), events, bodies };
}

async function main() {
  assert.deepEqual(SPECS.change_working_folder.function.parameters.properties.directory.type, ['string', 'boolean', 'null']);
  // The advertised schema carries no chatId: the model cannot name a chat.
  assert.deepEqual(Object.keys(SPECS.change_working_folder.function.parameters.properties), ['directory']);
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
  // The tool owns its chat: the chat id is ambient server context, so the
  // target comes from `opts`, never from an argument.
  const call = (args, chatId = chat.id) => runAppTool('change_working_folder', args, { projectDir, chatId });
  // A chat id is ambient context owned by the server. A spurious argument is
  // refused (never silently retargeting), and no current chat is a clear error.
  assert.equal((await runAppTool('change_working_folder', { chatId: other.id, directory: 'subfolder' }, { projectDir, chatId: chat.id })).result.code, 'EBADINPUT');
  assert.equal((await runAppTool('change_working_folder', {}, { projectDir })).result.code, 'EBADINPUT');
  assert.equal((await call({ directory: 1 })).result.code, 'EBADINPUT');
  assert.equal((await call({}, 'missing')).result.code, 'ENOTFOUND');
  assert.equal((await call({ directory: 'missing' })).result.code, 'ENOENT');
  assert.equal((await call({ directory: 'notes.txt' })).result.code, 'ENOTDIR');
  // Creating the default workspace is opt-in: off by default it fails with
  // EOFF and writes nothing, including the parents.
  assert.equal(authz.effectiveConfig(projectDir, 'change_working_folder').mode, 'ask');
  const offByDefault = await call({});
  assert.equal(offByDefault.ok, false);
  assert.equal(offByDefault.result.code, 'EOFF');
  assert.equal(offByDefault.result.message.includes('Settings → Project → General'), true,
    'EOFF points at the switch’s real location (the tool row is not where it lives)');
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false, 'EOFF creates nothing');
  assert.equal((await call({}, chat.id)).result.code, 'EOFF', 'the default chat target is still gated');
  assert.equal((await call({ directory: null })).result.code, 'EOFF');
  assert.equal((await call({ directory: true })).result.code, 'EBADINPUT', 'a boolean is only meaningful as false');
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, null);
  // The app-level default can enable creation for every project that does
  // not set its own value; a project value overrides it either way.
  settings.setApp({ autoWorkspace: true });
  assert.equal((await call({ directory: 'notes.txt' })).result.code, 'ENOTDIR', 'explicit directories still never create');
  const otherRoot = path.join(home, 'app-default');
  fs.mkdirSync(otherRoot);
  const appDefaultChat = chats.createChat(otherRoot, {});
  const appDefault = await runAppTool('change_working_folder', {}, { projectDir: otherRoot, chatId: appDefaultChat.id });
  assert.equal(appDefault.ok, true, 'app default on enables workspaces for projects without their own value');
  assert.equal(appDefault.result.created, true);
  settings.setProject(otherRoot, { autoWorkspace: false });
  const projectOff = await runAppTool('change_working_folder', {}, { projectDir: otherRoot, chatId: appDefaultChat.id });
  assert.equal(projectOff.result.code, 'EOFF', 'a project value overrides the app default');
  settings.setApp({ autoWorkspace: false });
  if (process.env.MOUAIF_ALLOW_ANY_ROOT !== '1') {
    assert.equal((await call({ directory: os.tmpdir() })).result.code, 'EOUTSIDE_HOME');
    fs.symlinkSync(os.tmpdir(), path.join(projectDir, 'outside-link'));
    assert.equal((await call({ directory: 'outside-link' })).result.code, 'EOUTSIDE_HOME');
  }
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, null);

  // Approval summaries name the operation, actual target and resolved path.
  // Recovering a pending approval must show the same details as its SSE event.
  const approvalCases = [
    [{}, 'Use a separate folder', chat.id, path.join(projectDir, '.mouaif', 'workspaces', chat.id)],
    [{ directory: false }, 'Use a separate folder', chat.id, path.join(projectDir, '.mouaif', 'workspaces', chat.id)],
    [{ directory: null }, 'Use a separate folder', chat.id, path.join(projectDir, '.mouaif', 'workspaces', chat.id)],
    [{ directory: '' }, 'Return to the project folder', chat.id, projectDir],
    [{ directory: '.' }, 'Return to the project folder', chat.id, projectDir],
    [{ directory: home }, 'Use a different folder', chat.id, home]
  ];
  for (const [args, action, targetId, destination] of approvalCases) {
    const approval = await modelCalls(chat, [{ name: 'change_working_folder', args }], 'deny');
    const request = approval.events.find(e => e.name === 'authorization_required').data;
    assert.equal(request.summary.split('\n')[0], action);
    assert.ok(request.summary.includes('Chat: ' + chats.getChat(projectDir, targetId).title + ' (' + targetId + ')'));
    assert.ok(request.summary.includes('Folder: ' + destination));
    assert.ok(request.summary.includes('Files read or edited and commands run for this chat will use this folder.'));
    assert.ok(request.summary.includes(action === 'Use a separate folder' ? 'starts empty; project files are not copied' : 'does not move or copy files'));
    assert.equal(request.summary.includes('Git'), false, 'approval explains user impact, not implementation details');
    assert.equal(approval.results[0].ok, false);
  }
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false, 'approval previews have no filesystem side effects');

  // Denial/off never creates a workspace or changes metadata.
  const denied = await modelCalls(chat, [{ name: 'change_working_folder', args: {} }], 'deny');
  assert.equal(denied.results[0].ok, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false);
  authz.setAuthorization(projectDir, { tools: { change_working_folder: { mode: 'off' } } });
  const off = await modelCalls(chat, [{ name: 'change_working_folder', args: {} }]);
  assert.equal(off.results[0].ok, false);
  assert.equal(off.events.some((e) => e.name === 'authorization_required'), false);

  settings.setProject(projectDir, { hideFileContent: [{ path: 'notes.txt', ranges: [{ start: 2, end: 2 }] }], autoWorkspace: true });
  authz.setAuthorization(projectDir, { tools: {
    change_working_folder: { mode: 'allow' }, shell: { mode: 'allow' }, file: { mode: 'allow' }
  } });
  const target = path.join(projectDir, '.mouaif', 'workspaces', chat.id);
  const branchesBefore = git('branch', '--list');
  const worktreesBefore = git('worktree', 'list', '--porcelain');
  const originalPath = process.env.PATH;
  let folder;
  try {
    process.env.PATH = '';
    folder = await call({});
  } finally { process.env.PATH = originalPath; }
  assert.equal(folder.ok, true, 'creating a workspace does not require Git on PATH');
  assert.equal(folder.result.created, true);
  assert.equal(folder.result.branch, null, 'the directory tool does not inspect or create branches');
  assert.deepEqual(fs.readdirSync(target), [], 'Git projects also receive an empty folder');
  assert.equal(git('branch', '--list'), branchesBefore);
  assert.equal(git('worktree', 'list', '--porcelain'), worktreesBefore);
  // Git setup is separate from folder selection, just as an assistant would
  // use an authorized shell call before selecting an existing checkout.
  git('worktree', 'add', '-b', 'fixture-workspace-' + chat.id, target, 'HEAD');
  const flow = await modelCalls(chat, [
    { name: 'change_working_folder', args: {} },
    { name: 'shell', args: { cmd: 'pwd' } },
    { name: 'read_file', args: { path: 'notes.txt' } },
    { name: 'search_files', args: { query: 'private-token' } },
    { name: 'group_read', args: { files: [{ path: 'notes.txt' }] } },
    { name: 'edit_file', args: { path: 'notes.txt', oldText: 'committed', newText: 'workspace edit' } }
  ]);
  assert.ok(flow.results.every((r) => r.ok), JSON.stringify(flow.results));
  assert.equal(flow.results[0].result.created, false, 'externally prepared workspaces are reused');
  assert.equal(flow.results[0].result.branch, null);
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
  // A delegated run gets its OWN folder, not the parent chat's: it starts in
  // the parent's folder, and can switch within it without retargeting the
  // parent conversation, whose stored folder must stay untouched.
  authz.setAuthorization(projectDir, { tools: {
    subagent: { mode: 'allow' }, change_working_folder: { mode: 'allow' }, shell: { mode: 'allow' }, file: { mode: 'allow' }
  } });
  fs.mkdirSync(path.join(target, 'sub-checkout'));
  const runEventsAll = [];
  const runNested = (calls, onAuthorization) => {
    runEventsAll.length = 0;
    let nestedRound = 0;
    let parentRound = 0;
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      // The nested run's system message may be a string or a content-block
      // array (agent personas), so match on the serialized transcript.
      const isNested = JSON.stringify(body.messages).includes('focused subagent');
      let delta;
      if (isNested) {
        const next = calls[nestedRound++];
        delta = next ? { tool_calls: [{ index: 0, id: 'nested-' + ++id, type: 'function',
          function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { content: 'nested done' };
      } else {
        delta = parentRound++ === 0
          ? { tool_calls: [{ index: 0, id: 'parent-' + ++id, type: 'function',
            function: { name: 'subagent', arguments: JSON.stringify({ task: 'Change the run folder' }) } }] }
          : { content: 'parent done' };
      }
      return new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    return streamChat({
      model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
      projectDir, chatId: chat.id, chat, promptSize: 'average',
      enabledTools: [...new Set(['subagent', 'change_working_folder', 'shell', ...calls.map((c) => c.name)])],
      messages: [{ role: 'user', content: 'Delegate a folder change' }],
      onEvent(name, data) {
        runEventsAll.push({ name, data });
        if (name === 'authorization_required') {
        assert.equal(data.chatId, chat.id, 'nested approvals belong to the real parent chat');
        const pending = authz.listPending(projectDir, chat.id).find((request) => request.callId === data.callId);
        assert.ok(pending, 'nested approvals are recoverable from the parent chat');
        assert.equal(pending.summary, data.summary);
        if (onAuthorization) onAuthorization(data);
        else authz.recordDecision(projectDir, chat.id, data.callId, 'allow-once');
        }
      }
    });
  };
  const runOut = await runNested([
    { name: 'change_working_folder', args: { directory: 'sub-checkout' } },
    { name: 'shell', args: { cmd: 'pwd' } },
    { name: 'change_working_folder', args: {} },
    { name: 'shell', args: { cmd: 'pwd' } }
  ]);
  assert.equal(runOut.ok, true, JSON.stringify(runOut.error));
  const runEvents = runEventsAll.find((e) => e.name === 'tool_result' && e.data.name === 'subagent')
    .data.result.toolEvents.filter((e) => e.name === 'tool_result');
  const runFolder = runEvents.find((e) => e.data.name === 'change_working_folder').data.result;
  const runPwds = runEvents.filter((e) => e.data.name === 'shell').map((e) => e.data.result.stdout.trim());
  assert.equal(runFolder.ok, true, JSON.stringify(runFolder));
  assert.equal(runFolder.workingDir, path.join(target, 'sub-checkout'), 'the run resolves its own folder');
  assert.deepEqual(runFolder.updated, [], 'a run never writes chat metadata');
  // A run never creates a folder, so `created` must stay false even though the
  // run moved: it selects an existing directory and prepares nothing.
  assert.equal(runFolder.created, false, 'a run never reports creating a folder');
  assert.deepEqual(runPwds, [path.join(target, 'sub-checkout'), target], 'a run resets to its start folder, not a new workspace');
  // The anchor is the run's START folder and never moves, so the same relative
  // argument always names the same directory (with the current folder as the
  // anchor, "sub-checkout" would mean sub-checkout/sub-checkout on a second
  // call). Checked on a live registration, since a settled run is forgotten.
  const anchorRun = workspace.registerRun(target, { root: target, current: target }, chat.id);
  const firstCall = (await runAppTool('change_working_folder', { directory: 'sub-checkout' }, { projectDir, chatId: chat.id, workspaceChatId: anchorRun.chatId })).result;
  const secondCall = (await runAppTool('change_working_folder', { directory: 'sub-checkout' }, { projectDir, chatId: chat.id, workspaceChatId: anchorRun.chatId })).result;
  assert.equal(firstCall.workingDir, path.join(target, 'sub-checkout'));
  assert.equal(secondCall.workingDir, path.join(target, 'sub-checkout'), 'the anchor is fixed, not the current folder');
  assert.equal(firstCall.created, false);
  assert.equal(secondCall.created, false, 'a run never reports creating a folder');
  // A card shown for this call names the same folder the call would use, and
  // the parent chat the run came from — not the run itself.
  const card = workspace.describeChange(projectDir, chat.id, { directory: 'sub-checkout' }, anchorRun.chatId);
  assert.ok(card.includes('Folder: ' + path.join(target, 'sub-checkout')), 'the preview matches the call');
  assert.ok(card.includes('Delegated from: '), card);
  assert.equal(card.includes('Delegated from: ' + anchorRun.chatId), false, 'the card does not name the run as its own parent');
  assert.equal(/starts empty|created/i.test(card), false, 'a run card never promises folder creation');
  workspace.clearRun(anchorRun.runId);
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, target, 'the parent chat keeps its folder');
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif', 'workspaces')), true);
  // A completed run is forgotten: its synthetic id no longer resolves, so a
  // stale or hand-crafted id fails instead of falling back to the project.
  assert.equal(workspace.isRunChatId(runFolder.workingDir), false);
  assert.equal((await runAppTool('change_working_folder', {}, { projectDir, chatId: chat.id, workspaceChatId: 'subagent:run-nope' })).result.code, 'ENOTFOUND');
  assert.throws(() => workspace.resolveForCall(projectDir, chat.id, anchorRun.chatId), { code: 'ENOTFOUND' }, 'settled runs never fall back to the parent');

  // Chat permissions and approval sessions must never use the synthetic id.
  // Project Allow + chat Ask is the regression that otherwise executes a
  // nested shell without asking the user.
  authz.setChatAuthorization(projectDir, chat.id, { native: { shell: { mode: 'ask' }, chats: { mode: 'ask' } } });
  assert.equal((await runNested([
    { name: 'change_working_folder', args: { directory: 'sub-checkout' } },
    { name: 'shell', args: { cmd: 'pwd' } }
  ])).ok, true);
  const asked = runEventsAll.filter((e) => e.name === 'authorization_required');
  assert.deepEqual(asked.map((e) => e.data.tool), ['change_working_folder', 'shell']);
  assert.ok(asked[0].data.summary.includes('Subagent run: subagent:run-'));
  assert.ok(asked[0].data.summary.includes('Folder: ' + path.join(target, 'sub-checkout')));
  assert.ok(asked[0].data.summary.includes('Delegated from: Keep folder (' + chat.id + ')'));
  const nestedResults = () => runEventsAll.find((e) => e.name === 'tool_result' && e.data.name === 'subagent')
    .data.result.toolEvents.filter((e) => e.name === 'tool_result').map((e) => e.data);
  assert.equal(nestedResults()[1].result.stdout.trim(), path.join(target, 'sub-checkout'));
  await runNested([{ name: 'shell', args: { cmd: 'pwd' } }], (data) => {
    authz.recordDecision(projectDir, chat.id, data.callId, 'deny');
  });
  assert.equal(nestedResults()[0].ok, false, 'denying from the parent prevents the nested shell');
  await runNested([{ name: 'shell', args: { cmd: 'pwd' } }], () => {
    assert.equal(authz.cancelSession(projectDir, chat.id), 1, 'Stop settles the nested authorization wait');
  });
  assert.equal(nestedResults()[0].ok, false);
  assert.deepEqual(authz.listPending(projectDir, chat.id), []);
  authz.setChatAuthorization(projectDir, chat.id, { native: { shell: { mode: 'off' } } });
  await runNested([{ name: 'shell', args: { cmd: 'pwd' } }]);
  assert.equal(nestedResults()[0].ok, false, 'chat Off remains enforced in delegates');
  assert.equal(runEventsAll.some((e) => e.name === 'authorization_required'), false);
  authz.setChatAuthorization(projectDir, chat.id, { native: { shell: null, chats: null } });

  // App tools keep the real ambient chat, but attachment paths use the run's
  // current folder even when an explicit target chat is supplied.
  fs.writeFileSync(path.join(target, 'sub-checkout', 'run-shot.png'), image);
  await runNested([
    { name: 'change_working_folder', args: { directory: 'sub-checkout' } },
    { name: 'get_chat', args: {} },
    { name: 'list_chat_attachments', args: {} },
    { name: 'attach_chat_image', args: { path: 'run-shot.png', chatId: chat.id } },
    { name: 'task', args: { action: 'create', title: 'Delegated task' } }
  ]);
  const ambient = nestedResults();
  assert.ok(ambient.every((e) => e.ok), JSON.stringify(ambient));
  assert.equal(ambient[1].result.chat.id, chat.id);
  assert.equal(ambient[2].result.chatId, chat.id);
  assert.equal(ambient[3].result.chatId, chat.id);
  assert.equal(require('../src/tools/task.js').dispatchTask(chat.id, { action: 'list' }).result.tasks[0].title, 'Delegated task');
  require('../src/tools/task.js').clearChat(chat.id);
  chats.updateChat(projectDir, chat.id, { draftAttachments: [] });
  assert.equal(chats.getChat(projectDir, chat.id).workingDir, target);

  // A live run also fails if its folder disappears, including a reset to its
  // now-missing starting folder. Validation must not silently change roots.
  const disappearing = path.join(home, 'disappearing-run');
  fs.mkdirSync(disappearing);
  const disappearingRun = workspace.registerRun(disappearing, { root: disappearing, current: disappearing }, chat.id);
  fs.rmdirSync(disappearing);
  assert.throws(() => workspace.resolveForCall(projectDir, chat.id, disappearingRun.chatId), { code: 'ENOENT' });
  const disappearedReset = await runAppTool('change_working_folder', {}, { projectDir, chatId: chat.id, workspaceChatId: disappearingRun.chatId });
  assert.equal(disappearedReset.result.code, 'ENOENT');
  workspace.clearRun(disappearingRun.runId);
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
  // `other` gets its own default workspace by acting as the calling chat,
  // which is the only way the tool now selects a chat.
  assert.equal((await call({}, other.id)).ok, true, 'each chat creates its own workspace');
  chats.deleteChat(projectDir, other.id);
  assert.equal(fs.existsSync(path.join(projectDir, '.mouaif', 'workspaces', other.id)), true, 'deleting chats never deletes work');

  const deletedFolder = chats.createChat(projectDir, {});
  chats.updateChat(projectDir, deletedFolder.id, { workingDir: path.join(home, 'no-longer-present') });
  const missingFolder = await modelCalls(deletedFolder, [{ name: 'shell', args: { cmd: 'pwd' } }]);
  assert.equal(missingFolder.results[0].ok, false, 'missing folder fails rather than writing to the original project');
  const missingDelegate = await modelCalls(deletedFolder, [
    { name: 'subagent', args: { task: 'Run pwd in the selected folder' } }
  ]);
  assert.equal(missingDelegate.results[0].ok, false, 'delegation fails when the parent folder is missing');
  assert.equal(missingDelegate.results[0].result.error.code, 'ENOENT');
  assert.equal(missingDelegate.bodies.length, 2, 'no nested provider request or tool execution occurs');
  const conflict = chats.createChat(projectDir, {});
  fs.mkdirSync(path.join(projectDir, '.mouaif', 'workspaces', conflict.id));
  fs.writeFileSync(path.join(projectDir, '.mouaif', 'workspaces', conflict.id, 'keep.txt'), 'keep');
  assert.equal((await call({}, conflict.id)).result.created, false, 'existing folders are reused without Git checks');
  assert.equal(fs.readFileSync(path.join(projectDir, '.mouaif', 'workspaces', conflict.id, 'keep.txt'), 'utf8'), 'keep');
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
  const collisionBranches = git('branch', '--list');
  assert.equal((await call({}, collision.id)).ok, true, 'branch names are unrelated to folder creation');
  assert.equal(git('branch', '--list'), collisionBranches, 'existing branches are untouched');
  const redirectedTarget = chats.createChat(projectDir, {});
  fs.symlinkSync(target, path.join(projectDir, '.mouaif', 'workspaces', redirectedTarget.id));
  assert.equal((await call({}, redirectedTarget.id)).result.code, 'EEXIST', 'default targets cannot be symlinks');
  const fileTarget = chats.createChat(projectDir, {});
  fs.writeFileSync(path.join(projectDir, '.mouaif', 'workspaces', fileTarget.id), 'keep');
  assert.equal((await call({}, fileTarget.id)).result.code, 'ENOTDIR', 'an existing file is never replaced');
  const plain = path.join(home, 'plain');
  fs.mkdirSync(plain);
  settings.setProject(plain, { autoWorkspace: true });
  const plainChat = chats.createChat(plain, {});
  const empty = await runAppTool('change_working_folder', {}, { projectDir: plain, chatId: plainChat.id });
  assert.equal(empty.ok, true);
  assert.equal(empty.result.branch, null);
  assert.equal(fs.readdirSync(empty.result.workingDir).length, 0);
  const cancelledRoot = path.join(home, 'cancelled');
  fs.mkdirSync(cancelledRoot);
  settings.setProject(cancelledRoot, { autoWorkspace: true });
  const cancelledTarget = chats.createChat(cancelledRoot, {});
  const cancelSignal = new AbortController();
  cancelSignal.abort();
  assert.equal((await runAppTool('change_working_folder', {}, { projectDir: cancelledRoot, chatId: cancelledTarget.id, signal: cancelSignal.signal })).result.code, 'EABORTED');
  assert.equal(fs.existsSync(path.join(cancelledRoot, '.mouaif')), false, 'a cancelled change leaves no workspace folders behind');
  const unborn = path.join(home, 'unborn');
  fs.mkdirSync(unborn);
  settings.setProject(unborn, { autoWorkspace: true });
  execFileSync('git', ['init', '-q'], { cwd: unborn });
  const unbornChat = chats.createChat(unborn, {});
  const unbornFolder = await runAppTool('change_working_folder', {}, { projectDir: unborn, chatId: unbornChat.id });
  assert.equal(unbornFolder.ok, true, 'repositories without HEAD still receive an empty folder');
  assert.deepEqual(fs.readdirSync(unbornFolder.result.workingDir), []);
  const redirected = path.join(home, 'redirected');
  fs.mkdirSync(redirected);
  settings.setProject(redirected, { autoWorkspace: true });
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
  console.log('PASS chat working folder: migration, Git-independent creation, external workspace reuse, retry, persistence, schema, paths, denial/off, shell/file/group/search redaction, delegation, direct HTTP shell, attachments, reset, safe lifecycle and serve smoke');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  settings.getDb().close();
  fs.rmSync(home, { recursive: true, force: true });
});
