'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./util.js');

// Origins only, never arbitrary CSP fragments. Initial host deliberately supports
// public HTTPS/WSS origins only; private-network and host API access are denied.
function approvedDomains(values, hostOrigin, connect = false) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 32) throw err('EMCP_APP_CSP', 'Invalid CSP origin list');
  const host = new URL(hostOrigin);
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || /[\s;'"*]/.test(value)) throw err('EMCP_APP_CSP', 'Invalid CSP origin');
    let url;
    try { url = new URL(value); } catch { throw err('EMCP_APP_CSP', 'Invalid CSP origin'); }
    const hostname = url.hostname.toLowerCase();
    if (!(url.protocol === 'https:' || (connect && url.protocol === 'wss:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || hostname === host.hostname || hostname === 'localhost' || !hostname.includes('.')
      || /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname)
      || /^[\d.]+$/.test(hostname) || hostname.includes(':')) {
      throw err('EMCP_APP_CSP', 'CSP origin is not an approved public origin');
    }
    return url.origin;
  }))];
}

function buildPolicy(ui, hostOrigin) {
  const declared = ui?.csp || {};
  if (typeof declared !== 'object' || Array.isArray(declared)
    || ['frameDomains', 'baseUriDomains'].some(key => declared[key] !== undefined
      && (!Array.isArray(declared[key]) || declared[key].length > 0))) {
    throw err('EMCP_APP_CSP', 'Unsupported or invalid CSP declaration');
  }
  const csp = {
    connectDomains: approvedDomains(declared.connectDomains, hostOrigin, true),
    resourceDomains: approvedDomains(declared.resourceDomains, hostOrigin),
    // Nested frames and external base URIs are not supported in this release.
    frameDomains: [], baseUriDomains: []
  };
  if ((declared.frameDomains?.length || declared.baseUriDomains?.length || ui?.domain)) {
    throw err('EMCP_APP_CSP', 'Dedicated domains, nested frames and external base URIs are not supported');
  }
  const resources = csp.resourceDomains.join(' ');
  const header = [
    "default-src 'none'", "script-src 'unsafe-inline' " + resources,
    "style-src 'unsafe-inline' " + resources, 'img-src data: ' + resources,
    'font-src data: ' + resources, 'media-src data: ' + resources,
    'connect-src ' + (csp.connectDomains.join(' ') || "'none'"),
    // about:blank/srcdoc is required for the inner sandbox; no network frames.
    "frame-src 'self' about:", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", 'frame-ancestors ' + hostOrigin
  ].join('; ');
  return { csp, header, permissions: {} };
}

// Single-use tickets for the trusted outer proxy, served on the app's own port
// at /api/mcp/apps/sandbox/:token, so an install only has to publish that port.
// `Content-Security-Policy: sandbox allow-scripts` gives the proxy an opaque
// (`null`) origin: unlike a sibling port, it shares neither cookies nor a site
// with the app. Tickets expire on teardown.
function createSandboxService() {
  const tickets = new Map();
  function handleProxy(req, res, token) {
    const ticket = tickets.get(token);
    if (req.method !== 'GET' || !ticket || ticket.expires < Date.now()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.headers.referer !== undefined) {
      let referrerOrigin;
      try { referrerOrigin = new URL(req.headers.referer).origin; } catch { /* reject malformed referrer */ }
      if (referrerOrigin !== ticket.hostOrigin) {
        res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
      }
    } else if (req.headers['sec-fetch-dest'] !== 'iframe'
      || !['same-origin', 'same-site'].includes(req.headers['sec-fetch-site'])) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    // Ports are not cookie boundaries. Ignore all cookie/auth headers and
    // never reflect them into the trusted proxy or its messages.
    if (req.headers.host !== ticket.host || ticket.used) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    try { ticket.validate?.(); } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    ticket.used = true; // reload/navigation requires a fresh mount
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ticket.policy.header + '; sandbox allow-scripts',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=(), display-capture=()',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    // Trusted proxy source only. App HTML arrives by postMessage, not HTTP.
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style><script>'
    + 'const EXPECTED_HOST_ORIGIN=' + JSON.stringify(ticket.hostOrigin) + ';\n'
    + fs.readFileSync(path.join(__dirname, 'mcp-apps-sandbox-proxy.js'), 'utf8') + '</script>');
  }
  async function issue(hostOrigin, policy) {
    const host = new URL(hostOrigin);
    if (host.protocol !== 'http:' && host.protocol !== 'https:') {
      throw err('EMCP_APP_ORIGIN', 'MCP Apps require an HTTP or HTTPS host origin');
    }
    for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(token);
    if (tickets.size >= 64) throw err('EMCP_APP_LIMIT', 'Sandbox ticket limit reached');
    const token = crypto.randomBytes(24).toString('base64url');
    tickets.set(token, { hostOrigin, host: host.host, policy, used: false, expires: Date.now() + 30 * 60 * 1000 });
    return { token, url: hostOrigin + '/api/mcp/apps/sandbox/' + token, origin: 'null' };
  }
  function bind(token, validate) { tickets.get(token).validate = validate; }
  function revoke(token) { tickets.delete(token); }
  function close() { tickets.clear(); }
  return { issue, handleProxy, bind, revoke, close };
}

module.exports = { approvedDomains, buildPolicy, createSandboxService };
