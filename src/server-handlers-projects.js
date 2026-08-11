'use strict';

// Projects + file editor + file tagging REST handlers. Extracted from
// the original single-file http-server.js. Shared helpers live in
// src/server-shared.js.

const os = require('os');
const path = require('path');
const {
  sendJSON,
  qs,
  readJsonOr400,
  errCodeToHttpStatus,
  settings,
  projects,
  chats,
  files,
  tags
} = require('./server-shared.js');

function projectsErrorStatus(err) {
  return errCodeToHttpStatus(err && err.code, 400);
}

async function handleProjects(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // File editor (in-app CodeMirror popup). See handleFileEditor for the
  // contract; dispatched here so /api/file, /api/files, and the
  // image-preview /api/file-media route all win over the generic
  // /api/projects routes below.
  if (urlPath === '/api/file' || urlPath === '/api/files' || urlPath === '/api/file-media') {
    return handleFileEditor(req, res, parsed);
  }

  // File tagging (docs/decisions.md §15). Routes live under a
  // registered project id: /api/projects/:id/tags[/...]. Delegated to
  // handleTags before the folder-picker / registered-project routes so
  // the more specific path wins.
  if (/^\/api\/projects\/[^/]+\/tags(\/.*)?$/.test(urlPath)) {
    return handleTags(req, res, parsed);
  }

  // GET /api/projects?dir=<abs>  -> list subdirs
  if (urlPath === '/api/projects' && method === 'GET') {
    const dir = typeof q.dir === 'string' && q.dir ? q.dir : os.homedir();
    try {
      const result = projects.listDir(dir);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, projectsErrorStatus(e), { error: e.message, code: e.code, path: e.path || dir });
    }
  }

  // GET /api/projects/registered
  if (urlPath === '/api/projects/registered' && method === 'GET') {
    return sendJSON(res, 200, { projects: projects.listProjects() });
  }

  // DELETE /api/projects/registered/:id
  const delMatch = urlPath.match(/^\/api\/projects\/registered\/([A-Za-z0-9_-]+)$/);
  if (delMatch && method === 'DELETE') {
    const ok = projects.removeProject(delMatch[1]);
    if (!ok) return sendJSON(res, 404, { error: 'Not found', id: delMatch[1] });
    return sendJSON(res, 200, { ok: true });
  }

  // PATCH /api/projects/registered/:id  body: { name }
  if (delMatch && method === 'PATCH') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const name = body && typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return sendJSON(res, 400, { error: 'name is required' });
    const updated = projects.renameProject(delMatch[1], name);
    if (!updated) return sendJSON(res, 404, { error: 'Not found', id: delMatch[1] });
    return sendJSON(res, 200, { project: updated });
  }

  // POST /api/projects  body: { action, ... }
  if (urlPath === '/api/projects' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const action = body && body.action;
    try {
      if (action === 'list') {
        const dir = typeof body.dir === 'string' && body.dir ? body.dir : os.homedir();
        return sendJSON(res, 200, projects.listDir(dir));
      }
      if (action === 'create') {
        if (typeof body.parent !== 'string' || typeof body.name !== 'string' || !body.name) {
          return sendJSON(res, 400, { error: 'parent and name are required' });
        }
        const target = path.join(body.parent, body.name);
        const out = projects.createDir(target);
        return sendJSON(res, 201, { ...out, parent: body.parent, name: body.name });
      }
      if (action === 'register') {
        if (typeof body.dir !== 'string' || !body.dir) {
          return sendJSON(res, 400, { error: 'dir is required' });
        }
        const row = projects.registerProject(body.dir);
        // Seed the persisted project total cost.
        try { chats.recomputeProjectTotalCost(body.dir); } catch { /* non-fatal */ }
        return sendJSON(res, 200, { project: row });
      }
      return sendJSON(res, 400, { error: 'Unknown action', action });
    } catch (e) {
      return sendJSON(res, projectsErrorStatus(e), { error: e.message, code: e.code, path: e.path });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'projects' });
}

// ---- File editor API ---------------------------------------------------
// Read + write text files inside a registered project folder, for the
// in-app CodeMirror editor popup. All paths are project-relative (or
// absolute under the project root). Both the project root and every
// read/write/list path go through files.resolveSafe, so the same
// home + MOUAIF_ALLOW_ANY_ROOT guard that protects the rest of the
// server applies here too.
//
// Endpoints:
//   GET  /api/files?projectDir=<abs>&dir=<abs>          -> list a folder
//   GET  /api/file?projectDir=<abs>&path=<abs|rel>      -> read a text file
//   PUT  /api/file   body { projectDir, path, content } -> write a text file
//   GET  /api/file-media?projectDir=<abs>&path=<abs|rel> -> read an image as data URL
//
// Errors map to typed codes so the UI can render the right message
// (EBINARY -> "binary file, cannot edit", ETOOLARGE -> "file too big",
// EOUTSIDE_PROJECT -> 403, ENOTIMAGE -> "file is not an image", etc.).

