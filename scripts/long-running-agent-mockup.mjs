// Build and serve the long-running agent mockup, never the mouaif app server.
//
// The mockup is a review harness: it renders the chat view with the
// production stylesheet and the production transcript renderers, plus a
// mockup-local long-running run card and a run designer. It never calls an
// app API, a provider, a tool runner or a settings store.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

export async function buildMockup() {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: {
      mockup: 'scripts/long-running-agent-mockup/main.js',
      style: 'scripts/long-running-agent-mockup/style.css'
    },
    bundle: true,
    write: false,
    outdir: path.join(root, '.mouaif/long-running-agent-mockup'),
    format: 'iife',
    target: 'es2020',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' }
  });
  const files = new Map(bundle.outputFiles.map(file => [path.basename(file.path), file.contents]));
  // The app's local-preview proxy rewrites root paths inside JavaScript, and
  // its text matcher mistakes regex literals for paths. Transport the bundle
  // as a data-script URL so the proxy only sees a small loader.
  const scriptUrl = 'data:text/javascript;base64,' + Buffer.from(files.get('mockup.js')).toString('base64');
  files.set('mockup.js', Buffer.from(
    'const script = document.createElement("script");\n'
    + 'script.src = ' + JSON.stringify(scriptUrl) + ';\n'
    + 'document.body.appendChild(script);\n'
  ));
  files.set('mockup.css', files.get('style.css'));
  files.delete('style.css');
  files.set('index.html', await fs.readFile(path.join(root, 'scripts/long-running-agent-mockup/index.html')));
  return files;
}

export async function serveMockup(files, port = 0) {
  files ||= await buildMockup();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    // No app API here: every API route fails closed. The mockup is a static
    // page with a local simulation.
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This preview has no app API' }));
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
  const output = path.join(root, '.mouaif/long-running-agent-mockup');
  await fs.mkdir(output, { recursive: true });
  await Promise.all([...files].map(([name, contents]) => fs.writeFile(path.join(output, name), contents)));
  if (process.argv.includes('--build')) console.log('Built .mouaif/long-running-agent-mockup/index.html');
  else {
    const portArg = process.argv.find(arg => arg.startsWith('--port='));
    const server = await serveMockup(files, portArg ? Number(portArg.slice(7)) : 0);
    console.log('Long-running agent mockup: http://127.0.0.1:' + server.address().port + '/');
    const close = () => { server.closeAllConnections(); server.close(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  }
}
