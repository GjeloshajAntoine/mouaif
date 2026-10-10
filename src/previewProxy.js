'use strict';

// Local preview proxy — serve a development server that runs on this machine
// through the mouaif origin, so the web preview's Live iframe works from a
// phone.
//
// Why it exists: Live mode frames the page in *your browser*, so the URL is
// resolved by the device you are holding, and `http://localhost:5173/` means
// "the phone" — where no Vite dev server is running. This endpoint makes
// mouaif's own server fetch the page and stream it back under
// `/api/preview/<scheme>/<authority>/<path>`, so the phone loads the dev
// server through the one address it already has.
//
// The URL shape is a *path prefix*, not a query string: that alone makes every
// relative URL resolve back through the proxy (`./main.jsx`, `url(../x.png)`,
// `fetch('api/state')`), with nothing rewritten.
//
// A path prefix does **not** cover a root-absolute URL (`/src/main.jsx`,
// `/@vite/client`): the browser resolves those against the *origin root*, which
// is mouaif's own app, not the proxy. Every dev server emits them — Vite's
// transformed modules are nothing but `import "/@fs/…"` lines — so the proxy
// prefixes them in the text bodies it serves (HTML attributes, CSS `url()` /
// `@import`, JS `from` / `import()` / `new URL()` specifiers) and in an
// absolute-path `Location` header. See prefixRootPaths below for the exact
// shapes and docs/features/local-preview-proxy.md for what is out of scope (a
// URL assembled at runtime from a string, for one).
//
// Deliberate limits (see docs/features/local-preview-proxy.md):
//   * loopback and the Docker host aliases only — this is a confused-deputy
//     machine, so it stays pointed at the machine that runs mouaif;
//   * GET and HEAD only, no request body, no WebSocket upgrade (a dev server's
//     HMR socket is not proxied; a reload of the frame picks up the change);
//   * the browser's cookies are never forwarded upstream and the upstream's
//     `Set-Cookie` never reaches the browser — a dev server that needs its own
//     login is out of scope;
//   * the response is re-served as a same-origin document, so it is as
//     privileged as the Live frame already was (see the same-origin warning
//     below).
//
// Public surface:
//   parseProxyPath(pathname)  -> { scheme, authority, host, port, targetPath,
//                                  upstream } or null for a non-proxy path.
//                                  Throws a typed error for a proxy path this
//                                  server refuses.
//   isLocalHost(host)         -> boolean.
//   proxyPathFor(url)         -> the proxy path for a local http(s) URL, else
//                                  null. The frontend helper in
//                                  frontend/src/components/chat/webpreviewFrame.js
//                                  mirrors this shape.
//   handlePreviewProxy(req, res, parsed, sessionToken, serverConfig)
//                             -> Promise<true> when it answered the request.

const { Readable } = require('node:stream');
const { sendJSON } = require('./server-shared.js');

const PREFIX = '/api/preview/';

// A dev server can take a while on a cold rebuild (Vite re-optimizing
// dependencies, a first TypeScript pass); past this the request is aborted so
// a hung upstream cannot hold a socket open forever.
const UPSTREAM_TIMEOUT_MS = 30_000;

// The proxy never sends a request body and cannot honour a client's intent for
// one, so anything else is refused rather than silently dropped.
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// Response headers copied through to the browser. Allow-listed, not filtered:
// a header a future dev server adds is dropped until it is listed here. The
// notable absences are `set-cookie` (never let an upstream write into the
// mouaif origin), `content-security-policy` and `x-frame-options` (a dev server
// that blocks framing would defeat the whole point of the preview), and
// `content-encoding` (the request asks for `identity`, see REQUEST_HEADERS).
const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-language',
  'content-range',
  'accept-ranges',
  'location'
];

// Bodies whose root-absolute URLs are rewritten before they reach the browser.
//
// Exactly three types, and deliberately no others. HTML, CSS and JavaScript are
// the documents and modules a page loads itself, where a leading `/` is a URL
// by definition. JSON is NOT in the list even though it is text: a JSON payload
// is data, and a string like `{"redirect":"/login"}` would be corrupted into a
// proxied path that then reaches the page's own code. XML and plain text are
// out for the same reason. A binary body (an image, a font, a source map) is
// streamed through untouched.
const REWRITABLE_TYPE = /^(?:text\/(?:html|css|javascript)|application\/(?:javascript|x-javascript))/i;

// A rewritable body is buffered to be rewritten, so it is bounded: a response
// past this is streamed as-is rather than held in memory. Dev-server pages and
// modules are orders of magnitude below it.
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

