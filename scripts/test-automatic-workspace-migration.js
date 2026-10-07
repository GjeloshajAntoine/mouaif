'use strict';

// Regression test for the one-shot migration that drops the retired
// `autoWorkspace` setting.
//
// `change_working_folder` used to create a default `.mouaif/workspaces/<chatId>`
// folder behind an opt-in switch stored as `autoWorkspace` at app and project
// level. The tool now only selects an existing directory, and the key was
// removed from DEFAULTS and CLIENT_SETTINGS_KEYS — but a value written before
// that still sits in the store looking like a setting that matters. The
// migration removes it from:
//   - the app row,
//   - every registered project,
//   - every project-scoped row (project_settings, chat_store),
// without touching any other key.
//
// Run: node scripts/test-automatic-workspace-migration.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-autows-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');

// A project on disk with the stale key plus a real setting beside it.
const diskProject = path.join(home, 'disk-project');
fs.mkdirSync(diskProject, { recursive: true });
fs.writeFileSync(path.join(diskProject, '.mouaif.json'), JSON.stringify({
  autoWorkspace: true,
  promptSize: 'extensive'
}, null, 2) + '\n', 'utf8');

// A project whose file we cannot read must be left alone, not rewritten.
const brokenProject = path.join(home, 'broken-project');
fs.mkdirSync(brokenProject, { recursive: true });
fs.writeFileSync(path.join(brokenProject, '.mouaif.json'), '{ not json', 'utf8');

// ---- seed a pre-fix database before the module opens it -------------------
//
// Every earlier migration is pre-recorded as already run. They are not what
// this test covers, and one of them (persist-project-total-cost) parses every
// registered project file, so the unreadable-project fixture below would make
// it throw before this migration ever ran. Recording them keeps the test on
// the one migration it is about.
const PRIOR_MIGRATIONS = [
  '2025-07-17-persist-project-total-cost',
  '2026-07-23-drop-unused-client-domains',
  '2026-07-27-add-thinking-level',
  '2026-07-28-add-max-output-tokens',
  '2026-08-16-add-draft-attachments',
  '2026-08-26-persist-chat-cost-totals',
  '2026-09-12-canonicalize-project-keys',
  '2026-09-26-drop-seeded-chat-prompt',
  '2026-09-27-snapshot-chat-prompts',
  '2026-10-01-separate-native-app-tools'
];
const dbPath = path.join(home, 'store.sqlite');
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.exec('CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
seed.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, run_at TEXT NOT NULL);');
seed.prepare('INSERT INTO app_kv (key, value) VALUES (?, ?)')
  .run('settings', JSON.stringify({
    projects: [
      { id: 'p1', path: diskProject, name: 'disk' },
      { id: 'p2', path: brokenProject, name: 'broken' }
    ],
    autoWorkspace: true,
    promptSize: 'average'
  }));
const markRan = seed.prepare('INSERT OR IGNORE INTO _migrations (name, run_at) VALUES (?, ?)');
for (const name of PRIOR_MIGRATIONS) markRan.run(name, '2026-10-06T00:00:00.000Z');
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

check('the migration is registered and runs', () => {
  settings.runMigrations();
  const names = settings.getDb().prepare('SELECT name FROM _migrations').all().map((r) => r.name);
  assert.equal(names.includes('2026-10-07-drop-automatic-workspaces'), true);
});

check('the app-level key is gone and its neighbours survive', () => {
  const app = settings.getApp();
  assert.equal(Object.prototype.hasOwnProperty.call(app, 'autoWorkspace'), false);
  assert.equal(app.promptSize, 'average', 'an unrelated app default is untouched');
  assert.equal(Array.isArray(app.projects) && app.projects.length, 2);
});

check('a project file is cleaned without losing other keys', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(diskProject, '.mouaif.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'autoWorkspace'), false);
  assert.equal(raw.promptSize, 'extensive');
});

check('an unreadable project file is left exactly as it was', () => {
  assert.equal(fs.readFileSync(path.join(brokenProject, '.mouaif.json'), 'utf8'), '{ not json');
});

check('the retired key no longer resolves, at either level', () => {
  const resolved = settings.getResolved(diskProject);
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'autoWorkspace'), false);
  assert.equal(settings.getProject(diskProject).autoWorkspace, undefined);
});

check('a second run changes nothing', () => {
  const before = fs.readFileSync(path.join(diskProject, '.mouaif.json'), 'utf8');
  settings.runMigrations();
  assert.equal(fs.readFileSync(path.join(diskProject, '.mouaif.json'), 'utf8'), before);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail > 0 ? 1 : 0);