function filesErrorStatus(err) {
  return errCodeToHttpStatus(err && err.code, 400);
}

async function handleFileEditor(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/files?projectDir=<abs>&dir=<abs>  -> list a folder
  if (urlPath === '/api/files' && method === 'GET') {
    const projectDir = qs(q, 'projectDir');
    const dir = qs(q, 'dir');
    try {
      return sendJSON(res, 200, files.listDir(projectDir, dir));
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path });
    }
  }

  // GET /api/file?projectDir=<abs>&path=<abs|rel>  -> read a text file
  if (urlPath === '/api/file' && method === 'GET') {
    const projectDir = qs(q, 'projectDir');
    const path = qs(q, 'path');
    try {
      const out = await files.readFile(projectDir, path);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path, size: e.size, maxBytes: e.maxBytes });
    }
  }

  // PUT /api/file  body { projectDir, path, content }  -> write a text file
  if (urlPath === '/api/file' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const path = body && typeof body.path === 'string' ? body.path : '';
    const content = body && typeof body.content === 'string' ? body.content : null;
    try {
      const out = await files.writeFile(projectDir, path, content);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path, size: e.size, maxBytes: e.maxBytes });
    }
  }

  // GET /api/file-media?projectDir=<abs>&path=<abs|rel>
  // Read an image file (or other previewable binary) as a base64
  // data URL. Used by the file editor popup to render an <img>
  // preview for .png/.jpg/.gif/.webp/.svg/.bmp/.ico without needing
  // a separate auth-bearing URL. The data URL is small (<= 1 MiB
  // cap, same as the text read).
  if (urlPath === '/api/file-media' && method === 'GET') {
    const projectDir = qs(q, 'projectDir');
    const path = qs(q, 'path');
    try {
      const out = await files.readMedia(projectDir, path);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path, size: e.size, maxBytes: e.maxBytes });
    }
  }
  return sendJSON(res, 404, { error: 'Not found', scope: 'fileEditor' });
}

// ---- File tagging API ---------------------------------------------------
// Per-project file tags (docs/decisions.md §15). All routes hang off a
// registered project id so the UI never has to pass an absolute path:
//   GET    /api/projects/:id/tags               -> { tags: { ... } }
//   PUT    /api/projects/:id/tags               body { tags: {...} }
//   POST   /api/projects/:id/tags/scan          body { exts? }
//   DELETE /api/projects/:id/tags/files/<relPath>
// The project id resolves to its absolute dir via projects.getProject.
// Tag CRUD requires a registered project (404 otherwise). Path escapes
// return 403 EOUTSIDE_PROJECT.

function tagsErrorStatus(err) {
  return errCodeToHttpStatus(err && err.code);
}

async function handleTags(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  // Pull the project id out of the path and resolve to an absolute dir.
  const idMatch = urlPath.match(/^\/api\/projects\/([^/]+)\/tags/);
  if (!idMatch) return sendJSON(res, 404, { error: 'Not found', scope: 'tags' });
  const projectId = decodeURIComponent(idMatch[1]);
  const project = projects.getProject(projectId);
  if (!project) return sendJSON(res, 404, { error: 'Project not registered', id: projectId });
  const dir = project.path;

  const rest = urlPath.slice(idMatch[0].length); // '' | '/scan' | '/files/<rel>'

  // GET /api/projects/:id/tags
  if (rest === '' && method === 'GET') {
    try {
      return sendJSON(res, 200, { tags: tags.getTags(dir) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/projects/:id/tags  body: { tags: { ... } }
  if (rest === '' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const map = body && typeof body.tags === 'object' && body.tags ? body.tags : {};
    try {
      return sendJSON(res, 200, { tags: tags.setTags(dir, map) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/projects/:id/tags/scan  body: { exts?: [...] }
  if (rest === '/scan' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const exts = body && Array.isArray(body.exts) ? body.exts : null;
    try {
      return sendJSON(res, 200, { files: tags.scanFiles(dir, exts) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/projects/:id/tags/files/<relPath>
  const fileMatch = rest.match(/^\/files\/(.+)$/);
  if (fileMatch && method === 'DELETE') {
    const relPath = decodeURIComponent(fileMatch[1]);
    try {
      const removed = tags.removeTag(dir, relPath);
      if (!removed) return sendJSON(res, 404, { error: 'Tag entry not found', path: relPath });
      return sendJSON(res, 200, { ok: true, removed: relPath });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'tags' });
}

module.exports = { handleProjects, handleFileEditor, handleTags };