// Request headers forwarded upstream. Cookies, `authorization`, `origin`,
// `referer`, conditional requests and `accept-encoding` stay here: the dev
// server sees a plain, unconditional, uncompressed GET, which also keeps the
// pass-through `content-length` exact.
const REQUEST_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-encoding': 'identity',
  'user-agent': 'mouaif-preview/1.0'
};

function err(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

// isLocalHost(host) — true for a hostname this machine answers to: the
// loopback names (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`)
// and the aliases Docker and Podman publish for the host from inside a
// container. Everything else — a LAN address, a public name — is refused: the
// proxy must never become a way to make mouaif's server fetch an arbitrary
// address on the user's behalf.
function isLocalHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'host.docker.internal' || h === 'host.containers.internal' || h === 'gateway.docker.internal') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // An IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`).
  if (h.startsWith('::ffff:')) return isLocalHost(h.slice(7));
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === '0.0.0.0';
}

// splitAuthority(authority) -> { host, port } | null
// Accepts `host`, `host:port`, `[::1]`, `[::1]:5173`. A missing port means the
// scheme's default. Fields that would change the target (userinfo) or need
// escaping are refused, so nothing but a host and a port ever reaches the
// upstream URL.
function splitAuthority(authority) {
  const raw = String(authority || '');
  if (!raw || !/^[A-Za-z0-9._\-:\[\]]+$/.test(raw)) return null;
  let host;
  let port = 0;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return null;
    host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    port = rest ? Number(rest.slice(1)) : 0;
    if (!host.includes(':')) return null;
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon >= 0) {
      host = raw.slice(0, colon);
      const digits = raw.slice(colon + 1);
      if (!/^\d{1,5}$/.test(digits)) return null;
      port = Number(digits);
      // An explicit `:0` is a typo, not a request for the default port.
      if (port < 1 || port > 65535) return null;
    } else {
      host = raw;
    }
  }
  if (!host) return null;
  if (port && (port < 1 || port > 65535)) return null;
  // `wireHost` is what goes into the upstream URL: an IPv6 literal has to keep
  // its brackets there, while `host` stays the bare address the allow-list and
  // the port-default logic read.
  return { host, wireHost: host.includes(':') ? '[' + host + ']' : host, port };
}

// parseProxyPath(pathname) -> target | null
//
// `/api/preview/http/localhost:5173/src/main.jsx` parses to the upstream
// `http://localhost:5173/src/main.jsx`. Anything not under the prefix returns
// null (the dispatcher's job to route elsewhere); a proxy path that is
// malformed or pointed off this machine throws a typed error the handler turns
// into a status code.
function parseProxyPath(pathname) {
  const path = String(pathname || '');
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  const scheme = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!scheme) throw err('EBADINPUT', 'A preview proxy path needs a scheme: /api/preview/<scheme>/<host>[:port]/<path>');
  if (scheme !== 'http' && scheme !== 'https') {
    throw err('EBADINPUT', 'preview proxy supports http and https only (got "' + scheme + '")');
  }
  if (slash < 0) throw err('EBADINPUT', 'A preview proxy path needs a host: /api/preview/' + scheme + '/<host>[:port]/<path>');
  const remainder = rest.slice(slash + 1);
  // `//host:port/x` is a scheme-relative URL whose path is `/x`, not an
  // authority followed by a path: nothing between the two slashes means no
  // host was named. Read it as the missing-host error the user needs.
  if (!remainder || remainder.startsWith('/')) {
    throw err('EBADINPUT', 'A preview proxy path needs a host: /api/preview/' + scheme + '/<host>[:port]/<path>');
  }
  // The authority ends at the first slash. A root-absolute upstream path always
  // follows it, so `/api/preview/http/localhost:5173` (no trailing slash) is
  // the same target as `/api/preview/http/localhost:5173/`.
  const slash2 = remainder.indexOf('/');
  const authority = slash2 < 0 ? remainder : remainder.slice(0, slash2);
  const targetPath = slash2 < 0 ? '/' : remainder.slice(slash2);
  const parts = splitAuthority(authority);
  if (!parts) throw err('EBADINPUT', 'Invalid preview proxy authority "' + authority + '"');
  if (!isLocalHost(parts.host)) {
    throw err('EREMOTE_HOST', 'The preview proxy only reaches this machine: "' + parts.host + '" is not a local host',
      { host: parts.host });
  }
  const port = parts.port || (scheme === 'https' ? 443 : 80);
  const upstream = scheme + '://' + parts.wireHost + ':' + port + targetPath;
  return { scheme, authority, host: parts.host, port, targetPath, upstream };
}

// proxyPathFor(url) — the proxy path for an http(s) URL on a local host, else
// null. `url` is a URL instance or a string.
//
// The path and query are copied byte for byte out of the URL (percent-encoding
// intact), so a request carries exactly the target the page would have asked
// for; the fragment stays a fragment, and the browser resolves it client-side.
function proxyPathFor(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isLocalHost(u.hostname)) return null;
  return PREFIX + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
}

