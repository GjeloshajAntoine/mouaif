'use strict';
// In-process regression coverage for character-range (column) redaction.
// No running server or user settings touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-redaction-chars-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
const lines = [
  'const apiKey = "SECRET";',
  'const normal = 1;',
  'const token = "TOKEN";',
  'const note = "public note";'
];
fs.writeFileSync(path.join(projectDir, 'config.js'), lines.join('\n'));
// Hide only the quoted literal on line 1 (cols 18-25, inclusive) and the
// whole line 3 — leaves line 4 untouched.
fs.writeFileSync(path.join(projectDir, '.mouaif.json'), JSON.stringify({
  hideFileContent: [{
    path: 'config.js',
    ranges: [{ start: 3, end: 3 }],
    chars: [{ startLine: 1, endLine: 1, startCol: 18, endCol: 25 }]
  }]
}));
const { runFileTool } = require('../src/tools/files.js');
const hideFileContent = require('../src/hideFileContent.js');
async function read(args = {}) {
  const result = await runFileTool('read_file', { projectDir, args: { path: 'config.js', ...args } });
  return result.result;
}
(async () => {
  try {
    // normalizeCharSpan drops malformed spans.
    assert.equal(hideFileContent.normalizeCharSpan(null), null);
    assert.equal(hideFileContent.normalizeCharSpan({}), null);
    assert.equal(hideFileContent.normalizeCharSpan({ startLine: 0, endLine: 1, startCol: 1, endCol: 2 }), null);
    assert.equal(hideFileContent.normalizeCharSpan({ startLine: 2, endLine: 1, startCol: 1, endCol: 2 }), null);
    assert.equal(hideFileContent.normalizeCharSpan({ startLine: 1, endLine: 1, startCol: 4, endCol: 2 }), null);
    assert.deepEqual(
      hideFileContent.normalizeCharSpan({ startLine: 1, endLine: 2, startCol: 4, endCol: 2 }),
      { startLine: 1, endLine: 2, startCol: 4, endCol: 2 },
      'multi-line span allows reverse boundary columns'
    );
    assert.deepEqual(
      hideFileContent.normalizeCharSpan({ startLine: 1, endLine: 1, startCol: 4, endCol: 4 }),
      { startLine: 1, endLine: 1, startCol: 4, endCol: 4 }
    );

    // lineIsHidden still reports whole-line matches for char-only rules.
    assert.equal(hideFileContent.lineIsHidden(projectDir, 'config.js', 3), true, 'line 3 hidden by range');
    assert.equal(hideFileContent.lineIsHidden(projectDir, 'config.js', 1), false, 'line 1 not whole-line hidden');

    // matchIsHidden with no columns conservatively suppresses on char-spans.
    assert.equal(
      hideFileContent.matchIsHidden(projectDir, 'config.js', 1, undefined, undefined),
      true,
      'no columns -> conservative suppress on a line with a char span'
    );
    // Column-aware: a match before or after the span is not hidden.
    assert.equal(
      hideFileContent.matchIsHidden(projectDir, 'config.js', 1, 1, 5),
      false,
      'match before the span stays visible'
    );
    assert.equal(
      hideFileContent.matchIsHidden(projectDir, 'config.js', 1, 26, 30),
      false,
      'match after the span stays visible'
    );
    // Column-aware: a match inside the span is hidden.
    assert.equal(
      hideFileContent.matchIsHidden(projectDir, 'config.js', 1, 20, 24),
      true,
      'match inside the span is hidden'
    );
    // A match that straddles the span is hidden.
    assert.equal(
      hideFileContent.matchIsHidden(projectDir, 'config.js', 1, 15, 20),
      true,
      'match straddling the span is hidden'
    );

    // read_file redacts the literal on line 1 and the whole line 3.
    const full = await read();
    assert.equal(full.redacted, true);
    assert.equal(full.redactedLines, 1, 'whole-line count is just the range');
    const bodyLines = full.body.split('\n');
    assert.ok(bodyLines[0].includes('[hidden]'), 'line 1 hides the literal: ' + bodyLines[0]);
    assert.ok(!bodyLines[0].includes('SECRET'), 'line 1 still hides the literal text');
    assert.equal(bodyLines[1], 'const normal = 1;', 'line 2 is untouched');
    assert.equal(bodyLines[2], '[hidden]', 'line 3 is fully hidden');
    assert.equal(bodyLines[3], 'const note = "public note";', 'line 4 is untouched');

    // search_files with a regex that matches both the hidden literal and a
    // visible token on the same line returns only the visible token.
    const s1 = await runFileTool('search_files', { projectDir, args: { query: 'note|TOKEN|SECRET' } });
    assert.ok(Array.isArray(s1.result.matches), 'search_files returns matches');
    const byPath = s1.result.matches.filter((m) => m.path === 'config.js');
    assert.equal(byPath.length, 1, 'one visible match left in config.js: ' + JSON.stringify(byPath));
    assert.equal(byPath[0].line, 4, 'match is on line 4');
    assert.ok(byPath[0].text.includes('public note'));

    // search_files on a line where the only match is inside the hidden span
    // returns nothing for that line.
    const s2 = await runFileTool('search_files', { projectDir, args: { query: 'SECRET' } });
    assert.equal(s2.result.matches.filter((m) => m.path === 'config.js').length, 0);

    // Multi-line char span: hide cols 7-20 on line 1, cols 1-8 on line 2.
    fs.writeFileSync(path.join(projectDir, '.mouaif.json'), JSON.stringify({
      hideFileContent: [{
        path: 'config.js',
        chars: [{ startLine: 1, endLine: 2, startCol: 7, endCol: 8 }]
      }]
    }));
    const multi = await read();
    assert.equal(multi.redacted, true);
    const out = multi.body.split('\n');
    assert.ok(out[0].startsWith('const ' + hideFileContent.REDACT_MARKER), 'line 1 keeps prefix');
    assert.ok(out[1].startsWith(hideFileContent.REDACT_MARKER + 'rmal = 1;'), 'line 2 keeps suffix');

    // The on-disk file is untouched across all redactions.
    assert.equal(fs.readFileSync(path.join(projectDir, 'config.js'), 'utf8'), lines.join('\n'));

    console.log('hide file char spans: normalization, line/mix/matchIsHidden, read_file redaction, search_files column filter, multi-line span, untouched source all passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
