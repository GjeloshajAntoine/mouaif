'use strict';

// Settings REST handlers. Extracted from the original single-file
// http-server.js so no file stays above ~2 000 lines. See
// src/server-shared.js for the shared helpers (sendJSON, readJsonBody,
// settingsForClient, sanitizeClientEntries, ...).

const {
  sendJSON,
  qs,
  readJsonOr400,
  settingsForClient,
  sanitizeClientEntries,
  connectionForClient,
  modelForClient,
  RESETTABLE_APP_KEYS,
  settings,
  ai
} = require('./server-shared.js');

async function handleSettings(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/settings -> { app, defaults, home }
  if (urlPath === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, {
      home: settings.MOUAIF_HOME,
      defaults: settingsForClient(settings.DEFAULTS),
      app: settingsForClient(settings.getApp())
    });
  }

  // GET /api/settings/resolved?projectDir=<abs path>
  if (urlPath === '/api/settings/resolved' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { resolved: settingsForClient(settings.getResolved(dir)) });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/settings/project?projectDir=<abs path>  -> { project, path, dbBacked }
  // Raw project file (no app merge, no defaults). The UI uses this to
  // show the project-level values separately from the resolved view.
  if (urlPath === '/api/settings/project' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const dbBacked = settings.isDbBacked(dir);
      return sendJSON(res, 200, {
        project: settingsForClient(settings.getProject(dir)),
        path: dbBacked ? null : settings.getProjectPath(dir),
        dbBacked
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/settings/app  body: { ...patch }   (shallow merge into app store)
  if (urlPath === '/api/settings/app' && method === 'PUT') {
    const patch = await readJsonOr400(req, res);
    if (!patch) return;
    try {
      for (const key of ['providers', 'models']) {
        sanitizeClientEntries(patch, key, settings.getApp()[key]);
      }
      const next = settings.setApp(patch);
      return sendJSON(res, 200, { app: settingsForClient(next) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // PUT /api/settings/project  body: { projectDir, ...patch }
  if (urlPath === '/api/settings/project' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const { projectDir, unset, ...patch } = body || {};
    if (!projectDir || typeof projectDir !== 'string') {
      return sendJSON(res, 400, { error: 'projectDir is required' });
    }
    try {
      // Same redaction contract as the app store: a round-tripped project
      // snapshot must not persist the response-only `hasApiKey` marker,
      // and an entry re-submitted without `apiKey` keeps the stored one.
      const currentProject = settings.getProject(projectDir);
      for (const key of ['providers', 'models']) {
        sanitizeClientEntries(patch, key, currentProject[key]);
      }
      let next = Object.keys(patch).length ? settings.setProject(projectDir, patch) : currentProject;
      if (Array.isArray(unset) && unset.length) next = settings.unsetProjectKeys(projectDir, unset);
      const dbBacked = settings.isDbBacked(projectDir);
      return sendJSON(res, 200, {
        project: settingsForClient(next),
        path: dbBacked ? null : settings.getProjectPath(projectDir),
        dbBacked
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // POST /api/settings/app/providers  body: { id, baseUrl?, apiKey?, auth?, oauthAccount? }
  // Provider connections are app-level. Project model records reference
  // them by `provider`, keeping credentials out of project files.
  if (urlPath === '/api/settings/app/providers' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id.trim()) {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    if (!Object.prototype.hasOwnProperty.call(ai.ENDPOINTS, body.id)) {
      return sendJSON(res, 400, { error: 'Unknown provider', id: body.id });
    }
    if (body.auth !== undefined && body.auth !== 'apikey' && body.auth !== 'oauth') {
      return sendJSON(res, 400, { error: 'auth must be "apikey" or "oauth"' });
    }
    if (body.oauthAccount !== undefined && (typeof body.oauthAccount !== 'string' || body.oauthAccount.length > 256)) {
      return sendJSON(res, 400, { error: 'oauthAccount must be a string' });
    }
    const app = settings.getApp();
    const providers = Array.isArray(app.providers) ? app.providers.slice() : [];
    const idx = providers.findIndex(p => p && p.id === body.id);
    const merged = Object.assign({}, idx >= 0 ? providers[idx] : {}, body, { id: body.id.trim() });
    delete merged.hasApiKey;
    if (!Object.prototype.hasOwnProperty.call(body, 'apiKey') && idx >= 0 && providers[idx].apiKey) {
      merged.apiKey = providers[idx].apiKey;
    }
    if (merged.auth === 'oauth') delete merged.apiKey;
    if (idx >= 0) providers[idx] = merged; else providers.push(merged);
    try {
      const next = settings.setApp({ providers });
      return sendJSON(res, 200, {
        provider: connectionForClient(merged),
        providers: next.providers.map(connectionForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/providers/:id
  const delProviderMatch = urlPath.match(/^\/api\/settings\/app\/providers\/([A-Za-z0-9._-]+)$/);
  if (delProviderMatch && method === 'DELETE') {
    const id = delProviderMatch[1];
    const app = settings.getApp();
    const providers = Array.isArray(app.providers) ? app.providers.slice() : [];
    const idx = providers.findIndex(p => p && p.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Provider not found', id });
    const [removed] = providers.splice(idx, 1);
    try {
      settings.setApp({ providers });
      return sendJSON(res, 200, {
        ok: true,
        removed: connectionForClient(removed),
        providers: providers.map(connectionForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // Legacy compatibility: app-level model CRUD is retained for older
  // clients. New clients configure providers globally and models per project.
  // POST /api/settings/app/models  body: { ...model }
  // Adds a model to the app-level models array, or merges into an
  // existing entry with the same id. `id` is required; `provider` is
  // required on add but optional on re-add (the existing entry is the
  // source of truth for that field). Returns the merged model and the
  // updated models array.
  if (urlPath === '/api/settings/app/models' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body !== 'object' || !body.id || typeof body.id !== 'string') {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    // Light validation: auth enum, oauthAccount shape, and a sanity
    // check that OAuth models don't carry a stale apiKey. We don't
    // enforce provider↔auth combos here (e.g. anthropic + oauth is
    // valid, openai-compatible + apikey is valid); that's the AI
    // client's job at request time.
    if (body.auth !== undefined && body.auth !== 'apikey' && body.auth !== 'oauth') {
      return sendJSON(res, 400, { error: 'auth must be "apikey" or "oauth"' });
    }
    if (body.oauthAccount !== undefined && (typeof body.oauthAccount !== 'string' || body.oauthAccount.length > 256)) {
      return sendJSON(res, 400, { error: 'oauthAccount must be a string' });
    }
    if (body.auth === 'oauth' && body.apiKey) {
      // OAuth models must not carry a leftover apiKey from a previous
      // apikey-mode entry. Drop it on merge rather than 400 — the user
      // may have toggled auth modes and forgotten to clear the key.
      delete body.apiKey;
    }
    const app = settings.getApp();
    const models = Array.isArray(app.models) ? app.models.slice() : [];
    const idx = models.findIndex(m => m && m.id === body.id);
    if (idx < 0 && !body.provider) {
      return sendJSON(res, 400, { error: 'provider is required when adding a new model' });
    }
    const merged = Object.assign({}, idx >= 0 ? models[idx] : {}, body);
    // Same dedup for the merged result (an existing apikey record
    // toggled to oauth would still carry apiKey from the prior entry).
    if (merged.auth === 'oauth') delete merged.apiKey;
    if (idx >= 0) models[idx] = merged; else models.push(merged);
    try {
      const next = settings.setApp({ models });
      return sendJSON(res, 200, {
        model: modelForClient(merged),
        models: next.models.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/models/:id  -> { ok, removed, models }
  const delModelMatch = urlPath.match(/^\/api\/settings\/app\/models\/([A-Za-z0-9._-]+)$/);
  if (delModelMatch && method === 'DELETE') {
    const id = delModelMatch[1];
    const app = settings.getApp();
    const models = Array.isArray(app.models) ? app.models.slice() : [];
    const idx = models.findIndex(m => m && m.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Model not found', id });
    const [removed] = models.splice(idx, 1);
    try {
      settings.setApp({ models });
      return sendJSON(res, 200, {
        ok: true,
        removed: modelForClient(removed),
        models: models.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // GET /api/settings/models/recent?projectDir=<abs>
  // Returns the recent models list for the given project (newest first, capped at 20).
  if (urlPath === '/api/settings/models/recent' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    return sendJSON(res, 200, { recent: settings.getRecentModels(dir) });
  }

  // POST /api/settings/models/recent  body: { projectDir, provider, modelId }
  // Records a model as recently used (touches timestamp, deduplicates, caps at 20).
  if (urlPath === '/api/settings/models/recent' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const { projectDir, provider, modelId } = body || {};
    if (!projectDir || !provider || !modelId) {
      return sendJSON(res, 400, { error: 'projectDir, provider, and modelId are required' });
    }
    settings.touchRecentModel(projectDir, provider, modelId);
    return sendJSON(res, 200, { ok: true });
  }

  // DELETE /api/settings/models/recent?projectDir=<abs>
  // Clears the recent models list for the given project.
  if (urlPath === '/api/settings/models/recent' && method === 'DELETE') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    settings.clearRecentModels(dir);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/settings/app/reset  body: { keys: ['models', 'flags'] }
  // Clears the listed app-level keys, restoring them to defaults.
  // Implementation: build a fresh patch that contains only the keys
  // NOT in the reset list. setApp shallow-merges, so omitting a key
  // from the patch is a no-op — we need a stronger reset, so we
  // explicitly delete the keys from a clone of the current app and
  // write that clone back.
  if (urlPath === '/api/settings/app/reset' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const keys = Array.isArray(body && body.keys) ? body.keys : [];
    const bad = keys.filter(k => !RESETTABLE_APP_KEYS.has(k));
    if (bad.length) return sendJSON(res, 400, { error: 'Unknown key(s)', bad });
    // Build a fresh object that omits the reset keys, then write it
    // through. SQLite stores the new object verbatim (setApp uses
    // { ...current, ...patch } internally; here we pass a patch that
    // does NOT include the reset keys, but the merged result still
    // contains them because the stored `current` does). So we need a
    // explicit delete: a special-cased "replace" path. The simplest
    // correct approach is to use the app store's underlying SQL: an
    // UPSERT of an object that has the keys removed.
    const current = settings.getApp();
    const next = Object.assign({}, current);
    for (const k of keys) delete next[k];
    try {
      // setApp is shallow-merge; passing the trimmed object and using
      // a direct write would be ideal, but we don't expose a
      // replace-at-the-root method. Cheapest correct option: pass an
      // empty patch alongside a sentinel, OR just deep-copy the app
      // and write the trimmed version through a new method.
      // -> we add setAppReplace for this.
      const result = settings.setAppReplace(next);
      return sendJSON(res, 200, { app: settingsForClient(result), reset: keys });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // GET /api/settings/project/storage?projectDir=<abs>
  // Reports where this project's settings live. `dbBacked: true` means the
  // settings are persisted in the app SQLite store (no .mouaif.json written);
  // `dbBacked: false` means the .mouaif.json file on disk.
  if (urlPath === '/api/settings/project/storage' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { dbBacked: settings.isDbBacked(dir) });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/settings/project/storage  body: { projectDir, dbBacked }
  // Moves a project between file-backed and DB-backed storage. Toggling on
  // copies the current project object into the DB and leaves any existing
  // .mouaif.json untouched (nothing is deleted). Toggling off writes the DB
  // copy back to .mouaif.json and clears the DB row.
  if (urlPath === '/api/settings/project/storage' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (typeof body.dbBacked !== 'boolean') {
      return sendJSON(res, 400, { error: 'dbBacked must be a boolean' });
    }
    try {
      if (body.dbBacked) {
        // Seed from the existing file (if any), then flag as DB-backed.
        settings.setDbProject(projectDir, { ...settings.getProjectRaw(projectDir), __dbBacked: true });
      } else {
        const current = settings.getDbProjectRaw(projectDir);
        delete current.__dbBacked;
        settings.writeProjectJson(settings.getProjectPath(projectDir), current);
        settings.getDb()
          .prepare('DELETE FROM ' + settings.PROJECT_SETTINGS_TABLE + ' WHERE project_dir = ?')
          .run(projectDir);
      }
      const dbBacked = settings.isDbBacked(projectDir);
      return sendJSON(res, 200, {
        dbBacked,
        project: settingsForClient(settings.getProject(projectDir)),
        path: dbBacked ? null : settings.getProjectPath(projectDir)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // ---- Hide file content (redaction) --------------------------------------
  // Per-project "hide file content" rules (docs/features/hide-file-content.md).
  // The user marks line ranges of a project file that the agent file tools
  // should not reveal. Stored on the project object under `hideFileContent`.
  //   GET  /api/settings/hide-file-content?projectDir=<abs>  -> { rules, project }
  //   PUT  /api/settings/hide-file-content                 body { projectDir, rules }
  // GET reads the normalized rules so the UI always sees a clean shape.
  const hideFileContent = require('./hideFileContent.js');
  if (urlPath === '/api/settings/hide-file-content' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { rules: hideFileContent.getRules(dir) });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }
  if (urlPath === '/api/settings/hide-file-content' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!Array.isArray(body.rules)) {
      return sendJSON(res, 400, { error: 'rules must be an array' });
    }
    // Normalize each entry; drop malformed ones. This keeps the stored value
    // canonical so the file-tool reader and this endpoint never disagree.
    const normalized = body.rules.map(hideFileContent.normalizeEntry).filter(Boolean);
    try {
      settings.setProject(dir, { hideFileContent: normalized });
      return sendJSON(res, 200, { rules: hideFileContent.getRules(dir) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  return sendJSON(res, 404, { error: 'Not found', scope: 'settings' });
}

module.exports = { handleSettings };
