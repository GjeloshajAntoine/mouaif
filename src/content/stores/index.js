'use strict';

// storeFor(doc, scope, projectDir) — the only function that knows where a
// document lives. Every adapter has the same members:
//
//   { kind, scope, location, read(), write(next) }
//
// | Document   | App scope              | Project, file mode       | Project, DB mode        |
// | ---------- | ---------------------- | ------------------------ | ----------------------- |
// | `settings` | `app_kv` row `settings` | `.mouaif.json` (or       | `project_settings` row  |
// |            |                        | `.mouaif/.mouaif.json`)  |                         |
// | `mcp`      | `mcp` inside the app   | `.mcp.json`              | `.mcp.json` if present, |
// |            | `settings` row         |                          | else `project_documents`|
//
// The `mcp` adapters also fall back to the legacy `mcp` block of the project's
// settings document; see project-mcp.js.
//
// The project's mode is the `__dbBacked` marker in its `project_settings` row
// (see project-db.js). setProjectMode() moves every document between modes.

const contentDb = require('../db.js');
const appDb = require('./app-db.js');
const projectFile = require('./project-file.js');
const projectDb = require('./project-db.js');
const projectMcp = require('./project-mcp.js');

const DOCS = Object.freeze(['settings', 'mcp']);

function badDoc(doc) {
  const e = new TypeError('unknown content document: ' + doc);
  e.code = 'EBADDOC';
  return e;
}

function projectMode(projectDir) {
  return projectDb.isDbBacked(projectDir) ? 'db' : 'file';
}

// One adapter per (doc, scope, mode). Built per call: an adapter is a handful
// of closures, and the mode can change between calls.
function storeFor(doc, scope, projectDir, mode) {
  if (!DOCS.includes(doc)) throw badDoc(doc);
  if (scope === 'app') {
    const settings = appDb.createAppDbStore('settings');
    return doc === 'mcp' ? projectMcp.createAppMcpStore(settings) : settings;
  }
  if (scope !== 'project') throw new TypeError('scope must be "app" or "project"');
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  const m = mode || projectMode(projectDir);
  const settings = m === 'db'
    ? projectDb.createProjectDbStore(projectDir)
    : projectFile.createProjectFileStore(projectDir);
  return doc === 'mcp' ? projectMcp.createProjectMcpStore(projectDir, m, settings) : settings;
}

// Take the write reservation before reading a document. SQLite also serves
// as the cross-process lock for settings files when workers share an app DB;
// their rename is atomic, but that alone cannot protect a read/merge/write.
// Callbacks must be synchronous. Emit notices only after this returns.
function withWriteLock(fn) {
  return contentDb.db().transaction(fn).immediate();
}

// Move a project between file and DB storage.
//
// Settings: to DB, the file is copied into the DB — the file is what the
// project was reading until now — and left in place: nothing is deleted. To
// file, the DB copy is written back to the file and cleared.
// MCP: see projectMcp.moveMode — an existing `.mcp.json` is read in both
// modes, so only a DB row moves (to file).
// Asking for the mode the project is already in changes nothing.
//
// Order: the settings copy, then the MCP row, then the old settings are
// cleared. The project's mode is the `__dbBacked` marker in the settings row,
// so it only flips at the last step: a write that throws on the way leaves the
// project in its old mode with every document where that mode reads it.
function setProjectMode(projectDir, dbBacked) {
  return withWriteLock(() => {
    const current = projectMode(projectDir);
    const target = dbBacked ? 'db' : 'file';
    if (current === target) return target;
    const from = storeFor('settings', 'project', projectDir, current);
    const to = storeFor('settings', 'project', projectDir, target);
    to.write(stripMarker(from.read()));
    projectMcp.moveMode(projectDir, target);
    if (from.clear) from.clear();
    return target;
  });
}

function stripMarker(value) {
  const out = { ...value };
  delete out.__dbBacked;
  return out;
}

module.exports = {
  DOCS,
  storeFor,
  withWriteLock,
  projectMode,
  setProjectMode,
  stripMarker
};
