'use strict';

// Who may write what. One table, read by the write pipeline
// (src/content/service.js) for every actor:
//
//   ui     the local web UI (settings routes)
//   tool   the model, through update_settings (or a content type's own tool)
//   share  a remote caller of a shared project (src/share-gate.js), through
//          the same routes; a share caller's model is `tool` with `remote`
//
// | Content                          | ui      | tool                 | share / remote |
// | -------------------------------- | ------- | -------------------- | -------------- |
// | app scope, clientVisible         | write   | write                | refuse         |
// | app scope, not clientVisible     | refuse  | refuse               | refuse         |
// | project scope (registered or not)| write   | write                | write, unless the type sets writers.share false |
// | secret field (an apiKey)         | write   | refuse               | refuse         |
// | approval: true (tools, mcp, …)   | write   | write after approval | as its actor   |
// | written by its own tool (hooks)  | refuse here: through its own route or tool |
//
// The approval itself is asked by the chat loop before the tool runs
// (src/ai-stream.js, PERMISSION_KEYS); a remote caller's own UI writes are the
// remote user's actions, bounded by the share gate's tool rules.

const registry = require('./registry.js');

function refusal(message, status = 400, code = 'EBADINPUT') {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function writableAppKeys() {
  return registry.clientSettingsKeys();
}

// checkKey({ key, scope, actor, remote }) -> { approval } or throws.
// `key` is a top-level key of the settings document.
function checkKey({ key, scope, actor = 'ui', remote = false }) {
  if (actor === 'share') remote = true;
  if (remote && scope === 'app') {
    throw refusal('App settings are not available through a shared project', 403, 'ESHARE_ROUTE');
  }
  const types = registry.typesForRoot(key);
  const dedicated = types.map(registry.dedicatedTool).find(Boolean);
  if (dedicated) {
    // Hooks are a page of Settings → Extensions (registry `page`).
    const under = String(types[0].page || '').startsWith('settings/extensions/') ? 'Extensions → ' : '';
    const label = under + (types[0].label || key);
    throw refusal(actor === 'tool'
      ? key + ' are not written through update_settings — use ' + dedicated
      : key + ' are not written through settings — use Settings → ' + label);
  }
  if (scope === 'app') {
    const visible = types.length && types.some((t) => t.clientVisible === true && t.scopes.includes('app'));
    if (!visible) {
      throw refusal('not a writable app setting: ' + key + ' — writable keys: ' + writableAppKeys().join(', '));
    }
  }
  const scoped = types.filter((t) => t.scopes.includes(scope));
  const writerActor = remote ? 'share' : actor;
  for (const t of scoped) {
    if (t.writers && t.writers[writerActor] === false) {
      throw refusal((t.label || key) + (remote
        ? ' cannot be changed through a shared project'
        : ' cannot be changed this way'), remote ? 403 : 400, remote ? 'ESHARE_ROUTE' : 'EBADINPUT');
    }
  }
  return { approval: actor === 'tool' && types.some((t) => t.approval === true) };
}

// checkType({ type, scope, actor, remote, via }) -> { approval } or throws.
// A write of one declared type through its own operations (a collection's
// put / remove, or a feature route). `via` names the dedicated tool or route
// making it: content written only by its own tool (hooks) is accepted when
// `via` is that tool, or `route` for its own HTTP route.
function checkType({ type, scope, actor = 'ui', remote = false, via = null }) {
  if (actor === 'share') remote = true;
  if (!type.scopes.includes(scope)) throw refusal(type.label + ' have no ' + scope + ' scope');
  if (remote && scope === 'app') {
    throw refusal('App settings are not available through a shared project', 403, 'ESHARE_ROUTE');
  }
  const dedicated = registry.dedicatedTool(type);
  if (dedicated && via !== dedicated && via !== 'route') {
    throw refusal(type.label + ' are written only through ' + dedicated);
  }
  const writerActor = remote ? 'share' : actor;
  if (type.writers && type.writers[writerActor] === false) {
    throw refusal(type.label + (remote ? ' cannot be changed through a shared project' : ' cannot be changed this way'),
      remote ? 403 : 400, remote ? 'ESHARE_ROUTE' : 'EBADINPUT');
  }
  return { approval: actor === 'tool' && type.approval === true };
}

// Secret fields (an `apiKey` on a provider or model entry, or a bare
// `apiKey` key) are written only from the local UI. A redacted snapshot —
// `hasApiKey` instead of the key — stays round-trippable for every actor.
function checkSecrets(patch, { actor = 'ui', remote = false } = {}) {
  if (actor === 'ui' && !remote) return;
  if (!patch || typeof patch !== 'object') return;
  const message = 'apiKey is not writable through this tool — connect the provider in Settings → Providers';
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) throw refusal(message);
  for (const key of Object.keys(patch)) {
    for (const type of registry.typesForRoot(key)) {
      if (type.shape !== 'collection' || type.path !== key) continue;
      const secrets = secretFields(type);
      if (!secrets.length || !Array.isArray(patch[key])) continue;
      for (const entry of patch[key]) {
        if (entry && typeof entry === 'object' && secrets.some((f) => Object.prototype.hasOwnProperty.call(entry, f))) {
          throw refusal(message);
        }
      }
    }
  }
}

function secretFields(type) {
  return Object.keys(type.fields || {}).filter((k) => type.fields[k].secret);
}

module.exports = { checkKey, checkType, checkSecrets, secretFields, refusal };
