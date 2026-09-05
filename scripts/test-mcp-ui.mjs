// Manual browser harness: real MCP editor, isolated fake API, no app changes.
// Run, open the printed loopback URL, then Ctrl-C (or wait five minutes).
// window.fixture exposes saved argv and OAuth status for browser assertions.
import http from 'node:http';
import { build } from 'esbuild';
const bundle = await build({
  stdin: { contents: `
    import { h, render } from 'preact';
    import { SettingsMcpEditView } from './frontend/src/components/SettingsMcpEdit.jsx';
    import './frontend/src/style.css';
    const server = { id: 'fixture', name: 'Fixture', transport: 'http', url: 'https://mcp.example/mcp', scope: 'app',
      command: 'node', args: ['/tmp/path with spaces/server.js', '', 'C:\\\\Program Files\\\\tool'],
      oauth: { enabled: true, clientId: '', scope: '' }, headers: {}, env: {}, tools: [] };
    window.fixture = { server, saved: null, connected: false, pending: false };
    window.fetch = async (url, options = {}) => {
      let value;
      if (url.includes('/oauth/start')) { window.fixture.pending = true; value = { authorizationUrl: 'https://login.example/authorize', redirectUrl: location.origin + '/oauth/mcp/callback' }; }
      else if (url.includes('/oauth') && options.method === 'DELETE') { window.fixture.connected = false; window.fixture.pending = false; value = { ok: true }; }
      else if (url.includes('/oauth')) value = { connected: window.fixture.connected, pending: window.fixture.pending };
      else if (options.method === 'PATCH') { window.fixture.saved = JSON.parse(options.body); value = { server }; }
      else value = { servers: [server] };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    render(h(SettingsMcpEditView, { id: 'fixture', scope: 'app' }), document.getElementById('root'));
  `, resolveDir: process.cwd(), sourcefile: 'mcp-ui-fixture.jsx', loader: 'jsx' },
  bundle: true, write: false, outdir: '/tmp/mouaif-mcp-ui-fixture', format: 'esm',
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
server.listen(0, '127.0.0.1', () => console.log('MCP UI fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 5 * 60 * 1000);
