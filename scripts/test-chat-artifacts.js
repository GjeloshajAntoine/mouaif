'use strict';

// Chat artifacts (docs/features/chat-artifacts.md), through the real tools, the
// real HTTP routes and the real mount, for a project configured either way: storage,
// the storage switch, the agent's tools,
// @artifact: mentions, data links, relink, and an app reloading on new data.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-artifacts-'));
process.env.MOUAIF_HOME = home;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const artifacts = require('../src/artifacts.js');
const authz = require('../src/tools/authorization.js');
const tags = require('../src/tags.js');
const { runAppTool, SPECS } = require('../src/tools/mouaif.js');
const { runFileTool } = require('../src/tools/files.js');
const { createServer } = require('../src/index.js');

// The whole suite runs once per way a project can keep its configuration.
let projectDir;
let mode;
const server = createServer(0);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
let base;
let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log('ok - [' + mode + '] ' + name);
}
const tool = (name, args, chatId) => runAppTool(name, args, { projectDir, chatId });
async function api(method, route, chatId, body, headers = {}) {
  const separator = route.includes('?') ? '&' : '?';
  const response = await fetch(base + '/api/chats/' + chatId + '/artifacts' + route + separator + 'projectDir=' + encodeURIComponent(projectDir), { method, headers, body });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, headers: response.headers };
}
async function appApi(route, body) {
  const response = await fetch(base + '/api/mcp/apps/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
// A create_mcp_app call as the stream persists it, so a card can mount it.
function persistCall(chatId, callId, args, result) {
  messages.appendMessage(projectDir, chatId, { role: 'tool', phase: 'call', toolCallId: callId, name: 'create_mcp_app', args, content: JSON.stringify(args) });
  messages.appendMessage(projectDir, chatId, { role: 'tool', phase: 'result', toolCallId: callId, name: 'create_mcp_app', ok: true, content: JSON.stringify(result) });
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    for (mode of ['db', 'files']) {
      projectDir = path.join(home, 'project-' + mode);
      fs.mkdirSync(projectDir);
      if (mode === 'db') settings.setDbBacked(projectDir, true);
      const chat = chats.createChat(projectDir, { title: 'Artifacts' }).id;
      const other = chats.createChat(projectDir, { title: 'Other' }).id;

      await check('names: a filename becomes valid, a folder never does', () => {
        assert.equal(artifacts.cleanName('my report (v2).csv'), 'my-report-v2.csv');
        assert.equal(artifacts.cleanName('données été.json'), 'données-été.json');
        assert.equal(artifacts.cleanName('artifact:a.json'), 'a.json');
        for (const bad of ['../x', 'a/b', 'a\\b', '', '...', '.artifacts.json/x']) assert.throws(() => artifacts.cleanName(bad), { code: 'EBADINPUT' }, bad);
        for (const bad of ['.artifacts.json', '../x', 'a b', '.hidden']) assert.throws(() => artifacts.checkName(bad), { code: 'EBADINPUT' }, bad);
      });

      await check('tools: save, list, page through and delete, scoped to the calling chat', async () => {
        assert.ok(['list_artifacts', 'read_artifact', 'save_artifact', 'delete_artifact', 'export_artifact'].every(name => SPECS[name]), 'all five are published');
        const empty = await tool('list_artifacts', {}, chat);
        assert.deepEqual(empty.result.artifacts, []);
        const saved = await tool('save_artifact', { name: 'notes.md', content: 'x'.repeat(70000), description: 'Long notes' }, chat);
        assert.equal(saved.ok, true, saved.content);
        assert.equal(saved.result.created, true);
        assert.equal(saved.result.artifact.createdBy, 'agent');
        assert.equal(saved.result.artifact.path, mode === 'db' ? undefined : '.mouaif/artifacts/' + chat + '/notes.md', 'only a real file has a path');
        assert.equal(saved.result.artifact.link, 'artifact:notes.md');
        const rowsNamed = settings.getDb().prepare("SELECT COUNT(*) AS n FROM chat_artifact WHERE chat_id = ? AND name = 'notes.md'").get(chat).n;
        assert.equal(rowsNamed, mode === 'db' ? 1 : 0, 'a row only when the project keeps its configuration in the DB');
        assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), mode === 'files', 'the project folder only when it does not');
        if (mode === 'files') assert.ok(fs.existsSync(path.join(projectDir, saved.result.artifact.path)), 'a real file, for shell and file tools');
        const page = await tool('read_artifact', { name: 'notes.md' }, chat);
        assert.equal(page.result.text.length, 64 * 1024);
        assert.equal(page.result.nextOffset, 64 * 1024);
        const rest = await tool('read_artifact', { name: 'notes.md', offset: page.result.nextOffset }, chat);
        assert.equal(rest.result.nextOffset, null);
        assert.equal(rest.result.text.length, 70000 - 64 * 1024);
        assert.equal((await tool('read_artifact', { name: 'notes.md' }, other)).result.code, 'ENOTFOUND', 'another chat cannot read it');
        const replaced = await tool('save_artifact', { name: 'notes.md', content: 'short' }, chat);
        assert.equal(replaced.result.created, false);
        assert.equal(replaced.result.artifact.description, 'Long notes', 'replacing keeps the description');
        assert.equal(replaced.result.artifact.createdBy, 'agent');
        assert.equal((await tool('save_artifact', { name: 'x.txt' }, chat)).result.code, 'EBADINPUT', 'needs content or path');
        assert.equal((await tool('save_artifact', { name: 'x.txt', content: 'a', path: 'b' }, chat)).result.code, 'EBADINPUT');
        assert.equal((await tool('delete_artifact', { name: 'notes.md' }, chat)).ok, true);
        assert.equal((await tool('delete_artifact', { name: 'notes.md' }, chat)).result.code, 'ENOTFOUND');
      });

      await check('tools: path copies a file, and keeps its hidden lines hidden', async () => {
        fs.writeFileSync(path.join(projectDir, 'logo.png'), PNG);
        const png = await tool('save_artifact', { name: 'logo.png', path: 'logo.png' }, chat);
        assert.equal(png.result.artifact.kind, 'image');
        assert.deepEqual(artifacts.readBytes(projectDir, chat, 'logo.png').bytes, PNG, 'bytes survive');
        const picture = await tool('read_artifact', { name: 'logo.png' }, chat);
        assert.equal(picture.ok, true, picture.content);
        assert.equal(picture.result.content[0].data, PNG.toString('base64'), 'an image comes back as the picture');
        assert.ok(!picture.content.includes(PNG.toString('base64')), 'and not as text in the tool message');
        artifacts.save(projectDir, chat, 'blob.bin', Buffer.from([0, 1, 2, 0]));
        assert.equal((await tool('read_artifact', { name: 'blob.bin' }, chat)).result.code, 'EBINARY');
        artifacts.remove(projectDir, chat, 'blob.bin');
        assert.equal((await tool('save_artifact', { name: 'x.txt', path: '../outside' }, chat)).result.code, 'EOUTSIDE_PROJECT');
        fs.writeFileSync(path.join(projectDir, 'secret.txt'), 'public\nTOKEN=abc\n');
        settings.setProject(projectDir, { hideFileContent: [{ path: 'secret.txt', ranges: [{ start: 2, end: 2 }] }] });
        assert.ok(require('../src/hideFileContent.js').ruleForPath(projectDir, 'secret.txt'), 'the rule is in force');
        await tool('save_artifact', { name: 'secret-copy.txt', path: 'secret.txt' }, chat);
        const copy = await tool('read_artifact', { name: 'secret-copy.txt' }, chat);
        assert.ok(!copy.result.text.includes('TOKEN=abc'), 'a hidden line stays hidden in the copy');
        assert.ok(copy.result.text.includes('public'), 'the rest of the file is copied');
        if (mode === 'files') {
          // A rule can name a real file: the model sees the marker, the owner's editor
          // sees the file, so saving from the sheet cannot write [hidden] into it.
          artifacts.save(projectDir, chat, 'ruled.txt', 'public\nTOKEN=abc\n');
          settings.setProject(projectDir, { hideFileContent: [{ path: artifacts.get(projectDir, chat, 'ruled.txt').path, ranges: [{ start: 2, end: 2 }] }] });
          assert.ok(!(await tool('read_artifact', { name: 'ruled.txt' }, chat)).result.text.includes('TOKEN=abc'), 'the model does not see it');
          assert.ok(!artifacts.mentionMessages(projectDir, chat, '@artifact:ruled.txt')[0].content.includes('TOKEN=abc'), 'nor through a mention');
          assert.equal((await api('GET', '/ruled.txt?text=1', chat)).json.text, 'public\nTOKEN=abc\n', 'the editor gets the real file');
          artifacts.remove(projectDir, chat, 'ruled.txt');
        }
        settings.unsetProjectKeys(projectDir, ['hideFileContent']);
        await tool('delete_artifact', { name: 'secret-copy.txt' }, chat);
      });

      await check('export: a copy for a command, approved, and never over an existing file', async () => {
        const done = await tool('export_artifact', { name: 'logo.png', path: 'out/copy.png' }, chat);
        assert.equal(done.ok, true, done.content);
        assert.deepEqual(fs.readFileSync(path.join(projectDir, 'out/copy.png')), PNG, 'the folder is created and the bytes survive');
        assert.equal(done.result.bytes, PNG.length);
        assert.equal((await tool('export_artifact', { name: 'logo.png', path: 'out/copy.png' }, chat)).result.code, 'EEXIST', 'it never replaces a file');
        assert.equal((await tool('export_artifact', { name: 'logo.png', path: '../outside.png' }, chat)).result.code, 'EOUTSIDE_PROJECT');
        assert.equal(fs.existsSync(path.join(home, 'outside.png')), false);
        assert.equal((await tool('export_artifact', { name: 'none.png', path: 'x.png' }, chat)).result.code, 'ENOTFOUND');
        fs.rmSync(path.join(projectDir, 'out'), { recursive: true });
      });

      await check('file tools: artifact: paths read, list and search from any working folder', async () => {
        // The chat works in another folder, as a worktree does. The artifact stays the chat's.
        const working = path.join(projectDir, 'elsewhere');
        fs.mkdirSync(working);
        const file = (name, args, chatId = chat) => runFileTool(name, { projectDir: working, settingsProjectDir: projectDir, chatId, args });
        artifacts.save(projectDir, chat, 'lines.txt', 'one\ntwo needle\nthree');
        artifacts.save(projectDir, chat, 'blob.bin', Buffer.from([0, 1, 2, 0]));
        artifacts.save(projectDir, chat, 'other.md', 'needle again');

        const whole = await file('read_file', { path: 'artifact:lines.txt' });
        assert.equal(whole.ok, true, whole.content);
        assert.equal(whole.result.body, 'one\ntwo needle\nthree');
        assert.match(whole.content, /^# File: artifact:lines\.txt/);
        const slice = await file('read_file', { path: 'artifact:lines.txt', startLine: 2, endLine: 2 });
        assert.equal(slice.result.body, 'two needle');
        assert.equal(slice.result.totalLines, 3);
        const image = await file('read_file', { path: 'artifact:logo.png' });
        assert.equal(image.result.kind, 'image');
        assert.equal(image.result.content[0].data, PNG.toString('base64'));
        assert.equal(image.result.content[0].mimeType, 'image/png');
        const group = await file('group_read', { files: [{ path: 'artifact:lines.txt' }, { path: 'artifact:logo.png' }, { path: 'artifact:none.txt' }] });
        assert.deepEqual(group.result.results.map(entry => entry.ok), [true, true, false]);
        assert.equal(group.result.content.length, 1, 'the group carries the picture');

        assert.equal((await file('read_file', { path: 'artifact:blob.bin' })).result.error.code, 'EBINARY');
        assert.equal((await file('read_file', { path: 'artifact:lines.txt' }, other)).result.error.code, 'ENOTFOUND', 'another chat cannot read it');
        assert.equal((await runFileTool('read_file', { projectDir: working, args: { path: 'artifact:lines.txt' } })).result.error.code, 'EBADINPUT', 'it takes a chat');
        assert.equal((await file('read_file', { path: 'artifact:../secret' })).result.error.code, 'EBADINPUT', 'a name is never a path');

        const listed = await file('list_files', { pattern: 'artifact:*' });
        const paths = listed.result.entries.map(entry => entry.path);
        assert.ok(paths.includes('artifact:lines.txt') && paths.includes('artifact:logo.png'));
        assert.ok(!paths.includes('artifact:blob.bin'), 'what it cannot read is not listed');
        assert.equal(listed.result.entries.find(entry => entry.path === 'artifact:logo.png').image, true);
        assert.deepEqual((await file('list_files', { pattern: 'artifact:*.md' })).result.entries, [{ path: 'artifact:other.md' }]);

        const one = await file('search_files', { query: 'needle', path: 'artifact:lines.txt' });
        assert.deepEqual(one.result.matches.map(match => [match.path, match.line]), [['artifact:lines.txt', 2]]);
        const every = await file('search_files', { query: '(?i)needle', path: 'artifact:' });
        assert.deepEqual([...new Set(every.result.matches.map(match => match.path))].sort(), ['artifact:lines.txt', 'artifact:other.md'], 'all of them, skipping binaries');
        assert.deepEqual((await file('search_files', { query: 'needle', path: 'artifact:', include: '*.md' })).result.matches.map(match => match.path), ['artifact:other.md']);

        assert.equal((await file('write_file', { path: 'artifact:new.txt', content: 'x' })).result.error.code, 'EBADINPUT');
        assert.equal((await file('edit_file', { path: 'artifact:lines.txt', oldText: 'one', newText: 'uno' })).result.error.code, 'EBADINPUT');
        assert.ok(!fs.existsSync(path.join(working, 'artifact:new.txt')), 'no file named artifact:new.txt appears');
        assert.ok(artifacts.readText(projectDir, chat, 'lines.txt').text.startsWith('one'), 'the artifact did not change');

        if (mode === 'files') {
          // A rule can only name an artifact that is a real file, and it holds here too.
          artifacts.save(projectDir, chat, 'ruled.txt', 'public\nTOKEN=abc\n');
          settings.setProject(projectDir, { hideFileContent: [{ path: artifacts.get(projectDir, chat, 'ruled.txt').path, ranges: [{ start: 2, end: 2 }] }] });
          assert.ok(!(await file('read_file', { path: 'artifact:ruled.txt' })).result.body.includes('TOKEN=abc'), 'a whole read hides it');
          assert.ok(!(await file('read_file', { path: 'artifact:ruled.txt', startLine: 2, endLine: 2 })).result.body.includes('TOKEN=abc'), 'a slice hides it');
          assert.deepEqual((await file('search_files', { query: 'TOKEN', path: 'artifact:ruled.txt' })).result.matches, [], 'a search does not find it');
          settings.unsetProjectKeys(projectDir, ['hideFileContent']);
          artifacts.remove(projectDir, chat, 'ruled.txt');
        }
        for (const name of ['lines.txt', 'blob.bin', 'other.md']) artifacts.remove(projectDir, chat, name);
        fs.rmSync(working, { recursive: true });
      });

      await check('attach: an artifact image goes to a draft or a message', async () => {
        const target = chats.createChat(projectDir, { title: 'Attach' }).id;
        artifacts.save(projectDir, target, 'shot.png', PNG);
        artifacts.save(projectDir, target, 'words.txt', 'hello');
        const drafted = await tool('attach_chat_image', { path: 'artifact:shot.png' }, target);
        assert.equal(drafted.ok, true, drafted.content);
        const draft = chats.getChat(projectDir, target).draftAttachments;
        assert.equal(draft.length, 1);
        assert.equal(draft[0].name, 'shot.png');
        assert.ok(draft[0].dataUrl.endsWith(PNG.toString('base64')), 'the bytes survive');
        const sent = await tool('attach_chat_image', { path: 'artifact:shot.png', target: 'message', content: 'Look' }, target);
        assert.equal(sent.ok, true, sent.content);
        assert.equal(sent.result.attached.relPath, 'artifact:shot.png');
        const row = messages.listMessages(projectDir, target).find(item => item.role === 'user');
        assert.equal(row.attachments[0].name, 'shot.png');
        assert.equal((await tool('attach_chat_image', { path: 'artifact:words.txt' }, target)).result.code, 'ENOTIMAGE');
        assert.equal((await tool('attach_chat_image', { path: 'artifact:none.png' }, target)).result.code, 'ENOTFOUND');
      });

      if (mode === 'files') await check('storage: symlinks never expose a file, and a symlinked store is refused', async () => {
        const outside = path.join(home, 'outside.txt');
        fs.writeFileSync(outside, 'private');
        const dir = path.join(projectDir, '.mouaif/artifacts', chat);
        fs.symlinkSync(outside, path.join(dir, 'link.txt'));
        assert.ok(!artifacts.list(projectDir, chat).some(item => item.name === 'link.txt'), 'not listed');
        assert.equal((await tool('read_artifact', { name: 'link.txt' }, chat)).result.code, 'ENOTFOUND');
        fs.rmSync(path.join(dir, 'link.txt'));
        const escaped = chats.createChat(projectDir, { title: 'Escaped' }).id;
        fs.symlinkSync(home, path.join(projectDir, '.mouaif/artifacts', escaped));
        assert.throws(() => artifacts.list(projectDir, escaped), { code: 'EBADINPUT' });
        fs.rmSync(path.join(projectDir, '.mouaif/artifacts', escaped));
      });

      if (mode === 'files') await check('storage: a file a command writes to the folder is an artifact', () => {
        fs.writeFileSync(path.join(projectDir, '.mouaif/artifacts', chat, 'made-by-shell.txt'), 'hello');
        const found = artifacts.list(projectDir, chat).find(item => item.name === 'made-by-shell.txt');
        assert.equal(found.path, '.mouaif/artifacts/' + chat + '/made-by-shell.txt');
        assert.equal(artifacts.readText(projectDir, chat, 'made-by-shell.txt').text, 'hello');
        artifacts.remove(projectDir, chat, 'made-by-shell.txt');
      });

      await check('storage: limits hold', () => {
        assert.throws(() => artifacts.save(projectDir, chat, 'big.bin', Buffer.alloc(artifacts.MAX_ARTIFACT_BYTES + 1)), { code: 'ETOOLARGE' });
        assert.throws(() => artifacts.save(projectDir, chat, 'a.txt', 'x', { description: 'd'.repeat(501) }), { code: 'EBADINPUT' });
      });

      await check('mentions: text, image, too large, binary and missing each say what happened', () => {
        artifacts.save(projectDir, chat, 'data.csv', 'a,b\n1,2\n', { description: 'Sales' });
        artifacts.save(projectDir, chat, 'huge.txt', 'x'.repeat(300 * 1024));
        artifacts.save(projectDir, chat, 'blob.bin', Buffer.from([0, 1, 2, 3]));
        assert.deepEqual(artifacts.mentionedNames('see @artifact:data.csv, and (@artifact:no) mail@artifact:bad'), ['data.csv']);
        assert.deepEqual(artifacts.mentionMessages(projectDir, chat, 'no mention here @src/a.js'), []);
        const [text, image, huge, blob, missing] = artifacts.mentionMessages(projectDir, chat, '@artifact:data.csv @artifact:logo.png @artifact:huge.txt @artifact:blob.bin @artifact:nope.txt');
        assert.equal(text.role, 'user');
        assert.match(text.content, /# Artifact: data\.csv/);
        assert.match(text.content, /# Description: Sales/);
        assert.equal(text.content.includes('# Path: '), mode === 'files', 'a path only for a real file');
        assert.match(blob.content, mode === 'files' ? /Use its path/ : /Use export_artifact/);
        assert.match(text.content, /a,b\n1,2/);
        assert.equal(image.content[1].type, 'image_url');
        assert.match(image.content[1].image_url.url, /^data:image\/png;base64,/);
        assert.match(huge.content, /Not attached: larger than/);
        assert.match(blob.content, /Not attached: not text/);
        assert.match(missing.content, /no artifact with that name/);
        assert.deepEqual(tags.parseReferences(projectDir, '@artifact:data.csv'), [], 'a mention is not read as a project file');
        const big = 'y'.repeat(220 * 1000);
        artifacts.save(projectDir, chat, 'near-limit.txt', big);
        assert.ok(artifacts.mentionMessages(projectDir, chat, '@artifact:near-limit.txt')[0].content.endsWith(big), 'a file under the limit attaches whole');
        artifacts.remove(projectDir, chat, 'near-limit.txt');
        artifacts.remove(projectDir, chat, 'huge.txt');
      });

      await check('links: data is inlined safely in each form', () => {
        artifacts.save(projectDir, chat, 'rows.json', '{"html":"</script><b>"}');
        artifacts.save(projectDir, chat, 'risky.txt', 'a</script>b');
        artifacts.save(projectDir, chat, 'plain.csv', 'x,y');
        artifacts.save(projectDir, chat, 'lib.js', 'const s="</script>";');
        const html = artifacts.resolveLinks(projectDir, chat,
          '<script type="application/json" id="d" src="artifact:rows.json"></script>'
          + '<script type="text/plain" id="r" src="artifact:risky.txt"></script>'
          + "<script type='text/csv' src='artifact:plain.csv'></script>"
          + '<script src="artifact:lib.js"></script>'
          + '<img src="artifact:logo.png"><style>a{background:url(artifact:logo.png)}</style>');
        assert.ok(html.includes('<script type="application/json" id="d" data-artifact="rows.json">{"html":"\\u003c/script>\\u003cb>"}</script>'), html);
        assert.match(html, /type="text\/plain" id="r" data-artifact="risky.txt"><\/script><script>\(s=>/, 'risky text is decoded after parsing');
        assert.ok(html.includes(Buffer.from('a</script>b').toString('base64')));
        assert.ok(html.includes('data-artifact="plain.csv">x,y</script>'));
        assert.ok(html.includes('const s="<\\/script>";'));
        assert.match(html, /<img src="data:image\/png;base64,/);
        assert.match(html, /url\("data:image\/png;base64,/);
        assert.ok(!html.includes('artifact:'), 'no link is left behind');
        assert.throws(() => artifacts.resolveLinks(projectDir, chat, '<img src="artifact:gone.png">'), { code: 'EARTIFACT_MISSING' });
        assert.throws(() => artifacts.resolveLinks(projectDir, chat, '<script src="artifact:logo.png"></script>'), { code: 'EBADINPUT' });
        assert.throws(() => artifacts.resolveLinks(projectDir, other, '<img src="artifact:logo.png">'), { code: 'EARTIFACT_MISSING' }, 'links stay in their chat');
        assert.deepEqual(artifacts.listLinks('<script src="artifact:a.json"></script><img src=\'artifact:b.png\'>url(artifact:c.webp) "artifact:not-a-link"').sort(), ['a.json', 'b.png', 'c.webp']);
      });

      const appSource = '<!doctype html><html><head><title>Dash</title></head><body><script type="application/json" id="data" src="artifact:rows.json"></script></body></html>';
      let appPath;
      let callId;

      await check('apps: a new app is an artifact of the chat, and a wrong link is the tool\'s error', async () => {
        assert.equal((await tool('create_mcp_app', { name: 'Bad', filename: 'bad.html', source: '<img src="artifact:gone.png">' }, chat)).result.code, 'EARTIFACT_MISSING');
        assert.ok(!artifacts.list(projectDir, chat).some(item => item.name === 'bad.html'), 'nothing is written');
        const made = await tool('create_mcp_app', { name: 'Dash', filename: 'dash.html', source: appSource }, chat);
        assert.equal(made.ok, true, made.content);
        appPath = made.result.path;
        assert.equal(appPath, 'artifact:dash.html', 'the app is kept in the store');
        assert.deepEqual(made.result.links, ['rows.json']);
        assert.equal(artifacts.get(projectDir, chat, 'dash.html').app, true);
        const second = await tool('create_mcp_app', { name: 'Dash 2', filename: 'dash.html', source: appSource }, chat);
        assert.equal(second.result.path, 'artifact:dash-2.html', 'a second app does not replace the first');
        const shown = await tool('create_mcp_app', { path: 'artifact:dash.html', name: 'Dash' }, chat);
        assert.equal(shown.result.path, appPath, 'artifact:<name> shows it again');
        callId = 'call-dash';
        persistCall(chat, callId, { path: appPath }, made.result);
      });

      await check('apps: the mount carries the data, and its revision follows the artifact', async () => {
        const mounted = await appApi('mount', { projectDir, chatId: chat, callId });
        assert.equal(mounted.status, 200, JSON.stringify(mounted.body));
        assert.equal(mounted.body.enabled, true);
        assert.ok(mounted.body.html.includes('data-artifact="rows.json">{"html"'), 'data is inlined');
        assert.ok(mounted.body.html.includes('window.mouaifAppReady'), 'the bridge is still there');
        assert.ok(mounted.body.revision);
        const first = await appApi(mounted.body.id + '/status', {});
        assert.equal(first.body.revision, mounted.body.revision);
        const before = artifacts.revision(projectDir, chat, ['rows.json']);
        await tool('save_artifact', { name: 'rows.json', content: '{"v":2}' }, chat);
        assert.notEqual(artifacts.revision(projectDir, chat, ['rows.json']), before);
        const after = await appApi(mounted.body.id + '/status', {});
        assert.notEqual(after.body.revision, mounted.body.revision, 'the card learns the data changed');
        const remounted = await appApi('mount', { projectDir, chatId: chat, callId });
        assert.ok(remounted.body.html.includes('data-artifact="rows.json">{"v":2}'), 'a new mount has new data');
        assert.equal((await fetch(base + '/api/mcp/apps/' + remounted.body.id, { method: 'DELETE', body: '{}' })).status, 200);
        assert.equal((await fetch(base + '/api/mcp/apps/' + mounted.body.id, { method: 'DELETE', body: '{}' })).status, 200);
      });

      await check('apps: relink changes only the link, and only to a real artifact', async () => {
        await tool('save_artifact', { name: 'rows-q2.json', content: '{"q":2}' }, chat);
        const appText = () => artifacts.readText(projectDir, chat, appPath).text;
        const before = appText();
        const missing = await tool('create_mcp_app', { path: appPath, relink: { 'rows.json': 'nope.json' } }, chat);
        assert.equal(missing.result.code, 'EARTIFACT_MISSING');
        assert.equal(appText(), before, 'a refused relink writes nothing');
        const absent = await tool('create_mcp_app', { path: appPath, relink: { 'other.json': 'rows-q2.json' } }, chat);
        assert.match(absent.result.message, /It links: rows\.json/);
        const evil = await tool('create_mcp_app', { path: appPath, relink: { 'rows.json': 'x"></script><script>alert(1)//' } }, chat);
        assert.equal(evil.result.code, 'EBADINPUT', 'a target cannot carry code');
        const done = await tool('create_mcp_app', { path: appPath, relink: { 'rows.json': 'rows-q2.json' } }, chat);
        assert.equal(done.ok, true, done.content);
        assert.deepEqual(done.result.relinked, { 'rows.json': 'rows-q2.json' });
        assert.equal(done.result.updated, true);
        assert.equal(appText(), before.replace('artifact:rows.json', 'artifact:rows-q2.json'), 'only the link changed');
        assert.equal((await tool('create_mcp_app', { path: appPath, relink: { 'rows-q2.json': 'rows.json' }, source: appSource }, chat)).result.code, 'EBADINPUT');
        const mounted = await appApi('mount', { projectDir, chatId: chat, callId });
        assert.ok(mounted.body.html.includes('{"q":2}'), 'the app reads the new file');
        await fetch(base + '/api/mcp/apps/' + mounted.body.id, { method: 'DELETE', body: '{}' });
      });

      await check('apps: renaming data follows into the chat\'s apps; deleting it fails with a sentence', async () => {
        const renamed = await api('PATCH', '/rows-q2.json', chat, JSON.stringify({ name: 'sales 2.json' }), { 'Content-Type': 'application/json' });
        assert.equal(renamed.status, 200, renamed.text);
        assert.equal(renamed.json.artifact.name, 'sales-2.json');
        assert.ok(artifacts.readText(projectDir, chat, appPath).text.includes('artifact:sales-2.json'));
        assert.equal((await api('DELETE', '/sales-2.json', chat)).status, 200);
        const broken = await appApi('mount', { projectDir, chatId: chat, callId });
        assert.equal(broken.status, 409);
        assert.match(broken.body.error, /links artifact:sales-2\.json, which is not in this chat/);
        await tool('save_artifact', { name: 'sales-2.json', content: '{}' }, chat);
        artifacts.remove(projectDir, chat, appPath);
        const gone = await appApi('mount', { projectDir, chatId: chat, callId });
        assert.equal(gone.status, 404);
        assert.match(gone.body.error, /renamed or deleted/);
      });

      await check('HTTP: upload, list, edit, download and delete', async () => {
        const put = await api('PUT', '/' + encodeURIComponent('Mon fichier.txt') + '?description=Hello', chat, 'bonjour', { 'Content-Type': 'application/octet-stream' });
        assert.equal(put.status, 200, put.text);
        assert.equal(put.json.artifact.name, 'Mon-fichier.txt');
        assert.equal(put.json.artifact.createdBy, 'user');
        assert.equal(put.json.artifact.description, 'Hello');
        const list = await api('GET', '', chat);
        assert.ok(list.json.artifacts.some(item => item.name === 'Mon-fichier.txt'));
        const text = await api('GET', '/Mon-fichier.txt?text=1', chat);
        assert.equal(text.json.text, 'bonjour');
        assert.equal(text.json.nextOffset, undefined, 'the editor always gets the whole text');
        assert.equal((await api('GET', '/logo.png?text=1', chat)).status, 415);
        artifacts.save(projectDir, chat, 'long.txt', 'x'.repeat(300 * 1000));
        assert.equal((await api('GET', '/long.txt?text=1', chat)).json.text.length, 300 * 1000, 'longer than one model page');
        artifacts.save(projectDir, chat, 'huge.txt', 'x'.repeat(1024 * 1024 + 1));
        const huge = await api('GET', '/huge.txt?text=1', chat);
        assert.equal(huge.status, 413);
        assert.match(huge.json.error, /too large to open in the editor/);
        artifacts.remove(projectDir, chat, 'long.txt');
        artifacts.remove(projectDir, chat, 'huge.txt');
        const blank = await api('PUT', '/blank.md', chat, '', { 'Content-Type': 'application/octet-stream' });
        assert.equal(blank.status, 200, 'New text starts from an empty artifact');
        assert.equal(blank.json.artifact.kind, 'text');
        assert.equal((await api('GET', '/blank.md?text=1', chat)).json.text, '');
        artifacts.remove(projectDir, chat, 'blank.md');
        const described = await api('PATCH', '/Mon-fichier.txt', chat, JSON.stringify({ description: 'Bonjour' }), { 'Content-Type': 'application/json' });
        assert.equal(described.json.artifact.description, 'Bonjour');
        assert.equal((await api('GET', '/none.txt', chat)).status, 404);
        assert.equal((await api('PUT', '/' + encodeURIComponent('../evil.txt'), chat, 'x')).status, 400);
        assert.equal((await api('PATCH', '/Mon-fichier.txt', chat, JSON.stringify({ name: 'logo.png' }), { 'Content-Type': 'application/json' })).status, 409, 'a rename never overwrites');
        assert.equal((await api('DELETE', '/Mon-fichier.txt', chat)).status, 200);
        assert.equal((await api('GET', '', 'no-such-chat')).status, 404);
      });

      await check('HTTP: an upload stops at the limit', async () => {
        const large = await fetch(base + '/api/chats/' + chat + '/artifacts/large.bin?projectDir=' + encodeURIComponent(projectDir), {
          method: 'PUT', body: Buffer.alloc(artifacts.MAX_ARTIFACT_BYTES + 1) }).then(async r => ({ status: r.status, body: await r.json() }));
        assert.equal(large.status, 413, 'the reason reaches the user, not a dropped connection');
        assert.match(large.body.error, /at most 16 MiB/);
        assert.ok(!artifacts.list(projectDir, chat).some(item => item.name === 'large.bin'));
      });

      await check('HTTP: stored HTML cannot run on the app\'s origin', async () => {
        artifacts.save(projectDir, chat, 'page.html', '<script>alert(1)</script>');
        for (const route of ['/page.html', '/page.html?inline=1']) {
          const response = await api('GET', route, chat);
          assert.equal(response.headers.get('content-type'), 'application/octet-stream', route);
          assert.match(response.headers.get('content-disposition'), /^attachment/, route);
          assert.match(response.headers.get('content-security-policy'), /sandbox/, route);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff', route);
        }
        artifacts.save(projectDir, chat, 'vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        assert.match((await api('GET', '/vector.svg?inline=1', chat)).headers.get('content-disposition'), /^attachment/, 'an SVG can script, so it never draws inline');
        const image = await api('GET', '/logo.png?inline=1', chat);
        assert.equal(image.headers.get('content-type'), 'image/png');
        assert.match(image.headers.get('content-disposition'), /^inline/);
      });

      await check('HTTP: opening an artifact as an app writes the pair a card mounts', async () => {
        const opened = await api('POST', '/page.html/open', chat);
        assert.equal(opened.status, 200, opened.text);
        const rows = messages.listMessages(projectDir, chat).filter(row => row.name === 'create_mcp_app').slice(-2);
        assert.deepEqual(rows.map(row => row.phase), ['call', 'result']);
        assert.equal(rows[0].toolCallId, rows[1].toolCallId);
        assert.equal(JSON.parse(rows[1].content).path, 'artifact:page.html');
        const mounted = await appApi('mount', { projectDir, chatId: chat, callId: rows[0].toolCallId });
        assert.equal(mounted.body.enabled, true, JSON.stringify(mounted.body));
        await fetch(base + '/api/mcp/apps/' + mounted.body.id, { method: 'DELETE', body: '{}' });
        assert.equal((await api('POST', '/logo.png/open', chat)).status, 400, 'an image is not an app');
        artifacts.save(projectDir, chat, 'orphan.html', '<img src="artifact:gone.png">');
        const orphan = await api('POST', '/orphan.html/open', chat);
        assert.equal(orphan.status, 409, 'a missing link is a reason, not a server error');
        assert.match(orphan.json.error, /links artifact:gone\.png/);
        const { runningChats, runningKey } = require('../src/server-shared.js');
        const key = runningKey(projectDir, chat);
        runningChats.add(key);
        try { assert.equal((await api('POST', '/page.html/open', chat)).status, 409, 'not during a turn'); }
        finally { runningChats.delete(key); }
      });

      await check('a real turn: the model receives mentions, and uses the tools without new approvals', async () => {
        const seen = [];
        const script = [];
        const provider = http.createServer((req, res) => {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            seen.push(JSON.parse(raw));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const next = script.shift();
            const write = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
            if (next) {
              write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: next.id, function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] });
              write({ choices: [{ index: 0, finish_reason: 'tool_calls' }] });
            } else write({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] });
            res.end('data: [DONE]\n\n');
          });
        });
        await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
        try {
          settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + provider.address().port }] });
          settings.setProject(projectDir, { models: [{ id: 'mock', provider: 'openai-compatible' }], tools: { chats: { mode: 'allow' }, mouaif: { mode: 'allow' }, file: { mode: 'allow' } } });
          const turnChat = chats.createChat(projectDir, { title: 'Turn' }).id;
          chats.updateChat(projectDir, turnChat, { modelId: 'mock', providerId: 'openai-compatible' });
          artifacts.save(projectDir, turnChat, 'old.json', '{"v":1}');
          artifacts.save(projectDir, turnChat, 'pic.png', PNG);
          const app = artifacts.save(projectDir, turnChat, 'view.html', '<script type="application/json" src="artifact:old.json"></script>');
          // An app opened from the sheet, before the turn: its rows join the model's history.
          const opened = await api('POST', '/view.html/open', turnChat);
          assert.equal(opened.status, 200, opened.text);
          script.push({ id: 'turn-save', name: 'save_artifact', args: { name: 'new.json', content: '{"v":2}' } });
          script.push({ id: 'turn-export', name: 'export_artifact', args: { name: 'new.json', path: 'exported.json' } });
          script.push({ id: 'turn-relink', name: 'create_mcp_app', args: { path: 'artifact:view.html', relink: { 'old.json': 'new.json' } } });
          // The stream has to carry the chat as far as the file tools and image parts.
          script.push({ id: 'turn-read-file', name: 'read_file', args: { path: 'artifact:pic.png' } });
          script.push({ id: 'turn-read-text', name: 'read_file', args: { path: 'artifact:old.json' } });
          script.push({ id: 'turn-read-picture', name: 'read_artifact', args: { name: 'pic.png' } });
          // Answers the export's card, as the user would.
          const approved = [];
          const approver = setInterval(() => {
            for (const request of authz.listPending(projectDir, turnChat)) {
              approved.push(request.tool);
              authz.recordDecision(projectDir, turnChat, request.callId, 'allow-once');
            }
          }, 50);
          const response = await fetch(base + '/api/chats/' + turnChat + '/messages/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, chatId: turnChat, modelId: 'mock', providerId: 'openai-compatible', content: 'Compare @artifact:old.json with @artifact:pic.png please' }) });
          const output = await response.text();
          clearInterval(approver);
          assert.equal(response.status, 200, output.slice(0, 300));
          assert.ok(seen.length >= 7, 'six tool rounds and an answer: ' + seen.length);
          // A picture read by a tool reaches the model as an image, from either tool.
          const pictureIn = id => {
            const rounds = seen[seen.length - 1].messages;
            const index = rounds.findIndex(m => m.role === 'tool' && m.tool_call_id === id);
            assert.ok(index > 0, id + ' is in the history');
            return rounds.slice(index + 1).some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(part => part.type === 'image_url' && part.image_url.url.includes(PNG.toString('base64'))));
          };
          assert.ok(pictureIn('turn-read-file'), 'read_file gave the model the picture');
          assert.ok(pictureIn('turn-read-picture'), 'read_artifact gave the model the picture');
          assert.ok(seen[seen.length - 1].messages.find(m => m.tool_call_id === 'turn-read-text').content.includes('{"v":1}'), 'read_file gave the model the text');
          const first = seen[0].messages;
          const mention = first.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('# Artifact: old.json'));
          assert.ok(mention, 'the text artifact reached the model');
          assert.ok(mention.content.includes('{"v":1}'));
          assert.ok(first.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png'))), 'the image reached the model as an image');
          assert.ok(first.some(m => m.role === 'system' && String(m.content).includes('[artifacts] 3 in this chat')), 'the agent is told what the chat holds');
          const toolIndex = first.findIndex(m => m.role === 'tool');
          assert.ok(toolIndex > 0, 'the opened app is in the history');
          assert.ok(first[toolIndex - 1].role === 'assistant' && first[toolIndex - 1].tool_calls?.some(call => call.function.name === 'create_mcp_app' && call.id === first[toolIndex].tool_call_id), 'its result answers a call, which strict providers require');
          const names = seen[0].tools.map(item => item.function.name);
          for (const name of ['list_artifacts', 'read_artifact', 'save_artifact', 'delete_artifact', 'export_artifact']) assert.ok(names.includes(name), name + ' is offered');
          // Only the export writes to the project, and the family's Allow does not cover it.
          assert.deepEqual(approved, ['export_artifact'], 'allow means no card for data and links');
          assert.equal(artifacts.readText(projectDir, turnChat, 'new.json').text, '{"v":2}', 'the agent saved it');
          assert.ok(artifacts.readText(projectDir, turnChat, app.artifact.name).text.includes('artifact:new.json'), 'the agent relinked it');
          const results = messages.listMessages(projectDir, turnChat).filter(row => row.role === 'tool' && row.phase === 'result');
          assert.deepEqual(results.map(row => row.ok), [true, true, true, true, true, true, true], 'the opened app and all six tool calls are persisted as successes');
          assert.equal(fs.readFileSync(path.join(projectDir, 'exported.json'), 'utf8'), '{"v":2}', 'the approved export reached the project');
          fs.rmSync(path.join(projectDir, 'exported.json'));
        } finally {
          await new Promise(resolve => provider.close(resolve));
          settings.unsetProjectKeys(projectDir, ['tools', 'models']);
        }
      });

      await check('the agent is told what the chat holds', () => {
        const { buildFeatureSummary } = require('../src/agentFeatures.js');
        const summary = buildFeatureSummary({ chat: chats.getChat(projectDir, chat), projectDir, project: {}, authz: null, mcpServers: [] });
        assert.match(summary, /\[artifacts\] \d+ in this chat: .*logo\.png/);
        const none = buildFeatureSummary({ chat: chats.getChat(projectDir, other), projectDir, project: {}, authz: null, mcpServers: [] });
        assert.ok(!String(none || '').includes('[artifacts]'), 'nothing is said about an empty store');
      });

      await check('deleting a chat removes its artifacts, and only its own', async () => {
        artifacts.save(projectDir, other, 'keep.txt', 'k');
        const response = await fetch(base + '/api/chats/' + chat + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' });
        assert.equal(response.status, 200);
        assert.deepEqual(artifacts.list(projectDir, chat), []);
        const rowsFor = id => settings.getDb().prepare('SELECT COUNT(*) AS n FROM chat_artifact WHERE chat_id = ?').get(id).n;
        assert.equal(rowsFor(chat), 0, 'nothing is left in the DB');
        assert.equal(fs.existsSync(path.join(projectDir, '.mouaif/artifacts', chat)), false, 'nothing is left in the folder');
        assert.ok(artifacts.list(projectDir, other).some(item => item.name === 'keep.txt'));
        const toolChat = chats.createChat(projectDir, { title: 'Tool delete' }).id;
        artifacts.save(projectDir, toolChat, 'gone.txt', 'x');
        assert.equal((await tool('delete_chat', { chatId: toolChat, confirm: true }, other)).ok, true);
        assert.equal(rowsFor(toolChat), 0, 'the tool path cleans up too');
        assert.equal(fs.existsSync(path.join(projectDir, '.mouaif/artifacts', toolChat)), false);
        if (mode === 'db') assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false, 'a DB project\'s folder was never touched');
      });

    }

    mode = 'switch';
    const storageRoute = (dir, dbBacked) => fetch(base + '/api/settings/project/storage', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir, dbBacked }) });
    const rowCount = id => settings.getDb().prepare('SELECT COUNT(*) AS n FROM chat_artifact WHERE chat_id = ?').get(id).n;

    await check('flipping the project\'s storage switch moves its artifacts, both ways', async () => {
      projectDir = path.join(home, 'project-switch');
      fs.mkdirSync(projectDir);
      const id = chats.createChat(projectDir, { title: 'Switch' }).id;
      artifacts.save(projectDir, id, 'data.json', '{"a":1}', { description: 'Kept', createdBy: 'agent' });
      artifacts.save(projectDir, id, 'logo.png', PNG, { createdBy: 'user' });
      const before = artifacts.list(projectDir, id).map(item => [item.name, item.size, item.description, item.createdBy, item.createdAt, item.updatedAt]);
      assert.ok(fs.existsSync(path.join(projectDir, '.mouaif/artifacts', id, 'data.json')));

      assert.equal((await storageRoute(projectDir, true)).status, 200);
      assert.equal(settings.isDbBacked(projectDir), true);
      assert.equal(rowCount(id), 2, 'now rows');
      assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false, 'and the project folder is left clean');
      const same = () => artifacts.list(projectDir, id).map(item => [item.name, item.size, item.description, item.createdBy, item.createdAt, item.updatedAt]);
      assert.deepEqual(same(), before, 'nothing about them changed');
      assert.deepEqual(artifacts.readBytes(projectDir, id, 'logo.png').bytes, PNG);

      assert.equal((await storageRoute(projectDir, false)).status, 200);
      assert.equal(settings.isDbBacked(projectDir), false);
      assert.equal(rowCount(id), 0, 'back out of the DB');
      assert.ok(fs.existsSync(path.join(projectDir, '.mouaif/artifacts', id, 'data.json')), 'and back in the folder');
      assert.deepEqual(same(), before, 'still unchanged');
      assert.deepEqual(artifacts.readBytes(projectDir, id, 'logo.png').bytes, PNG);
    });

    await check('a move that fails changes nothing', async () => {
      projectDir = path.join(home, 'project-fails');
      fs.mkdirSync(projectDir);
      settings.setDbBacked(projectDir, true);
      const id = chats.createChat(projectDir, { title: 'Fails' }).id;
      artifacts.save(projectDir, id, 'data.json', '{"a":1}');
      fs.writeFileSync(path.join(projectDir, '.mouaif'), 'a file where the folder has to go');
      const refused = await storageRoute(projectDir, false);
      assert.equal(refused.status, 400);
      assert.equal(settings.isDbBacked(projectDir), true, 'the project stays on the DB');
      assert.equal(artifacts.readText(projectDir, id, 'data.json').text, '{"a":1}', 'with its artifact');
      fs.rmSync(path.join(projectDir, '.mouaif'));
    });

    await check('registering a project into the DB takes its old folder artifacts along', async () => {
      projectDir = path.join(home, 'project-register');
      fs.mkdirSync(projectDir);
      const id = chats.createChat(projectDir, { title: 'Register' }).id;
      artifacts.save(projectDir, id, 'data.json', '{"a":1}');
      const response = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', dir: projectDir, dbBacked: true }) });
      assert.equal(response.status, 200);
      assert.equal(rowCount(id), 1);
      assert.equal(fs.existsSync(path.join(projectDir, '.mouaif')), false);
    });

    await check('a symlinked path follows the project\'s configuration, through the app tools too', async () => {
      const real = path.join(home, 'project-real');
      fs.mkdirSync(real);
      projectDir = path.join(home, 'project-alias');
      fs.symlinkSync(real, projectDir);
      settings.setDbBacked(projectDir, true);
      const id = chats.createChat(projectDir, { title: 'Alias' }).id;
      artifacts.save(projectDir, id, 'rows.json', '[1]');
      const made = await tool('create_mcp_app', { name: 'Alias', filename: 'alias.html', source: '<script type="application/json" src="artifact:rows.json"></script>' }, id);
      assert.equal(made.ok, true, made.content);
      assert.equal(made.result.path, 'artifact:alias.html');
      assert.equal(rowCount(id), 2, 'the app is a row, although the tool resolves the symlink');
      assert.equal(fs.existsSync(path.join(real, '.mouaif')), false, 'and the project stays untouched');
      assert.throws(() => artifacts.list('relative/dir', id), { code: 'EBADINPUT' });
      assert.throws(() => artifacts.list(projectDir, '../other'), { code: 'EBADINPUT' });
    });

    console.log(passed + ' passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