// rawQuery(req) — the request's own query string, undecoded.
//
// `parseRequestTarget` hands the handlers a parsed query object, which would
// re-encode (`?a=%2Fb` → `?a=%2Fb` at best, `?tags=a+b` differently); a proxy
// has to forward the bytes the page asked for, so the raw target is split
// here. An absolute-form target is not expected from a browser and is left
// alone.
function rawQuery(req) {
  const target = String((req && req.url) || '');
  const withoutHash = target.split('#', 1)[0];
  const at = withoutHash.indexOf('?');
  return at >= 0 ? withoutHash.slice(at + 1) : '';
}

// prefixFor(target) — the path prefix a body served for this target must use
// for its own root-absolute URLs. Always ends in `/`, so `prefix + '/src/x.js'`
// cannot produce a double slash.
function prefixFor(target) {
  return PREFIX + target.scheme + '/' + target.authority + '/';
}

// prefixRootPaths(body, prefix) -> the body with every root-absolute URL
// pointed back at the proxy.
//
// Only shapes where a leading `/` is unambiguously an origin-root URL are
// touched, and each is anchored on the quotes/delimiters that surround it, so
// prose, a comment and a division operator are left alone:
//
//   * HTML/JS/CSS string and attribute positions:  "/src/x.js"  '/src/x.js'
//     (…)                       — a quoted or parenthesized argument
//     url(/x) @import "/x" style="…/x…" href="/x" src='/x'
//   * a JS *bare* module specifier, which is how Vite hands back a transformed
//     module:  import "/@fs/…"   and   export … from "/@fs/…"
//
// `//host/x` (a protocol-relative URL) and `/` alone are never prefixed, and a
// path that is already under the prefix is left as it is so a rewrite is
// idempotent.
function prefixRootPaths(body, prefix) {
  if (typeof body !== 'string' || !body || body.indexOf('/') < 0) return body;
  const up = (path) => {
    if (!path.startsWith('/')) return path;
    if (path.startsWith('//')) return path;      // protocol-relative
    if (path === '/') return path;                // the root itself
    if (path.startsWith(prefix)) return path;     // already proxied
    // `prefix` ends in `/`, and `path` starts with one: keep exactly one.
    return prefix + path.slice(1);
  };
  let out = body;
  // `url(/x)` / `@import /x` (CSS) — case-insensitive, either quote or none.
  out = out.replace(/(url\(\s*|@import\s+)(['"]?)(\/(?!\/)[^'")\s;]+)/gi,
    (m, lead, quote, path) => lead + quote + up(path));
  // A quoted or parenthesized absolute path in an attribute, an import, a
  // `new URL('/x', …)` or a `fetch('/x')` argument.
  out = out.replace(/(["'(])(\/(?!\/)[^"'`\s),;]+)/g,
    (m, lead, path) => lead + up(path));
  // A JS bare specifier: `export … from "/@fs/…"` is already covered by the
  // quoted form above; this catches the unquoted `import /…` shape.
  out = out.replace(/\b(from\s+|import\s+)(\/(?!\/)[^"'`\s),;]+)/g,
    (m, keyword, path) => keyword + up(path));
  return out;
}

// sendRewritten(res, status, headers, webBody, prefix) -> Promise<void>
//
// Buffer a body that is allowed to be rewritten, then rewrite and send it. A
// body that turns out to exceed MAX_REWRITE_BYTES stops being buffered and is
// streamed through as it is: nothing about a huge response is rewritten, and
// nothing is dropped either.
//
// The declared `content-length` is always dropped on this path: the rewritten
// body is almost never the length the dev server declared, and Node frames the
// response itself once the header is gone.
async function sendRewritten(res, status, headers, webBody, prefix) {
  delete headers['content-length'];
  const body = Readable.fromWeb(webBody);
  const chunks = [];
  let size = 0;
  let overflowed = false;
  let started = false;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_REWRITE_BYTES) overflowed = true;
    if (overflowed) {
      if (!started) { res.writeHead(status, headers); started = true; }
      if (!res.write(buf)) await new Promise((resolve) => res.once('drain', resolve));
      continue;
    }
    chunks.push(buf);
  }
  if (overflowed) {
    res.end();
    return;
  }
  const raw = Buffer.concat(chunks, size);
  const rewritten = Buffer.from(prefixRootPaths(raw.toString('utf8'), prefix), 'utf8');
  // A changed length invalidates a weak validator the dev server sent on the
  // *original* bytes.
  if (rewritten.length !== raw.length) delete headers.etag;
  res.writeHead(status, headers);
  res.end(rewritten);
}

// copyHeaders(upstream) -> the allow-listed response headers, plus a
// no-store policy: a preview is live state, and a cached copy of a dev server
// page would show the previous build.
function responseHeaders(upstream) {
  const out = { 'Cache-Control': 'no-store' };
  // `fetch` decodes a compressed body itself. `accept-encoding: identity` asks
  // the dev server not to compress, but a server may ignore it (a proxy in
  // front of it, a hand-rolled build server), and then a forwarded
  // `content-length` counts the *compressed* bytes while the body we pipe is
  // the decoded one — a mismatch the browser resolves by waiting for bytes
  // that never arrive. So a declared encoding drops the length and lets Node
  // frame the response itself.
  const encoded = upstream.headers.has('content-encoding');
  for (const name of PASS_HEADERS) {
    if (encoded && name === 'content-length') continue;
    const value = upstream.headers.get(name);
    if (value != null) out[name] = value;
  }
  return out;
}

// handlePreviewProxy(req, res, parsed) -> Promise<boolean>
//
// Answers a `/api/preview/...` request and returns true. The caller's
// same-origin + session + access checks have already run (the path sits under
// `/api/`), so this only has to decide the target, fetch it, and stream it
// back.
async function handlePreviewProxy(req, res, parsed, sessionToken, serverConfig) {
  void sessionToken;
  void serverConfig;
  const pathname = (parsed && parsed.pathname) || '';
  if (!pathname.startsWith(PREFIX)) return false;

  let target;
  try {
    target = parseProxyPath(pathname);
  } catch (e) {
    sendJSON(res, e.code === 'EREMOTE_HOST' ? 403 : 400, { error: e.message, code: e.code || 'EBADINPUT' });
    return true;
  }
  if (!target) return false;

  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    sendJSON(res, 405, { error: 'The preview proxy serves GET and HEAD only', code: 'EMETHOD' });
    return true;
  }

  const query = rawQuery(req);
  const upstreamUrl = target.upstream + (query ? '?' + query : '');

  // Abort the upstream fetch when the client goes away (a frame navigated, a
  // phone screen locked) or when it outlives the timeout, so neither a hung
  // dev server nor a closed tab leaks a socket.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  if (timer && timer.unref) timer.unref();
  let closed = false;
  const onClose = () => {
    closed = true;
    controller.abort();
  };
  res.on('close', onClose);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: REQUEST_HEADERS
    });
  } catch (e) {
    clearTimeout(timer);
    res.removeListener('close', onClose);
    if (closed || res.headersSent) return true;
    const timedOut = controller.signal.aborted;
    sendJSON(res, timedOut ? 504 : 502, {
      error: timedOut
        ? 'The local page did not answer within ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's'
        : 'Could not reach ' + upstreamUrl + ': ' + ((e && e.message) || String(e)),
      code: timedOut ? 'EPREVIEW_TIMEOUT' : 'EPREVIEW_UNREACHABLE',
      url: upstreamUrl
    });
    return true;
  }

  const headers = responseHeaders(upstream);

  // A redirect that points into the dev server's own root has to be re-pointed
  // at the proxy, or the frame leaves it (and, on a phone, the browser lands on
  // an address only the *other* machine has). A relative `Location` already
  // resolves under the prefix and is left alone.
  const prefix = prefixFor(target);
  const location = headers.location;
  if (location && location.startsWith('/') && !location.startsWith('//') && !location.startsWith(prefix)) {
    headers.location = prefix + location.slice(1);
  }

  const contentType = String(headers['content-type'] || '');
  // A text body is buffered and rewritten; a binary one is streamed. A very
  // large text body degrades to streaming, which is what a source map or a
  // bundled asset past the cap gets — served whole, just not rewritten.
  const rewritable = REWRITABLE_TYPE.test(contentType);

  try {
    if (method === 'HEAD' || !upstream.body) {
      res.writeHead(upstream.status, headers);
      res.end();
      return true;
    }

    if (rewritable) {
      await sendRewritten(res, upstream.status, headers, upstream.body, prefix);
      return true;
    }

    res.writeHead(upstream.status, headers);
    await new Promise((resolve) => {
      const body = Readable.fromWeb(upstream.body);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      body.on('error', () => { try { res.destroy(); } catch { /* already gone */ } done(); });
      res.on('error', () => { try { body.destroy(); } catch { /* already gone */ } done(); });
      res.on('close', done);
      body.pipe(res);
    });
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClose);
  }
  return true;
}

module.exports = {
  handlePreviewProxy,
  parseProxyPath,
  proxyPathFor,
  prefixFor,
  prefixRootPaths,
  isLocalHost,
  splitAuthority,
  PREFIX,
  PASS_HEADERS,
  MAX_REWRITE_BYTES,
  UPSTREAM_TIMEOUT_MS
};
