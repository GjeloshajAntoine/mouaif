// Flush-route scroll fixture — the real settings views inside the real shell.
//
// Flush routes (no tab bar) render into `.app__main--flush`, whose scroll
// container is a *direct `<section>` child* (the `.app__main--flush > section`
// rule in layout.css). A view that returns a bare Fragment instead gets no
// scroll container at all: everything below the fold is clipped with no way to
// reach it. SettingsDefaults, SettingsProjects, SettingsProviders and
// SettingsTags all shipped that way.
//
// Run `node scripts/test-flush-scroll-ui.mjs`, then point the Chrome debug
// session at the printed URL. The page exposes `window.__mount(name, props)`
// so a browser check can render each view and assert its root `<section>`
// reports `overflow-y: auto` and actually advances `scrollTop`.
import http from 'node:http';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      import { h, render } from 'preact';
      import { SettingsDefaultsView } from './frontend/src/components/SettingsDefaults.jsx';
      import { SettingsProjectsView } from './frontend/src/components/SettingsProjects.jsx';
      import { SettingsTagsView } from './frontend/src/components/SettingsTags.jsx';
      import { SettingsProvidersView } from './frontend/src/components/SettingsProviders.jsx';
      import { SettingsNotificationsView } from './frontend/src/components/SettingsNotifications.jsx';
      import { SettingsAboutView } from './frontend/src/components/SettingsAbout.jsx';
      import { SettingsPricingView } from './frontend/src/components/SettingsPricing.jsx';
      import { SettingsMcpView } from './frontend/src/components/SettingsMcp.jsx';
      import './frontend/src/style.css';

      window.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
      window.localStorage.clear();
      window.__views = {
        SettingsDefaultsView, SettingsProjectsView, SettingsTagsView, SettingsProvidersView,
        SettingsNotificationsView, SettingsAboutView, SettingsPricingView, SettingsMcpView
      };
      window.__mount = (name, props) => {
        const root = document.getElementById('root');
        render(null, root);
        render(h(window.__views[name], props || {}), root);
      };
    `,
    resolveDir: process.cwd(),
    sourcefile: 'flush-scroll-fixture.jsx',
    loader: 'jsx'
  },
  bundle: true,
  write: false,
  outdir: '/tmp/mouaif-flush-scroll',
  format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map(f => [f.path.endsWith('.css') ? '/app.css' : '/app.js', f.text]));

// The shell markup App.jsx renders for a flush route: a flex-column <main>
// carrying both classes, inside `.app__shell`.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/app.css"></head>
<body><div id="app" class="app__shell">
<main id="root" class="app__main app__main--flush"></main>
</div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return res.end(files[req.url]);
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

server.listen(0, '127.0.0.1', () => {
  console.log('flush-scroll fixture: http://127.0.0.1:' + server.address().port);
});
setTimeout(() => { server.closeAllConnections(); server.close(); }, 5 * 60 * 1000).unref?.();
