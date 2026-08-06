'use strict';

// HTTP server core — routes + handlers.
//
// The original single-file src/index.js was split so no file in the
// repo stays above ~1 000 lines. This module owns the request routing
// and the server bootstrap (createServer); the handlers live in focused
// sub-modules:
//
//   server-shared.js            — shared state + cross-cutting helpers
//                                 (sendJSON, cookies/origin auth, settings
//                                 redaction, model resolution, SSE, ...)
//   server-handlers-settings.js — /api/settings/*
//   server-handlers-chats.js    — /api/chats/* + the SSE stream loop
//   server-handlers-projects.js — /api/projects/*, /api/file(s), tags
//   server-handlers-ai.js       — /api/ai/*
//   server-handlers-auth.js     — /api/auth/* + /oauth/callback
//   server-handlers-access.js   — /api/access/*
//   server-handlers-push.js     — /api/push/*
//   server-handlers-git.js      — /api/git/*
//   server-handlers-tools.js    — /api/tools/*
//   server-handlers-prompts.js  — /api/prompts/*, /api/features, /api/agents/*
//   server-handlers-misc.js     — /api/mcp/*, /api/restart, /api/inspector/*,
//                                 /api/tools/authorization
//   server-web-static.js        — /web/ static serving
//
// src/index.js is now a thin facade that re-exports this module.

const http = require('http');
const url = require('url');
const crypto = require('crypto');

const {
  DEFAULT_PORT,
  SESSION_COOKIE,
  ACCESS_COOKIE,
  sessionCookie,
  expectedOrigin,
  requestOrigin,
  parseCookies,
  requestHasBrowserOrigin,
  authorizeBrowserRequest,
  authorizeAccessRequest,
  handleSSE,
  sendJSON,
  broadcast,
  store,
  normalizePublicOrigin,
  trackSocket,
  destroyOpenSockets,
  settings,
  projects,
  ai,
  auth,
  oauthAnthropic,
  oauthCopilot,
  chats,
  resolveModel,
  seedModelListCache,
  accessAuth,
  push,
  inspector,
  usage,
  promptProfiles
} = require('./server-shared.js');

const { handleSettings } = require('./server-handlers-settings.js');
const { handleChats } = require('./server-handlers-chats.js');
const { handleProjects, handleFileEditor } = require('./server-handlers-projects.js');
const { handleAI } = require('./server-handlers-ai.js');
const { handleAuth, handleOAuthCallback, handleOAuthCallbackPost } = require('./server-handlers-auth.js');
const { handleAccess } = require('./server-handlers-access.js');
const { handlePush } = require('./server-handlers-push.js');
const { handleGit, handleGitInfo, handleGitLog } = require('./server-handlers-git.js');
const { handleTools } = require('./server-handlers-tools.js');
const { handlePrompts, handleFeatures, handleAgents } = require('./server-handlers-prompts.js');
const { handleMcp, handleRestart, handleInspector, handleToolAuthorization } = require('./server-handlers-misc.js');
const { serveWebFile, serveWebRequest } = require('./server-web-static.js');

// ---- Route table --------------------------------------------------------

