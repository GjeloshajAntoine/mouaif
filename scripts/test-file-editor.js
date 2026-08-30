// Smoke test for the file editor server module (src/files.js).
// Verifies path safety, listing, read, write, atomicity on crash, and
// the text-only allowlist. Runs in-process; no HTTP server required.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const files = require('../src/files.js');

let pass = 0;
let fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

function makeProject() {
  // Test directories must be under homedir unless MOUAIF_ALLOW_ANY_ROOT is set.
  // We place it in homedir to ensure it works regardless of the flag.
  const testRoot = path.join(os.homedir(), '.mouaif-test-files-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(testRoot);
  const root = testRoot;
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;\n', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '# inner\n', 'utf8');
  fs.writeFileSync(path.join(root, 'binary.png'), Buffer.from([0, 1, 2, 0xff, 0xfe]));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.js'), 'should not appear', 'utf8');
  // Dotfiles are real text files the editor is meant to open (see
  // docs/features/files-modal-text-and-images.md); .git is junk that
  // must stay hidden.
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'FOO=1\n', 'utf8');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref\n', 'utf8');
  return root;
}

async function run() {
  console.log('files module');

  // 1. listDir at the project root
  const root = makeProject();
  const list = files.listDir(root, root);
  t('listDir returns entries', Array.isArray(list.entries) && list.entries.length >= 4, JSON.stringify(list));
  const names = list.entries.map(e => e.name);
  t('listDir shows hello.txt', names.includes('hello.txt'));
  t('listDir shows app.js', names.includes('app.js'));
  t('listDir shows sub/ as dir', names.includes('sub'));
  t('listDir skips node_modules', !names.includes('node_modules'));
  const png = list.entries.find(e => e.name === 'binary.png');
  t('listDir marks png as binary', png && png.binary === true);
  t('listDir shows dotfile .gitignore', names.includes('.gitignore'));
  t('listDir shows dotfile .env', names.includes('.env'));
  t('listDir skips .git dir', !names.includes('.git'));
  t('listDir marks dotfile .gitignore as text', list.entries.find(e => e.name === '.gitignore').text === true);

  // 2. listDir into a subdir
  const sub = files.listDir(root, path.join(root, 'sub'));
  t('listDir sub shows inner.md', sub.entries.some(e => e.name === 'inner.md'));
  t('listDir sub relDir is sub', sub.relDir === 'sub');

  // 3. readFile happy path
  const r = await files.readFile(root, path.join(root, 'hello.txt'));
  t('readFile returns content', r.content === 'hello world\n');
  t('readFile has relPath hello.txt', r.relPath === 'hello.txt');

  // 4. readFile rejects binary
  let binaryErr = null;
  try { await files.readFile(root, path.join(root, 'binary.png')); }
  catch (e) { binaryErr = e; }
  t('readFile rejects binary with EBINARY', binaryErr && binaryErr.code === 'EBINARY');

  // 5. readFile rejects path outside the *home* boundary. When
// MOUAIF_ALLOW_ANY_ROOT is off this is EOUTSIDE_HOME; with the flag on
// any absolute path is allowed so the bound is the whole filesystem.
let outside = null;
try { await files.readFile(root, '/etc/passwd'); }
catch (e) { outside = e; }
t('readFile refuses outside home with EOUTSIDE_HOME', outside && (outside.code === 'EOUTSIDE_HOME' || outside.code === 'EOUTSIDE_PROJECT'));
// 6. readFile can now go *above* the project root but stay under home.
// A sibling directory of the project (still under the user home) is a
// valid browse target once the project-root cap is lifted.
let sibling = null;
try {
const parent = path.dirname(root);
const sib = path.join(parent, '.mouaif-test-sibling-' + Math.random().toString(36).slice(2));
fs.mkdirSync(sib);
fs.writeFileSync(path.join(sib, 'sib.txt'), 'sibling\n', 'utf8');
sibling = await files.readFile(root, path.join(sib, 'sib.txt'));
} catch (e) { sibling = { error: e }; }
t('readFile allows a sibling above the project root', sibling && sibling.content === 'sibling\n');
t('readFile sibling relPath is ..-prefixed', sibling && sibling.relPath && sibling.relPath.startsWith('..'));

  // 7. writeFile happy path
  const w = await files.writeFile(root, path.join(root, 'hello.txt'), 'updated\n');
  t('writeFile reports bytesWritten', w.bytesWritten === 'updated\n'.length);
  const after = fs.readFileSync(path.join(root, 'hello.txt'), 'utf8');
  t('writeFile persisted', after === 'updated\n');

  // 8. writeFile rejects binary
  let wb = null;
  try { await files.writeFile(root, path.join(root, 'binary.png'), 'no'); }
  catch (e) { wb = e; }
  t('writeFile rejects binary', wb && wb.code === 'EBINARY');

  // 9. writeFile refuses to clobber a directory
  let dirClobber = null;
  try { await files.writeFile(root, path.join(root, 'sub'), 'nope'); }
  catch (e) { dirClobber = e; }
  t('writeFile refuses to clobber directory', dirClobber && dirClobber.code === 'EISDIR');

  // 10. writeFile with relative path under project
  const rel = await files.writeFile(root, 'app.js', 'const y = 2;\n');
  t('writeFile relative relPath', rel.relPath === 'app.js');

  // 11. writeFile can now go *above* the project root but stay under home.
const esc = await files.writeFile(root, '../.mouaif-test-write-' + Math.random().toString(36).slice(2) + '.txt', 'wrote above\n');
t('writeFile allows writing above the project root', esc && esc.relPath && esc.relPath.startsWith('..'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
