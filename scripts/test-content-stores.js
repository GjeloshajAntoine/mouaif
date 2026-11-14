'use strict';

// Content document stores (src/content/stores/): storeFor() picks the adapter
// for a document, scope and project mode; setProjectMode() moves a project's
// documents between its file and the app DB.
//
// Run: node scripts/test-content-stores.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-stores-home-'));
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const stores = require(path.join(ROOT, 'src/content/stores/index.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-stores-project-'));
const file = path.join(proj, '.mouaif.json');
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));

check('app scope uses the app_kv row', () => {
  const store = stores.storeFor('settings', 'app');
  assert.equal(store.kind, 'app-db');
  assert.equal(store.location, 'app_kv:settings');
  store.write({ promptSize: 'chat' });
  assert.deepStrictEqual(settings.getApp(), { promptSize: 'chat' });
  settings.setApp({ autoRetry: false });
  assert.deepStrictEqual(store.read(), { promptSize: 'chat', autoRetry: false });
});

check('a file-mode project uses .mouaif.json and writes it atomically', () => {
  const store = stores.storeFor('settings', 'project', proj);
  assert.equal(store.kind, 'project-file');
  assert.equal(store.location, file);
  settings.setProject(proj, { name: 'Demo', promptSize: 'extensive' });
  assert.deepStrictEqual(readFile(), { name: 'Demo', promptSize: 'extensive' });
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('}\n'), 'trailing LF');
  assert.deepStrictEqual(fs.readdirSync(proj).filter((n) => n.includes('.tmp-')), [], 'no staging file left');
});

check('the folder layout is discovered on every call', () => {
  const folderProj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-stores-folder-'));
  fs.mkdirSync(path.join(folderProj, '.mouaif'));
  fs.writeFileSync(path.join(folderProj, '.mouaif', '.mouaif.json'), '{"name":"F"}\n');
  const store = stores.storeFor('settings', 'project', folderProj);
  assert.equal(store.location, path.join(folderProj, '.mouaif', '.mouaif.json'));
  settings.setProject(folderProj, { promptSize: 'chat' });
  assert.equal(fs.existsSync(path.join(folderProj, '.mouaif.json')), false, 'root file not created');
  assert.deepStrictEqual(settings.getProject(folderProj), { name: 'F', promptSize: 'chat' });
});

check('switching to DB copies the file and leaves it in place', () => {
  stores.setProjectMode(proj, true);
  assert.equal(stores.projectMode(proj), 'db');
  assert.equal(stores.storeFor('settings', 'project', proj).kind, 'project-db');
  assert.deepStrictEqual(settings.getProject(proj), { name: 'Demo', promptSize: 'extensive', __dbBacked: true });
  assert.deepStrictEqual(readFile(), { name: 'Demo', promptSize: 'extensive' }, 'file untouched');
});

check('a DB-mode write never touches the file', () => {
  const before = fs.statSync(file).mtimeMs;
  settings.setProject(proj, { promptSize: 'chat' });
  settings.unsetProjectKeys(proj, ['name']);
  assert.deepStrictEqual(settings.getProject(proj), { promptSize: 'chat', __dbBacked: true });
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.deepStrictEqual(readFile(), { name: 'Demo', promptSize: 'extensive' });
});

check('asking for the current mode changes nothing', () => {
  stores.setProjectMode(proj, true);
  assert.deepStrictEqual(settings.getProject(proj), { promptSize: 'chat', __dbBacked: true }, 'DB edits not re-seeded from the file');
});

check('switching back writes the DB copy to the file and clears the row', () => {
  stores.setProjectMode(path.join(proj, 'sub', '..') + '/', false);
  assert.equal(stores.projectMode(proj), 'file');
  assert.deepStrictEqual(readFile(), { promptSize: 'chat' }, 'marker not written to the file');
  assert.equal(settings.getDb().prepare('SELECT COUNT(*) AS n FROM project_settings').get().n, 0);
});

check('round trip keeps every key', () => {
  settings.setProject(proj, { agents: [{ name: 'a', content: 'x' }], tags: { 'a.js': { tags: ['t'] } } });
  const before = settings.getProject(proj);
  settings.setDbBacked(proj, true);
  settings.setDbBacked(proj, false);
  assert.deepStrictEqual(settings.getProject(proj), before);
});

check('an unknown document or scope is refused', () => {
  assert.throws(() => stores.storeFor('nope', 'app'), /unknown content document/);
  assert.throws(() => stores.storeFor('settings', 'chat', proj), /scope/);
  assert.throws(() => stores.storeFor('settings', 'project', ''), /projectDir/);
});

// ---- Read cache (src/content/stores/cache.js) ----------------------------

const { execFileSync } = require('node:child_process');
const cache = require(path.join(ROOT, 'src/content/stores/cache.js'));

