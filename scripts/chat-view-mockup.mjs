// Build and serve the tracked review harness, never the mouaif app server.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

export async function buildMockup() {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: { mockup: 'scripts/chat-view-mockup/main.js', style: 'scripts/chat-view-mockup/style.css' },
    bundle: true, write: false, outdir: path.join(root, '.mouaif/chat-view-mockup'),
    format: 'iife', target: 'es2020',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' }
  });
  const files = new Map(bundle.outputFiles.map(file => [path.basename(file.path), file.contents]));
  // The app's local-preview proxy rewrites root paths in JavaScript, but its
  // text matcher also mistakes regex literals for paths and breaks this real
  // renderer bundle. Transport the unchanged bundle as a data-script URL so
  // the existing proxy only sees a small loader, not executable source to
  // rewrite. No eval, tool execution, or app-server change is needed.
  const scriptUrl = 'data:text/javascript;base64,' + Buffer.from(files.get('mockup.js')).toString('base64');
  files.set('mockup.js', Buffer.from(
    'const script = document.createElement("script");\n'
    + 'script.src = ' + JSON.stringify(scriptUrl) + ';\n'
    + 'document.body.appendChild(script);\n'
  ));
  // Keep one predictable stylesheet name in the standalone HTML.
  files.set('mockup.css', files.get('style.css'));
  files.delete('style.css');
  files.set('index.html', await fs.readFile(path.join(root, 'scripts/chat-view-mockup/index.html')));
  return files;
}

export async function serveMockup(files, port = 0) {
  files ||= await buildMockup();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    // Mock decisions in memory only. This server has no app API, tool runner,
    // provider, live chat, or settings store; all other API routes fail closed.
    if (req.method === 'POST' && url.pathname === '/api/tools/authorization/decision') {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = req.method === 'GET' && files.get(name);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8'
      : name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(file);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildMockup();
  const output = path.join(root, '.mouaif/chat-view-mockup');
  await fs.mkdir(output, { recursive: true });
  await Promise.all([...files].map(([name, contents]) => fs.writeFile(path.join(output, name), contents)));
  if (process.argv.includes('--build')) console.log('Built .mouaif/chat-view-mockup/index.html');
  else {
    const portArg = process.argv.find(arg => arg.startsWith('--port='));
    const server = await serveMockup(files, portArg ? Number(portArg.slice(7)) : 0);
    console.log('Chat view mockup: http://127.0.0.1:' + server.address().port + '/');
    const close = () => { server.closeAllConnections(); server.close(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  }
}
