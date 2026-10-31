'use strict';

// Extensions REST (docs/features/extensions.md, spec §6). Behind the normal
// session and access gates, like every /api route.
//
//   GET    /api/extensions?projectDir=                 -> { app: [...], project: [...], permissions }
//   POST   /api/extensions { manifest }                -> { extension, summary, replaced }  (imported OFF)
//   PUT    /api/extensions/:id { enabled? }            -> { extension }                     (app extension on/off)
//   PUT    /api/extensions/:id { projectDir, offInProject } -> { ok }                       (per-project switch)
//   DELETE /api/extensions/:id                         -> { ok }                            (app extension + its server)
//   GET    /api/extensions/:id/export                  -> the stored file + exportedAt (download)
//   POST   /api/extensions/:id/trust { projectDir, hash } -> { extension }                  (project extension)
//   DELETE /api/extensions/:id/trust?projectDir=       -> { ok }
//   GET    /api/extensions/surfaces?projectDir=&slot=  -> { surfaces }   (active views; mounts go
//                                                                         through POST /api/mcp/apps/mount)

const fs = require('node:fs');
const path = require('node:path');
const { sendJSON, readJsonOr400 } = require('./server-shared.js');
const extensions = require('./extensions.js');
const { HookError } = require('./hooks.js');

const ROUTE_RE = /^\/api\/extensions\/([a-z0-9][a-z0-9-]{0,39})(\/export|\/trust)?$/;

function projectDirOk(dir) {
  return typeof dir === 'string' && dir && path.isAbsolute(dir) && fs.existsSync(dir);
}

async function handleExtensions(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const query = parsed.query || {};
  try {
    if (urlPath === '/api/extensions' && method === 'GET') {
      const projectDir = projectDirOk(query.projectDir) ? query.projectDir : '';
      return sendJSON(res, 200, Object.assign(extensions.list(projectDir), { permissions: extensions.PERMISSIONS }));
    }
    if (urlPath === '/api/extensions' && method === 'POST') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      return sendJSON(res, 200, extensions.importApp(body.manifest));
    }
    // GET /api/extensions/surfaces?projectDir=&slot= -> { surfaces } — the views the UI may mount here.
    if (urlPath === '/api/extensions/surfaces' && method === 'GET') {
      if (!projectDirOk(query.projectDir)) return sendJSON(res, 200, { surfaces: [] });
      const slot = typeof query.slot === 'string' && query.slot ? query.slot : '';
      return sendJSON(res, 200, { surfaces: extensions.surfaces(query.projectDir, slot) });
    }
    const m = ROUTE_RE.exec(urlPath);
    if (!m) return sendJSON(res, 404, { error: 'not found' });
    const id = m[1];
    const sub = m[2] || '';
    if (!sub && method === 'PUT') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      if (typeof body.offInProject === 'boolean') {
        if (!projectDirOk(body.projectDir)) return sendJSON(res, 400, { error: 'projectDir must be an existing project folder' });
        extensions.setProjectOff(body.projectDir, id, body.offInProject);
        return sendJSON(res, 200, { ok: true });
      }
      if (typeof body.enabled !== 'boolean') return sendJSON(res, 400, { error: 'enabled (boolean) or offInProject (boolean) is required' });
      const view = extensions.setAppEnabled(id, body.enabled);
      if (!view) return sendJSON(res, 404, { error: 'no app extension "' + id + '"' });
      return sendJSON(res, 200, { extension: view });
    }
    if (!sub && method === 'DELETE') {
      if (!extensions.removeApp(id)) return sendJSON(res, 404, { error: 'no app extension "' + id + '"' });
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === '/export' && method === 'GET') {
      const file = extensions.exportApp(id);
      if (!file) return sendJSON(res, 404, { error: 'no app extension "' + id + '"' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + id + extensions.SUFFIX + '"'
      });
      res.end(JSON.stringify(file, null, 2) + '\n');
      return;
    }
    if (sub === '/trust' && (method === 'POST' || method === 'DELETE')) {
      let projectDir = query.projectDir;
      let body = null;
      if (method === 'POST') {
        body = await readJsonOr400(req, res);
        if (!body) return;
        projectDir = body.projectDir;
      }
      if (!projectDirOk(projectDir)) return sendJSON(res, 400, { error: 'projectDir must be an existing project folder' });
      if (method === 'DELETE') { extensions.revokeProject(projectDir, id); return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, { extension: extensions.trustProject(projectDir, id, typeof body.hash === 'string' ? body.hash : '') });
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e instanceof HookError ? e.status : (e && e.code === 'EBADINPUT' ? 400 : 500);
    return sendJSON(res, status, { error: e.message });
  }
}

module.exports = { handleExtensions };
