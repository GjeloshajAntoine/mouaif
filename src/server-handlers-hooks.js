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
    // Project hooks and their trust (src/projectHooks.js):
    //   GET    /api/hooks/project?projectDir=        -> status + referenced files (first 8 KB each)
    //   POST   /api/hooks/project/trust { projectDir, hash } -> status (409 when it changed)
    //   DELETE /api/hooks/project/trust?projectDir=  -> status
    if (urlPath === '/api/hooks/project' || urlPath === '/api/hooks/project/trust') {
      const projectHooks = require('./projectHooks.js');
      let projectDir = parsed.query && typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
      let body = null;
      if (method === 'POST') {
        body = await readJsonOr400(req, res);
        if (!body) return;
        projectDir = typeof body.projectDir === 'string' ? body.projectDir : '';
      }
      if (!projectDir || !require('node:path').isAbsolute(projectDir) || !fs.existsSync(projectDir)) {
        return sendJSON(res, 400, { error: 'projectDir must be an existing project folder' });
      }
      const view = (st) => Object.assign({}, st, {
        files: st.files.map((f) => {
          if (f.missing) return f;
          let text = '';
          try { text = fs.readFileSync(require('node:path').join(projectDir, f.path), 'utf8').slice(0, 8192); } catch { /* unreadable */ }
          return Object.assign({}, f, { text, truncated: f.bytes > 8192 });
        })
      });
      if (urlPath === '/api/hooks/project' && method === 'GET') return sendJSON(res, 200, view(projectHooks.status(projectDir)));
      if (urlPath === '/api/hooks/project/trust' && method === 'POST') {
        return sendJSON(res, 200, view(projectHooks.trust(projectDir, typeof body.hash === 'string' ? body.hash : '')));
      }
      if (urlPath === '/api/hooks/project/trust' && method === 'DELETE') {
        projectHooks.revoke(projectDir);
        return sendJSON(res, 200, view(projectHooks.status(projectDir)));
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
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

// ---- A chat's own hooks (src/chatHooks.js) ----------------------------------
//
// GET    /api/chats/:id/hooks?projectDir=                 -> { hooks, runs, max }
// POST   /api/chats/:id/hooks { projectDir, entry }       -> { hook }        (added by the user)
// PUT    /api/chats/:id/hooks/:hookId { projectDir, entry?, status? } -> { hook }
// DELETE /api/chats/:id/hooks/:hookId?projectDir=         -> { ok }
// POST   /api/chats/:id/hooks/:hookId/promote { projectDir, scope: 'app' | 'project' } -> { ok, hook }
const CHAT_HOOKS_RE = /^\/api\/chats\/([^/]+)\/hooks(?:\/([^/]+))?(\/promote)?$/;

function isChatHooksPath(urlPath) {
  return CHAT_HOOKS_RE.test(urlPath);
}

function decode(part) {
  try { return decodeURIComponent(part); } catch { return null; }
}

async function handleChatHooks(req, res, parsed) {
  const chatHooks = require('./chatHooks.js');
  const m = CHAT_HOOKS_RE.exec(parsed.pathname);
  const chatId = m && decode(m[1]);
  const hookId = m && m[2] ? decode(m[2]) : '';
  const promote = !!(m && m[3]);
  if (!chatId || hookId === null) return sendJSON(res, 400, { error: 'bad path' });
  const method = req.method;
  try {
    let body = null;
    let projectDir = parsed.query && typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
    if (method === 'POST' || method === 'PUT') {
      body = await readJsonOr400(req, res);
      if (!body) return;
      if (typeof body.projectDir === 'string') projectDir = body.projectDir;
    }
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    let chat = null;
    try { chat = require('./chats.js').getChat(projectDir, chatId); } catch { chat = null; }
    if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id: chatId });

    if (!hookId && method === 'GET') {
      return sendJSON(res, 200, { hooks: chatHooks.list(projectDir, chatId),
        runs: hooks.listRuns({ projectDir, chatId, limit: 30 }), max: chatHooks.MAX_PER_CHAT, hooksOn: hooks.getConfig().enabled });
    }
    if (!hookId && method === 'POST') {
      return sendJSON(res, 200, { hook: chatHooks.add(projectDir, chatId, body.entry, 'user') });
    }
    if (hookId && promote && method === 'POST') {
      if (body.scope !== 'app' && body.scope !== 'project') return sendJSON(res, 400, { error: 'scope must be "app" or "project"' });
      const hook = chatHooks.promote(projectDir, chatId, hookId, body.scope);
      if (!hook) return sendJSON(res, 404, { error: 'Hook not found', hookId });
      return sendJSON(res, 200, { ok: true, hook });
    }
    if (hookId && !promote && method === 'PUT') {
      const row = chatHooks.update(projectDir, chatId, hookId, { entry: body.entry, status: body.status });
      if (!row) return sendJSON(res, 404, { error: 'Hook not found', hookId });
      return sendJSON(res, 200, { hook: row });
    }
    if (hookId && !promote && method === 'DELETE') {
      if (!chatHooks.remove(projectDir, chatId, hookId)) return sendJSON(res, 404, { error: 'Hook not found', hookId });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e instanceof hooks.HookError ? e.status : 500;
    return sendJSON(res, status, { error: e.message });
  }
}

module.exports = { handleHooks, handleChatHooks, isChatHooksPath };
