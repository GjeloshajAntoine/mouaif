'use strict';

// Tests for the local preview proxy (src/previewProxy.js):
//   - path parsing / normalisation and the authority rules;
//   - the local-host allow-list, including the Docker host aliases;
//   - proxyPathFor() mirroring what the frontend helper builds;
//   - an end-to-end round trip through the real server against a stand-in
//     dev server: the page, a relative asset, the query string, a redirect,
//     and the headers that must NOT cross (cookies either way);
//   - the refusals: a remote host, a non-GET method, a bad scheme.
// See docs/features/local-preview-proxy.md.

require('./lib/test-home.js').isolate('mouaif-preview-proxy-');

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const proxy = require('../src/previewProxy.js');
const { createServer } = require('../src/index.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}

// ---- path parsing --------------------------------------------------------

ok('a proxy path is parsed into scheme, authority and target path', () => {
  const t = proxy.parseProxyPath('/api/preview/http/localhost:5173/src/main.jsx');
  assert.equal(t.scheme, 'http');
  assert.equal(t.host, 'localhost');
  assert.equal(t.port, 5173);
  assert.equal(t.targetPath, '/src/main.jsx');
  assert.equal(t.upstream, 'http://localhost:5173/src/main.jsx');
});

ok('a missing slash after the authority means the root path', () => {
  assert.equal(proxy.parseProxyPath('/api/preview/http/localhost:5173').targetPath, '/');
  assert.equal(proxy.parseProxyPath('/api/preview/http/localhost:5173').upstream, 'http://localhost:5173/');
});

ok('a trailing slash after the authority keeps the root path', () => {
  assert.equal(proxy.parseProxyPath('/api/preview/http/localhost:5173/').targetPath, '/');
});

ok('a non-proxy path parses to null', () => {
  assert.equal(proxy.parseProxyPath('/api/chats'), null);
  assert.equal(proxy.parseProxyPath('/'), null);
});

ok('the scheme defaults the port', () => {
  assert.equal(proxy.parseProxyPath('/api/preview/https/example.localhost/').port, 443);
  assert.equal(proxy.parseProxyPath('/api/preview/http/127.0.0.1/').port, 80);
});

ok('a custom port is kept, and an out-of-range one is refused', () => {
  assert.equal(proxy.parseProxyPath('/api/preview/http/localhost:8080/x').port, 8080);
  assert.throws(() => proxy.parseProxyPath('/api/preview/http/localhost:99999/x'), /Invalid preview proxy authority/);
  assert.throws(() => proxy.parseProxyPath('/api/preview/http/localhost:0/x'), /Invalid preview proxy authority/);
});

ok('a bad scheme is refused with a typed error', () => {
  assert.throws(() => proxy.parseProxyPath('/api/preview/file/tmp/x.html'), (e) => e.code === 'EBADINPUT');
  assert.throws(() => proxy.parseProxyPath('/api/preview/'), /needs a scheme/);
  assert.throws(() => proxy.parseProxyPath('/api/preview/http/'), /needs a host/);
});

ok('userinfo cannot be smuggled into the authority', () => {
  assert.throws(() => proxy.parseProxyPath('/api/preview/http/user@localhost:5173/'), /Invalid preview proxy authority/);
});

ok('a remote host is refused, not proxied', () => {
  const e = (() => { try { proxy.parseProxyPath('/api/preview/http/example.com/'); return null; } catch (err) { return err; } })();
  assert.ok(e, 'example.com was accepted');
  assert.equal(e.code, 'EREMOTE_HOST');
});

ok('an IPv6 loopback authority parses', () => {
  const t = proxy.parseProxyPath('/api/preview/http/[::1]:5173/app');
  assert.equal(t.host, '::1');
  assert.equal(t.port, 5173);
  assert.equal(t.upstream, 'http://[::1]:5173/app');
});

// ---- host allow-list -----------------------------------------------------

ok('loopback names are local', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(proxy.isLocalHost(h), true, h);
  }
});

ok('the container-to-host aliases are local', () => {
  for (const h of ['host.docker.internal', 'gateway.docker.internal', 'host.containers.internal']) {
    assert.equal(proxy.isLocalHost(h), true, h);
  }
});

ok('everything else is not local', () => {
  for (const h of ['example.com', '192.168.1.10', '10.0.0.1', 'localhost.evil.com', '127.0.0.1.evil.com', '']) {
    assert.equal(proxy.isLocalHost(h), false, h);
  }
});

// ---- proxyPathFor --------------------------------------------------------

ok('proxyPathFor builds the proxy path for a local URL', () => {
  assert.equal(proxy.proxyPathFor('http://localhost:5173/'), '/api/preview/http/localhost:5173/');
  assert.equal(proxy.proxyPathFor('http://127.0.0.1:3000/src/a.js'), '/api/preview/http/127.0.0.1:3000/src/a.js');
  assert.equal(proxy.proxyPathFor('https://localhost/app'), '/api/preview/https/localhost/app');
});

