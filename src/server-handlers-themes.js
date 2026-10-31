'use strict';

// Theme REST handlers (docs/features/themes.md).
//
//   GET    /api/themes                    -> { active, themes: [summary] }
//   PUT    /api/themes/active   { id }    -> { active }
//   POST   /api/themes          {theme}   -> { theme }        (create)
//   GET    /api/themes/<id>               -> { theme }        (with js)
//   PUT    /api/themes/<id>     {theme}   -> { theme }        (replace)
//   DELETE /api/themes/<id>               -> { active }
//   GET    /api/themes/<id>/script.js     -> the theme's JS module
//
// Every route sits under /api/, so the browser-origin and access gates in
// http-server.js apply, including to the script: it only loads for a signed-in
// session, and a cross-origin page cannot read or import it.

const { sendJSON, readJsonOr400 } = require('./server-shared.js');
const themes = require('./themes.js');

function fail(res, error) {
  const status = error instanceof themes.ThemeError ? error.status : 500;
  return sendJSON(res, status, { error: error.message });
}

function decode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

async function handleThemes(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  try {
    if (urlPath === '/api/themes' && method === 'GET') {
      return sendJSON(res, 200, themes.list());
    }
    if (urlPath === '/api/themes' && method === 'POST') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      return sendJSON(res, 200, { theme: themes.create(body) });
    }
    if (urlPath === '/api/themes/active' && method === 'PUT') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      return sendJSON(res, 200, themes.setActive(body.id));
    }

    const scriptMatch = urlPath.match(/^\/api\/themes\/([^/]+)\/script\.js$/);
    if (scriptMatch && method === 'GET') {
      const js = themes.script(decode(scriptMatch[1]));
      if (js === null) return sendJSON(res, 404, { error: 'theme not found' });
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        // The client imports `script.js?v=<content hash>`, so every edit is a
        // new URL; no-store keeps a deleted theme's code out of the HTTP cache.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(js);
    }

    const idMatch = urlPath.match(/^\/api\/themes\/([^/]+)$/);
    if (idMatch) {
      const id = decode(idMatch[1]);
      if (method === 'GET') {
        const theme = themes.get(id);
        return theme ? sendJSON(res, 200, { theme }) : sendJSON(res, 404, { error: 'theme not found' });
      }
      if (method === 'PUT') {
        const body = await readJsonOr400(req, res);
        if (!body) return;
        return sendJSON(res, 200, { theme: themes.update(id, body) });
      }
      if (method === 'DELETE') {
        return sendJSON(res, 200, themes.remove(id));
      }
    }
    return sendJSON(res, 404, { error: 'not found' });
  } catch (error) {
    return fail(res, error);
  }
}

module.exports = { handleThemes };
