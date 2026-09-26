'use strict';

// Regression test for the one-shot migration that drops the retired
// auto-seeded "Chat" prompt from app settings.
//
// An earlier commit seeded a built-in prompt (id `chat`, empty content, an
// exclusive empty-tool preset) into app settings and set a `promptsSeeded`
// flag so a deleted default would not come back. That behaviour was reverted,
// but any store that ran the seeding code still lists a prompt the current
// code never creates. The migration removes it, without touching:
//   - a `chat` prompt the user actually gave content to,
//   - every other saved prompt,
//   - unrelated app settings.
//
// Run: node scripts/test-seeded-chat-prompt-migration.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chatseed-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');

// ---- seed a pre-fix database before the module opens it -------------------
const dbPath = path.join(home, 'store.sqlite');
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.exec(`CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
seed.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, run_at TEXT NOT NULL);`);
const seededPrompt = {
  id: 'chat',
  title: 'Chat',
  icon: 'chat',
  showOnProjectCard: false,
  content: '',
  role: 'system',
  preset: { tools: [], exclusive: true },
  createdAt: '2026-09-25T18:22:35.554Z',
  updatedAt: '2026-09-25T18:22:35.554Z'
};
const keptPrompt = {
  id: 'reviewer',
  title: 'Reviewer',
  icon: 'bug',
  content: 'You review code.',
  role: 'system'
};
seed.prepare('INSERT INTO app_kv (key, value) VALUES (?, ?)')
  .run('settings', JSON.stringify({
    projects: [{ id: 'p1', path: '/tmp/p1', name: 'p1' }],
    promptsSeeded: true,
    prompts: [seededPrompt, keptPrompt],
    promptSize: 'extensive'
  }));
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

check('migration removes the seeded chat prompt and the flag', () => {
  settings.runMigrations();
  const app = settings.getApp();
  assert.equal(
    Object.prototype.hasOwnProperty.call(app, 'promptsSeeded'),
    false,
    'promptsSeeded flag is gone'
  );
  assert.deepEqual(
    app.prompts.map((p) => p.id),
    ['reviewer'],
    'only the user-authored prompt survives'
  );
});

check('unrelated app settings are preserved', () => {
  const app = settings.getApp();
  assert.equal(app.promptSize, 'extensive');
  assert.equal(Array.isArray(app.projects) && app.projects.length, 1);
});

check('the seeded prompt no longer reaches the picker', () => {
  const prompts = require(path.join(ROOT, 'src/prompts.js'));
  const ids = prompts.listPrompts('').map((p) => p.id);
  assert.deepEqual(ids, ['reviewer']);
});

check('migration is recorded and runs only once', () => {
  settings.runMigrations();
  const names = settings.getDb().prepare('SELECT name FROM _migrations').all().map((r) => r.name);
  assert.equal(names.includes('2026-09-26-drop-seeded-chat-prompt'), true);
  assert.equal(settings.getApp().prompts.length, 1, 'a second run does not duplicate prompts');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail > 0 ? 1 : 0);