function handleRequest(req, res, activePort = DEFAULT_PORT, sessionToken = '', lifecycle = {}, serverConfig = {}) {
  const parsed = url.parse(req.url, true);
  const urlPath = parsed.pathname;
  const method = req.method;

  // The UI and API are deliberately same-origin. A browser first loads
  // /web/, which receives an HttpOnly SameSite cookie. API/SSE requests
  // carrying an Origin must present that cookie and match Host exactly.
  // Requests without Origin remain available to local CLI clients and tests;
  // the CLI binds to loopback unless the user explicitly opts into a remote
  // host. No Access-Control-Allow-Origin header is emitted.
  if (method === 'OPTIONS') {
    return sendJSON(res, 403, { error: 'Cross-origin preflight is not allowed', code: 'EORIGIN' });
  }
  // `/oauth/callback` is exempt from the same-origin browser gate: the OAuth
  // provider (openrouter.ai, anthropic.com, github.com, ...) redirects the
  // user's browser back here in a top-level navigation, so the Origin header
  // is legitimately the provider's, not ours. Rejecting on that mismatch is
  // what broke iOS PWA sign-in ("shows in provider" = the redirect-back
  // arrived in the web preview tab, and the app never got the token). The
  // callback is safe to admit because it is not authenticated: it only
  // exchanges a one-time code bound to a pending `state` + PKCE verifier that
  // the user started in the app, then writes the result into the keyring.
  // The session/CSRF gates below still protect every `/api/*` route.
  const browserProtected = urlPath === '/events'
    || urlPath.startsWith('/api/');
  if (browserProtected && requestHasBrowserOrigin(req) && !authorizeBrowserRequest(req, res, sessionToken, serverConfig.publicOrigin)) {
    return;
  }

  // Access setup/login endpoints must remain reachable before a user has a
  // session. They still pass the same-origin/CSRF check above in browsers.
  if (urlPath.startsWith('/api/access/')) {
    return handleAccess(req, res, parsed, serverConfig);
  }

  // Static assets and the Preact shell stay public so they can render the
  // login/setup view. Everything containing app data is authenticated.
  const accessProtected = urlPath === '/events'
    || urlPath === '/oauth/callback'
    || urlPath.startsWith('/api/')
    || urlPath === '/data';
  // The OAuth loopback callback is the one exception to the access gate: a
  // browser redirected back from the IdP has no reason to hold an access
  // cookie (iOS PWA popup flow, fresh Safari context, or the popup being
  // denied entirely). It must be reachable to complete the code exchange;
  // `finishOAuth` still validates the state against a pending record the
  // user created inside the authenticated app.
  if (accessProtected && urlPath !== '/oauth/callback' && !authorizeAccessRequest(req, res, serverConfig.authEnabled)) return;

  // SSE endpoint
  if (urlPath === '/events' && method === 'GET') {
    return handleSSE(req, res);
  }

  // Static /web/ (mobile UI bundle). Prefers the Vite build at
  // src/web/dist/; falls back to src/web/ when the build hasn't run yet
  // (e.g. during development before `npm run build:web`). This lets the
  // repo keep working in either state without breaking.
  if (urlPath === '/web' || urlPath === '/web/') {
    const servedOrigin = expectedOrigin(req, serverConfig.publicOrigin);
    res.setHeader('Set-Cookie', sessionCookie(sessionToken, !!servedOrigin && servedOrigin.startsWith('https://')));
    return serveWebFile(res, 'index.html', { preferDist: true });
  }
  if (urlPath.startsWith('/web/')) {
    return serveWebRequest(res, urlPath.slice('/web/'.length));
  }

  // Browser auto-requests a favicon. Serve the real one now that
  // we've generated a 32x32 PNG (no more 204 stub).
  if (urlPath === '/favicon.ico' && method === 'GET') {
    return serveWebFile(res, 'icons/favicon-32.png', { preferDist: true });
  }

  // Settings API
  if (urlPath.startsWith('/api/settings')) {
    return handleSettings(req, res, parsed);
  }

  // Projects API (folder picker + registered projects)
  if (urlPath.startsWith('/api/projects')) {
    return handleProjects(req, res, parsed);
  }

  // File editor (in-app CodeMirror popup). See handleFileEditor for the
  // contract; dispatched here as a top-level route so /api/file and
  // /api/files are first-class (they do not start with /api/projects).
  if (urlPath === '/api/file' || urlPath === '/api/files') {
    return handleFileEditor(req, res, parsed);
  }

  // AI proxy (server-side call to upstream providers; SSE stream back)
  if (urlPath.startsWith('/api/ai/')) {
    return handleAI(req, res, parsed);
  }

  // Auth API (account list, sign-out, status polling, sign-in)
  if (urlPath.startsWith('/api/auth/')) {
    return handleAuth(req, res, parsed, serverConfig);
  }

  // Usage / pricing (model id list, built-in pricing table).
  // The chat UI never holds pricing data; the cost is computed
  // server-side per the stream and shipped on the `done` event.
  // The only read endpoint the chat UI uses here is /builtin, for
  // the SettingsPricing view's "known model ids" hint.
  if (urlPath === '/api/usage/builtin' && method === 'GET') {
    const table = usage.BUILTIN_PRICING || {};
    return sendJSON(res, 200, {
      ids: Object.keys(table).sort(),
      // Echo the table itself so the Settings view (or any future
      // "I want to see what default prices are" UI) doesn't have to
      // duplicate the data. Pricing values are public — no secrets
      // are exposed here.
      table
    });
  }

  // Prompt-size profiles. Static read-only endpoint that lists the
  // three profiles (very-small | average | extensive) so the chat
  // UI and the Settings view can render a picker without hard-coding
  // the labels or descriptions. The actual profile text is consumed
  // server-side at stream time; only the metadata is exposed here.
  if (urlPath === '/api/prompt-profiles' && method === 'GET') {
    return sendJSON(res, 200, {
      profiles: promptProfiles.listProfiles(),
      default: promptProfiles.DEFAULT_PROFILE
    });
  }

  // Agent features — structured state of every mouaif feature for a
  // project. Returns the same data the `list_features` tool provides.
  // Requires ?projectDir=<abs>.
  if (urlPath === '/api/features' && method === 'GET') {
    return handleFeatures(req, res, parsed);
  }

  // OAuth loopback callback (provider redirects here after login)
  if (urlPath === '/oauth/callback' && method === 'GET') {
    return handleOAuthCallback(req, res, parsed);
  }
  // No-browser fallback: the UI POSTs { provider, state, code } and
  // gets a JSON response. Same exchange as the GET path.
  if (urlPath === '/oauth/callback' && method === 'POST') {
    return handleOAuthCallbackPost(req, res, parsed);
  }

  // Chats (per-project chat list). The projectDir is part of the URL so
  // the routes are stable and cacheable; for the common case the
  // mobile UI ships it as a query string. PUT and DELETE carry it in
  // the JSON body.
  if (urlPath === '/api/chats' || urlPath.startsWith('/api/chats/')) {
    return handleChats(req, res, parsed, sessionToken);
  }

  // Prompts (custom per-project prompts)
  if (urlPath === '/api/prompts' || urlPath.startsWith('/api/prompts/')) {
    return handlePrompts(req, res, parsed);
  }

  // Project agents (project-scoped Markdown definitions + configuration)
  if (urlPath === '/api/agents' || urlPath.startsWith('/api/agents/')) {
    return handleAgents(req, res, parsed);
  }

  // Tool Authorization API
  if (urlPath.startsWith('/api/tools/authorization')) {
    return handleToolAuthorization(req, res, parsed);
  }

  // Git — direct git command execution (status, diff, log, add, commit).
  // Uses the project directory as working dir. No model round-trip.
  // GET /api/git/info?projectDir=<abs> returns parsed status + recent
  // commits + per-section diffs for the Git modal in the chat view.
  if (urlPath === '/api/git/info' && method === 'GET') {
    return handleGitInfo(req, res, parsed);
  }
  if (urlPath === '/api/git/commits' && method === 'GET') {
    return handleGitLog(req, res, parsed);
  }
  if (urlPath === '/api/git' && method === 'POST') {
    return handleGit(req, res, parsed);
  }

  // Tools — the native shell tool's direct REST surface (also the
  // /shell composer command). Model-initiated calls run inside the
  // AI client's tool loop and do not hit this endpoint.
  if (urlPath === '/api/tools/shell' || urlPath.startsWith('/api/tools/')) {
    return handleTools(req, res, parsed);
  }

  // MCP (Model Context Protocol) — per-project server registry +
  // lifecycle + tool dispatch. Routes are mounted in handleMcp below.
  if (urlPath === '/api/mcp' || urlPath.startsWith('/api/mcp/')) {
    return handleMcp(req, res, parsed);
  }

  // Server lifecycle — graceful restart. Stops MCP children, closes the
  // listening socket, then exits. When possible the CLI relaunches in-process;
  // otherwise an external supervisor may relaunch after exit code 0.
  if (urlPath === '/api/restart') {
    return handleRestart(req, res, parsed, lifecycle);
  }

  // Inspector — REST surface for the CDP bridge. The WebSocket proxy
  // at /api/inspector/proxy is handled in the server's 'upgrade'
  // event (see createServer below), not here.
  if (urlPath.startsWith('/api/inspector/')) {
    return handleInspector(req, res, parsed);
  }

  // Root opens the mobile UI. Keep the actual static bundle under
  // /web/ so asset URLs and the browser session cookie stay consistent.
  if (urlPath === '/' && method === 'GET') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  // REST: GET /data
  if (urlPath === '/data' && method === 'GET') {
    return sendJSON(res, 200, store);
  }

  // REST: POST /data
  if (urlPath === '/data' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body);
        Object.assign(store, parsedBody);
        store.timestamp = new Date().toISOString();
        broadcast('data-update', store);
        sendJSON(res, 200, { ok: true, data: store });
      } catch (e) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Push notification API — managed by the browser push subsystem.
  if (urlPath.startsWith('/api/push/')) {
    return handlePush(req, res, parsed, sessionToken, expectedOrigin(req, serverConfig.publicOrigin));
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
}

