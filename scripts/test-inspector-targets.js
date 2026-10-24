'use strict';

// Regression coverage for Chrome's browser-owned entries in /json/list.
// Chrome reports chrome://newtab, chrome-untrusted:// pages, and DevTools'
// own frontend beside normal tabs. They are not attachable Inspector pages,
// while extension targets and ordinary non-http pages remain useful targets.
const assert = require('node:assert/strict');
const http = require('node:http');
const inspector = require('../src/inspector.js');

const rawTargets = [
  { id: 'newtab', type: 'page', url: 'chrome://newtab/' },
  { id: 'pdf-viewer', type: 'iframe', url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' },
  { id: 'devtools', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
  { id: 'untrusted', type: 'page', url: 'chrome-untrusted://new-tab-page/' },
  { id: 'normal', type: 'page', url: 'http://127.0.0.1:5732/' },
  { id: 'extension', type: 'background_page', url: 'chrome-extension://example/background.html' },
  { id: 'file', type: 'page', url: 'file:///tmp/fixture.html' },
  { id: 'about', type: 'page', url: 'about:blank' },
  { id: 'malformed', type: 'page', url: 'not a URL' }
];

function main() {
  assert.equal(inspector.isChromeInternalTarget(rawTargets[0]), true, 'chrome:// target is internal');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[2]), true, 'devtools:// target is internal');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[3]), true, 'chrome-untrusted:// target is internal');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[1]), false, 'extension PDF viewer remains available');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[4]), false, 'ordinary page remains available');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[6]), false, 'file target remains available');
  assert.equal(inspector.isChromeInternalTarget(rawTargets[8]), false, 'malformed target is preserved');

  const filtered = inspector.filterInspectorTargets(rawTargets);
  assert.deepEqual(filtered.map((target) => target.id), [
    'pdf-viewer', 'normal', 'extension', 'file', 'about', 'malformed'
  ], 'only Chrome-owned UI targets are removed');
  assert.notEqual(filtered, rawTargets, 'filter returns a new list');

  const server = http.createServer((req, res) => {
    if (req.url !== '/json/list') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(rawTargets));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const targets = await inspector.fetchInspectorTargets('http://127.0.0.1:' + port);
        assert.deepEqual(targets.map((target) => target.id), filtered.map((target) => target.id),
          'fetchInspectorTargets applies the same filter used by the Inspector endpoint');
        console.log('PASS Inspector target filtering');
        server.close(resolve);
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
