'use strict';
// Prompts + agent features + project agents REST handlers. Extracted
// from the original single-file http-server.js. Shared helpers live in
// src/server-shared.js.
const {
  sendJSON,
  qs,
  readJsonOr400,
  errCodeToHttpStatus,
  settings,
  prompts,
  chats,
  agents,
  agentFeatures,
  safeDecode
} = require('./server-shared.js');

// ---- Prompts API ---------------------------------------------------------
// Custom prompts. Stored in the app SQLite database or in project.prompts.
// Routes:
//   GET    /api/prompts[?projectDir=<abs>][&scope=app|project]  -> { prompts }
//   GET    /api/prompts/:id[?projectDir=<abs>][&scope=app|project] -> { prompt }
//   POST   /api/prompts   body: { projectDir?, scope?, title?, content, role? } -> { prompt }
//   PATCH  /api/prompts/:id  body: { projectDir?, scope?, title?, content?, role? } -> { prompt }
//   DELETE /api/prompts/:id[?projectDir=<abs>][&scope=app|project] -> { ok: true }
async function handlePrompts(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  function projectDirFrom(body) {
    const fromQuery = qs(q, 'projectDir');
    const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    return fromQuery || fromBody;
  }

  function promptError(e) {
    return errCodeToHttpStatus(e && e.code);
  }

  // GET /api/prompts[?projectDir=<abs>]
  if (urlPath === '/api/prompts' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    const scope = qs(q, 'scope');
    try {
      return sendJSON(res, 200, { prompts: prompts.listPrompts(dir, { scope }) });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/prompts/:id[?projectDir=<abs>]
  const getMatch = urlPath.match(/^\/api\/prompts\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const id = safeDecode(getMatch[1]);
    const dir = qs(q, 'projectDir');
    const scope = qs(q, 'scope');
    try {
      const p = prompts.getPrompt(dir, id, { scope });
      if (!p) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/prompts  body: { projectDir?, scope?, title?, content, role? }
  if (urlPath === '/api/prompts' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = projectDirFrom(body);
    const scope = body.scope || (dir ? 'project' : 'app');
    if (!dir && scope === 'project') {
      return sendJSON(res, 400, { error: 'projectDir is required for project-scoped prompts' });
    }
    try {
      const p = prompts.createPrompt(dir, body || {});
      return sendJSON(res, 201, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/prompts/:id  body: { projectDir?, scope?, title?, content?, role? }
  if (getMatch && method === 'PATCH') {
    const id = safeDecode(getMatch[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = projectDirFrom(body);
    try {
      const p = prompts.updatePrompt(dir, id, body || {});
      if (!p) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/prompts/:id[?projectDir=<abs>]
  if (getMatch && method === 'DELETE') {
    const id = safeDecode(getMatch[1]);
    const dir = qs(q, 'projectDir');
    const scope = qs(q, 'scope');
    try {
      let clearedChats = 0;
      const removed = prompts.deletePrompt(dir, id, {
        scope,
        onRemoved: (deletedId) => {
          if (dir) {
            clearedChats = chats.clearPromptId(dir, deletedId);
          } else {
            try {
              const allProjects = require('./projects.js').listProjects();
              for (const prj of allProjects) {
                if (prj && prj.path) {
                  clearedChats += chats.clearPromptId(prj.path, deletedId);
                }
              }
            } catch { /* non-fatal */ }
          }
        }
      });
      if (!removed) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { ok: true, removed: id, clearedChats });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'prompts' });
}

// ---- Agent features API ------------------------------------------------
// Structured state of every mouaif feature for a project. Returns the
// same data the `list_features` tool provides, without requiring a chat.
// Routes:
//   GET /api/features?projectDir=<abs>        -> { features: { ... } }
async function handleFeatures(req, res, parsed) {
  const dir = (parsed.query && parsed.query.projectDir || '').trim();
  if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
  try {
    const project = require('./settings.js').getProject(dir);
    let authz = null;
    try { authz = require('./tools/authorization.js').getAuthorization(dir); } catch { /* safe default */ }
    let mcpServers = null;
    try { mcpServers = require('./mcp.js').listServers(dir); } catch { /* safe default */ }
    const featureContent = agentFeatures.buildFeatureSummary({ projectDir: dir, project, authz, mcpServers });
    const jsonState = await agentFeatures.dispatchListFeatures({}, { projectDir: dir });
    sendJSON(res, 200, {
      features: (jsonState && jsonState.result) || {},
      summary: featureContent
    });
  } catch (e) {
    sendJSON(res, 500, { error: e.message, code: 'EINTERNAL' });
  }
}

// ---- Project agents API -----------------------------------------------
// Project-scoped named personas stored in .mouaif.json under `agents`.
// Each agent = { name, content, tools?, modelId? } — a delegation target
// for the native `subagent` tool, nothing else. See docs/features/agents.md.
// Routes:
//   GET    /api/agents?projectDir=<abs>          -> { agents }
//   POST   /api/agents  body: { projectDir, name, content, tools?, modelId? }
//   GET    /api/agents/:name?projectDir=<abs>    -> { agent } | 404
//   PATCH  /api/agents/:name  body: { projectDir, name?, content?, tools?, modelId? }
//   DELETE /api/agents/:name?projectDir=<abs>
async function handleAgents(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  function agentDirFrom(body) {
    const fromQuery = qs(q, 'projectDir');
    const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    return fromQuery || fromBody;
  }

  function agentError(e) {
    return errCodeToHttpStatus(e && e.code);
  }

  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  // GET/DELETE carry projectDir in the query string; POST/PATCH carry
  // it in the JSON body. Only the query-string routes can 400 up front.
  const dir = qs(q, 'projectDir');

  // GET /api/agents?projectDir=...
  if (urlPath === '/api/agents' && method === 'GET') {
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { agents: agents.list(dir) });
    } catch (e) {
      return sendJSON(res, agentError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/agents  body: { projectDir, name, content, tools? }
  if (urlPath === '/api/agents' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = agentDirFrom(body);
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const agent = agents.create(projectDir, body || {});
      return sendJSON(res, 201, { agent });
    } catch (e) {
      const status = e.code === 'EBADINPUT' ? 400 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET|PATCH|DELETE /api/agents/:name
  let getMatch = urlPath.match(/^\/api\/agents\/([^/]+)$/);
  if (getMatch) {
    const name = safeDecode(getMatch[1]);
    if (method === 'GET') {
      if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
      try {
        const agent = agents.get(dir, name);
        if (!agent) return sendJSON(res, 404, { error: 'Agent not found', name });
        return sendJSON(res, 200, { agent });
      } catch (e) {
        return sendJSON(res, agentError(e), { error: e.message, code: e.code || 'INTERNAL' });
      }
    }
    if (method === 'PATCH') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      const patchDir = dir || (body && typeof body.projectDir === 'string' ? body.projectDir : '');
      if (!patchDir) return sendJSON(res, 400, { error: 'projectDir is required' });
      try {
        const agent = agents.update(patchDir, name, body || {});
        if (!agent) return sendJSON(res, 404, { error: 'Agent not found', name });
        return sendJSON(res, 200, { agent });
      } catch (e) {
        return sendJSON(res, agentError(e), { error: e.message, code: e.code || 'INTERNAL' });
      }
    }
    if (method === 'DELETE') {
      if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
      try {
        const ok = agents.remove(dir, name);
        if (!ok) return sendJSON(res, 404, { error: 'Agent not found', name });
        return sendJSON(res, 200, { ok: true, removed: name });
      } catch (e) {
        return sendJSON(res, agentError(e), { error: e.message, code: e.code || 'INTERNAL' });
      }
    }
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'agents' });
}

module.exports = { handlePrompts, handleFeatures, handleAgents };
