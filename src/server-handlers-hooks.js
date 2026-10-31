'use strict';

// Hook REST handlers (docs/features/hooks.md).
//
//   GET  /api/hooks                          -> { enabled, list, events, shells, disabledByEnv }
//   PUT  /api/hooks   { enabled, list }      -> the saved config (validated)
//   POST /api/hooks/test { hook, payload?, projectDir? }
//                                            -> { parsed, code, ms, timedOut, stdout, stderr }
//
// Every route sits under /api/, so the browser-origin and access gates in
// http-server.js apply. Hooks run local commands: only a signed-in session can
// read or change them, and the model has no route to them (update_settings
// refuses keys outside CLIENT_SETTINGS_KEYS).

const fs = require('node:fs');
const { sendJSON, readJsonOr400 } = require('./server-shared.js');
const hooks = require('./hooks.js');

function view(config) {
  return {
    enabled: config.enabled,
    list: config.list,
    events: hooks.EVENTS,
    origins: hooks.ORIGINS,
    families: hooks.FAMILIES,
    shells: hooks.SHELLS,
    disabledByEnv: process.env.MOUAIF_NO_HOOKS === '1'
  };
}

async function handleHooks(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  try {
    if (urlPath === '/api/hooks' && method === 'GET') {
      return sendJSON(res, 200, view(hooks.getConfig()));
    }
    if (urlPath === '/api/hooks' && method === 'PUT') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      return sendJSON(res, 200, view(hooks.setConfig(body)));
    }
    if (urlPath === '/api/hooks/runs' && method === 'GET') {
      const q = parsed.query || {};
      return sendJSON(res, 200, { runs: hooks.listRuns({
        projectDir: typeof q.projectDir === 'string' ? q.projectDir : '',
        chatId: typeof q.chatId === 'string' ? q.chatId : '',
        limit: q.limit
      }) });
    }
    if (urlPath === '/api/hooks/test' && method === 'POST') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      const projectDir = typeof body.projectDir === 'string' && body.projectDir && fs.existsSync(body.projectDir) ? body.projectDir : '';
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
      return sendJSON(res, 200, await hooks.testHook(body.hook, payload, { projectDir, cwd: projectDir }));
    }
    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof hooks.HookError ? e.status : 500;
    return sendJSON(res, status, { error: e.message });
  }
}

module.exports = { handleHooks };
