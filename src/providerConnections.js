'use strict';

// providerConnections — the app-level provider connections and their types.
//
// A connection has an `id` (what project models, chats, agents and bookmarks
// store as `provider` / `providerId`) and a `type` (the entry in
// src/ai-endpoints.js ENDPOINTS that says how to talk to it). They used to be
// the same string, which allowed one connection per type. They still are for
// the first connection of a type and for every record saved before `type`
// existed, so such a record needs no migration: its type is its id.
//
// A *hydrated* model (see hydrateModel) carries both: `provider` is the type,
// because that is what every request builder, parser and capability check
// branches on, and `providerId` is the connection. An unhydrated project model
// record only has `provider`, and there it is the connection id.
const settings = require('./settings.js');
const { projectModelRecord } = require('./util.js');

function connectionType(connection) {
  if (!connection) return '';
  return (typeof connection.type === 'string' && connection.type) || connection.id || '';
}

function listConnections() {
  const providers = settings.getApp().providers;
  return Array.isArray(providers) ? providers.filter(Boolean) : [];
}

function findConnection(id) {
  return id ? listConnections().find((p) => p.id === id) || null : null;
}

// providerTypeOf(id) — the type behind a connection id. An id with no
// connection is returned as is, so a bare type name keeps working for callers
// that ask about a provider before it is connected.
function providerTypeOf(id) {
  const connection = findConnection(id);
  return connection ? connectionType(connection) : id;
}

// connectionIdOf(model) — the connection a model belongs to, hydrated or not.
function connectionIdOf(model) {
  return (model && (model.providerId || model.provider)) || '';
}

// nextConnectionId(type, connections) — the first free id for a new connection.
// The first of a type takes the type name, so a project file that says
// `"provider": "ollama"` means the same thing on every machine.
function nextConnectionId(type, connections) {
  const taken = new Set((connections || []).map((p) => p && p.id));
  if (!taken.has(type)) return type;
  let n = 2;
  while (taken.has(type + '-' + n)) n++;
  return type + '-' + n;
}

// hydrateModel(connection, record) — a request-ready model: the connection owns
// transport and credentials, and the record contributes only the fields
// projectModelRecord allows. A missing connection still yields a record, which
// then fails on its missing credential with a clear error.
function hydrateModel(connection, record) {
  const { type, name, ...transport } = connection || {};
  const providerId = record && record.provider;
  return Object.assign({}, transport, projectModelRecord(record), {
    provider: connection ? connectionType(connection) : providerId,
    providerId
  });
}

module.exports = {
  connectionType,
  listConnections,
  findConnection,
  providerTypeOf,
  connectionIdOf,
  nextConnectionId,
  hydrateModel
};
