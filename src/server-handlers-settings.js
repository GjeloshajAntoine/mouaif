'use strict';

// Settings REST handlers. Extracted from the original single-file
// http-server.js so no file stays above ~2 000 lines. See
// src/server-shared.js for the shared helpers (sendJSON, readJsonBody,
// settingsForClient, ...). Writes to the settings document go through the
// content write path, src/content/service.js.

const {
  sendJSON,
  qs,
  readJsonOr400,
  settingsForClient,
  projectForClient,
  connectionForClient,
  modelForClient,
  RESETTABLE_APP_KEYS,
  settings,
  ai
} = require('./server-shared.js');
const { connectionType, nextConnectionId } = require('./providerConnections.js');
const content = require('./content/service.js');
const collection = require('./content/collection.js');

// `share` when a shared project's remote caller made this request
// (src/share-gate.js runs it inside the caller's context), else `ui`.
function actorOf() {
  return require('./share-gate.js').currentCaller() ? 'share' : 'ui';
}

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
      return sendJSON(res, 200, { resolved: projectForClient(settings.getResolved(dir)) });
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
        project: projectForClient(settings.getProject(dir)),
        path: dbBacked ? null : settings.getProjectPath(dir),
        dbBacked
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/settings/app  body: { ...patch }   (shallow merge into app store)
  // Goes through the content write path (src/content/service.js): only
  // client-visible app keys are writable, the same rule update_settings has
  // always applied. The response adds the change list.
  if (urlPath === '/api/settings/app' && method === 'PUT') {
    const patch = await readJsonOr400(req, res);
    if (!patch) return;
    try {
      const r = content.applyPatch({ scope: 'app', patch, actor: actorOf() });
      return sendJSON(res, 200, { app: settingsForClient(r.document), changes: r.changes });
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message, code: e.code || undefined });
    }
  }

  // PUT /api/settings/project  body: { projectDir, unset?, ...patch }
  if (urlPath === '/api/settings/project' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const { projectDir, unset, ...patch } = body || {};
    if (!projectDir || typeof projectDir !== 'string') {
      return sendJSON(res, 400, { error: 'projectDir is required' });
    }
    try {
      // Project hooks run only after a trust review (src/projectHooks.js);
      // the policy refuses them here — they are edited in the file itself or
      // through the /api/hooks routes. A round-tripped snapshot's `hasApiKey`
      // marker is dropped and an entry re-sent without `apiKey` keeps it.
      const r = content.applyPatch({ scope: 'project', projectDir, patch, unset, actor: actorOf() });
      const dbBacked = settings.isDbBacked(projectDir);
      return sendJSON(res, 200, {
        project: projectForClient(r.document),
        path: dbBacked ? null : settings.getProjectPath(projectDir),
        dbBacked,
        changes: r.changes
      });
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message, code: e.code || undefined });
    }
  }

  // POST /api/settings/app/providers
  // body: { id?, type?, name?, baseUrl?, apiKey?, auth?, oauthAccount? }
  // Provider connections are app-level. Project model records reference
  // them by `provider`, keeping credentials out of project files.
  //
  // `{ type }` adds a connection and the server picks its id. `{ id }` updates
  // that connection, or adds it when the id is itself a type name, which is
  // what clients did before a type could have more than one connection.
  if (urlPath === '/api/settings/app/providers' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body !== 'object') {
      return sendJSON(res, 400, { error: 'id or type is required' });
    }
    if ((body.id !== undefined && typeof body.id !== 'string') || (body.type !== undefined && typeof body.type !== 'string')) {
      return sendJSON(res, 400, { error: 'id and type must be strings' });
    }
    const providers = collection.read('providers', 'app').slice();
    const wantedId = (body.id || '').trim();
    const idx = wantedId ? providers.findIndex(p => p && p.id === wantedId) : -1;
    const type = idx >= 0 ? connectionType(providers[idx]) : ((body.type || '').trim() || wantedId);
    if (!type) return sendJSON(res, 400, { error: 'id or type is required' });
    if (!Object.prototype.hasOwnProperty.call(ai.ENDPOINTS, type)) {
      return sendJSON(res, 400, { error: 'Unknown provider', id: wantedId || undefined, type });
    }
    if (idx >= 0 && body.type !== undefined && body.type.trim() !== type) {
      return sendJSON(res, 400, { error: 'A connection\'s type cannot change', id: wantedId, type });
    }
    if (idx < 0 && wantedId && wantedId !== type) {
      return sendJSON(res, 400, { error: 'Leave id out when adding a connection; the server picks it', id: wantedId });
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80)) {
      return sendJSON(res, 400, { error: 'name must be a string of at most 80 characters' });
    }
    if (body.auth !== undefined && body.auth !== 'apikey' && body.auth !== 'oauth') {
      return sendJSON(res, 400, { error: 'auth must be "apikey" or "oauth"' });
    }
    if (body.oauthAccount !== undefined && (typeof body.oauthAccount !== 'string' || body.oauthAccount.length > 256)) {
      return sendJSON(res, 400, { error: 'oauthAccount must be a string' });
    }
    const merged = Object.assign({}, idx >= 0 ? providers[idx] : {}, body, {
      id: wantedId || nextConnectionId(type, providers),
      type
    });
    delete merged.hasApiKey;
    if (typeof merged.name === 'string') merged.name = merged.name.trim();
    if (!merged.name) delete merged.name;
    if (!Object.prototype.hasOwnProperty.call(body, 'apiKey') && idx >= 0 && providers[idx].apiKey) {
      merged.apiKey = providers[idx].apiKey;
    }
    if (merged.auth === 'oauth') delete merged.apiKey;
    try {
      const r = collection.put('providers', 'app', undefined, merged);
      return sendJSON(res, 200, {
        provider: connectionForClient(merged),
        providers: r.value.map(connectionForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/providers/:id
  const delProviderMatch = urlPath.match(/^\/api\/settings\/app\/providers\/([A-Za-z0-9._-]+)$/);
  if (delProviderMatch && method === 'DELETE') {
    const id = delProviderMatch[1];
    if (!collection.get('providers', 'app', undefined, id)) return sendJSON(res, 404, { error: 'Provider not found', id });
    try {
      const r = collection.remove('providers', 'app', undefined, id);
      return sendJSON(res, 200, {
        ok: true,
        removed: connectionForClient(r.removed),
        providers: r.value.map(connectionForClient)
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
    const models = collection.read('models', 'app');
    const idx = models.findIndex(m => m && m.id === body.id);
    if (idx < 0 && !body.provider) {
      return sendJSON(res, 400, { error: 'provider is required when adding a new model' });
    }
    const merged = Object.assign({}, idx >= 0 ? models[idx] : {}, body);
    // Same dedup for the merged result (an existing apikey record
    // toggled to oauth would still carry apiKey from the prior entry).
    if (merged.auth === 'oauth') delete merged.apiKey;
    try {
      const r = collection.put('models', 'app', undefined, merged);
      return sendJSON(res, 200, {
        model: modelForClient(merged),
        models: r.value.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/models/:id  -> { ok, removed, models }
  const delModelMatch = urlPath.match(/^\/api\/settings\/app\/models\/([A-Za-z0-9._-]+)$/);
  if (delModelMatch && method === 'DELETE') {
    const id = delModelMatch[1];
    if (!collection.get('models', 'app', undefined, id)) return sendJSON(res, 404, { error: 'Model not found', id });
    try {
      const r = collection.remove('models', 'app', undefined, id);
      return sendJSON(res, 200, {
        ok: true,
        removed: modelForClient(r.removed),
        models: r.value.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // GET /api/settings/models/recent
  // The app-wide list of recently used models (newest first, capped at 20).
  // Deliberately not project-scoped: the same list follows the user across
  // every project. `projectDir` is accepted and ignored so an older client
  // keeps working.
  if (urlPath === '/api/settings/models/recent' && method === 'GET') {
    return sendJSON(res, 200, { recent: settings.getRecentModels() });
  }

  // POST /api/settings/models/recent  body: { provider, modelId }
  // Records a model as recently used (touches timestamp, deduplicates, caps at 20).
  if (urlPath === '/api/settings/models/recent' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const { provider, modelId } = body || {};
    if (!provider || !modelId) {
    return sendJSON(res, 400, { error: 'provider and modelId are required' });
    }
    settings.touchRecentModel(provider, modelId);
    return sendJSON(res, 200, { ok: true });
  }

  // DELETE /api/settings/models/recent
  // Clears the app-wide recent models list.
  if (urlPath === '/api/settings/models/recent' && method === 'DELETE') {
    settings.clearRecentModels();
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
      // A chat's artifacts follow the project's storage. They move first, so a
      // failed move leaves the project on its old store with nothing lost.
      if (body.dbBacked !== settings.isDbBacked(projectDir)) {
        require('./artifacts.js').moveStorage(projectDir, body.dbBacked);
      }
      // On: seed the DB from the existing file (if any); the file stays.
      // Off: write the DB copy back to the file and clear the row (keyed by
      // the canonical directory, so a trailing slash or `..` still finds it).
      settings.setDbBacked(projectDir, body.dbBacked);
      const dbBacked = settings.isDbBacked(projectDir);
      return sendJSON(res, 200, {
      dbBacked,
      project: projectForClient(settings.getProject(projectDir)),
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
    // setRules normalizes each entry and drops malformed ones, so the stored
    // value stays canonical and the file-tool reader never disagrees.
    try {
      return sendJSON(res, 200, { rules: hideFileContent.setRules(dir, body.rules) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  return sendJSON(res, 404, { error: 'Not found', scope: 'settings' });
}

module.exports = { handleSettings };
