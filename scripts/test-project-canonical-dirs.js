'use strict';

// Regression test for canonical project-directory keys in the app store.
//
// Every project-scoped table (project_settings, mcp_tool_cache, model_recent)
// used the caller's raw string as its key, so `/tmp/demo`, `/tmp/demo/` and
// `/tmp/demo/../demo` were three different projects. The visible bug: a project
// registered with a trailing slash was opted into DB-backed settings under a
// key no other code path reads, so it kept silently using `.mouaif.json`.
//
// Also covers the one-shot migration that folds pre-existing non-canonical
// rows onto their canonical key without losing data.
//
// Run: node scripts/test-project-canonical-dirs.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-canon-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');

// ---- seed a pre-fix database before the module opens it -------------------
// Written by hand (not through settings.js) so it holds the non-canonical
// keys the old code produced.
const dbPath = path.join(home, 'store.sqlite');
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.exec(`CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
seed.exec(`CREATE TABLE IF NOT EXISTS project_settings (project_dir TEXT PRIMARY KEY, value TEXT NOT NULL);`);
seed.exec(`CREATE TABLE IF NOT EXISTS mcp_tool_cache (
  project_dir TEXT NOT NULL, server_id TEXT NOT NULL, tools TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (project_dir, server_id));`);
seed.exec(`CREATE TABLE IF NOT EXISTS model_recent (
  project_dir TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (project_dir, provider, model_id));`);
seed.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, run_at TEXT NOT NULL);`);
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-canon-project-'));
seed.prepare('INSERT INTO project_settings (project_dir, value) VALUES (?, ?)')
  .run(proj + '/', JSON.stringify({ promptSize: 'extensive' }));
seed.prepare('INSERT INTO project_settings (project_dir, value) VALUES (?, ?)')
  .run(path.join(proj, 'sub', '..'), JSON.stringify({ promptSize: 'extensive', __dbBacked: true }));
seed.prepare('INSERT INTO mcp_tool_cache (project_dir, server_id, tools, updated_at) VALUES (?, ?, ?, ?)')
  .run(proj + '/', 'chrome-debug', JSON.stringify([{ name: 'old' }]), '2026-01-01T00:00:00.000Z');
seed.prepare('INSERT INTO mcp_tool_cache (project_dir, server_id, tools, updated_at) VALUES (?, ?, ?, ?)')
  .run(proj, 'chrome-debug', JSON.stringify([{ name: 'new' }]), '2026-09-01T00:00:00.000Z');
seed.prepare('INSERT INTO model_recent (project_dir, provider, model_id, ts) VALUES (?, ?, ?, ?)')
  .run(proj + '/', 'ollama', 'llama3', 100);
seed.prepare('INSERT INTO model_recent (project_dir, provider, model_id, ts) VALUES (?, ?, ?, ?)')
  .run(proj, 'ollama', 'llama3', 200);
seed.close();

const settings = require(path.join(ROOT, 'src/settings.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

check('canonicalProjectDir resolves, or refuses non-absolute input', () => {
  assert.equal(settings.canonicalProjectDir('/tmp/a/'), '/tmp/a');
  assert.equal(settings.canonicalProjectDir('/tmp/a/../a'), '/tmp/a');
  assert.equal(settings.canonicalProjectDir('tmp/a'), null);
  assert.equal(settings.canonicalProjectDir(''), null);
  assert.equal(settings.canonicalProjectDir(null), null);
});

check('migration folds every non-canonical row onto one key', () => {
  settings.runMigrations();
  const projRows = settings.getDb().prepare('SELECT project_dir, value FROM project_settings').all();
  assert.equal(projRows.length, 1, 'project_settings has one row, got ' + JSON.stringify(projRows));
  assert.equal(projRows[0].project_dir, proj);
  assert.equal(JSON.parse(projRows[0].value).promptSize, 'extensive', 'value preserved');
  assert.equal(JSON.parse(projRows[0].value).__dbBacked, true, 'the opted-in row wins');

  const cacheRows = settings.getDb().prepare('SELECT project_dir, tools FROM mcp_tool_cache').all();
  assert.equal(cacheRows.length, 1, 'mcp_tool_cache has one row');
  assert.equal(cacheRows[0].project_dir, proj);
  assert.deepEqual(JSON.parse(cacheRows[0].tools), [{ name: 'new' }], 'newest cache wins');

  const recentRows = settings.getDb().prepare('SELECT project_dir, ts FROM model_recent').all();
  assert.equal(recentRows.length, 1, 'model_recent has one row');
  assert.equal(recentRows[0].project_dir, proj);
  assert.equal(recentRows[0].ts, 200, 'newest timestamp wins');
});

check('migration is recorded and runs only once', () => {
  settings.runMigrations();
  const names = settings.getDb().prepare('SELECT name FROM _migrations').all().map((r) => r.name);
  assert.equal(names.includes('2026-09-12-canonicalize-project-keys'), true);
  assert.equal(
    settings.getDb().prepare('SELECT COUNT(*) AS n FROM project_settings').get().n,
    1,
    'a second run does not duplicate rows'
  );
});

check('DB-backed reads answer for every spelling of the directory', () => {
  for (const spelling of [proj, proj + '/', path.join(proj, 'sub', '..')]) {
    assert.equal(settings.isDbBacked(spelling), true, 'isDbBacked(' + spelling + ')');
    assert.equal(settings.getProject(spelling).promptSize, 'extensive');
  }
});

check('DB-backed writes land under the canonical key', () => {
  settings.setProject(proj + '/', { promptSize: 'very-small' });
  const keys = settings.getDb().prepare('SELECT project_dir FROM project_settings').all().map((r) => r.project_dir);
  assert.deepEqual(keys, [proj]);
  assert.equal(settings.getProject(proj).promptSize, 'very-small');
});

check('a trailing-slash opt-in no longer silently misses its own row', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-canon-other-'));
  fs.writeFileSync(path.join(other, '.mouaif.json'), JSON.stringify({ name: 'file-backed' }, null, 2) + '\n');
  settings.setDbBacked(other + '/', true);
  assert.equal(settings.isDbBacked(other), true, 'the file-backed project actually switched');
  assert.equal(settings.getProject(other).name, 'file-backed', 'seed content copied from the file');
  const rows = settings.getDb().prepare('SELECT project_dir FROM project_settings WHERE project_dir = ?').all(other);
  assert.equal(rows.length, 1);
});

check('mcp tool cache + recent models share the canonical key', () => {
  settings.setMcpToolCache(proj + '/', 'chrome-debug', [{ name: 'again' }]);
  assert.deepEqual(settings.getMcpToolCache(proj, 'chrome-debug'), [{ name: 'again' }]);
  settings.touchRecentModel(proj + '/', 'ollama', 'qwen', 1);
  const recent = settings.getRecentModels(proj).map((r) => r.id);
  assert.equal(recent.includes('qwen'), true);
});

check('writes reject a relative projectDir instead of storing junk', () => {
  assert.throws(() => settings.setDbProject('relative/dir', {}), /absolute path/);
  assert.throws(() => settings.touchRecentModel('relative/dir', 'ollama', 'x'), /absolute path/);
  assert.throws(() => settings.setMcpToolCache('relative/dir', 's', []), /absolute path/);
  assert.equal(settings.isDbBacked('relative/dir'), false);
  assert.deepEqual(settings.getRecentModels('relative/dir'), []);
});

settings.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