ok('proxyPathFor keeps the percent-encoding, the query and the fragment', () => {
  assert.equal(
    proxy.proxyPathFor('http://localhost:5173/a%20b/c.js?raw&x=%2F#top'),
    '/api/preview/http/localhost:5173/a%20b/c.js?raw&x=%2F#top'
  );
});

ok('proxyPathFor leaves a remote or non-http URL alone', () => {
  for (const u of ['https://example.com/', 'file:///tmp/a.html', 'data:text/html,<b>x</b>', 'about:blank', 'nope']) {
    assert.equal(proxy.proxyPathFor(u), null, u);
  }
});

// ---- root-absolute URL rewriting -----------------------------------------

const P = '/api/preview/http/localhost:5173/';

ok('a quoted HTML attribute is pointed back at the proxy', () => {
  assert.equal(
    proxy.prefixRootPaths('<script type="module" src="/src/main.jsx"></script>', P),
    '<script type="module" src="' + P + 'src/main.jsx"></script>'
  );
  assert.equal(
    proxy.prefixRootPaths("<link href='/style.css' rel='stylesheet'>", P),
    "<link href='" + P + "style.css' rel='stylesheet'>"
  );
});

ok('a JS bare module specifier is rewritten (how Vite serves a module)', () => {
  const out = proxy.prefixRootPaths('import "/@fs/home/u/x/node_modules/.vite/deps/preact.js";\nimport { a } from "/src/a.js";\n', P);
  assert.match(out, /import "\/api\/preview\/http\/localhost:5173\/@fs\/home\/u\/x/);
  assert.match(out, /from "\/api\/preview\/http\/localhost:5173\/src\/a\.js"/);
});

ok('a CSS url() and an @import are rewritten', () => {
  assert.equal(proxy.prefixRootPaths('a{background:url(/bg.png)}', P), 'a{background:url(' + P + 'bg.png)}');
  assert.equal(proxy.prefixRootPaths('@import "/base.css";', P), '@import "' + P + 'base.css";');
});

ok('a protocol-relative URL, the root itself, and a data: URL are left alone', () => {
  const src = 'x="/" y="//cdn.example.com/a.js" z="data:text/css,/x"';
  assert.equal(proxy.prefixRootPaths(src, P), src);
});

ok('an already-proxied path is not double-prefixed (the rewrite is idempotent)', () => {
  const once = proxy.prefixRootPaths('src="/src/main.jsx"', P);
  assert.equal(proxy.prefixRootPaths(once, P), once);
});

ok('prose and arithmetic are not touched', () => {
  const src = 'const half = a /b; // see /usr/local and 1 /2 /3\n';
  assert.equal(proxy.prefixRootPaths(src, P), src);
  const prose = '<p>Use /src for sources and /tmp for scratch.</p>';
  // A run of plain prose has no quote or `url(` in front of it: untouched.
  assert.equal(proxy.prefixRootPaths(prose, P), prose);
});

ok('prefixFor builds a prefix that already ends in a slash', () => {
  const t = proxy.parseProxyPath('/api/preview/http/localhost:5173');
  assert.equal(proxy.prefixFor(t), P);
});

// ---- end to end ----------------------------------------------------------

// A stand-in dev server: one HTML document with a relative script, one asset,
// and a redirect. It also records what reached it.
const seenRequests = [];
function startUpstream() {
  const server = http.createServer((req, res) => {
    seenRequests.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url.startsWith('/redirect')) {
    res.writeHead(302, { Location: '/after-redirect' });
    res.end();
    return;
    }
    if (req.url.startsWith('/absolute-redirect')) {
    res.writeHead(302, { Location: 'http://127.0.0.1:' + req.socket.localPort + '/after-redirect' });
    res.end();
    return;
    }
    if (req.url.startsWith('/style.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('a{background:url(/bg.png)}\n');
    return;
    }
    if (req.url.startsWith('/bg.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return;
    }
    if (req.url.startsWith('/after-redirect')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('landed');
      return;
    }
    if (req.url.startsWith('/asset.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('export const n = 1;\n');
      return;
    }
    if (req.url.startsWith('/echo-query')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
    return;
    }
    if (req.url.startsWith('/json-data')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ redirect: '/login', paths: ['/a', '/b'] }));
    return;
    }
    // The page is served **gzipped** on purpose: the proxy asks for
    // `identity`, `fetch` decodes whatever arrives regardless, and the test
    // pins that the decoded body survives (and that the upstream's byte count
    // is not passed off as the length of the decoded body).
    const html = zlib.gzipSync('<!doctype html><title>dev</title><link rel="stylesheet" href="/style.css"><script type="module" src="./asset.js"></script>');
    res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': 'upstream=secret; Path=/',
    'X-Frame-Options': 'DENY',
    'Content-Encoding': 'gzip',
    'Content-Length': String(html.length)
    });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const upstream = await startUpstream();
  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = '/api/preview/http/127.0.0.1:' + upstream.port;

  await okAsync('the proxied page is served from the mouaif origin', async () => {
    seenRequests.length = 0;
    const r = await request(port, 'GET', base + '/', { Accept: '*/*' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /<title>dev<\/title>/);
    // A live page must not be cached: the next request would show the old build.
    assert.match(r.headers['cache-control'], /no-store/);
  });

  await okAsync('the frame-blocking headers of the dev server do not cross', async () => {
    const r = await request(port, 'GET', base + '/', {});
    assert.equal(r.headers['x-frame-options'], undefined);
    assert.equal(r.headers['content-security-policy'], undefined);
    assert.equal(r.headers['content-encoding'], undefined);
  });

  await okAsync('cookies cross in neither direction', async () => {
    seenRequests.length = 0;
    const r = await request(port, 'GET', base + '/', { Cookie: 'mouaif_access=abc; session=xyz' });
    assert.equal(r.headers['set-cookie'], undefined, 'the upstream Set-Cookie reached the browser');
    const sent = seenRequests[0].headers;
    assert.equal(sent.cookie, undefined, 'the browser cookie reached the dev server');
    assert.equal(sent.authorization, undefined);
    assert.equal(sent.origin, undefined, 'an Origin header would make the dev server answer a CORS request');
    assert.equal(sent['accept-encoding'], 'identity', 'an encoded body would break the passed content-length');
  });

  await okAsync('a relative asset resolves under the proxy prefix', async () => {
    const r = await request(port, 'GET', base + '/asset.js', {});
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /javascript/);
    assert.match(r.body, /export const n = 1/);
  });

  await okAsync('the query string is forwarded byte for byte', async () => {
    const r = await request(port, 'GET', base + '/echo-query?raw&x=%2F', {});
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { url: '/echo-query?raw&x=%2F' });
  });

  await okAsync('a JSON payload is passed through unrewritten', async () => {
    // A leading slash inside data is not a URL; rewriting it would corrupt the
    // response a page is about to parse.
    const r = await request(port, 'GET', base + '/json-data', {});
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { redirect: '/login', paths: ['/a', '/b'] });
  });

  await okAsync('a root-absolute redirect is re-pointed at the proxy', async () => {
    const r = await request(port, 'GET', base + '/redirect', {});
    assert.equal(r.status, 302);
    // Left as `/after-redirect` the browser would resolve it against the
    // origin root — the app, not the dev server (and the app's 404 in a frame).
    assert.equal(r.headers.location, base + '/after-redirect');
  });

  await okAsync('an upstream that redirects to its own absolute URL is not followed', async () => {
    const r = await request(port, 'GET', base + '/absolute-redirect', {});
    assert.equal(r.status, 302);
    // An absolute upstream Location names a host only the *other* machine has;
    // it is passed through untouched rather than rewritten.
    assert.equal(r.headers.location, 'http://127.0.0.1:' + upstream.port + '/after-redirect');
  });

  await okAsync('a root-absolute URL in the document is rewritten, a relative one is not', async () => {
    const r = await request(port, 'GET', base + '/', {});
    assert.ok(r.body.includes('href="' + base + '/style.css"'), r.body);
    // Relative already resolves under the prefix; rewriting it would be wrong.
    assert.ok(r.body.includes('src="./asset.js"'), r.body);
  });

  await okAsync('root-absolute CSS urls are rewritten and the body is reframed', async () => {
    const r = await request(port, 'GET', base + '/style.css', {});
    assert.equal(r.status, 200);
    assert.equal(r.body, 'a{background:url(' + base + '/bg.png)}\n');
    // The rewrite changed the byte count, so the upstream's length is dropped
    // and Node frames the response itself (chunked, no content-length) — the
    // alternative is a body the browser truncates at the stale length.
    if (r.headers['content-length'] !== undefined) {
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
    }
  });

  await okAsync('a binary body is streamed through untouched', async () => {
    const r = await request(port, 'GET', base + '/bg.png', {});
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /image\/png/);
  });

  await okAsync('HEAD is answered with headers and no body', async () => {
    const r = await request(port, 'HEAD', base + '/', {});
    assert.equal(r.status, 200);
    assert.equal(r.body, '');
  });

  await okAsync('a remote host is refused with 403', async () => {
    const r = await request(port, 'GET', '/api/preview/http/example.com/', {});
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).code, 'EREMOTE_HOST');
  });

  await okAsync('a bad scheme is a 400', async () => {
    const r = await request(port, 'GET', '/api/preview/file/tmp/x.html', {});
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).code, 'EBADINPUT');
  });

  await okAsync('a non-GET method is refused with Allow: GET, HEAD', async () => {
    const r = await request(port, 'POST', base + '/', {});
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
  });

  await okAsync('a closed port reports the unreachable upstream, not a hang', async () => {
    // Port 1 is never a dev server; the fetch fails immediately.
    const r = await request(port, 'GET', '/api/preview/http/127.0.0.1:1/', {});
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).code, 'EPREVIEW_UNREACHABLE');
  });

  await okAsync('the proxy does not shadow the normal REST surface', async () => {
    const r = await request(port, 'GET', '/api/tools/list', {});
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(JSON.parse(r.body).tools));
  });

  upstream.server.close();
  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
