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
  assert(files.globToRegExp('README.md').test('readme.md'), 'glob is case-insensitive so a model need not guess project casing');
  assert(files.globToRegExp('readme.md').test('README.md'), 'glob is case-insensitive in both directions');
  // Bare (non-glob) patterns are directory-or-file prefixes: `src` matches
  // every file under src/ (the `/**` suffix is implied), so a model that
  // asks to "list src" gets an answer instead of nothing.
  assert(files.globToRegExp('src').test('src/index.js'), 'bare glob src matches a file under src');
  assert(files.globToRegExp('src').test('src/utils/new.js'), 'bare glob src matches nested files too');
  assert(files.globToRegExp('src').test('other.js') === false, 'bare glob src does not match outside src');
  assert(files.globToRegExp('src/index.js').test('src/index.js'), 'bare glob with a full file path matches it');

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
  // Bare directory pattern: `src` (no `/**`) implies the subtree, so a
  // model that says "list src" gets the files rather than an empty list.
  const r2b = await files.runFileTool('list_files', { projectDir: root, args: { pattern: 'src' } });
  assert(r2b.ok === true, 'list_files bare-dir pattern ok');
  const bp = r2b.result.entries.map((e) => e.path);
  assert(bp.indexOf('src/a.js') >= 0 && bp.indexOf('src/b.ts') >= 0, 'list_files bare `src` lists the subtree');
  assert(bp.indexOf('README.md') === -1, 'list_files bare `src` does not leak outside src');


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
  // A missing / partial directory path is treated as a subtree prefix
  // instead of silently returning zero matches: `src/util` (typo or a dir
  // not created yet) still searches everything under the nearest existing
  // ancestor `src`.
  const r3sub = await files.runFileTool('search_files', { projectDir: root, args: { query: 'function (login|logout)', path: 'src/util' } });
  assert(r3sub.ok === true, 'search_files missing-dir subtree path ok');
  assert(r3sub.result.matches.length > 0, 'search_files missing-dir subtree still finds matches');

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

  // Helpful hint on ENO_MATCH.
  const hintFile = path.join(root, 'hint.js');
  writeFile(hintFile, 'function alpha() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n');
  const eHint = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'hint.js', oldText: 'function alpha() {\n  const x = 1;\n  const y = 99;\n  return x + y;\n}', newText: 'function beta() {}' }
  });
  assert(eHint.ok === false && eHint.result.error.code === 'ENO_MATCH', 'edit_file ENO_MATCH when content differs');
  assert(eHint.result.error.message.includes('Closest match found around lines'), 'edit_file surfaces closest matching lines hint');

  // Line-trimmed matching (agent sends block with differing indentation / surrounding blank lines).
  const trimFile = path.join(root, 'trim.js');
  writeFile(trimFile, '  function testIndent() {\n    const a = 1;\n    const b = 2;\n    return a + b;\n  }\n');
  const eTrim = await files.runFileTool('edit_file', {
    projectDir: root,
    args: {
      path: 'trim.js',
      oldText: '\nfunction testIndent() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n',
      newText: 'function testIndent() {\n  return 42;\n}'
    }
  });
  assert(eTrim.ok === true, 'edit_file matches block despite indentation and blank line padding');
  assert(fs.readFileSync(trimFile, 'utf8').includes('return 42;'), 'edit_file applied trimmed replacement');

  // Formatter-tolerant matching accepts harmless wrapping, blank lines, and
  // punctuation spacing while preserving the unique-match safety rule.
  const layoutFile = path.join(root, 'layout.js');
  writeFile(layoutFile, [
    'function toggleSettingsGroup(groupId, checked) {',
    "  if (groupId === 'shell') pickShellMode(mode);",
    '',
    "  else if (groupId === 'files') {",
    '    const names = toolsCatalog',
    "      .filter((tool) => tool && tool.kind === 'native')",
    '      .map((tool) => tool.name);',
    '    pickFileGroupMode(names, mode);',
    '  }',
    '}',
    ''
  ].join('\n'));
  const eLayout = await files.runFileTool('edit_file', {
    projectDir: root,
    args: {
      path: 'layout.js',
      oldText: "function toggleSettingsGroup(groupId, checked) {\nif (groupId==='shell') pickShellMode(mode);\nelse if (groupId === 'files') {\nconst names=toolsCatalog.filter((tool)=>tool && tool.kind === 'native').map((tool)=>tool.name);\npickFileGroupMode(names,mode);\n}\n}",
      newText: 'function toggleSettingsGroup() {\n  return true;\n}'
    }
  });
  assert(eLayout.ok === true, 'edit_file matches formatter-only layout differences');
  assert(fs.readFileSync(layoutFile, 'utf8') === 'function toggleSettingsGroup() {\n  return true;\n}\n', 'edit_file replaces the full layout-tolerant span');

  const changedCodeFile = path.join(root, 'changed-code.js');
  writeFile(changedCodeFile, 'const total = one + two;\n');
  const eChangedCode = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'changed-code.js', oldText: 'const total = one - two;', newText: 'const total = 0;' }
  });
  assert(eChangedCode.ok === false && eChangedCode.result.error.code === 'ENO_MATCH', 'edit_file does not ignore changed punctuation');

  const changedStringFile = path.join(root, 'changed-string.js');
  writeFile(changedStringFile, "const label = 'two words';\n");
  const eChangedString = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'changed-string.js', oldText: "const label = 'twowords';", newText: "const label = 'fixed';" }
  });
  assert(eChangedString.ok === false && eChangedString.result.error.code === 'ENO_MATCH', 'edit_file preserves meaningful string whitespace');

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
  // Re-indentation: a line-aligned block (whole function on its own lines,
  // top level) matched with different leading whitespace lands at the file's
  // indentation depth, not the caller's. Matching still runs on trimmed lines.
  const indentFile = path.join(root, 'indent.js');
  writeFile(indentFile, 'function alpha() {\n  const one = 1;\n  const two = 2;\n  return one + two;\n}\n');
  const eIndent = await files.runFileTool('edit_file', {
    projectDir: root,
    args: {
      path: 'indent.js',
      oldText: 'function alpha() {\nconst one = 1;\nconst two = 2;\nreturn one + two;\n}',
      newText: 'function alpha() {\n  return 42;\n}'
    }
  });
  const indentAfter = fs.readFileSync(indentFile, 'utf8');
  assert(eIndent.ok === true, 'edit_file re-indents a line-aligned replacement');
  assert(indentAfter.includes('  return 42;'), 'edit_file re-indents interior body to the file depth');
  assert(indentAfter.endsWith('}\n'), 'edit_file keeps the re-indented closing brace at the matched top-level depth');

  // Escape-normalized matching: a model that JSON-escapes its block (oldText
  // and newText both carry literal \\n) still lands the edit.
  const escFile = path.join(root, 'esc.js');
  writeFile(escFile, 'alpha\nbeta\ngamma\n');
  const eEsc = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'esc.js', oldText: 'alpha\\nbeta', newText: 'one\\ntwo' }
  });
  assert(eEsc.ok === true, 'edit_file applies an escape-normalized block');
  assert(fs.readFileSync(escFile, 'utf8') === 'one\ntwo\ngamma\n', 'edit_file unescapes both the matched span and the replacement');

  // No regression: a genuine content mismatch (not whitespace/escaping) still
  // fails with ENO_MATCH rather than auto-applying a near-miss.
  const strictFile = path.join(root, 'strict.js');
  writeFile(strictFile, 'const total = one + two;\n');
  const eStrict = await files.runFileTool('edit_file', {
    projectDir: root,
    args: { path: 'strict.js', oldText: 'const total = one - two;', newText: 'const total = 0;' }
  });
  assert(eStrict.ok === false && eStrict.result.error.code === 'ENO_MATCH', 'edit_file still rejects genuinely changed code');


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
