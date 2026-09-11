'use strict';

// Live-server test for the Content-Security-Policy the app ships with.
//
// The policy is defence in depth behind the escaping each surface already
// does: it is what stops a markup-injection bug (the SVG file preview that
// fed a project file's bytes to innerHTML, for example) from becoming
// script execution in the app origin, where the access cookie and the whole
// `/api/*` surface live. See docs/features/content-security-policy.md.
//
// Asserted here:
//   * the app shell (`/`) carries the policy, and script-src is exactly
//     'self' — no 'unsafe-inline', no 'unsafe-eval', no remote origin;
//   * the SPA fallback route serves the same document and the same header;
//   * static assets are NOT policy-carrying documents (only .html is), so an
//     asset can never be turned into a document by a future cache rule;
//   * `nosniff` and `Referrer-Policy` ride along on the document.

const http = require('http');

const { createServer } = require('../src/index.js');
const { WEB_CSP } = require('../src/server-web-static.js');

let pass = 0;
let fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log('  ok   - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (msg ? (' :: ' + msg) : '')); }
}

// parseCsp(header) -> { 'script-src': "'self'", ... }
function parseCsp(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp === -1) out[trimmed] = '';
    else out[trimmed.slice(0, sp)] = trimmed.slice(sp + 1);
  }
  return out;
}

const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;

  function req(method, urlPath) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      r.on('error', reject);
      r.end();
    });
  }

  (async () => {
    try {
      // ---- 1. The app shell carries the policy ----------------------

      const home = await req('GET', '/');
      check('GET / is 200', home.status === 200, 'status ' + home.status);
      const csp = home.headers['content-security-policy'];
      check('GET / sends a Content-Security-Policy', !!csp);
      check('the header is the app policy verbatim', csp === WEB_CSP);

      const d = parseCsp(csp);
      check("script-src is exactly 'self'", d['script-src'] === "'self'", JSON.stringify(d['script-src']));
      check('script-src allows no inline script', !/unsafe-inline/.test(d['script-src'] || ''));
      check('script-src allows no eval', !/unsafe-eval/.test(d['script-src'] || ''));
      check('no remote origin can serve script', !/https?:\/\//.test(d['script-src'] || ''));
      check("default-src is 'self'", d['default-src'] === "'self'");
      check("object-src is 'none'", d['object-src'] === "'none'");
      check("base-uri is 'none'", d['base-uri'] === "'none'");
      check("form-action is 'self'", d['form-action'] === "'self'");
      check('connect-src keeps same-origin fetch, SSE and the CDP socket', /'self'/.test(d['connect-src'] || '') && /\bws:/.test(d['connect-src'] || ''));
      check('img-src keeps the data: image previews', /data:/.test(d['img-src'] || ''));
      check('worker-src keeps the service worker', /'self'/.test(d['worker-src'] || ''));
      check('frame-ancestors still allows a local shell to embed the UI',
        /localhost:\*/.test(d['frame-ancestors'] || '') && /127\.0\.0\.1:\*/.test(d['frame-ancestors'] || ''));
      check('frame-ancestors blocks remote framing', !/(^|\s)\*(\s|$)|https:\/\/\*/.test(d['frame-ancestors'] || ''));

      check('nosniff rides along on the document', home.headers['x-content-type-options'] === 'nosniff');
      check('a referrer policy rides along on the document', !!home.headers['referrer-policy']);

      // The document must actually be the app shell, not a JSON error.
      check('GET / served the app shell', /<main id="app">/.test(home.body), home.body.slice(0, 80));

      // ---- 2. The SPA fallback is the same document -----------------

      const spa = await req('GET', '/not-a-real-route');
      check('the SPA fallback is 200 + the app shell',
        spa.status === 200 && /<main id="app">/.test(spa.body), 'status ' + spa.status);
      check('the SPA fallback carries the same policy',
        spa.headers['content-security-policy'] === WEB_CSP);

      // ---- 3. Assets are not documents ------------------------------

      // Pull one real hashed bundle out of the shell, then ask for it.
      const asset = (home.body.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
      check('the shell references a hashed bundle', !!asset, home.body.slice(0, 200));
      if (asset) {
        const js = await req('GET', asset);
        check('the bundle is served', js.status === 200, 'status ' + js.status);
        check('the bundle carries no policy header', !js.headers['content-security-policy']);
        check('the bundle is served as javascript', /javascript/.test(js.headers['content-type'] || ''));
      }

      const man = await req('GET', '/manifest.webmanifest');
      check('the manifest is served', man.status === 200, 'status ' + man.status);
      check('the manifest carries no policy header', !man.headers['content-security-policy']);

      // ---- 4. The policy has no obviously broken directive ----------

      for (const [name, value] of Object.entries(d)) {
        check('directive ' + name + ' has a value', String(value).trim().length > 0, JSON.stringify(value));
      }
    } catch (err) {
      fail++;
      console.log('  FAIL - ' + err.message);
    } finally {
      console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
      server.close();
      if (fail) process.exitCode = 1;
    }
  })();
});
