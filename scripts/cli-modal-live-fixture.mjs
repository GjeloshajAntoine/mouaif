// Real CliModal + real serve handlers + isolated disposable project.
// No mocked commands. ?buffered=1 simulates a proxy that never delivers SSE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-live-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
fs.writeFileSync(path.join(projectDir, 'terminal-test.txt'), 'real terminal fixture\n');
const bundle = await build({
  stdin: {
    contents: `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { CliModal } from './frontend/src/components/chat/CliModal.jsx';
import './frontend/src/style.css';
if (new URLSearchParams(location.search).has('buffered')) {
  window.EventSource = class { addEventListener() {} close() {} };
}
function Host() {
  const [open, setOpen] = useState(true);
  return h('div', { class: 'app__shell' },
    h('button', { onClick: () => setOpen(true) }, 'Open terminal'),
    open ? h(CliModal, { projectDir: ${JSON.stringify(projectDir)}, onClose: () => setOpen(false) }) : null);
}
render(h(Host), document.getElementById('root'));
`,
    resolveDir: process.cwd(), sourcefile: 'cli-modal-live.jsx', loader: 'jsx'
  },
  bundle: true, write: false, outdir: '/tmp/mouaif-cli-live-build', format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map((file) => [
  file.path.endsWith('.css') ? '/__cli-live.css' : '/__cli-live.js', file.text
]));
const { createServer } = require('../src/index.js');
const { closeCliSession } = require('../src/server-handlers-tools.js');
const server = createServer(0);
const [handleRequest] = server.listeners('request');
server.removeListener('request', handleRequest);
server.on('request', (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (files[pathname]) {
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return res.end(files[pathname]);
  }
  if (pathname === '/__cli-live') {
    // Let the real handler set the session cookie used by browser API calls.
    req.url = '/';
    // The fixture replaces the document body, so do not compress the real
    // app shell or retain its original content length.
    delete req.headers['accept-encoding'];
    const writeHead = res.writeHead;
    res.writeHead = function (status, headers) {
    if (headers) {
      delete headers['Content-Length'];
      delete headers['content-length'];
    }
    return writeHead.call(this, status, headers);
    };
    const end = res.end;
    res.end = function () {
      return end.call(this, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<link rel="stylesheet" href="/__cli-live.css"><main id="root"></main>'
        + '<script type="module" src="/__cli-live.js"></script>');
    };
  }
  handleRequest(req, res);
});
server.listen(0, '127.0.0.1', () => {
  console.log('Live terminal fixture: http://127.0.0.1:' + server.address().port + '/__cli-live');
  console.log('Buffered SSE: http://127.0.0.1:' + server.address().port + '/__cli-live?buffered=1');
});
setTimeout(() => {
  closeCliSession(projectDir);
  server.closeAllConnections();
  server.close();
}, 10 * 60 * 1000);
