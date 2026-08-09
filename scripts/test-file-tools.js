'use strict';

// Smoke test for src/tools/files.js.
//
// Covers the same shape the other tool test scripts use (assert +
// pass/fail tally). No test framework — a single script that exits 0
// on full pass, 1 on any failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const files = require('../src/tools/files.js');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; failures.push(label); console.error('FAIL', label); }
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'mouaif-file-tools-'));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

(async function main() {
  // ---- globToRegExp -----------------------------------------------
  assert(files.globToRegExp('*.js') instanceof RegExp, 'globToRegExp returns a RegExp');
  assert(files.globToRegExp('*.js').test('foo.js'), 'glob * matches stem.js');
  assert(!files.globToRegExp('*.js').test('foo.ts'), 'glob *.js does not match foo.ts');
  assert(files.globToRegExp('**/*.js').test('a/b/c.js'), 'glob **/*.js matches deep paths');
  assert(files.globToRegExp('src/**/*.test.js').test('src/x/foo.test.js'), 'glob src/**/*.test.js matches');
  assert(!files.globToRegExp('src/**/*.test.js').test('lib/x/foo.test.js'), 'glob src/**/*.test.js is anchored to src/');
  assert(files.globToRegExp('README.md').test('README.md'), 'glob literal matches');
  assert(!files.globToRegExp('README.md').test('readme.md'), 'glob is case-sensitive on POSIX');

  // ---- SPEC shape ------------------------------------------------
  assert(files.SPECS.read_file.function.name === 'read_file', 'read_file spec name');
  assert(files.SPECS.list_files.function.name === 'list_files', 'list_files spec name');
  assert(files.SPECS.search_files.function.name === 'search_files', 'search_files spec name');
  assert(files.SPECS.write_file.function.name === 'write_file', 'write_file spec name');
  assert(files.SPECS.edit_file.function.name === 'edit_file', 'edit_file spec name');
  for (const n of files.FILE_TOOL_NAMES) {
    const s = files.SPECS[n];
    assert(s && s.type === 'function' && s.function && s.function.parameters && s.function.parameters.type === 'object', n + ' has OpenAI shape');
    // read_file, search_files, write_file require at least one arg;
    // list_files takes an optional pattern only.
    if (n === 'read_file' || n === 'search_files' || n === 'write_file' || n === 'edit_file') {
      assert(Array.isArray(s.function.parameters.required) && s.function.parameters.required.length >= 1, n + ' has required[]');
    } else {
      assert(!s.function.parameters.required || s.function.parameters.required.length === 0, n + ' has empty required[]');
    }
  }
  assert(files.isFileToolName('read_file'), 'isFileToolName(read_file) true');
  assert(files.isFileToolName('edit_file'), 'isFileToolName(edit_file) true');
  assert(!files.isFileToolName('shell'), 'isFileToolName(shell) false');
  assert(!files.isFileToolName('mcp__x__y'), 'isFileToolName(mcp__x__y) false');

  // ---- resolveSandbox --------------------------------------------
  const root = tmpdir('ft-');
  const realRoot = fs.realpathSync(root);
  assert(files.resolveSandbox(root) === realRoot, 'resolveSandbox returns realpath');
  let threw = null;
  try { files.resolveSandbox(path.join(root, 'no-such-dir')); } catch (e) { threw = e; }
  assert(threw && threw.code === 'ENOENT', 'resolveSandbox throws ENOENT on missing dir');
  threw = null;
  try { files.resolveSandbox(''); } catch (e) { threw = e; }
  assert(threw && threw.code === 'EBADINPUT', 'resolveSandbox throws EBADINPUT on empty');

  // ---- runFileTool: read_file ------------------------------------
  const fileA = path.join(root, 'src', 'index.js');
  writeFile(fileA, 'one\ntwo\nthree\nfour\nfive\n');
  const r1 = await files.runFileTool('read_file', { projectDir: root, args: { path: 'src/index.js' } });
  assert(r1.ok === true, 'read_file ok');
  assert(r1.result.relPath === 'src/index.js', 'read_file relPath normalized');
  assert(r1.content.includes('# File: src/index.js'), 'read_file content has file header');
  assert(r1.content.includes('three'), 'read_file content has body');

  // Slice.
  const r1s = await files.runFileTool('read_file', { projectDir: root, args: { path: 'src/index.js', startLine: 2, endLine: 4 } });
  assert(r1s.ok === true, 'read_file slice ok');
  assert(r1s.result.startLine === 2 && r1s.result.endLine === 4, 'read_file slice line range');
  assert(r1s.result.body.split('\n').length === 3, 'read_file slice body has 3 lines');
  assert(!r1s.content.includes('one\n'), 'read_file slice excludes line 1');

  // ETOOL_CAP on whole-file large read (line cap).
  const big = path.join(root, 'big.js');
  writeFile(big, ('x\n').repeat(files.DEFAULT_READ_MAX_LINES + 1));
  const r1c = await files.runFileTool('read_file', { projectDir: root, args: { path: 'big.js' } });
  assert(r1c.ok === false && r1c.result.error.code === 'ETOOL_CAP', 'read_file ETOOL_CAP on oversized whole-file read');
  const r1cs = await files.runFileTool('read_file', { projectDir: root, args: { path: 'big.js', startLine: 1, endLine: 1 } });
  assert(r1cs.ok === true, 'read_file slice bypasses ETOOL_CAP');

  // Outside project.
  const r1o = await files.runFileTool('read_file', { projectDir: root, args: { path: '../outside.js' } });
  assert(r1o.ok === false && r1o.result.error.code === 'EOUTSIDE_PROJECT', 'read_file EOUTSIDE_PROJECT on ..');
  const r1a = await files.runFileTool('read_file', { projectDir: root, args: { path: '/etc/hosts' } });
  assert(r1a.ok === false && r1a.result.error.code === 'EOUTSIDE_PROJECT', 'read_file EOUTSIDE_PROJECT on absolute outside');

  // ---- runFileTool: list_files -----------------------------------
  writeFile(path.join(root, 'src', 'a.js'), 'a');
  writeFile(path.join(root, 'src', 'b.ts'), 'b');
  writeFile(path.join(root, 'src', 'c.css'), 'c');
  writeFile(path.join(root, 'README.md'), '# hi');
  writeFile(path.join(root, 'node_modules', 'lib', 'd.js'), 'd');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFile(path.join(root, '.git', 'HEAD'), 'ref: ...');
  writeFile(path.join(root, '.next', 'cache.js'), 'cache');

  const r2 = await files.runFileTool('list_files', { projectDir: root, args: {} });
  assert(r2.ok === true, 'list_files ok');
  const paths = r2.result.entries.map((e) => e.path).sort();
  assert(paths.indexOf('src/a.js') >= 0, 'list_files includes src/a.js');
  assert(paths.indexOf('src/b.ts') >= 0, 'list_files includes src/b.ts');
  assert(paths.indexOf('README.md') >= 0, 'list_files includes README.md');
  assert(paths.indexOf('.next/cache.js') >= 0, 'list_files includes .next');
  assert(paths.indexOf('node_modules/lib/d.js') === -1, 'list_files skips node_modules');
  assert(paths.indexOf('.git/HEAD') === -1, 'list_files skips .git');

  // Glob pattern.
  const r2g = await files.runFileTool('list_files', { projectDir: root, args: { pattern: 'src/*.js' } });
  assert(r2g.ok === true, 'list_files glob ok');
  const gp = r2g.result.entries.map((e) => e.path);
  assert(gp.indexOf('src/a.js') >= 0 && gp.indexOf('src/b.ts') === -1, 'list_files src/*.js matches only .js');

  // Empty pattern.
  const r2z = await files.runFileTool('list_files', { projectDir: root, args: { pattern: '   ' } });
  assert(r2z.ok === true && r2z.result.pattern === '', 'list_files blank pattern treated as no filter');

  // ---- runFileTool: search_files ---------------------------------
  writeFile(path.join(root, 'src', 'auth.js'), 'export function login() {}\nexport const TOKEN = "x";\n');
  writeFile(path.join(root, 'src', 'logout.js'), 'export function logout() {}\n');
  const r3 = await files.runFileTool('search_files', { projectDir: root, args: { query: 'function (login|logout)' } });
  assert(r3.ok === true, 'search_files ok');
  const r3p = r3.result.matches.map((m) => m.path + ':' + m.line);
  assert(r3p.some((s) => s.startsWith('src/auth.js:1')), 'search_files finds auth.js:1');
  assert(r3p.some((s) => s.startsWith('src/logout.js:1')), 'search_files finds logout.js:1');
  assert(r3.result.filesScanned >= 4, 'search_files filesScanned counted');

  // Path filter (directory and single file).
  const r3d = await files.runFileTool('search_files', { projectDir: root, args: { query: 'function (login|logout)', path: 'src' } });
  assert(r3d.ok === true, 'search_files directory path filter ok');
  assert(r3d.result.matches.some((m) => m.path === 'src/auth.js'), 'search_files directory path includes auth.js');
  assert(r3d.result.matches.some((m) => m.path === 'src/logout.js'), 'search_files directory path includes logout.js');
  const r3dot = await files.runFileTool('search_files', { projectDir: root, args: { query: 'TOKEN', path: '.' } });
  assert(r3dot.ok === true && r3dot.result.filesScanned > 0, 'search_files dot path means whole project');
  const r3f = await files.runFileTool('search_files', { projectDir: root, args: { query: 'TOKEN', path: 'src/auth.js' } });
  assert(r3f.ok === true, 'search_files path filter ok');
  assert(r3f.result.matches.length === 1, 'search_files path filter narrows to one file');
  assert(r3f.result.matches[0].path === 'src/auth.js', 'search_files path filter result is the file');

  // Bad regex.
  const r3b = await files.runFileTool('search_files', { projectDir: root, args: { query: '(' } });
  assert(r3b.ok === false && r3b.result.error.code === 'EBADINPUT', 'search_files bad regex -> EBADINPUT');

  // Missing query.
  const r3m = await files.runFileTool('search_files', { projectDir: root, args: {} });
  assert(r3m.ok === false && r3m.result.error.code === 'EBADINPUT', 'search_files missing query -> EBADINPUT');

  // ---- runFileTool: write_file -----------------------------------
  const newFile = path.join(root, 'src', 'utils', 'new.js');
  const w1 = await files.runFileTool('write_file', { projectDir: root, args: { path: 'src/utils/new.js', content: 'export const x = 1;\n' } });
  assert(w1.ok === true, 'write_file ok');
  assert(fs.existsSync(newFile), 'write_file created file on disk');
  assert(fs.readFileSync(newFile, 'utf8') === 'export const x = 1;\n', 'write_file content matches');

  // Overwrite.
  const w2 = await files.runFileTool('write_file', { projectDir: root, args: { path: 'src/utils/new.js', content: 'replaced\n' } });
  assert(w2.ok === true, 'write_file overwrite ok');
  assert(fs.readFileSync(newFile, 'utf8') === 'replaced\n', 'write_file overwrite content matches');

  // edit_file performs an exact replacement rather than interpreting a
  // one-line patch as the complete file body.
  const e1 = await files.runFileTool('edit_file', { projectDir: root, args: { file: 'src/utils/new.js', oldText: 'replaced', newText: 'edited' } });
  assert(e1.ok === true, 'edit_file alias ok');
  assert(fs.readFileSync(newFile, 'utf8') === 'edited\n', 'edit_file alias overwrites content');
  const beforeBadEdit = fs.readFileSync(newFile, 'utf8');
  const e2 = await files.runFileTool('edit_file', { projectDir: root, args: { file: 'src/utils/new.js', content: 'dangerous partial body' } });
  assert(e2.ok === false && e2.result.error.code === 'EBADINPUT', 'edit_file rejects write_file-style content');
  assert(fs.readFileSync(newFile, 'utf8') === beforeBadEdit, 'rejected edit_file leaves file unchanged');
  const e3 = await files.runFileTool('edit_file', { projectDir: root, args: { path: 'src/utils/new.js', oldText: 'missing', newText: 'x' } });
  assert(e3.ok === false && e3.result.error.code === 'ENO_MATCH', 'edit_file rejects missing oldText');
  writeFile(path.join(root, 'duplicate.txt'), 'same\nsame\n');
  const e4 = await files.runFileTool('edit_file', { projectDir: root, args: { path: 'duplicate.txt', oldText: 'same', newText: 'x' } });
  assert(e4.ok === false && e4.result.error.code === 'EMULTI_MATCH', 'edit_file rejects ambiguous oldText');

  // Line-ending differences are not meaningful patch differences. A model
  // commonly sends JSON strings with LF even when the checked-out file uses
  // CRLF; edit_file must match them and preserve the file's convention.
  const crlfFile = path.join(root, 'crlf.js');
  writeFile(crlfFile, 'function oldName() {\r\n  const one = 1;\r\n  const two = 2;\r\n  return one + two;\r\n}\r\n');
  const e5 = await files.runFileTool('edit_file', {
    projectDir: root,
    args: {
      path: 'crlf.js',
      oldText: 'function oldName() {\n  const one = 1;\n  const two = 2;\n  return one + two;\n}',
      newText: 'function newName() {\n  return 3;\n}'
    }
  });
  const crlfEdited = fs.readFileSync(crlfFile, 'utf8');
  assert(e5.ok === true, 'edit_file matches LF oldText against a CRLF file');
  assert(crlfEdited === 'function newName() {\r\n  return 3;\r\n}\r\n', 'edit_file preserves CRLF in replacement text');
  assert(!/(^|[^\r])\n/.test(crlfEdited), 'edit_file does not introduce bare LF into a CRLF file');

  const lfFile = path.join(root, 'lf.js');
  writeFile(lfFile, 'alpha\nbeta\ngamma\n');
  const e6 = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'lf.js', oldText: 'alpha\r\nbeta', newText: 'one\r\ntwo' }
  });
  assert(e6.ok === true, 'edit_file matches CRLF oldText against an LF file');
  assert(fs.readFileSync(lfFile, 'utf8') === 'one\ntwo\ngamma\n', 'edit_file preserves LF in replacement text');

  writeFile(path.join(root, 'duplicate-eol.txt'), 'same\r\nblock\r\nsame\nblock\n');
  const e7 = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'duplicate-eol.txt', oldText: 'same\nblock', newText: 'x' }
  });
  assert(e7.ok === false && e7.result.error.code === 'EMULTI_MATCH', 'edit_file detects duplicates across line-ending styles');

  // Outside project.
  const w3 = await files.runFileTool('write_file', { projectDir: root, args: { path: '../escape.js', content: 'x' } });
  assert(w3.ok === false && w3.result.error.code === 'EOUTSIDE_PROJECT', 'write_file EOUTSIDE_PROJECT on ..');

  // ETOOL_CAP on oversized write.
  const big2 = 'x'.repeat(files.DEFAULT_WRITE_MAX_BYTES + 1);
  const w4 = await files.runFileTool('write_file', { projectDir: root, args: { path: 'src/huge.js', content: big2 } });
  assert(w4.ok === false && w4.result.error.code === 'ETOOL_CAP', 'write_file ETOOL_CAP on oversized content');

  // Unknown tool name.
  const u = await files.runFileTool('mystery', { projectDir: root, args: {} });
  assert(u.ok === false && u.result.error.code === 'EUNKNOWN_TOOL', 'unknown file tool -> EUNKNOWN_TOOL');

  // ---- runFileTool: ENOENT for missing file ----------------------
  // A missing path inside the project: the realpath path walks up to
  // the existing parent and returns the joined path, so the runner
  // reaches the read step and gets a clean ENOENT from fsp.stat.
  const miss = await files.runFileTool('read_file', { projectDir: root, args: { path: 'src/no-such-file.js' } });
  assert(miss.ok === false, 'read_file missing path -> !ok');
  assert(miss.result && miss.result.error && miss.result.error.code === 'ENOENT', 'read_file missing path -> ENOENT (not EOUTSIDE_PROJECT)');

  // ---- Settings caps (fileReadMaxLines) --------------------------
  const root2 = tmpdir('ft2-');
  writeFile(path.join(root2, 'big.js'), Array(101).join('x\n'));
  const wSet = await files.runFileTool('read_file', {
    projectDir: root2,
    args: { path: 'big.js' },
    settings: { fileReadMaxLines: 50 }
  });
  assert(wSet.ok === false && wSet.result.error.code === 'ETOOL_CAP', 'read_file respects fileReadMaxLines override');

  // ---- End --------------------------------------------------------
  console.log('---');
  console.log('file tools: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
