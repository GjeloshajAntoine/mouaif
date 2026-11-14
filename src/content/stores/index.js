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
//
// The project's mode is the `__dbBacked` marker in its `project_settings` row
// (see project-db.js). setProjectMode() moves every document between modes.

const appDb = require('./app-db.js');
const projectFile = require('./project-file.js');
const projectDb = require('./project-db.js');

const DOCS = Object.freeze(['settings']);

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
  if (scope === 'app') return appDb.createAppDbStore('settings');
  if (scope !== 'project') throw new TypeError('scope must be "app" or "project"');
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  const m = mode || projectMode(projectDir);
  return m === 'db'
    ? projectDb.createProjectDbStore(projectDir)
    : projectFile.createProjectFileStore(projectDir);
}

// Move a project between file and DB storage.
//
// To DB: each document is copied from its file into the DB — the file is what
// the project was reading until now. The files are left in place: nothing is
// deleted. To file: each document is written back to its file and the DB copy
// is cleared. Asking for the mode the project is already in changes nothing.
function setProjectMode(projectDir, dbBacked) {
  const current = projectMode(projectDir);
  const target = dbBacked ? 'db' : 'file';
  if (current === target) return target;
  for (const doc of DOCS) {
    const from = storeFor(doc, 'project', projectDir, current);
    const to = storeFor(doc, 'project', projectDir, target);
    to.write(stripMarker(from.read()));
    if (from.clear) from.clear();
  }
  return target;
}

function stripMarker(value) {
  const out = { ...value };
  delete out.__dbBacked;
  return out;
}

module.exports = {
  DOCS,
  storeFor,
  projectMode,
  setProjectMode,
  stripMarker
};
