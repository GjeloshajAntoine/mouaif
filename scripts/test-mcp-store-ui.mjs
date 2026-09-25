// Manual browser harness: the real MCP store view, isolated fake API.
// Run, open the printed loopback URL, then Ctrl-C (or wait five minutes).
// /api/mcp/registry is proxied to the live official registry (read-only);
// /api/mcp/servers is an in-memory fake, and window.fixture exposes what the
// store POSTed so a browser check can assert on it. No app state is touched.
import http from 'node:http';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    import { h, render } from 'preact';
    import { SettingsMcpRegistryView } from './frontend/src/components/SettingsMcpRegistry.jsx';
    import './frontend/src/style.css';
    const params = new URLSearchParams(location.search);
    render(h(SettingsMcpRegistryView, { projectDir: params.get('projectDir') || '' }), document.getElementById('root'));
  `, resolveDir: process.cwd(), sourcefile: 'mcp-store-fixture.jsx', loader: 'jsx' },
  bundle: true, write: false, outdir: '/tmp/mouaif-mcp-store-fixture', format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const servers = [];
const posted = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => resolve(s)); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (files[url.pathname]) {
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return res.end(files[url.pathname]);
  }
  if (url.pathname === '/api/mcp/registry') {
    const up = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
    for (const k of ['search', 'cursor', 'limit']) if (url.searchParams.get(k)) up.searchParams.set(k, url.searchParams.get(k));
    up.searchParams.set('version', 'latest');
    try {
      const r = await fetch(up, { headers: { Accept: 'application/json' } });
      const body = await r.json();
      return json(res, 200, { servers: (body.servers || []).map((e) => Object.assign({ popularity: { score: 50 } }, e)), metadata: body.metadata || {} });
    } catch (e) { return json(res, 502, { error: 'Registry proxy error: ' + e.message }); }
  }
  if (url.pathname === '/api/mcp/servers' && req.method === 'GET') return json(res, 200, { servers });
  if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    posted.push(body);
    const s = Object.assign({ id: 'srv' + servers.length, status: 'stopped', tools: [] }, body);
    servers.push(s);
    return json(res, 201, { server: s });
  }
  const m = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
  if (m) return json(res, 200, { server: { id: m[1], status: 'ready', tools: [{ name: 'a' }, { name: 'b' }] } });
  if (url.pathname === '/__posted') return json(res, 200, posted);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="app"><div class="app__shell"><main id="root" class="app__main app__main--flush"></main></div></div><script type="module" src="/app.js"></script></body></html>');
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => console.log('MCP store fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 5 * 60 * 1000);
