'use strict';

// Regression coverage for the search_files engine in
// src/tools/searchEngine.js.
//
// The suite runs every assertion twice: once with ripgrep (when a binary is
// available on the machine) and once with the JS walk fallback forced on via
// MOUAIF_RG_DISABLE. Both engines advertise themselves in `result.engine`, so
// a run that silently used only one of them is visible in the output.
//
// In-process only: no server, no user settings, every project lives in a
// fresh tmpdir.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let fail = 0;
const failures = [];

function t(label, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(label + ': ' + e.message);
    console.error('FAIL', label, '-', e.message);
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-search-'));
}

// A fixture project that exercises every behavior the engine claims:
//   - an extensionless file (Dockerfile, Makefile)
//   - a generated tree that .gitignore excludes
//   - a binary file
//   - a hidden (dot) directory
//   - a file with a hidden line and a hidden character span
//   - a line with two occurrences where only the second is hidden
function fixture() {
  const root = tmpdir();
  const w = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  w('src/a.js', 'const login = 1;\nconst token = "SECRET";\nconst logout = 2;\n');
  w('src/multi.js', 'login login login\n');
  w('src/nested/b.js', 'function login() {}\n');
  w('src/nested/deep/c.ts', 'export const login = () => 1;\n');
  w('Dockerfile', 'FROM node:22\nRUN npm ci\n');
  w('Makefile', 'build:\n\tnpm run build\n');
  w('README.md', 'install with npm ci\n');
  w('docs-dist/bundle.js', 'const login = "generated copy";\n');
  w('node_modules/pkg/index.js', 'const login = "vendored";\n');
  w('.github/workflows/ci.yml', 'run: login\n');
  fs.mkdirSync(path.join(root, 'linked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'linked', 'l.js'), 'const login = "linked";\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from('\x00\x01login binary\n'));
  w('.gitignore', 'docs-dist/\n');
  // Two occurrences of ONE symbol, the second of them hidden. Under the old
  // "check only the first occurrence" behavior this row came back with its
  // hidden copy in plain view; the docs promise the row is dropped.
  w('src/twice.js', 'const DUP = 1; const DUP = 2;\n');
  w('.mouaif.json', JSON.stringify({
    hideFileContent: [{
      path: 'src/a.js',
      ranges: [{ start: 2, end: 2 }],
      chars: [{ startLine: 1, endLine: 1, startCol: 7, endCol: 11 }]
    }, {
      path: 'src/twice.js',
      chars: [{ startLine: 1, endLine: 1, startCol: 21, endCol: 23 }]
    }]
  }));
  return root;
}

async function search(projectDir, args, settings) {
  const files = require('../src/tools/files.js');
  return await files.runFileTool('search_files', { projectDir, args, settings });
}

// Async variant of `t`, for the checks that await a search.
async function tAsync(label, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(label + ': ' + e.message);
    console.error('FAIL', label, '-', e.message);
  }
}

// Every assertion in this file runs against each engine backend.
async function forEachEngine(fn) {
  const files = require('../src/tools/files.js');
  const engine = require('../src/tools/searchEngine.js');
  for (const mode of ['ripgrep', 'walk']) {
    process.env.MOUAIF_RG_DISABLE = mode === 'walk' ? '1' : '';
    engine._clearRipgrepCache();
    const hasRg = Boolean(engine.findRipgrepBinary());
    if (mode === 'ripgrep' && !hasRg) {
      console.log('  skip - ripgrep backend (no binary on this machine)');
      continue;
    }
    await fn(mode, files);
  }
  process.env.MOUAIF_RG_DISABLE = '';
  engine._clearRipgrepCache();
}

