'use strict';

// Chat artifact REST handlers (docs/features/chat-artifacts.md).
//
//   GET    /api/chats/:id/artifacts?projectDir=            -> { artifacts }
//   GET    /api/chats/:id/artifacts/:name?projectDir=      -> the file, as a download
//     &inline=1  draws a PNG, JPEG, WebP or GIF in the page
//     &text=1    -> { artifact, text } for the Files editor, up to 1 MiB
//   PUT    /api/chats/:id/artifacts/:name?projectDir=      raw bytes -> { artifact, created }
//   PATCH  /api/chats/:id/artifacts/:name?projectDir=      { name?, description? } -> { artifact }
//   DELETE /api/chats/:id/artifacts/:name?projectDir=      -> { removed }
//   POST   /api/chats/:id/artifacts/:name/open?projectDir= -> shows it as an app in the chat
//
// Every route sits under /api/, so the browser-origin and access gates in
// http-server.js apply.

const { sendJSON, readJsonOr400, runningChats, runningKey } = require('./server-shared.js');
const artifacts = require('./artifacts.js');
const chats = require('./chats.js');
const messages = require('./messages.js');

const ARTIFACTS_RE = /^\/api\/chats\/([^/]+)\/artifacts(?:\/([^/]+)(\/open)?)?$/;
const STATUS = Object.freeze({ EBADINPUT: 400, EBINARY: 415, ENOTFOUND: 404, ETOOLARGE: 413, EEXIST: 409, EALREADY_RUNNING: 409, EARTIFACT_MISSING: 409 });

function isArtifactsPath(urlPath) {
  return ARTIFACTS_RE.test(urlPath);
}

function decode(part) {
  try { return decodeURIComponent(part); }
  catch { return ''; }
}

// Bounded, so a large upload cannot fill memory. Past the limit the rest of the
// body is read and dropped: cutting the connection would lose the 413 and show
// the user a network error instead of the reason.
function readBytes(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let parts = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        parts = [];
        reject(Object.assign(new Error('An artifact can be at most 16 MiB'), { code: 'ETOOLARGE' }));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// An artifact is untrusted content on the app's own origin. Only a raster image
// is ever drawn in place; everything else downloads, and `sandbox` stops an HTML
// file from running with the app's cookies even if a browser opens it anyway.
function sendFile(res, artifact, bytes, inline) {
  const canInline = inline && artifacts.RASTER_IMAGES.has(artifact.mimeType);
  res.writeHead(200, {
    'Content-Type': canInline ? artifact.mimeType : 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Disposition': (canInline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(artifact.name),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(bytes);
}

// Show an artifact as an app without a model turn, as the tool would: a call and
// its result in the transcript are what a mounted card is bound to.
function openAsApp(projectDir, chatId, name) {
  if (runningChats.has(runningKey(projectDir, chatId))) {
    throw Object.assign(new Error('Wait for the current response to finish'), { code: 'EALREADY_RUNNING' });
  }
  const created = require('./instant-mcp-apps.js').createApp(projectDir, { path: artifacts.LINK_PREFIX + name, name }, { chatId });
  const toolCallId = 'artifact_' + messages.newClientId('a');
  const args = { path: artifacts.LINK_PREFIX + name, name };
  messages.appendMessage(projectDir, chatId, { role: 'tool', phase: 'call', toolCallId, name: 'create_mcp_app', args, content: JSON.stringify(args) });
  const result = { ok: true, ...created, content: [{ type: 'text', text: created.name + ' is ready in this chat.' }] };
  messages.appendMessage(projectDir, chatId, { role: 'tool', phase: 'result', toolCallId, name: 'create_mcp_app', ok: true, content: JSON.stringify(result) });
  return result;
}

async function handleArtifacts(req, res, parsed) {
  const match = parsed.pathname.match(ARTIFACTS_RE);
  const chatId = decode(match[1]);
  const name = match[2] ? decode(match[2]) : null;
  const opening = !!match[3];
  const { method } = req;
  const query = parsed.query || {};
  const projectDir = typeof query.projectDir === 'string' ? query.projectDir : '';
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
  try {
    if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', code: 'ENOTFOUND' });
    if (!name) {
      if (method !== 'GET') return sendJSON(res, 405, { error: 'Method not allowed' });
      return sendJSON(res, 200, { artifacts: artifacts.list(projectDir, chatId) });
    }
    if (opening) {
      if (method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });
      return sendJSON(res, 200, openAsApp(projectDir, chatId, artifacts.checkName(name)));
    }
    if (method === 'GET') {
      if (query.text === '1') {
        return sendJSON(res, 200, artifacts.readForEditor(projectDir, chatId, name));
      }
      const { artifact, bytes } = artifacts.readBytes(projectDir, chatId, name);
      return sendFile(res, artifact, bytes, query.inline === '1');
    }
    if (method === 'PUT') {
      const bytes = await readBytes(req, artifacts.MAX_ARTIFACT_BYTES);
      return sendJSON(res, 200, artifacts.save(projectDir, chatId, name, bytes, {
        createdBy: 'user', ...(typeof query.description === 'string' ? { description: query.description } : {})
      }));
    }
    if (method === 'PATCH') {
      const body = await readJsonOr400(req, res);
      if (!body) return undefined;
      let current = artifacts.checkName(name);
      if (body.description !== undefined) artifacts.setDescription(projectDir, chatId, current, body.description);
      if (body.name !== undefined) current = artifacts.rename(projectDir, chatId, current, body.name).name;
      return sendJSON(res, 200, { artifact: artifacts.get(projectDir, chatId, current) });
    }
    if (method === 'DELETE') {
      return sendJSON(res, 200, { removed: artifacts.remove(projectDir, chatId, name) });
    }
    return sendJSON(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    const code = e && e.code;
    if (res.headersSent) return undefined;
    return sendJSON(res, STATUS[code] || 500, { error: (e && e.message) || String(e), code: code || 'INTERNAL' });
  }
}

module.exports = { handleArtifacts, isArtifactsPath };
