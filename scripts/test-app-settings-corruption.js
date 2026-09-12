'use strict';

// Regression test for an unreadable app-level settings row.
//
// getAppRaw() used to swallow a JSON.parse failure and return {}. Verified
// damage: with `{oops` in the `app_kv` row the whole app store read as empty —
// every provider connection, registered project, prompt, pricing entry and the
// dictation choice disappeared from the UI, and the next `setApp()` persisted
// that emptiness over the only copy of the data.
//
// An unreadable value is now moved aside under `settings.corrupt-<ts>` before
// the live row is reset, so the caller still sees an empty store (reads must
// not throw: every route calls getApp()) but nothing is destroyed and the
// failure is reported on stderr.
//
// Run: node scripts/test-app-settings-corruption.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-corrupt-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const db = settings.getDb();

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

const liveRow = () => db.prepare("SELECT value FROM app_kv WHERE key = 'settings'").get();
const setRaw = (value) => db
  .prepare("INSERT INTO app_kv (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(value);

const silence = (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = original; }
};

check('a fresh store has no quarantined rows', () => {
  assert.deepEqual(settings.listQuarantinedAppSettings(), []);
});

check('valid settings are returned as stored', () => {
  settings.setApp({ promptSize: 'extensive', providers: [{ id: 'ollama', baseUrl: 'http://x' }] });
  assert.equal(settings.getApp().promptSize, 'extensive');
  assert.deepEqual(settings.listQuarantinedAppSettings(), [], 'nothing quarantined');
});

check('an unparseable blob is quarantined instead of vanishing', () => {
  settings.setApp({ promptSize: 'extensive', providers: [{ id: 'ollama', apiKey: 'sk-secret' }] });
  const stored = liveRow().value;
  const truncated = stored.slice(0, -1); // drop the closing brace: truncated mid-save
  setRaw(truncated);
  const app = silence(() => settings.getApp());
  assert.deepEqual(app, {}, 'reads still do not throw');
  const quarantined = settings.listQuarantinedAppSettings();
  assert.equal(quarantined.length, 1, 'exactly one quarantine row');
  assert.equal(quarantined[0].value, truncated, 'the stored bytes are preserved verbatim');
  assert.equal(quarantined[0].value.includes('sk-secret'), true, 'including the data that was at risk');
  assert.match(quarantined[0].key, /^settings\.corrupt-/);
  assert.equal(liveRow(), undefined, 'the unreadable live row is gone');
});

check('reading again does not quarantine a second time', () => {
  assert.deepEqual(settings.getApp(), {});
  assert.equal(settings.listQuarantinedAppSettings().length, 1);
});

check('a later write starts a clean row and keeps the quarantine', () => {
  const app = settings.setApp({ promptSize: 'very-small' });
  assert.equal(app.promptSize, 'very-small');
  assert.equal(settings.getApp().promptSize, 'very-small');
  assert.equal(settings.listQuarantinedAppSettings().length, 1, 'quarantine survives the next save');
});

check('non-object JSON is treated as corrupt too', () => {
  for (const bad of ['null', '[]', '"a string"', '42']) {
    setRaw(bad);
    const before = settings.listQuarantinedAppSettings().length;
    assert.deepEqual(silence(() => settings.getApp()), {}, bad + ' reads as empty');
    const after = settings.listQuarantinedAppSettings();
    assert.equal(after.length, before + 1, bad + ' was quarantined');
    // Ordering is by key (timestamp), and two corruptions inside the same
    // millisecond tie-break on a random suffix, so assert membership.
    assert.ok(after.some((row) => row.value === bad), bad + ' preserved');
  }
});

check('two corruptions never overwrite the same quarantine key', () => {
  setRaw('{first');
  silence(() => settings.getApp());
  setRaw('{second');
  silence(() => settings.getApp());
  const values = settings.listQuarantinedAppSettings().map((r) => r.value);
  assert.equal(values.includes('{first'), true);
  assert.equal(values.includes('{second'), true);
  assert.equal(new Set(settings.listQuarantinedAppSettings().map((r) => r.key)).size, settings.listQuarantinedAppSettings().length);
});

check('an empty store (no row at all) is not a corruption', () => {
  db.prepare("DELETE FROM app_kv WHERE key = 'settings'").run();
  const before = settings.listQuarantinedAppSettings().length;
  assert.deepEqual(settings.getApp(), {});
  assert.equal(settings.listQuarantinedAppSettings().length, before, 'no new quarantine row');
});

check('setAppReplace and the resettable-keys path still work', () => {
  settings.setAppReplace({ promptSize: 'average' });
  assert.equal(settings.getApp().promptSize, 'average');
  settings.setAppReplace({});
  assert.deepEqual(settings.getApp(), {});
});

settings.close();
fs.rmSync(home, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
