'use strict';

// Project-scope document store kept in the app DB (`project_settings` table),
// for projects that opted into "Store settings in app DB" so the working tree
// is never touched. The row value is the same raw object the project file
// would carry, plus the internal `__dbBacked: true` marker that records the
// opt-in itself.

const contentDb = require('../db.js');
const cache = require('./cache.js');

const { PROJECT_SETTINGS_TABLE } = contentDb;

// Prepared once per handle: tool authorization and hooks read this on every
// tool call, and the parsed row is cached until the store changes.
let rowStatement = null;
let rowStatementGeneration = -1;
function loadRow(dir) {
  const d = contentDb.db();
  if (rowStatementGeneration !== contentDb.generation()) {
    rowStatement = d.prepare(`SELECT value FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`);
    rowStatementGeneration = contentDb.generation();
  }
  const row = rowStatement.get(dir);
  if (!row) return { exists: false, value: {} };
  try {
    const value = JSON.parse(row.value);
    return { exists: true, value: value && typeof value === 'object' && !Array.isArray(value) ? value : {} };
  } catch { return { exists: true, value: {} }; }
}

function entry(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return { exists: false, value: {} };
  return cache.readRow('project:' + dir, () => loadRow(dir));
}

// Read-only look at the cached row, without the copy readRow() makes.
function peek(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return { exists: false, value: {} };
  return cache.peekRow('project:' + dir, () => loadRow(dir));
}

function hasRow(projectDir) {
  return peek(projectDir).exists;
}

function readRow(projectDir) {
  return entry(projectDir).value;
}

function isDbBacked(projectDir) {
  return peek(projectDir).value.__dbBacked === true;
}

function writeRow(projectDir, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('setDbProject() expects an object');
  }
  const dir = contentDb.requireCanonicalProjectDir(projectDir);
  contentDb.db()
    .prepare(
      `INSERT INTO ${PROJECT_SETTINGS_TABLE} (project_dir, value) VALUES (?, ?)
       ON CONFLICT(project_dir) DO UPDATE SET value = excluded.value`
    )
    .run(dir, JSON.stringify(next));
  cache.wroteRow('project:' + dir, next);
  return next;
}

// Remove a project's DB-backed settings row entirely. Canonicalizes the key
// like every other project-scoped write so a non-canonical spelling (trailing
// slash, `..` segment) still targets the row the opt-in created.
function deleteRow(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return;
  contentDb.db()
    .prepare(`DELETE FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`)
    .run(dir);
  cache.wroteRow('project:' + dir, {}, false);
}

function createProjectDbStore(projectDir) {
  return {
    kind: 'project-db',
    scope: 'project',
    location: PROJECT_SETTINGS_TABLE + ':' + (contentDb.canonicalProjectDir(projectDir) || projectDir),
    read: () => readRow(projectDir),
    // The opt-in marker lives in the row: a write never drops it.
    write: (next) => writeRow(projectDir, { ...next, __dbBacked: true }),
    clear: () => deleteRow(projectDir),
    version: () => cache.dbStamp()
  };
}

module.exports = {
  createProjectDbStore,
  isDbBacked,
  hasRow,
  readRow,
  writeRow,
  deleteRow
};
