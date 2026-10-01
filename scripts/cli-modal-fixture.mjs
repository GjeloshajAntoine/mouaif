// CLI modal UI fixture — the real modal, the real stylesheet, stubbed
// /api/tools/cli routes and a stubbed EventSource.
//
// Run `node scripts/cli-modal-fixture.mjs --write /tmp/mouaif-cli-modal` and
// serve the directory with any static server, then open it at 390px wide.
// The page mounts `CliModal` directly, so what it shows is what the chat shows.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const INDEX_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<link rel="stylesheet" href="/app.css"></head>'
  + '<body><main id="root"></main>'
  + '<script type="module" src="/app.js"></script></body></html>';

const bundle = await build({
  stdin: {
    contents: `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { CliModal } from './frontend/src/components/chat/CliModal.jsx';
import './frontend/src/style.css';

const OUTPUT = [
  'Welcome to the mouaif sandbox shell',
  '',
  '$ ls',
  'frontend  package.json  src  scripts',
  '',
  '$ git status',
  'On branch master',
  'nothing to commit, working tree clean',
  '',
  '$ npm run build:web',
  'vite v5.4.0 building for production...',
  '\\u2713 2191 modules transformed.',
  'dist/assets/index-DPhWahLC.js  412.03 kB \\u2502 gzip: 122.11 kB',
  '\\u2713 built in 4.12s',
  ''
].join('\\r\\n');

const realFetch = window.fetch;
window.fetch = async (url, init) => {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
  if (u.startsWith('/api/tools/cli/session')) {
    return json({ id: 'cli_fixture', projectDir: '/home/ubuntu/mouaif', shell: '/bin/bash', interactive: true, startedAt: Date.now(), defaultDir: '/home/ubuntu/mouaif' });
  }
  if (u.startsWith('/api/tools/cli/output')) {
    return json({ id: 'cli_fixture', running: true, seq: 3, firstSeq: 1, dropped: false, bytes: OUTPUT.length, chunks: [
      { seq: 1, stream: 'stdout', data: OUTPUT }
    ] });
  }
  if (u.startsWith('/api/tools/cli/command')) return json({ ok: true });
  if (u.startsWith('/api/files')) {
    return json({ entries: [
      { name: 'frontend', type: 'dir' }, { name: 'src', type: 'dir' },
      { name: 'scripts', type: 'dir' }, { name: 'package.json', type: 'file' },
      { name: 'README.md', type: 'file' }
    ] });
  }
  return realFetch(url, init);
};

class FakeEventSource {
  constructor() { this.listeners = {}; window.__es = this; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  emit(type, data) { (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
  close() {}
}
window.EventSource = FakeEventSource;

function Host() {
  const [open, setOpen] = useState(true);
  window.fixture = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    emit: (data) => { if (window.__es) window.__es.emit('cli_output', data); },
    clickKey: (label) => {
      const btn = Array.from(document.querySelectorAll('.cli__key')).find((b) => b.textContent === label);
      if (btn) btn.click();
      return !!btn;
    },
    type: (text) => {
      const input = document.querySelector('.cli__prompt');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    measure: () => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const head = document.querySelector('.cli__head');
      return {
        viewport: { w: innerWidth, h: innerHeight },
        head: rect(head),
        headChildren: head ? Array.from(head.children).map((c) => ({ cls: c.className, rect: rect(c) })) : null,
        out: rect(document.querySelector('.cli__out')),
        keys: Array.from(document.querySelectorAll('.cli__key')).map((b) => ({ label: b.textContent, rect: rect(b) })),
        hint: rect(document.querySelector('.cli__hint')),
        prompt: rect(document.querySelector('.cli__prompt')),
        outTail: (document.querySelector('.cli__out') || {}).textContent ? document.querySelector('.cli__out').textContent.slice(-260) : null
      };
    }
  };
  return h('div', { class: 'app__shell' },
    h('button', { class: 'btn', type: 'button', onClick: () => setOpen(true) }, 'Open CLI'),
    open ? h(CliModal, { projectDir: '/home/ubuntu/mouaif', onClose: () => setOpen(false) }) : null
  );
}
render(h(Host), document.getElementById('root'));
`,
    resolveDir: process.cwd(),
    sourcefile: 'cli-modal-fixture.jsx',
    loader: 'jsx'
  },
  bundle: true,
  write: false,
  outdir: '/tmp/mouaif-cli-modal-fixture',
  format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});

const files = Object.fromEntries(bundle.outputFiles.map((file) => [
  file.path.endsWith('.css') ? '/app.css' : '/app.js',
  file.text
]));

const writeDirIndex = process.argv.indexOf('--write');
if (writeDirIndex !== -1) {
  const dir = process.argv[writeDirIndex + 1] || '/tmp/mouaif-cli-modal';
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  console.log('CLI modal fixture written to ' + dir);
} else {
  const server = http.createServer((req, res) => {
    if (files[req.url]) {
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
      res.end(files[req.url]);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(INDEX_HTML);
    }
  });
  server.listen(0, '127.0.0.1', () => console.log('CLI modal fixture: http://127.0.0.1:' + server.address().port));
  setTimeout(() => { server.closeAllConnections(); server.close(); }, 30 * 60 * 1000);
}