async function main() {
  const engine = require('../src/tools/searchEngine.js');

  // ---- normalizePattern -------------------------------------------
  t('normalizePattern peels (?i)', () => {
    const n = engine.normalizePattern('(?i)foo');
    assert.equal(n.pattern, 'foo');
    assert.equal(n.ignoreCase, true);
  });
  t('normalizePattern peels (?s)', () => {
    const n = engine.normalizePattern('(?s)f.o');
    assert.equal(n.pattern, 'f.o');
    assert.equal(n.multiline, true);
  });
  t('normalizePattern peels (?is) in any order', () => {
    const n = engine.normalizePattern('(?si)foo');
    assert.equal(n.ignoreCase, true);
    assert.equal(n.multiline, true);
    assert.equal(n.pattern, 'foo');
  });
  t('normalizePattern leaves a normal pattern alone', () => {
    const n = engine.normalizePattern('(?P<name>foo)');
    assert.equal(n.ignoreCase, false);
    assert.equal(n.pattern, '(?P<name>foo)');
  });
  t('normalizePattern keeps a flags-only query intact for the error path', () => {
    const n = engine.normalizePattern('(?i)');
    assert.equal(n.pattern, '(?i)');
  });

  // ---- sanitizeInclude -------------------------------------------
  t('sanitizeInclude strips an exclusion prefix', () => {
    assert.equal(engine.sanitizeInclude('!*.js'), '*.js');
  });
  t('sanitizeInclude strips a leading anchor', () => {
    assert.equal(engine.sanitizeInclude('/src/*.js'), 'src/*.js');
  });
  t('sanitizeInclude ignores a non-string', () => {
    assert.equal(engine.sanitizeInclude(7), null);
  });
  t('includeMatches matches a bare name glob at any depth', () => {
    assert.equal(engine.includeMatches('*.js', 'src/nested/b.js'), true);
    assert.equal(engine.includeMatches('*.js', 'src/a.ts'), false);
  });
  t('includeMatches matches a path glob from the root', () => {
    assert.equal(engine.includeMatches('src/*.js', 'src/a.js'), true);
    assert.equal(engine.includeMatches('src/*.js', 'other/a.js'), false);
  });

  // ---- resolveScope ----------------------------------------------
  const fx = fixture();
  t('resolveScope treats an omitted path as the whole project', () => {
    const s = engine.resolveScope(fx, null);
    assert.equal(s.dir, fs.realpathSync(fx));
    assert.equal(s.relFile, null);
  });
  t('resolveScope treats "." as the whole project', () => {
    const s = engine.resolveScope(fx, '.');
    assert.equal(s.dir, fs.realpathSync(fx));
  });
  t('resolveScope accepts a directory with and without a slash', () => {
    for (const p of ['src', 'src/']) {
      const s = engine.resolveScope(fx, p);
      assert.equal(s.relDir, 'src', p);
      assert.equal(s.relFile, null);
    }
  });
  t('resolveScope accepts a single file', () => {
    const s = engine.resolveScope(fx, 'src/a.js');
    assert.equal(s.relFile, 'src/a.js');
  });
  t('resolveScope falls back to the nearest existing ancestor', () => {
    const s = engine.resolveScope(fx, 'src/util');
    assert.equal(s.relDir, 'src');
  });
  t('resolveScope never escapes the project root', () => {
    const s = engine.resolveScope(fx, '../..');
    assert.equal(s.dir, fs.realpathSync(fx));
  });

  // ---- both engines, same answers --------------------------------
  await forEachEngine(async (mode, files) => {
    const m = (label) => mode + ' / ' + label;
    // Each check below is tallied on its own so the summary counts the
    // assertions and a failure is reported without aborting the rest.
    await tAsync(m('a plain search finds the nested match'), async () => {
      const basic = await search(fx, { query: 'function login' });
      assert.equal(basic.ok, true);
      assert.equal(basic.result.engine, mode, 'engine is reported');
      assert.deepEqual(basic.result.matches.map((x) => x.path + ':' + x.line).sort(), ['src/nested/b.js:1']);
    });

    await tAsync(m('one row per matching line'), async () => {
      const multi = await search(fx, { query: 'login' });
      assert.equal(multi.result.matches.filter((x) => x.path === 'src/multi.js').length, 1);
    });

    await tAsync(m('finds a file at any depth'), async () => {
      const deep = await search(fx, { query: 'export const login' });
      assert.deepEqual(deep.result.matches.map((x) => x.path), ['src/nested/deep/c.ts']);
    });

    await tAsync(m('searches extensionless files'), async () => {
      const docker = await search(fx, { query: 'FROM node' });
      assert.deepEqual(docker.result.matches.map((x) => x.path), ['Dockerfile']);
      const make = await search(fx, { query: 'npm run build' });
      assert.deepEqual(make.result.matches.map((x) => x.path), ['Makefile']);
    });

    await tAsync(m('skips a .gitignore-excluded tree'), async () => {
      const ignored = await search(fx, { query: 'generated copy' });
      assert.equal(ignored.result.matches.length, 0);
    });

    await tAsync(m('skips node_modules but searches hidden directories'), async () => {
      assert.equal((await search(fx, { query: 'vendored' })).result.matches.length, 0);
      const ci = await search(fx, { query: 'run: login' });
      assert.deepEqual(ci.result.matches.map((x) => x.path), ['.github/workflows/ci.yml']);
      assert.equal((await search(fx, { query: 'workflows', path: '.github' })).ok, true);
    });

    await tAsync(m('skips binary files'), async () => {
      assert.equal((await search(fx, { query: 'login binary' })).result.matches.length, 0);
    });

    await tAsync(m('never reports a path outside the root'), async () => {
      const linked = await search(fx, { query: 'linked' });
      assert.ok(linked.result.matches.every((x) => !x.path.startsWith('..')));
    });

    await tAsync(m('path scope: directory'), async () => {
      const r = await search(fx, { query: 'login', path: 'src' });
      assert.ok(r.result.matches.length > 0);
      assert.ok(r.result.matches.every((x) => x.path.startsWith('src/')));
    });

    await tAsync(m('path scope: single file'), async () => {
      const r = await search(fx, { query: 'login', path: 'src/multi.js' });
      assert.deepEqual([...new Set(r.result.matches.map((x) => x.path))], ['src/multi.js']);
    });

    await tAsync(m('path scope: a directory that does not exist yet'), async () => {
      const r = await search(fx, { query: 'login', path: 'src/util' });
      assert.ok(r.result.matches.length > 0);
    });

    await tAsync(m('include filters by glob'), async () => {
      assert.deepEqual((await search(fx, { query: 'npm ci', include: '*.md' })).result.matches.map((x) => x.path), ['README.md']);
      assert.deepEqual((await search(fx, { query: 'login', include: '*.ts' })).result.matches.map((x) => x.path), ['src/nested/deep/c.ts']);
      assert.equal((await search(fx, { query: 'login', include: '*.rs' })).result.matches.length, 0);
    });

    await tAsync(m('(?i) is honored'), async () => {
      assert.deepEqual((await search(fx, { query: '(?i)FROM NODE' })).result.matches.map((x) => x.path), ['Dockerfile']);
      assert.equal((await search(fx, { query: 'function (login|logout)' })).ok, true);
    });

    await tAsync(m('unsupported constructs are a typed input error'), async () => {
      const lookahead = await search(fx, { query: 'l(?=ogin)' });
      assert.equal(lookahead.ok, false);
      assert.equal(lookahead.result.error.code, 'EBADINPUT');
      assert.match(lookahead.result.error.message, /lookahead/i);
      const backref = await search(fx, { query: '(l)\\1' });
      assert.equal(backref.ok, false, 'backreference rejected');
      assert.equal(backref.result.error.code, 'EBADINPUT');
    });

    await tAsync(m('missing query / bad regex keep their error codes'), async () => {
      assert.equal((await search(fx, {})).result.error.code, 'EBADINPUT');
      assert.equal((await search(fx, { query: '(' })).result.error.code, 'EBADINPUT');
      assert.equal((await search(fx, { query: 'login', path: '../../etc' })).ok, true);
    });

    await tAsync(m('a hidden line and a hidden span are both suppressed'), async () => {
    assert.equal((await search(fx, { query: 'SECRET' })).result.matches.length, 0);
    assert.ok(!(await search(fx, { query: 'login' })).result.matches.some((x) => x.path === 'src/a.js'));
    assert.deepEqual((await search(fx, { query: 'const logout' })).result.matches.map((x) => x.path), ['src/a.js']);
    });

    // If ANY occurrence of the pattern on a line is hidden, the row is dropped:
    // printing it because only the *first* occurrence was visible would hand the
    // model the hidden copy. This is the case the old fixture never covered.
    await tAsync(m('a hidden second occurrence drops the whole row'), async () => {
    const r = await search(fx, { query: 'DUP' });
    assert.equal(r.result.matches.length, 0, 'a row with any hidden occurrence is not printed');
    // The same line is returned when nothing on it is hidden, so this is
    // suppression and not a fixture that never matched.
    assert.equal((await search(fx, { query: 'const DUP = 1' })).result.matches.length, 1);
    });

    // A path that does not exist searches its longest existing ancestor.
    await tAsync(m('a missing path falls back to its existing ancestor'), async () => {
    const r = await search(fx, { query: 'login', path: 'src/nope/deeper' });
    assert.ok(r.ok && r.result.matches.length > 0);
    assert.ok(r.result.matches.every((x) => x.path.startsWith('src/')));
    });

    await tAsync(m('the match cap is enforced'), async () => {
      const capped = await search(fx, { query: 'login|npm|FROM|build|run' }, { fileSearchMaxMatches: 2 });
      assert.equal(capped.result.matches.length, 2);
      assert.equal(capped.result.truncated, true);
      assert.equal(capped.result.capMatches, 2);
    });

    await tAsync(m('a no-match search reports honestly'), async () => {
      const none = await search(fx, { query: 'zzq-no-such-token-zzq' });
      assert.equal(none.ok, true);
      assert.equal(none.result.matches.length, 0);
      assert.equal(none.result.filesScanned, 0, 'no match means no matched file');
    });

    // `filesScanned` is "files with at least one match", and it must mean the
    // same thing on both backends. It is the "N files" the chat card prints
    // next to "N matches". It used to count ripgrep's begin+end records, i.e.
    // twice the number of matching files.
    await tAsync(m('filesScanned counts the files that matched, once each'), async () => {
    const r = await search(fx, { query: 'login' });
    const paths = new Set(r.result.matches.map((x) => x.path));
    assert.equal(r.result.filesScanned, paths.size);
    // Dockerfile has two matching lines and is still one file.
    const multi = await search(fx, { query: 'npm|FROM|RUN' });
    assert.equal(multi.result.matches.length, 4);
    assert.equal(multi.result.filesScanned, 3);
    });

    // `(?s)` used to mean two different things per backend, and on the ripgrep
    // path it let a multi-line match print a hidden line verbatim (the record's
    // line_number only names the first line). It is refused now, on both.
    await tAsync(m('(?s) is refused instead of leaking a hidden line'), async () => {
      const r = await search(fx, { query: '(?s)const logout.*SECRET' });
      assert.equal(r.ok, false);
      assert.equal(r.result.error.code, 'EBADINPUT');
      assert.match(r.result.error.message, /dot-matches-newline/);
    });

    // Brace alternation and character classes are documented glob grammar, so
    // the walk backend has to implement them too — it used to escape them and
    // return nothing for a query the docs advertise.
    await tAsync(m('include globs survive the fallback: braces and classes'), async () => {
    assert.deepEqual((await search(fx, { query: 'login', include: '*.{js,ts}' })).result.matches.map((x) => x.path).sort(),
      ['linked/l.js', 'src/multi.js', 'src/nested/b.js', 'src/nested/deep/c.ts']);
    // A character class, both bare and behind `**/`.
    assert.deepEqual((await search(fx, { query: 'login', include: 'src/**/[ab].js' })).result.matches.map((x) => x.path).sort(),
      ['src/nested/b.js']);
    assert.deepEqual((await search(fx, { query: 'login', include: 'src/multi.[jt]s' })).result.matches.map((x) => x.path),
      ['src/multi.js']);
    assert.deepEqual((await search(fx, { query: 'login', include: 'src/**/*.{js,ts}' })).result.matches.map((x) => x.path).sort(),
      ['src/multi.js', 'src/nested/b.js', 'src/nested/deep/c.ts']);
    });

    // A caller-supplied include must not be able to re-enable a skipped tree:
    // ripgrep applies -g in order, so the include is pushed before them.
    await tAsync(m('an include cannot dig a skipped directory back out'), async () => {
      const r = await search(fx, { query: 'login', include: '**/node_modules/**' });
      assert.deepEqual(r.result.matches.map((x) => x.path), []);
    });
  });

  // ---- one engine can be pinned explicitly ------------------------
  process.env.MOUAIF_RG_DISABLE = '1';
  engine._clearRipgrepCache();
  t('MOUAIF_RG_DISABLE forces the walk engine', () => {
    assert.equal(engine.findRipgrepBinary(), null);
  });
  process.env.MOUAIF_RG_DISABLE = '';
  engine._clearRipgrepCache();

  try {
    fs.rmSync(fx, { recursive: true, force: true });
  } catch { /* best effort */ }

  console.log('---');
  console.log('search engine: ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) console.log(failures.join('\n'));
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
