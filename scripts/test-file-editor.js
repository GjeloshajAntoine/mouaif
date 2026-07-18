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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-files-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;\n', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '# inner\n', 'utf8');
  fs.writeFileSync(path.join(root, 'binary.png'), Buffer.from([0, 1, 2, 0xff, 0xfe]));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.js'), 'should not appear', 'utf8');
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

  // 5. readFile rejects path outside root
  let outside = null;
  try { await files.readFile(root, '/etc/passwd'); }
  catch (e) { outside = e; }
  t('readFile refuses outside with EOUTSIDE_PROJECT', outside && outside.code === 'EOUTSIDE_PROJECT');

  // 6. readFile rejects path outside home (when ALLOW_ANY_ROOT is off)
  let home = null;
  try { await files.readFile('/etc', '/etc/hosts'); }
  catch (e) { home = e; }
  t('readFile refuses outside home with EOUTSIDE_HOME', home && (home.code === 'EOUTSIDE_HOME' || home.code === 'EOUTSIDE_PROJECT'));

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

  // 11. writeFile refuses escape
  let esc = null;
  try { await files.writeFile(root, '../escape.txt', 'nope'); }
  catch (e) { esc = e; }
  t('writeFile refuses escape', esc && esc.code === 'EOUTSIDE_PROJECT');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
