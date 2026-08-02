// Live-server smoke test for the PWA manifest, service worker, icons,
// and the index.html metadata. Stands up an in-process server on an
// ephemeral port, then asserts the contracts documented in
// docs/features/pwa.md: the manifest is reachable at /web/manifest.webmanifest
// with the right MIME, the SW is reachable at /web/sw.js with the
// Service-Worker-Allowed + no-cache headers, the index.html links to
// the manifest + apple-touch-icon, and the icons resolve.
'use strict';

const http = require('http');
const path = require('path');

const { createServer } = require('../src/index.js');

const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('listening on', port);

  function req(method, urlPath) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // latin1 keeps the raw bytes intact for binary content
          // (icons). Buffers decoded as utf8 would fold high-bit
          // bytes into U+FFFD replacement characters and break the
          // PNG magic check below.
          const text = Buffer.concat(chunks).toString('latin1');
          resolve({ status: res.statusCode, headers: res.headers, body: text });
        });
      });
      r.on('error', reject);
      r.end();
    });
  }

  function assert(cond, msg) {
    if (!cond) { throw new Error('assertion failed: ' + msg); }
  }

  (async () => {
    try {
      // 1. GET /web/ -> index.html with manifest + apple-touch-icon <link>s.
      const home = await req('GET', '/web/');
      assert(home.status === 200, 'home: status 200');
      assert(/<link rel="manifest"/i.test(home.body), 'home: <link rel="manifest"> present');
      assert(/href="\/web\/manifest\.webmanifest"/i.test(home.body), 'home: manifest href');
      assert(/<link rel="apple-touch-icon"/i.test(home.body), 'home: <link rel="apple-touch-icon"> present');
      assert(/theme-color/i.test(home.body), 'home: theme-color meta present');
      assert(/<title>mouaif<\/title>/i.test(home.body), 'home: title present');

      // 2. GET /web/manifest.webmanifest -> JSON-ish, correct MIME, must declare icons.
      const manifest = await req('GET', '/web/manifest.webmanifest');
      assert(manifest.status === 200, 'manifest: status 200');
      assert(/application\/manifest\+json/.test(manifest.headers['content-type'] || ''), 'manifest: content-type');
      const m = JSON.parse(manifest.body);
      assert(m.name === 'mouaif', 'manifest: name');
      assert(m.id === '/web/', 'manifest: stable same-origin app id');
      assert(m.start_url === '/web/', 'manifest: start_url');
      assert(m.scope === '/web/', 'manifest: scope');
      assert(m.display === 'standalone', 'manifest: display');
      assert(m.theme_color === '#111418', 'manifest: theme_color matches app palette');
      assert(Array.isArray(m.icons) && m.icons.length >= 3, 'manifest: at least 3 icons declared');
      for (const size of ['192x192', '512x512']) {
        const hit = m.icons.find((i) => i.sizes === size);
        assert(hit, 'manifest: contains a ' + size + ' icon');
        assert(/^\/web\//.test(hit.src), 'manifest: icon src is absolute under /web/');
      }

      // 3. GET /web/sw.js -> JS body + Service-Worker-Allowed + no-cache.
      const sw = await req('GET', '/web/sw.js');
      assert(sw.status === 200, 'sw: status 200');
      assert(/javascript/i.test(sw.headers['content-type'] || ''), 'sw: javascript content-type');
      assert(sw.headers['service-worker-allowed'] === '/web/', 'sw: Service-Worker-Allowed: /web/');
      assert((sw.headers['cache-control'] || '').toLowerCase().indexOf('no-cache') >= 0, 'sw: Cache-Control: no-cache');
      // SW must include the precache list so the very first install
      // primes the cache.
      assert(sw.body.indexOf('install') >= 0, 'sw: install handler present');
      assert(sw.body.indexOf('fetch') >= 0, 'sw: fetch handler present');
      assert(sw.body.indexOf('activate') >= 0, 'sw: activate handler present');
      assert(sw.body.indexOf('CACHE_VERSION') >= 0, 'sw: hash baked in');
      // SW must guard out /api/* (live data surface, must never be cached).
      assert(sw.body.indexOf('/web/api/') >= 0 || sw.body.indexOf('/api/') >= 0, 'sw: /api/ bypass present');
      assert(sw.body.indexOf("addEventListener('push'") >= 0, 'sw: push handler present');
      assert(sw.body.indexOf("addEventListener('notificationclick'") >= 0, 'sw: notification click handler present');
      assert(sw.body.indexOf('/api/tools/authorization/decision') >= 0, 'sw: notification actions submit decisions');
      assert(sw.body.indexOf('allow-once') >= 0, 'sw: allow-once action supported');
      assert(sw.body.indexOf('answer-') >= 0, 'sw: quick-answer action supported');
      assert(sw.body.indexOf('getNotifications') >= 0, 'sw: prunes old same-tag notifications before showing (iOS replace)');
      assert(sw.body.indexOf("postMessage({ type: 'NAVIGATE'") >= 0, 'sw: focuses the existing app window via NAVIGATE postMessage');

      // 4. Icon reachability + content-type. All three declared sizes.
      for (const rel of ['/web/icons/icon-192.png', '/web/icons/icon-512.png', '/web/icons/icon-maskable-512.png']) {
        const icon = await req('GET', rel);
        assert(icon.status === 200, rel + ': status 200');
        assert((icon.headers['content-type'] || '').indexOf('image/png') >= 0, rel + ': image/png');
        // PNG magic bytes.
        const buf = Buffer.from(icon.body, 'binary');
        assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, rel + ': PNG magic');
      }

      // 5. Favicon endpoint returns the 32x32 PNG now.
      const fav = await req('GET', '/favicon.ico');
      assert(fav.status === 200, 'favicon: status 200');
      assert((fav.headers['content-type'] || '').indexOf('image/png') >= 0, 'favicon: image/png');

      // 6. Cache-Control headers on hashed assets: immutable.
      const cssReq = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(home.body);
      assert(cssReq, 'home: css link present');
      const css = await req('GET', cssReq[1]);
      assert(css.status === 200, 'css: status 200');
      assert((css.headers['cache-control'] || '').toLowerCase().indexOf('immutable') >= 0, 'css: immutable Cache-Control');

      console.log('OK — PWA manifest, service worker, and icons all served correctly');
      server.close();
      process.exit(0);
    } catch (e) {
      console.error('FAIL:', e && e.stack || e);
      server.close();
      process.exit(1);
    }
  })();
});
