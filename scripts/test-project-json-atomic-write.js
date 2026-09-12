'use strict';

// Regression test for the project-file write contract.
//
// `writeProjectJson` used to be a bare fs.writeFileSync, so a crash, a full
// disk or a killed process mid-write left a truncated `<projectDir>/.mouaif.json`
// behind. That is not a cosmetic failure: readProjectJson() maps a corrupt file
// to MOUAIF_PROJECT_PARSE_ERROR, so the settings routes AND every chat route for
// that project answer 422 until the user repairs the file by hand.
//
// The write now stages a sibling temp file, fsyncs it, and renames it over the
// target. This pins: the on-disk format, the rename behaviour, and that a
// failed write leaves the previous file byte-identical with no staging file
// left behind.
//
// Run: node scripts/test-project-json-atomic-write.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-atomic-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-atomic-project-'));
const file = path.join(dir, '.mouaif.json');
const stagingFiles = () => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));

check('the file format is unchanged', () => {
  settings.writeProjectJson(file, { name: 'x', promptSize: 'extensive' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "name": "x",\n  "promptSize": "extensive"\n}\n');
});

check('no staging file survives a successful write', () => {
  settings.writeProjectJson(file, { name: 'x' });
  assert.deepEqual(stagingFiles(), []);
});

check('the write goes through a rename (new inode, same path)', () => {
  settings.writeProjectJson(file, { name: 'first' });
  const before = fs.statSync(file).ino;
  settings.writeProjectJson(file, { name: 'second' });
  const after = fs.statSync(file).ino;
  assert.notEqual(before, after, 'a rename replaces the file rather than truncating it');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'second');
});

check('the previous file survives a serialization failure', () => {
  settings.writeProjectJson(file, { name: 'keep-me' });
  const before = fs.readFileSync(file, 'utf8');
  const circular = { name: 'nope' };
  circular.self = circular;
  assert.throws(() => settings.writeProjectJson(file, circular), /circular|Converting/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'file untouched');
  assert.deepEqual(stagingFiles(), [], 'no staging file left behind');
});

check('the previous file survives a filesystem failure', () => {
  settings.writeProjectJson(file, { name: 'keep-me-too' });
  const before = fs.readFileSync(file, 'utf8');
  // A directory cannot be replaced by a rename of a regular file.
  const asDir = path.join(dir, 'blocked');
  fs.mkdirSync(asDir);
  fs.writeFileSync(path.join(asDir, 'inner'), 'x');
  assert.throws(() => settings.writeProjectJson(asDir, { name: 'clobber' }));
  assert.equal(fs.existsSync(path.join(asDir, 'inner')), true, 'the directory is untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no staging file left behind');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

check('a readable project is never observed half-written', () => {
  // Serialize a very large object; the read helper must always see a complete
  // parseable document, never a partial one.
  const big = { name: 'big', prompts: Array.from({ length: 4000 }, (_, i) => ({ id: 'p' + i })) };
  settings.writeProjectJson(file, big);
  const seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(seen.prompts.length, 4000);
  assert.equal(seen.prompts[3999].id, 'p3999');
});

check('setProject keeps using the atomic writer and the documented format', () => {
  settings.setProject(dir, { name: 'via-setProject' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('}\n'), 'trailing LF');
  assert.ok(raw.includes('\n  "'), '2-space indent');
  assert.equal(settings.getProject(dir).name, 'via-setProject');
  assert.deepEqual(stagingFiles(), []);
});

check('parent directories are still created, and the write is atomic in them', () => {
  const nested = path.join(dir, 'a', 'b');
  settings.writeProjectJson(path.join(nested, '.mouaif.messages.m1.json'), { messages: [] });
  assert.deepEqual(fs.readdirSync(nested), ['.mouaif.messages.m1.json']);
});

check('non-string paths are rejected before any filesystem work', () => {
  assert.throws(() => settings.writeProjectJson(null, {}), /non-empty string/);
  assert.throws(() => settings.writeProjectJson('', {}), /non-empty string/);
});

check('a corrupt file still surfaces MOUAIF_PROJECT_PARSE_ERROR', () => {
  fs.writeFileSync(file, '{"name": "truncated"');
  assert.throws(() => settings.getProject(dir), (e) => e.code === 'MOUAIF_PROJECT_PARSE_ERROR');
});

check('a corrupt file is reported, never silently overwritten', () => {
  const corrupt = '{"name": "truncated"';
  fs.writeFileSync(file, corrupt);
  // Saving over an unparseable file fails loudly: setProject() reads the
  // current file first, so the user's broken-but-present data is preserved for
  // them to repair rather than being replaced by the patch.
  assert.throws(() => settings.setProject(dir, { name: 'repaired' }), (e) => e.code === 'MOUAIF_PROJECT_PARSE_ERROR');
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the file is untouched');
  assert.deepEqual(stagingFiles(), [], 'no staging file left behind');
});

check('writing over a corrupt file directly is still atomic', () => {
  // The JSON editor's Save path rewrites the whole object, which is how a user
  // repairs a broken file.
  settings.writeProjectJson(file, { name: 'repaired' });
  assert.equal(settings.getProject(dir).name, 'repaired');
  assert.deepEqual(stagingFiles(), []);
});

settings.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
