'use strict';

// The `mcp` document: MCP servers and their authorization block.
//
// | Scope              | Read order                                   | Write target                 |
// | ------------------ | -------------------------------------------- | ---------------------------- |
// | app                | `mcp` inside the app settings row            | the same                     |
// | project, file mode | `.mcp.json`, else legacy `.mouaif.json` mcp  | `.mcp.json`                  |
// | project, DB mode   | `.mcp.json`, else DB row, else legacy mcp    | `.mcp.json` if it exists,    |
// |                    |                                              | else the DB row              |
//
// An existing `.mcp.json` always wins: it may be the user's own file, shared
// with other MCP clients, so a DB-mode project keeps reading and writing it.
// A DB-mode project without one never gets one created; its servers live in a
// `project_documents` row instead. The legacy `mcp` block of the project's
// settings document (`.mouaif.json`, or its DB row) is the last fallback, as
// it was before `.mcp.json` existed.
//
// `.mcp.json` is written atomically and cached on its stamp, like
// `.mouaif.json` (json-file.js, cache.js).

const fs = require('fs');
const path = require('path');
const contentDb = require('../db.js');
const cache = require('./cache.js');
const { createJsonFileStore } = require('./project-file.js');

const MCP_FILE = '.mcp.json';
const DOC = 'mcp';
const { PROJECT_DOCUMENTS_TABLE } = contentDb;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function getMcpPath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, MCP_FILE);
}

function fileExists(projectDir) {
  const st = fs.statSync(getMcpPath(projectDir), { throwIfNoEntry: false });
  return !!(st && st.isFile());
}

// `.mcp.json` as a plain store. A missing file reads as {}; a corrupt one
// throws MOUAIF_PROJECT_PARSE_ERROR (422 on the HTTP routes).
function createMcpFileStore(projectDir) {
  return createJsonFileStore('project-mcp-file', () => getMcpPath(projectDir));
}

// ---- DB row (project_documents) ------------------------------------------

let statements = null;
let statementsGeneration = -1;
function stmts() {
  if (statementsGeneration !== contentDb.generation()) {
    const d = contentDb.db();
    statements = {
      get: d.prepare(`SELECT value FROM ${PROJECT_DOCUMENTS_TABLE} WHERE project_dir = ? AND doc = ?`),
      put: d.prepare(
        `INSERT INTO ${PROJECT_DOCUMENTS_TABLE} (project_dir, doc, value) VALUES (?, ?, ?)
         ON CONFLICT(project_dir, doc) DO UPDATE SET value = excluded.value`
      ),
      del: d.prepare(`DELETE FROM ${PROJECT_DOCUMENTS_TABLE} WHERE project_dir = ? AND doc = ?`)
    };
    statementsGeneration = contentDb.generation();
  }
  return statements;
}

function rowKey(dir) {
  return 'projectdoc:' + DOC + ':' + dir;
}

function loadRow(dir) {
  const row = stmts().get.get(dir, DOC);
  if (!row) return { exists: false, value: {} };
  try {
    const value = JSON.parse(row.value);
    return { exists: true, value: isPlainObject(value) ? value : {} };
  } catch { return { exists: true, value: {} }; }
}

function readRow(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return { exists: false, value: {} };
  return cache.readRow(rowKey(dir), () => loadRow(dir));
}

function writeRow(projectDir, next) {
  const dir = contentDb.requireCanonicalProjectDir(projectDir);
  stmts().put.run(dir, DOC, JSON.stringify(next));
  cache.wroteRow(rowKey(dir), next);
  return next;
}

function deleteRow(projectDir) {
  const dir = contentDb.canonicalProjectDir(projectDir);
  if (!dir) return;
  stmts().del.run(dir, DOC);
  cache.wroteRow(rowKey(dir), {}, false);
}

// ---- Adapters ------------------------------------------------------------

// The legacy `mcp` block of a settings document, or {}.
function legacyBlock(settingsDoc) {
  return isPlainObject(settingsDoc) && isPlainObject(settingsDoc.mcp) ? settingsDoc.mcp : {};
}

// createProjectMcpStore(projectDir, mode, settingsStore)
//   mode           'file' | 'db' — the project's storage mode
//   settingsStore  the project's settings store in that mode (legacy fallback)
//
// `source()` says where the next read comes from: 'file', 'db' or 'legacy'.
function createProjectMcpStore(projectDir, mode, settingsStore) {
  const file = createMcpFileStore(projectDir);
  const source = () => {
    if (fileExists(projectDir)) return 'file';
    if (mode === 'db' && readRow(projectDir).exists) return 'db';
    return 'legacy';
  };
  return {
    kind: mode === 'db' ? 'project-mcp-db' : 'project-mcp-file',
    scope: 'project',
    get location() {
      if (mode === 'db' && !fileExists(projectDir)) {
        return PROJECT_DOCUMENTS_TABLE + ':' + (contentDb.canonicalProjectDir(projectDir) || projectDir) + ':' + DOC;
      }
      return getMcpPath(projectDir);
    },
    source,
    read: () => {
      const from = source();
      // Valid JSON that is not an object (`null`, a list) reads as an empty
      // document, as it did before the store existed.
      if (from === 'file') {
        const value = file.read();
        return isPlainObject(value) ? value : {};
      }
      if (from === 'db') return readRow(projectDir).value;
      return cache.clone(legacyBlock(settingsStore.read()));
    },
    write: (next) => {
      if (!isPlainObject(next)) throw new TypeError('an mcp document must be an object');
      if (mode === 'db' && !fileExists(projectDir)) return writeRow(projectDir, next);
      return file.write(next);
    },
    version: () => [
      cache.fileStamp(getMcpPath(projectDir)) || 'missing',
      mode === 'db' ? cache.dbStamp() : '',
      settingsStore.version()
    ].join('|')
  };
}

// App scope: the `mcp` block inside the app settings document (unchanged
// location). A write replaces that block and keeps every other app key.
function createAppMcpStore(appSettingsStore) {
  return {
    kind: 'app-mcp',
    scope: 'app',
    location: appSettingsStore.location + ':' + DOC,
    read: () => legacyBlock(appSettingsStore.read()),
    write: (next) => {
      if (!isPlainObject(next)) throw new TypeError('an mcp document must be an object');
      appSettingsStore.write({ ...appSettingsStore.read(), mcp: next });
      return next;
    },
    version: () => appSettingsStore.version()
  };
}

// Mode switch. To DB: nothing moves — an existing `.mcp.json` stays and is
// still preferred, and the legacy block travels with the settings document.
// To file: a DB row becomes `.mcp.json` (unless the user has one by now, which
// was already winning) and the row is cleared once written.
function moveMode(projectDir, target) {
  if (target !== 'file') return;
  const row = readRow(projectDir);
  if (!row.exists) return;
  if (fileExists(projectDir)) return;
  createMcpFileStore(projectDir).write(row.value);
  deleteRow(projectDir);
}

module.exports = {
  MCP_FILE,
  getMcpPath,
  fileExists,
  createProjectMcpStore,
  createAppMcpStore,
  moveMode,
  readRow,
  deleteRow
};
