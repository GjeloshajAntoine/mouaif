'use strict';

const fs = require('node:fs');
const path = require('node:path');
const apps = require('./instant-mcp-apps.js');
const mcp = require('./mcp.js');
const chats = require('./chats.js');
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
    const projectDir = apps.projectRoot(body.projectDir);
    const name = typeof body.name === 'string' ? body.name.trim() : 'On-the-fly app';
    if (!name || name.length > 100) throw err('EBADINPUT', 'App name must be 1–100 characters');
    if (parsed.pathname.endsWith('/request')) {
      if (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 16000) {
        throw err('EBADINPUT', 'App request must be 1–16000 characters');
      }
      const filename = apps.newSourcePath(projectDir);
      // No automatic AI call, model choice, settings mutation or execution.
      // The user reviews/sends this draft in a separate resumable dev chat.
      const chat = chats.createChat(projectDir, { title: 'Build app: ' + name });
      chats.updateChat(projectDir, chat.id, { draft: apps.developmentDraft(body.request.trim(), filename) });
      return sendJSON(res, 201, { chatId: chat.id, path: filename, url: '#/chat/' + encodeURIComponent(chat.id) });
    }
    const sources = ['path', 'source'].filter(key => body[key] !== undefined);
    if (sources.length !== 1) throw err('EBADINPUT', 'Provide exactly one path or source');
    let filename;
    if (sources[0] === 'path') {
      const { source, kind } = apps.readSource(projectDir, body.path);
      apps.renderHtml(source, kind, name);
      filename = body.path;
    } else {
      const kind = apps.sourceKind(body.filename);
      apps.renderHtml(body.source, kind, name);
      filename = apps.newSourcePath(projectDir, kind);
      fs.writeFileSync(path.join(projectDir, filename), body.source, { flag: 'wx', mode: 0o600 });
    }
    // Existing MCP registry/lifecycle and tool permissions remain authoritative.
    // The new server is stopped; sandbox and tool permissions still apply.
    const server = mcp.addServer(projectDir, { scope: 'project', name,
      command: process.execPath, args: [path.join(__dirname, 'instant-mcp-app-server.js'), projectDir, filename, name], cwd: projectDir });
    return sendJSON(res, 201, { server, path: filename });
  } catch (error) {
    const status = ['EBADINPUT', 'ENOENT', 'ENOTDIR', 'EEXIST'].includes(error.code) ? 400 : 500;
    return sendJSON(res, status, { error: error.message, code: error.code || 'INTERNAL' });
  }
}

module.exports = { handleInstantMcpApps };
