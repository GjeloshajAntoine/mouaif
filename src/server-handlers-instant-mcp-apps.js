'use strict';

const apps = require('./instant-mcp-apps.js');
const { err } = require('./util.js');
const { sendJSON, readJsonOr400, expectedOrigin } = require('./server-shared.js');

async function handleInstantMcpApps(req, res, parsed, publicOrigin) {
  const origin = expectedOrigin(req, publicOrigin);
  if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin)
    || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
    return sendJSON(res, 403, { error: 'App creation origin mismatch', code: 'EORIGIN' });
  }
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Use POST', code: 'EBADINPUT' });
  const body = await readJsonOr400(req, res);
  if (!body) return;
  try {
    const isRequest = parsed.pathname.endsWith('/request');
    if (isRequest ? body.request === undefined : body.request !== undefined) throw err('EBADINPUT', 'Use the matching request or import endpoint');
    // HTTP imports remain stopped; only the explicitly approved native tool
    // starts its fixed adapter. Both paths use the same validation/storage.
    return sendJSON(res, 201, apps.createApp(body.projectDir, body));
  } catch (error) {
    const status = ['EBADINPUT', 'ENOENT', 'ENOTDIR', 'EEXIST'].includes(error.code) ? 400 : 500;
    return sendJSON(res, status, { error: error.message, code: error.code || 'INTERNAL' });
  }
}

module.exports = { handleInstantMcpApps };
