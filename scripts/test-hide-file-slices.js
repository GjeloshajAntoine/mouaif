'use strict';
// In-process regression coverage: no running server or user settings touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-redaction-slices-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
const lines = ['visible one', 'hidden two', 'hidden three', 'visible four', 'hidden five', ''];
fs.writeFileSync(path.join(projectDir, 'sample.txt'), lines.join('\n'));
fs.writeFileSync(path.join(projectDir, '.mouaif.json'), JSON.stringify({
  hideFileContent: [{ path: 'sample.txt', ranges: [{ start: 2, end: 3 }, { start: 5, end: 5 }] }]
}));
const { runFileTool } = require('../src/tools/files.js');
async function read(args = {}) {
  const result = await runFileTool('read_file', { projectDir, args: { path: 'sample.txt', ...args } });
  return result.result;
}
(async () => {
  try {
    const expected = ['visible one', '[hidden]', '[hidden]', 'visible four', '[hidden]', ''];
    assert.equal((await read()).body, expected.join('\n'));
    for (let startLine = 1; startLine <= lines.length; startLine++) {
      for (let endLine = startLine; endLine <= lines.length + 1; endLine++) {
        const result = await read({ startLine, endLine });
        const body = expected.slice(startLine - 1, endLine).join('\n');
        assert.equal(result.body, body, `slice ${startLine}–${endLine}`);
        assert.equal(result.startLine, startLine);
        assert.equal(result.endLine, Math.min(endLine, lines.length));
        const count = expected.slice(startLine - 1, endLine).filter((line) => line === '[hidden]').length;
        assert.equal(result.redactedLines, count);
        assert.equal(result.redacted, count > 0);
      }
    }
    assert.equal(fs.readFileSync(path.join(projectDir, 'sample.txt'), 'utf8'), lines.join('\n'));
    console.log('hide file slices: all slice boundaries, visible lines, metadata and unchanged source passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
