'use strict';

// The `mcp` document (src/content/stores/project-mcp.js): `.mcp.json` for a
// file-mode project, a `project_documents` row for a DB-mode project without
// that file, the legacy `.mouaif.json` mcp block as a fallback, and the app
// block inside the app settings. mcp.js (servers) and tools/authorization.js
// (the authorization block) both go through it.
//
// Run: node scripts/test-content-mcp-store.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcpstore-home-'));
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const stores = require(path.join(ROOT, 'src/content/stores/index.js'));
const mcp = require(path.join(ROOT, 'src/mcp.js'));
const authorization = require(path.join(ROOT, 'src/tools/authorization.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

function newProject(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcpstore-' + tag + '-'));
}
const mcpFile = (dir) => path.join(dir, '.mcp.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const server = (name) => ({ name, command: process.execPath, args: ['srv.js'] });
const names = (dir) => mcp.listServers(dir).filter((s) => s.scope === 'project').map((s) => s.name);
const dbRow = (dir) => settings.getDb()
  .prepare("SELECT value FROM project_documents WHERE project_dir = ? AND doc = 'mcp'").get(dir);

// ---- File mode -----------------------------------------------------------

check('a file-mode project writes .mcp.json atomically', () => {
  const proj = newProject('file');
  mcp.addServer(proj, server('One'));
  const store = stores.storeFor('mcp', 'project', proj);
  assert.equal(store.kind, 'project-mcp-file');
  assert.equal(store.location, mcpFile(proj));
  assert.equal(store.source(), 'file');
  assert.deepStrictEqual(readJson(mcpFile(proj)).servers.map((s) => s.name), ['One']);
  assert.ok(fs.readFileSync(mcpFile(proj), 'utf8').endsWith('}\n'), 'trailing LF');
  assert.deepStrictEqual(fs.readdirSync(proj).filter((n) => n.includes('.tmp-')), [], 'no staging file left');
});

check('the legacy .mouaif.json mcp block is read when there is no .mcp.json', () => {
  const proj = newProject('legacy');
  settings.setProject(proj, { mcp: { servers: [{ id: 'old', name: 'Legacy', command: 'x' }] } });
  assert.equal(stores.storeFor('mcp', 'project', proj).source(), 'legacy');
  assert.deepStrictEqual(names(proj), ['Legacy']);
  mcp.addServer(proj, server('New'));
  assert.deepStrictEqual(readJson(mcpFile(proj)).servers.map((s) => s.name), ['Legacy', 'New']);
});

check('a hand edit of .mcp.json is seen on the next read', () => {
  const proj = newProject('edit');
  mcp.addServer(proj, server('Before'));
  assert.deepStrictEqual(names(proj), ['Before']);
  const doc = readJson(mcpFile(proj));
  doc.servers[0].name = 'After!';
  fs.writeFileSync(mcpFile(proj), JSON.stringify(doc, null, 2) + '\n');
  assert.deepStrictEqual(names(proj), ['After!']);
});

check('a corrupt .mcp.json is a parse error (422), not an empty list', () => {
  const proj = newProject('corrupt');
  fs.writeFileSync(mcpFile(proj), '{ nope');
  assert.throws(() => stores.storeFor('mcp', 'project', proj).read(), (e) => e.code === 'MOUAIF_PROJECT_PARSE_ERROR');
  assert.throws(() => mcp.listServers(proj), (e) => e.code === 'MOUAIF_PROJECT_PARSE_ERROR');
});

// ---- DB mode -------------------------------------------------------------

check('a DB-mode project adds a server without creating any file', () => {
  const proj = newProject('db');
  settings.setDbBacked(proj, true);
  const before = fs.readdirSync(proj);
  const added = mcp.addServer(proj, server('Db Server'));
  assert.deepStrictEqual(fs.readdirSync(proj), before, 'working tree untouched');
  const store = stores.storeFor('mcp', 'project', proj);
  assert.equal(store.kind, 'project-mcp-db');
  assert.equal(store.source(), 'db');
  assert.match(store.location, /^project_documents:/);
  assert.deepStrictEqual(names(proj), ['Db Server']);
  mcp.updateServer(proj, added.id, { name: 'Renamed' });
  mcp.addServer(proj, server('Second'));
  assert.deepStrictEqual(names(proj), ['Renamed', 'Second']);
  assert.equal(mcp.removeServer(proj, added.id), true);
  assert.deepStrictEqual(names(proj), ['Second']);
  assert.deepStrictEqual(fs.readdirSync(proj), before, 'still untouched');
  assert.ok(dbRow(proj), 'the row exists');
});

check('MCP authorization in a DB-mode project lands in the row and is read back', () => {
  const proj = newProject('dbauth');
  settings.setDbBacked(proj, true);
  const srv = mcp.addServer(proj, server('Gate'));
  const before = fs.readdirSync(proj);
  authorization.setAuthorization(proj, { mcp: { mode: 'allow', servers: { [srv.slug]: { mode: 'off' } } } });
  assert.deepStrictEqual(fs.readdirSync(proj), before, 'no .mcp.json');
  const row = JSON.parse(dbRow(proj).value);
  assert.equal(row.authorization.mode, 'allow');
  assert.deepStrictEqual(row.servers.map((s) => s.name), ['Gate'], 'servers kept beside the block');
  const view = authorization.getAuthorization(proj);
  assert.equal(view.mcp.mode, 'allow');
  assert.equal(view.mcp.servers[srv.slug].mode, 'off');
  // mcp.js reads the same block: the server is gated off.
  assert.equal(mcp.listServers(proj)[0].enabled, false);
});

check('a DB-mode project with an existing .mcp.json keeps reading and writing it', () => {
  const proj = newProject('dbfile');
  fs.writeFileSync(mcpFile(proj), JSON.stringify({ servers: [{ id: 'mine', name: 'Mine', command: 'x' }], other: 1 }, null, 2) + '\n');
  settings.setDbBacked(proj, true);
  assert.equal(stores.storeFor('mcp', 'project', proj).source(), 'file');
  assert.deepStrictEqual(names(proj), ['Mine']);
  mcp.addServer(proj, server('Added'));
  const doc = readJson(mcpFile(proj));
  assert.deepStrictEqual(doc.servers.map((s) => s.name), ['Mine', 'Added']);
  assert.equal(doc.other, 1, 'unknown keys kept');
  assert.equal(dbRow(proj), undefined, 'no row written');
});

check('switching a DB-mode project back to files moves the row to .mcp.json', () => {
  const proj = newProject('switch');
  settings.setDbBacked(proj, true);
  mcp.addServer(proj, server('Moves'));
  assert.equal(fs.existsSync(mcpFile(proj)), false);
  settings.setDbBacked(proj, false);
  assert.deepStrictEqual(readJson(mcpFile(proj)).servers.map((s) => s.name), ['Moves']);
  assert.equal(dbRow(proj), undefined, 'row cleared');
  assert.deepStrictEqual(names(proj), ['Moves']);
  // And back to DB: the file stays and is still the one read.
  settings.setDbBacked(proj, true);
  assert.ok(fs.existsSync(mcpFile(proj)));
  assert.equal(dbRow(proj), undefined);
  assert.deepStrictEqual(names(proj), ['Moves']);
});

check('switching to files keeps a row the user\'s own .mcp.json shadows', () => {
  const proj = newProject('shadow');
  settings.setDbBacked(proj, true);
  mcp.addServer(proj, server('In Row'));
  fs.writeFileSync(mcpFile(proj), JSON.stringify({ servers: [{ id: 'f', name: 'In File', command: 'x' }] }) + '\n');
  settings.setDbBacked(proj, false);
  assert.deepStrictEqual(names(proj), ['In File']);
  assert.ok(dbRow(proj), 'the shadowed row is not deleted');
});

check('the legacy block is the fallback in DB mode too', () => {
  const proj = newProject('dblegacy');
  settings.setProject(proj, { mcp: { servers: [{ id: 'old', name: 'Old', command: 'x' }] } });
  settings.setDbBacked(proj, true);
  assert.equal(stores.storeFor('mcp', 'project', proj).source(), 'legacy');
  assert.deepStrictEqual(names(proj), ['Old']);
  mcp.addServer(proj, server('New'));
  assert.equal(fs.existsSync(mcpFile(proj)), false);
  assert.deepStrictEqual(JSON.parse(dbRow(proj).value).servers.map((s) => s.name), ['Old', 'New']);
});

// ---- App scope -----------------------------------------------------------

check('app scope reads and writes the mcp block of the app settings', () => {
  settings.setApp({ promptSize: 'chat', mcp: { authorization: { mode: 'ask' } } });
  const store = stores.storeFor('mcp', 'app');
  assert.equal(store.kind, 'app-mcp');
  assert.deepStrictEqual(store.read(), { authorization: { mode: 'ask' } });
  mcp.addServer(null, Object.assign(server('App One'), { scope: 'app' }));
  const app = settings.getApp();
  assert.equal(app.promptSize, 'chat', 'other app keys kept');
  assert.deepStrictEqual(app.mcp.authorization, { mode: 'ask' }, 'authorization kept');
  assert.deepStrictEqual(app.mcp.servers.map((s) => s.name), ['App One']);
});

check('a read hands out a copy', () => {
  const proj = newProject('copy');
  mcp.addServer(proj, server('Kept'));
  const store = stores.storeFor('mcp', 'project', proj);
  store.read().servers.length = 0;
  assert.equal(store.read().servers.length, 1);
});

check('a .mcp.json that is not an object reads as an empty document', () => {
  const proj = newProject('non-object');
  for (const body of ['null', '[]', '"x"', '42']) {
    fs.writeFileSync(path.join(proj, '.mcp.json'), body);
    require('../src/content/stores/cache.js').clear();
    assert.deepStrictEqual(stores.storeFor('mcp', 'project', proj).read(), {}, body);
    assert.deepStrictEqual(mcp.listServers(proj).filter((s) => s.scope === 'project'), [], body);
  }
  mcp.addServer(proj, server('After'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8')).servers.map((s) => s.name), ['After']);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
