// Isolated browser fixture; real components, fake API, no project file writes.
// Run node scripts/test-hidden-content-ui.mjs and open the printed URL.
import http from 'node:http';
import { build } from 'esbuild';
const bundle = await build({
  stdin: { contents: `
import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { SettingsHiddenContentView } from './frontend/src/components/SettingsHiddenContent.jsx';
import { SettingsProjectView } from './frontend/src/components/SettingsProject.jsx';
import './frontend/src/style.css';
const file = 'src/a-long-folder-name/a-long-file-name-for-mobile-testing.txt';
window.fixture = { file, fail: false, previewFail: false, loadFail: false, delay: 0, writes: [], rules: [] };
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin), f = window.fixture;
  let body = {}, status = 200;
  if (url.pathname === '/api/settings/hide-file-content') {
    if (options.method === 'PUT') {
      const payload = JSON.parse(options.body); f.writes.push(payload);
      await new Promise(resolve => setTimeout(resolve, f.delay));
      if (f.fail) status = 503;
      else f.rules = payload.rules;
    } else if (f.loadFail) status = 503;
    body = { rules: f.rules };
  } else if (url.pathname === '/api/file') {
    if (f.previewFail) { status = 413; body = { code: 'ETOOLARGE' }; }
    else body = { content: Array.from({length: 250}, (_, i) => 'Example line ' + (i + 1) + (i === 1 ? ' with_a_very_long_unbroken_value_'.repeat(8) : '')).join('\\n') };
  } else if (url.pathname === '/api/files') {
    body = { dir: '/fixture', browseTop: '/fixture', entries: [{type: 'file', name: file, path: '/fixture/' + file, relPath: file, size: 1000}] };
  } else if (url.pathname === '/api/settings/project') {
    body = { project: { hideFileContent: f.rules }, path: '/fixture/.mouaif.json' };
  } else if (url.pathname === '/api/settings/resolved') {
    body = { resolved: {} };
  } else if (url.pathname === '/api/tools/authorization') {
    body = { tools: {}, mcp: {} };
  } else if (url.pathname === '/api/tools/list') {
    body = { tools: [{ name: 'read_file', description: 'Read a project file' }] };
  } else if (url.pathname === '/api/mcp/servers') {
    body = { servers: [] };
  } else if (url.pathname === '/api/prompts') {
    body = { prompts: [] };
  } else if (url.pathname === '/api/agents') {
    body = { agents: [] };
  }
  return new Response(JSON.stringify(body), { status });
};
function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const fn = () => setHash(location.hash); addEventListener('hashchange', fn); return () => removeEventListener('hashchange', fn); }, []);
  const qs = new URLSearchParams(hash.split('?')[1] || '');
  const path = hash.split('?')[0];
  if (path === '#/settings/project') return h(SettingsProjectView, {projectDir: '/fixture', from: 'settings/projects'});
  return h(SettingsHiddenContentView, {projectDir: '/fixture', from: 'settings/projects', filePath: qs.get('file') || ''});
}
render(h(App), document.getElementById('root'));
`, resolveDir: process.cwd(), sourcefile: 'hidden-content-ui-fixture.jsx', loader: 'jsx' },
  bundle: true, write: false, outdir: '/tmp/mouaif-hidden-content-ui-fixture', format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><main id="root" class="app__main app__main--flush"></main><script type="module" src="/app.js"></script></html>');
  }
});
server.listen(0, '127.0.0.1', () => console.log('Hidden content UI fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000);