check('a read hands out a copy, never the cached object', () => {
  settings.setProject(proj, { agents: [{ name: 'a' }] });
  const first = settings.getProject(proj);
  first.agents.push({ name: 'mutated' });
  first.promptSize = 'mutated';
  assert.deepStrictEqual(settings.getProject(proj).agents, [{ name: 'a' }]);
  assert.notEqual(settings.getProject(proj).promptSize, 'mutated');
  const app = settings.getApp();
  app.promptSize = 'mutated';
  assert.notEqual(settings.getApp().promptSize, 'mutated');
});

check('a hand edit of the same size is seen on the next read', () => {
  fs.writeFileSync(file, JSON.stringify({ promptSize: 'aaaa' }));
  assert.equal(settings.getProject(proj).promptSize, 'aaaa');
  fs.writeFileSync(file, JSON.stringify({ promptSize: 'bbbb' }));
  assert.equal(settings.getProject(proj).promptSize, 'bbbb', 'same size, same clock tick');
});

check('an old file is trusted on its stamp and re-read when it changes', () => {
  fs.writeFileSync(file, JSON.stringify({ promptSize: 'old' }));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  assert.equal(settings.getProject(proj).promptSize, 'old');
  // A same-size in-place edit that keeps the old mtime would be invisible;
  // any real edit moves the mtime, which is what the stamp checks.
  fs.writeFileSync(file, JSON.stringify({ promptSize: 'new' }));
  assert.equal(settings.getProject(proj).promptSize, 'new');
});

check('a corrupt hand edit is reported, not served from the cache', () => {
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => settings.getProject(proj), (e) => e.code === 'MOUAIF_PROJECT_PARSE_ERROR');
  fs.writeFileSync(file, '{}\n');
  assert.deepStrictEqual(settings.getProject(proj), {});
});

const child = (code) => execFileSync(process.execPath, ['-e', code], {
  env: { ...process.env, MOUAIF_HOME: process.env.MOUAIF_HOME }, stdio: 'pipe'
});

check('a write from a second process is seen: DB row', () => {
  settings.setApp({ promptSize: 'chat' });
  assert.equal(settings.getApp().promptSize, 'chat');
  child(`const D=require(${JSON.stringify(require.resolve('better-sqlite3', { paths: [ROOT] }))});
    const d=new D(${JSON.stringify(path.join(process.env.MOUAIF_HOME, 'store.sqlite'))});
    const v=JSON.parse(d.prepare("SELECT value FROM app_kv WHERE key='settings'").get().value);
    v.promptSize='extensive';
    d.prepare("UPDATE app_kv SET value=? WHERE key='settings'").run(JSON.stringify(v));`);
  assert.equal(settings.getApp().promptSize, 'extensive');
});

check('a write from a second process is seen: project file', () => {
  settings.setProject(proj, { promptSize: 'chat' });
  assert.equal(settings.getProject(proj).promptSize, 'chat');
  child(`const s=require(${JSON.stringify(path.join(ROOT, 'src/settings.js'))});
    s.setProject(${JSON.stringify(proj)}, { promptSize: 'full' });`);
  assert.equal(settings.getProject(proj).promptSize, 'full');
});

check('a direct SQL write on the shared handle is seen', () => {
  settings.setDbBacked(proj, true);
  assert.equal(settings.getProject(proj).promptSize, 'full');
  settings.getDb().prepare('UPDATE project_settings SET value = ? WHERE project_dir = ?')
    .run(JSON.stringify({ promptSize: 'sql', __dbBacked: true }), proj);
  assert.equal(settings.getProject(proj).promptSize, 'sql');
  settings.setDbBacked(proj, false);
});

check('cached reads are faster than parsing (timing, informative)', () => {
  const big = {};
  for (let i = 0; i < 60; i++) big['key' + i] = { value: 'x'.repeat(40), list: [1, 2, 3] };
  settings.setProject(proj, big);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  settings.getProject(proj);
  const n = 2000;
  let t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) settings.getProject(proj);
  const cached = Number(process.hrtime.bigint() - t) / n / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { cache.clear(); settings.getProject(proj); }
  const uncached = Number(process.hrtime.bigint() - t) / n / 1000;
  console.log('       project file read: cached ' + cached.toFixed(1) + ' µs, uncached ' + uncached.toFixed(1) + ' µs');
  settings.setDbBacked(proj, true);
  settings.getProject(proj);
  t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) settings.getProject(proj);
  const dbCached = Number(process.hrtime.bigint() - t) / n / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { cache.clear(); settings.getProject(proj); }
  const dbUncached = Number(process.hrtime.bigint() - t) / n / 1000;
  console.log('       project DB read:   cached ' + dbCached.toFixed(1) + ' µs, uncached ' + dbUncached.toFixed(1) + ' µs');
  settings.setDbBacked(proj, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
