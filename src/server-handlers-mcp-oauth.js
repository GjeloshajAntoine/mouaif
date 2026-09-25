'use strict';

const oauth = require('./oauth-mcp.js');
const { sendJSON, readJsonOr400, expectedOrigin, mcp, safeDecode } = require('./server-shared.js');

async function handleMcpOAuth(req, res, parsed, serverConfig) {
  const match = parsed.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/oauth(?:\/(start))?$/);
  if (!match) return false;
  res.setHeader('Cache-Control', 'no-store');
  const isStart = !!match[2];
  if ((isStart && req.method !== 'POST') || (!isStart && !['GET', 'DELETE'].includes(req.method))) {
    sendJSON(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const body = isStart ? await readJsonOr400(req, res) : {};
  if (!body) return true;
  const dir = typeof parsed.query?.projectDir === 'string' ? parsed.query.projectDir : (typeof body.projectDir === 'string' ? body.projectDir : '');
  try {
    const context = mcp.getOAuthContext(dir, safeDecode(match[1]));
    if (!context) { sendJSON(res, 404, { error: 'Server not found' }); return true; }
    if (isStart) {
      await mcp.stopOAuthSessions(context);
      sendJSON(res, 200, await oauth.begin(context, expectedOrigin(req, serverConfig.publicOrigin)));
    } else if (req.method === 'DELETE') {
      // Revoke at the authorization server first (RFC 7009, best-effort and
      // bounded), then always drop local credentials. `?revoke=0` skips the
      // remote call. The client secret is configuration and is kept.
      let revoked = 'skipped';
      if (parsed.query?.revoke !== '0') {
        try { revoked = await oauth.revoke(context); } catch { revoked = 'failed'; }
      }
      oauth.clear(context);
      await mcp.stopOAuthSessions(context);
      sendJSON(res, 200, { ok: true, revoked });
    } else {
      sendJSON(res, 200, oauth.status(context));
    }
  } catch (e) {
    const code = ['EBADINPUT', 'EKEYRING', 'EMCP_AUTH'].includes(e.code) ? e.code : 'EMCP_AUTH';
    sendJSON(res, code === 'EBADINPUT' ? 400 : code === 'EKEYRING' ? 503 : 409, {
      code, error: code === e.code ? e.message : 'MCP OAuth failed. Check configuration and try again.'
    });
  }
  return true;
}

async function handleMcpOAuthCallback(req, res, parsed) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (req.method !== 'GET') { res.writeHead(405).end('Method not allowed'); return; }
  let ok = false;
  try {
    await oauth.finish(parsed.query?.state, parsed.query?.code, parsed.query?.error);
    ok = true;
  } catch { /* Never reflect provider-controlled errors, codes, or tokens. */ }
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP sign-in</title><h1>'
    + (ok ? 'MCP sign-in complete' : 'MCP sign-in failed')
    + '</h1><p>' + (ok ? 'Return to mouaif. You can now start this MCP server.' : 'The request expired, was declined, or could not be completed. Return to Settings and start sign-in again.')
    + '</p><p><a href="/">Return to mouaif</a></p></html>');
}
module.exports = { handleMcpOAuth, handleMcpOAuthCallback };
