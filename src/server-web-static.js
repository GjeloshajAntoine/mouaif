'use strict';

// Static frontend serving. The mobile UI lives in frontend/ (built by
// Vite into frontend/dist/) and is served at the root /. Shared
// helpers + constants live in src/server-shared.js.

const path = require('path');
const fs = require('fs');
const { sendJSON, WEB_DIR, WEB_DIST } = require('./server-shared.js');

const WEB_MIME = {
  '.html':            'text/html; charset=utf-8',
  '.css':             'text/css; charset=utf-8',
  '.js':              'application/javascript; charset=utf-8',
  '.mjs':             'application/javascript; charset=utf-8',
  '.json':            'application/json; charset=utf-8',
  '.webmanifest':     'application/manifest+json; charset=utf-8',
  '.svg':             'image/svg+xml',
  '.png':             'image/png',
  '.webp':            'image/webp',
  '.ico':             'image/x-icon'
};

// Cache-Control for the PWA's static, fingerprinted assets (the
// hashed JS/CSS rollup emits). These URLs change on every build, so
// they can be cached forever by the browser; the cache name busts on
// each release because the hashed filename changes.
const LONG_LIVED = new Set(['.js', '.css', '.png', '.webp', '.svg', '.ico']);

// isInside(dir, abs) — true when `abs` is `dir` itself or lives under it.
// A plain `abs.startsWith(dir)` also matches a sibling whose name shares
// the prefix (`/app/frontend-evil` for `/app/frontend`), which is how a
// prefix test silently stops being a containment test.
function isInside(dir, abs) {
  const root = path.resolve(dir);
  const target = path.resolve(abs);
  return target === root || target.startsWith(root + path.sep);
}

// Headers the service worker script needs to be installed for the
// root scope. SW scripts normally inherit their scope from their
// script URL's directory, but `Service-Worker-Allowed` lets the
// /sw.js script claim the entire / prefix (which is what
// we want so navigation + static requests are both handled).
// `Cache-Control: no-cache` keeps the browser from serving a stale
// SW after a redeploy; the activate handler then evicts the old
// cache on the next load.
function applyPwaHeaders(res, absPath, relPath) {
  const ext = path.extname(absPath).toLowerCase();
  const isSw = relPath === 'sw.js';
  if (isSw) {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    return;
  }
  if (LONG_LIVED.has(ext)) {
    // Cap to 1 year so we don't hand out "never expires" assets.
    // The Vite build hashes every entry, so a stale copy will be
    // garbage-collected next deploy anyway.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (relPath === 'manifest.webmanifest') {
    // Manifests are stable for a release (no content-hash in their
    // URL), so cache briefly — long enough for the install prompt
    // to be available offline, short enough to refresh across
    // deploys.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return;
  }
}

function serveWebFile(res, absOrRel, opts) {
  const opt = opts || {};
  let abs;
  if (path.isAbsolute(absOrRel)) {
    abs = absOrRel;
  } else if (opt.preferDist) {
    // Look in frontend/dist/<relPath> first, fall back to frontend/<relPath>.
    const inDist = path.join(WEB_DIST, absOrRel);
    if (fs.existsSync(inDist)) abs = inDist;
    else abs = path.join(WEB_DIR, absOrRel);
  } else {
    abs = path.join(WEB_DIR, absOrRel);
  }
  // Allow serving from outside WEB_DIR only when the caller explicitly
  // opted in (used to be for the old virtual-list.js alias; no longer
  // needed now that Vite bundles it).
  //
  // `startsWith` on its own is a prefix test, not a containment test: a
  // sibling directory whose name begins with the same characters
  // (`frontend-evil`) would pass it. Compare against the boundary with a
  // trailing separator. `url.parse` does not decode the path, so an
  // encoded `%2e%2e` arrives here literally and `path.join` keeps it
  // inside; this check is the belt to that suspenders.
  if (!isInside(WEB_DIR, abs) && !opt.allowOutside) {
    return sendJSON(res, 400, { error: 'Bad path' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not found', path: absOrRel });
    applyPwaHeaders(res, abs, absOrRel);
    res.writeHead(200, { 'Content-Type': WEB_MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveWebRequest(res, relPath) {
  if (!relPath) return serveWebFile(res, 'index.html', { preferDist: true });
  // SPA fallback: if the path is not a known asset type (no extension
  // or an unknown extension), serve index.html so the client-side hash
  // router can handle it. This prevents 404 JSON pages when navigation
  // resolves to a garbage path like '/+ safe +'.
  const ext = path.extname(relPath).toLowerCase();
  if (!ext || !WEB_MIME[ext]) {
    return serveWebFile(res, 'index.html', { preferDist: true });
  }
  return serveWebFile(res, relPath, { preferDist: true });
}

module.exports = { serveWebFile, serveWebRequest, isInside };
