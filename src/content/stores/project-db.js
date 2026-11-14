'use strict';

// Project-scope document store kept in the app DB (`project_settings` table),
// for projects that opted into "Store settings in app DB" so the working tree
// is never touched. The row value is the same raw object the project file
// would carry, plus the internal `__dbBacked: true` marker that records the
// opt-in itself.

const contentDb = require('../db.js');

const { PROJECT_SETTINGS_TABLE } = contentDb;

// Prepared once per handle: tool authorization and hooks read this on every
// tool call.
let rowStatement = null;
let rowStatementGeneration = -1;
function settingsRow(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return null;
  const d = contentDb.db();
  if (rowStatementGeneration !== contentDb.generation()) {
    rowStatement = d.prepare(`SELECT value FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`);
    rowStatementGeneration = contentDb.generation();
  }
  return rowStatement.get(dir) || null;
}

function hasRow(projectDir) {
  return !!settingsRow(projectDir);
}

function readRow(projectDir) {
  const row = settingsRow(projectDir);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

function isDbBacked(projectDir) {
  const row = settingsRow(projectDir);
  if (!row) return false;
  try { return JSON.parse(row.value).__dbBacked === true; } catch { return false; }
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
}

function createProjectDbStore(projectDir) {
  return {
    kind: 'project-db',
    scope: 'project',
    location: PROJECT_SETTINGS_TABLE + ':' + (contentDb.canonicalProjectDir(projectDir) || projectDir),
    read: () => readRow(projectDir),
    // The opt-in marker lives in the row: a write never drops it.
    write: (next) => writeRow(projectDir, { ...next, __dbBacked: true }),
    clear: () => deleteRow(projectDir)
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
