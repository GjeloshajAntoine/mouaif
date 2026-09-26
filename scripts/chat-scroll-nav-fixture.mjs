// Chat scroll-nav fixture — the real ChatView with a long, fake transcript.
//
// Run `node scripts/chat-scroll-nav-fixture.mjs [port]`, then point the Chrome
// debug session at the printed URL (phone viewport). Every API call is
// answered in-page, so no server or sign-in is needed. Use it to check the
// transcript's previous / next / bottom arrows: where they sit, and that each
// tap moves the transcript.
import http from 'node:http';
import { build } from 'esbuild';

const port = Number(process.argv[2]) || 0;
const bundle = await build({
  stdin: {
    contents: `
      import { h, render } from 'preact';
      import { ChatView } from './frontend/src/components/chat/Chat.jsx';
      import './frontend/src/style.css';
      const msgs = [];
      for (let i = 0; i < 40; i++) {
        msgs.push({
          seq: i, role: i % 2 ? 'assistant' : 'user', ts: Date.now(),
          content: 'Message ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(6 + (i % 5) * 4)
        });
      }
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      window.fetch = async (url) => {
        url = String(url);
        if (/\\/api\\/chats\\/c1\\/messages/.test(url)) return json({ messages: msgs, total: msgs.length, hasMore: false, nextSeq: msgs.length });
        if (/\\/api\\/chats\\/c1\\?/.test(url)) return json({ chat: { id: 'c1', name: 'Scroll nav', tools: null } });
        return json({});
      };
      window.EventSource = class { constructor() {} close() {} addEventListener() {} };
      render(h(ChatView, { chatId: 'c1', projectDir: '/tmp/fixture' }), document.getElementById('root'));
    `,
    resolveDir: process.cwd(),
    sourcefile: 'chat-scroll-nav-fixture.jsx',
    loader: 'jsx'
  },
  bundle: true,
  // The transcript is all this fixture exercises; keep ChatView's lazy
  // sheets out of the bundle so an unrelated one cannot break the build.
  splitting: true,
  write: false,
  outdir: '/tmp/mouaif-chat-scroll-nav',
  format: 'esm',
  plugins: [{
    name: 'stub-lazy-sheets',
    setup(b) {
      b.onResolve({ filter: /\/WebpreviewModal\.jsx$/ }, () => ({ path: 'stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const WebpreviewModal = () => null;', loader: 'js' }));
    }
  }],
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }
});
// The entry chunk is served as /app.js and the stylesheet as /app.css; lazy
// chunks keep their own names next to it.
const files = {};
for (const f of bundle.outputFiles) {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  if (name.endsWith('.css')) files['/app.css'] = (files['/app.css'] || '') + f.text;
  else if (name === 'stdin.js') files['/app.js'] = f.text;
  else files['/' + name] = f.text;
}

// The shell markup App.jsx renders for the chat route.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/app.css"></head>
<body><div id="app" class="app__shell">
<main id="root" class="app__main app__main--flush app__main--chat"></main>
</div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (files[p]) {
    res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return res.end(files[p]);
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});
server.listen(port, '127.0.0.1', () => {
  console.log('chat scroll-nav fixture: http://127.0.0.1:' + server.address().port);
});
setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000).unref?.();
