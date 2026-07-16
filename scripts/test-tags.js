'use strict';

// Unit test for src/tags.js — the file-tagging module (decisions §15).
// Exercises path normalization / escape refusal, CRUD round-trip through
// a temp project, the directory scan (allowlist + skip dirs), the size
// cap, excerpt rendering, @-reference parsing, and role promotion.
// Prints a pass/fail summary and exits non-zero on any failure.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Temp MOUAIF_HOME so registered-project / app settings never touch a
// real store, and a temp project dir the tags module reads/writes.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tags-home-'));
process.env.MOUAIF_HOME = HOME;
// Project lives under HOME so it passes the folder-picker allowlist too.
const PROJ = fs.mkdtempSync(path.join(HOME, 'proj-'));

const tags = require('../src/tags.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
function throws(name, fn, code) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, !code || e.code === code, 'code=' + e.code); }
}

// ---- Fixture files ------------------------------------------------------

fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'src', 'a.js'), 'line1\nline2\nline3\nline4\n');
fs.writeFileSync(path.join(PROJ, 'README.md'), '# hi\nbody\n');
fs.writeFileSync(path.join(PROJ, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(PROJ, 'node_modules', 'x', 'dep.js'), 'should be skipped');
// Oversized file (> default 256 KB) with no excerpt -> not injected.
fs.writeFileSync(path.join(PROJ, 'big.txt'), 'x'.repeat(300 * 1024));

// ---- Path normalization -------------------------------------------------

check('toRelPath posix-normalizes', tags.toRelPath(PROJ, path.join('src', 'a.js')) === 'src/a.js');
check('toRelPath accepts abs inside root', tags.toRelPath(PROJ, path.join(PROJ, 'src', 'a.js')) === 'src/a.js');
throws('toRelPath refuses ..', () => tags.toRelPath(PROJ, '../evil.js'), 'EOUTSIDE_PROJECT');
throws('toRelPath refuses absolute outside', () => tags.toRelPath(PROJ, path.resolve(os.tmpdir(), 'x.js')), 'EOUTSIDE_PROJECT');
throws('toRelPath refuses empty', () => tags.toRelPath(PROJ, ''), 'EBADINPUT');

// ---- Scan ---------------------------------------------------------------

const scan = tags.scanFiles(PROJ);
const scanPaths = scan.map(f => f.path);
check('scan finds src/a.js', scanPaths.includes('src/a.js'));
check('scan finds README.md', scanPaths.includes('README.md'));
check('scan skips node_modules', !scanPaths.some(p => p.startsWith('node_modules')));
check('scan flags png as binary', (scan.find(f => f.path === 'logo.png') || {}).binary === true);
check('scan flags js as non-binary', (scan.find(f => f.path === 'src/a.js') || {}).binary === false);

// ---- CRUD round-trip ----------------------------------------------------

check('getTags empty initially', Object.keys(tags.getTags(PROJ)).length === 0);
tags.setTags(PROJ, {
  'src/a.js': { tags: ['api', 'core'], excerpt: null, includeInChat: true },
  'README.md': { tags: ['docs'], excerpt: { start: 1, end: 1 }, includeInChat: false },
  '../escape.js': { tags: ['bad'] } // dropped by normalizeMap
});
const map = tags.getTags(PROJ);
check('setTags persisted src/a.js', !!map['src/a.js'] && map['src/a.js'].tags.length === 2);
check('setTags dropped escape entry', !map['../escape.js'] && !map['..\\escape.js']);
check('setTags kept excerpt', map['README.md'].excerpt && map['README.md'].excerpt.start === 1);
check('setTags kept includeInChat=false', map['README.md'].includeInChat === false);

check('removeTag removes existing', tags.removeTag(PROJ, 'README.md') === true);
check('removeTag on missing returns false', tags.removeTag(PROJ, 'nope.js') === false);
check('removeTag actually gone', !tags.getTags(PROJ)['README.md']);

// ---- Injection ----------------------------------------------------------

// Re-tag: one included whole-file, one excerpt, one excluded, one oversize.
tags.setTags(PROJ, {
  'src/a.js':   { tags: ['api'], excerpt: { start: 2, end: 3 }, includeInChat: true }, // real multi-line range
  'README.md':  { tags: ['docs'], excerpt: { start: 2, end: 2 }, includeInChat: true }, // 0-length -> empty body
  'big.txt':    { tags: ['big'], excerpt: null, includeInChat: true }, // oversize, no excerpt -> skipped
  'gone.js':    { tags: ['stale'], excerpt: null, includeInChat: true }  // missing -> skipped
});

const injected = tags.resolveForInjection(PROJ, {});
const injPaths = injected.map(m => m.relPath);
check('injects included file', injPaths.includes('src/a.js'));
check('skips oversize file without excerpt', !injPaths.includes('big.txt'));
check('skips missing file', !injPaths.includes('gone.js'));

const aMsg = injected.find(m => m.relPath === 'src/a.js');
check('injected role is system by default', aMsg && aMsg.role === 'system');
check('injected content has File header', aMsg && aMsg.content.includes('# File: src/a.js'));
check('injected content has Tags header', aMsg && aMsg.content.includes('# Tags: api'));
check('excerpt header present', aMsg && aMsg.content.includes('# Excerpt: 2-3'));
check('excerpt body is lines 2-3', aMsg && aMsg.content.includes('line2') && aMsg.content.includes('line3') && !aMsg.content.includes('line1') && !aMsg.content.includes('line4'));

const rMsg = injected.find(m => m.relPath === 'README.md');
check('0-length excerpt header present', rMsg && rMsg.content.includes('# Excerpt: 2-2'));
check('0-length excerpt body is empty', rMsg && rMsg.content.trim().endsWith('# Excerpt: 2-2'));

// ---- @-reference parsing + promotion -----------------------------------

const refs = tags.parseReferences(PROJ, 'please look at @src/a.js and @../evil.js and plain text');
check('parseReferences finds valid ref', refs.includes('src/a.js'));
check('parseReferences drops escaping ref', !refs.some(r => r.includes('..')));

// A file that is includeInChat=false is still injected when @-referenced,
// and promoted to role=user.
tags.setTags(PROJ, {
  'src/a.js': { tags: ['api'], excerpt: null, includeInChat: false }
});
const promoted = tags.resolveForInjection(PROJ, { referencedPaths: ['src/a.js'] });
const pMsg = promoted.find(m => m.relPath === 'src/a.js');
check('@-referenced excluded file is injected', !!pMsg);
check('@-referenced file promoted to user role', pMsg && pMsg.role === 'user');

// Not referenced + excluded -> not injected.
const none = tags.resolveForInjection(PROJ, {});
check('excluded + unreferenced file skipped', !none.some(m => m.relPath === 'src/a.js'));

// ---- Summary ------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
