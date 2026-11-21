'use strict';

// Unit tests for shared projects (docs/features/share-project.md): stream
// framing and flow control, first-time codes, the route allowlist, the project
// filter, and the files-only tool gate. No network, no second process.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-share-unit-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const mux = require('../src/share-mux.js');
const store = require('../src/share-store.js');
const gate = require('../src/share-gate.js');
const settings = require('../src/settings.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok   - ' + name);
}

// Two muxes wired back to back, with frames delivered asynchronously like a
// socket would.
function pair() {
  let a; let b;
  a = new mux.Mux({ dialer: true, send: (buf) => setImmediate(() => b.handleFrame(buf)) });
  b = new mux.Mux({ dialer: false, send: (buf) => setImmediate(() => a.handleFrame(buf)) });
  return { a, b };
}

async function main() {
  await test('frames round-trip with type, id and payload', () => {
    const f = mux.encodeFrame(mux.T.REQ, 7, { k: 'http', path: '/x' });
    const d = mux.decodeFrame(f);
    assert.equal(d.type, mux.T.REQ);
    assert.equal(d.id, 7);
    assert.deepEqual(JSON.parse(d.payload.toString()), { k: 'http', path: '/x' });
    const data = mux.decodeFrame(mux.encodeFrame(mux.T.DATA, 0xfffffff1, Buffer.from([1, 2, 3])));
    assert.equal(data.id, 0xfffffff1);
    assert.deepEqual([...data.payload], [1, 2, 3]);
    assert.throws(() => mux.decodeFrame(Buffer.from([9, 0, 0, 0, 1])), { code: 'EFRAME' });
    assert.throws(() => mux.decodeFrame(Buffer.from([1, 0])), { code: 'EFRAME' });
  });

  await test('a stream carries head, body and end both ways; ids do not collide', async () => {
    const { a, b } = pair();
    const got = new Promise((resolve) => {
      b.on('stream', (s) => {
        const parts = [];
        s.on('data', (c) => { parts.push(c); s.ack(c.length); });
        s.on('end', () => {
          s.respond({ status: 200 });
          s.write(Buffer.from('pong:' + Buffer.concat(parts).toString()));
          s.end();
          resolve(s.head);
        });
      });
    });
    const s = a.open({ k: 'http', path: '/ping' });
    assert.equal(s.id % 2, 1, 'dialer opens odd ids');
    s.write(Buffer.from('he'));
    s.write(Buffer.from('llo'));
    s.end();
    const head = await got;
    assert.equal(head.path, '/ping');
    const res = await new Promise((resolve) => {
      let status; const parts = [];
      s.on('head', (h) => { status = h.status; });
      s.on('data', (c) => parts.push(c));
      s.on('end', () => resolve({ status, body: Buffer.concat(parts).toString() }));
    });
    assert.deepEqual(res, { status: 200, body: 'pong:hello' });
    const s2 = b.open({ k: 'borrow' });
    assert.equal(s2.id % 2, 0, 'acceptor opens even ids');
  });

  await test('flow control: a sender stops at the window and resumes on credit', async () => {
    const { a, b } = pair();
    let receiver;
    let received = 0;
    b.on('stream', (s) => { receiver = s; s.on('data', (c) => { received += c.length; }); });
    const s = a.open({ k: 'http' });
    const big = Buffer.alloc(mux.WINDOW_BYTES + 10);
    assert.equal(s.write(big), false, 'out of credit after one window');
    await new Promise((r) => setTimeout(r, 20));
    let drained = false;
    s.on('drain', () => { drained = true; });
    assert.equal(received, big.length);
    assert.equal(drained, false, 'no credit until the receiver acknowledges');
    receiver.ack(received);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(drained, true);
  });

  await test('abort reaches the other side; a closed mux aborts every stream', async () => {
    const { a, b } = pair();
    let remote;
    b.on('stream', (s) => { remote = s; });
    const s = a.open({ k: 'http' });
    await new Promise((r) => setTimeout(r, 10));
    const reason = new Promise((resolve) => remote.on('abort', (why, local) => resolve({ why, local })));
    s.abort('client disconnected');
    assert.deepEqual(await reason, { why: 'client disconnected', local: false });
    const s3 = a.open({ k: 'http' });
    const closed = new Promise((resolve) => s3.on('abort', resolve));
    a.close('socket gone');
    assert.equal(await closed, 'socket gone');
    assert.throws(() => a.open({}), { code: 'ESHARE_OFFLINE' });
  });

  await test('identity keys sign and verify; addresses normalize', () => {
    const me = store.identity();
    assert.equal(store.identity().publicKey, me.publicKey, 'one stable key pair');
    const sig = store.sign('hello');
    assert.equal(store.verify(me.publicKey, 'hello', sig), true);
    assert.equal(store.verify(me.publicKey, 'hellO', sig), false);
    assert.equal(store.verify('garbage', 'hello', sig), false);
    assert.equal(store.normalizeAddress('mouaif.example.com'), 'https://mouaif.example.com');
    assert.equal(store.normalizeAddress('192.168.1.5:5732'), 'http://192.168.1.5:5732');
    assert.equal(store.normalizeAddress('http://localhost:5733/'), 'http://localhost:5733');
    assert.throws(() => store.normalizeAddress('https://x.example/path'), { code: 'EBADADDRESS' });
    assert.throws(() => store.normalizeAddress('ftp://x.example'), { code: 'EBADADDRESS' });
    assert.equal(store.wsUrlFor('https://x.example'), 'wss://x.example/api/share');
  });

  await test('first-time code: single use, wrong answers counted, locked after five', () => {
    const peer = store.outgoingPeerFor('https://other.example');
    const { code } = store.issueCode(peer.id);
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(store.consumeCode(peer.id, 'AAAA-AAAA'), 'wrong');
    assert.equal(store.consumeCode(peer.id, code.toLowerCase().replace('-', '')), 'ok', 'case and dash do not matter');
    assert.equal(store.consumeCode(peer.id, code), 'missing', 'single use');
    const second = store.issueCode(peer.id);
    for (let i = 0; i < store.MAX_CODE_ATTEMPTS - 1; i++) assert.equal(store.consumeCode(peer.id, 'BBBB-BBBB'), 'wrong');
    assert.equal(store.consumeCode(peer.id, 'BBBB-BBBB'), 'locked');
    assert.equal(store.consumeCode(peer.id, second.code), 'missing', 'a locked code is gone');
    const third = store.issueCode(peer.id, -1);
    assert.equal(store.consumeCode(peer.id, third.code), 'expired');
  });

  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'a.txt'), 'a');
  fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(projectDir, 'escape'));
  const files = { projectDir, access: 'files' };
  const full = { projectDir, access: 'full' };
  const check = (share, method, urlPath, query, body) => gate.checkRequest({ share, method, urlPath, query, body, hooks: { cliSessionDir: (id) => (id === 'mine' ? projectDir : '/elsewhere') } });

  await test('allowlist: project routes pass, app/provider/access/restart routes do not', () => {
    check(files, 'GET', '/api/chats', { projectDir });
    check(files, 'POST', '/api/chats/abc/stream', {}, { projectDir, modelId: 'm' });
    check(files, 'PUT', '/api/settings/project', {}, { projectDir, patch: {} });
    check(files, 'GET', '/api/git/info', { projectDir });
    for (const [method, url] of [['GET', '/api/settings'], ['PUT', '/api/settings/app'], ['POST', '/api/settings/app/providers'],
      ['GET', '/api/auth/accounts'], ['POST', '/api/restart'], ['GET', '/api/access/status'], ['GET', '/api/projects'],
      ['GET', '/api/projects/registered'], ['POST', '/api/inspector/open'], ['GET', '/api/ai/models/live'], ['GET', '/api/share/state'],
      ['GET', '/s/x/api/chats'], ['GET', '/api/push/config'], ['GET', '/data']]) {
      assert.throws(() => check(full, method, url, { projectDir }, { projectDir }), { code: 'ESHARE_ROUTE' }, method + ' ' + url);
    }
    assert.throws(() => check(full, 'GET', '/api/prompts', { projectDir, scope: 'app' }), { code: 'ESHARE_ROUTE' });
  });

  await test('project filter: the request must name the shared project, and paths stay inside it', () => {
    assert.throws(() => check(files, 'GET', '/api/chats', {}), { code: 'ESHARE_PROJECT' });
    assert.throws(() => check(files, 'GET', '/api/chats', { projectDir: path.join(tmp, 'other') }), { code: 'ESHARE_PROJECT' });
    assert.throws(() => check(files, 'POST', '/api/chats', { projectDir }, { projectDir: '/' }), { code: 'ESHARE_PROJECT' });
    check(files, 'GET', '/api/file', { projectDir, path: 'src/a.txt' });
    check(files, 'GET', '/api/file', { projectDir, path: path.join(projectDir, 'src/new.txt') });
    assert.throws(() => check(files, 'GET', '/api/file', { projectDir, path: '../outside/x' }), { code: 'ESHARE_PATH' });
    assert.throws(() => check(files, 'GET', '/api/file', { projectDir, path: '/etc/passwd' }), { code: 'ESHARE_PATH' });
    assert.throws(() => check(files, 'GET', '/api/files', { projectDir, dir: 'escape' }), { code: 'ESHARE_PATH' }, 'a symlink out of the project');
    assert.throws(() => check(files, 'PUT', '/api/file', {}, { projectDir, path: '../../x', content: '' }), { code: 'ESHARE_PATH' });
    check(full, 'GET', '/api/tools/cli/output', { id: 'mine' });
    assert.throws(() => check(full, 'GET', '/api/tools/cli/output', { id: 'theirs' }), { code: 'ESHARE_PROJECT' });
  });

  await test('files only: shell, terminal, commands and git writes are refused', () => {
    for (const [method, url] of [['POST', '/api/tools/shell'], ['GET', '/api/tools/cli/session'], ['POST', '/api/git'],
      ['POST', '/api/actions/run'], ['POST', '/api/mcp/servers/x/start'], ['POST', '/api/chats/c1/hooks']]) {
      assert.throws(() => check(files, method, url, { projectDir }, { projectDir }), { code: 'ESHARE_FILES_ONLY' }, method + ' ' + url);
      check(full, method, url, { projectDir }, { projectDir });
    }
    check(files, 'GET', '/api/mcp/servers', { projectDir });
    // The event stream is open to a files-only caller; its terminal output
    // is filtered out per frame (src/http-server.js).
    check(files, 'GET', '/events', { projectDir });
  });

  await test('tool gate: per caller, not per project', async () => {
    assert.equal(gate.toolDenied('shell', {}), null, 'a local request is not limited');
    await gate.runAsCaller({ projectDir, access: 'files' }, async () => {
      await Promise.resolve();
      assert.match(gate.toolDenied('shell', {}), /files only/);
      assert.match(gate.toolDenied('group_cli', {}), /files only/);
      assert.match(gate.toolDenied('mcp__srv__run', {}), /files only/);
      assert.match(gate.toolDenied('schedule_wake', {}), /files only/);
      assert.equal(gate.toolDenied('read_file', { path: 'a' }), null);
      assert.equal(gate.toolDenied('subagent', {}), null);
      assert.match(gate.toolDenied('restart_app', {}), /not available/);
      assert.match(gate.toolDenied('list_projects', {}), /not available/);
      assert.match(gate.toolDenied('update_settings', { scope: 'app' }), /App settings/);
      assert.equal(gate.toolDenied('update_settings', { scope: 'project' }), null);
      assert.match(gate.toolDenied('change_working_folder', { directory: '/tmp' }), /inside/);
      assert.equal(gate.toolDenied('change_working_folder', { directory: 'src' }), null);
    });
    await gate.runAsCaller({ projectDir, access: 'full' }, async () => {
      assert.equal(gate.toolDenied('shell', {}), null);
      assert.equal(gate.toolDenied('mcp__srv__run', {}), null);
      assert.match(gate.toolDenied('restart_app', {}), /not available/);
    });
    // The authorization gate refuses before any project setting is read.
    const authz = require('../src/tools/authorization.js');
    await gate.runAsCaller({ projectDir, access: 'files' }, async () => {
      await assert.rejects(authz.authorize({ projectDir, chatId: 'c', tool: 'shell', callId: 'x', args: { cmd: 'ls' } }), { code: 'ETOOL_DISABLED' });
    });
  });

  await test('Tools panel data: refused tools are not listed and read as off, per caller', async () => {
    const catalog = [
      { name: 'shell', kind: 'native' }, { name: 'group_cli', kind: 'native' }, { name: 'webpreview', kind: 'native' },
      { name: 'read_file', kind: 'native' }, { name: 'subagent', kind: 'native' }, { name: 'restart_app', kind: 'native' },
      { name: 'mcp__srv__run', kind: 'mcp', source: 'srv' }
    ];
    const view = { tools: { shell: { enabled: true, mode: 'ask' }, file: { enabled: true, mode: 'ask' }, restart_app: { enabled: true, mode: 'allow' } },
      mcp: { enabled: true, mode: 'ask', servers: {}, tools: {} } };
    const names = (list) => list.map((t) => t.name);
    // Used directly on this machine: nothing changes.
    assert.equal(gate.filterToolList(catalog), catalog);
    assert.equal(gate.maskAuthorization(view), view);
    await gate.runAsCaller({ projectDir, access: 'files' }, async () => {
      assert.deepEqual(names(gate.filterToolList(catalog)), ['read_file', 'subagent']);
      const masked = gate.maskAuthorization(view);
      assert.deepEqual(masked.tools.shell, { enabled: false, mode: 'off', share: 'denied' });
      assert.equal(masked.tools.restart_app.mode, 'off');
      assert.deepEqual(masked.tools.file, { enabled: true, mode: 'ask' });
      assert.equal(masked.mcp.mode, 'off');
      assert.equal(view.tools.shell.mode, 'ask', 'the stored view is not changed');
      assert.equal(gate.mcpHidden(), true);
    });
    await gate.runAsCaller({ projectDir, access: 'full' }, async () => {
      assert.deepEqual(names(gate.filterToolList(catalog)), ['shell', 'group_cli', 'webpreview', 'read_file', 'subagent', 'mcp__srv__run']);
      const masked = gate.maskAuthorization(view);
      assert.equal(masked.tools.shell.mode, 'ask');
      assert.equal(masked.tools.restart_app.mode, 'off');
      assert.equal(masked.mcp.mode, 'ask');
      assert.equal(gate.mcpHidden(), false);
    });
  });

  console.log('share unit tests: ' + passed + ' passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  try { settings.close(); } catch { /* closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});