function createServer(port = DEFAULT_PORT, options = {}) {
  const requestedPublicOrigin = options && typeof options === 'object'
    ? (options.publicOrigin || process.env.MOUAIF_PUBLIC_ORIGIN || '')
    : (process.env.MOUAIF_PUBLIC_ORIGIN || '');
  const publicOrigin = normalizePublicOrigin(requestedPublicOrigin);
  if (requestedPublicOrigin && !publicOrigin) {
    throw Object.assign(new Error('publicOrigin must be an http(s) origin without a path'), { code: 'EBAD_PUBLIC_ORIGIN' });
  }
  // Run any pending database migrations before serving requests.
  try { settings.runMigrations(); } catch (e) { console.warn('[mouaif] migrations failed:', e.message); }
  try { accessAuth.ensureTables(); } catch (e) { console.warn('[mouaif] access auth init failed:', e.message); }
  // Initialise push notification tables and VAPID keys.
  try { push.ensureTable(); } catch (e) { console.warn('[mouaif] push table init failed:', e.message); }
  try { push.ensureVapidKeys(publicOrigin); } catch (e) { console.warn('[mouaif] VAPID key init failed:', e.message); }
  // Drop OAuth flows the user abandoned (closed the tab mid-sign-in). They
  // are never consumed and would otherwise accumulate PKCE verifiers in the
  // app store forever. Best-effort: a failure here must not stop the server.
  try {
    const pruned = auth.prunePending();
    if (pruned > 0) console.log(`[mouaif] pruned ${pruned} stale OAuth flow${pruned === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('[mouaif] could not prune stale OAuth flows:', e.message);
  }
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const lifecycle = (options && typeof options === 'object') ? (options.lifecycle || {}) : {};
  const serverConfig = { publicOrigin, authEnabled: options.authEnabled === true };
  const server = http.createServer((req, res) => {
    // Bind port to the request handler
    handleRequest(req, res, port, sessionToken, lifecycle, serverConfig);
  });
  // Track connections so the graceful-restart path can force-close
  // SSE / keep-alive sockets that would otherwise hang server.close().
  server.on('connection', trackSocket);
  server.on('secureConnection', trackSocket);
  // WebSocket upgrade routing. Only /api/inspector/proxy is upgraded;
  // any other upgrade is rejected so the rest of the server stays
  // untouched. The noServer WebSocketServer gives us manual
  // handleUpgrade() so we can decide per-request.
  const wss = inspector.makeNoServerWss();
  server.on('upgrade', (req, socket, head) => {
    const u = req.url || '';
    if (u.startsWith('/api/inspector/proxy')) {
      const origin = requestOrigin(req);
      const expected = expectedOrigin(req, publicOrigin);
      const cookies = parseCookies(req.headers.cookie);
      const actual = cookies[SESSION_COOKIE] || '';
      const validToken = actual.length === sessionToken.length
        && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(sessionToken));
      const accessToken = cookies[ACCESS_COOKIE] || '';
      const validAccess = !serverConfig.authEnabled || !!accessAuth.session(accessToken);
      if (!origin || origin !== expected || !validToken || !validAccess) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.end();
        return;
      }
      // The inspector module does the heavy lifting. We pass `server`
      // so it can complete the upgrade on the browser side via
      // server.handleUpgrade().
      inspector.handleProxy(req, socket, head, { server, wss, debuggerUrl: inspector.getDebuggerUrl() })
        .catch((e) => {
          // Already-closed sockets are normal; the only way to surface
          // a true error here is to write a 500-style HTTP response on
          // the raw socket.
          try {
            socket.write('HTTP/1.1 500 Internal\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.end();
          } catch { /* ignore */ }
        });
      return;
    }
    // Reject anything else.
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.end();
  });
  // Stash the wss so the inspector module can find it; not strictly
  // required today but lets a future commit add server-initiated
  // pushes (e.g. browser-driven "fetch the next page of history").
  void wss;
  return server;
}

module.exports = {
  createServer,
  broadcast,
  destroyOpenSockets,
  DEFAULT_PORT,
  settings,
  projects,
  ai,
  auth,
  oauthAnthropic,
  oauthCopilot,
  chats,
  resolveModel,
  seedModelListCache
};
