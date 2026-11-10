'use strict';

// The two places a chat's artifacts can live (docs/features/chat-artifacts.md).
// A project's own configuration decides, the way it decides where its settings
// live (docs/features/project-settings-storage.md):
//
//   - settings in the app DB: rows in `chat_artifact`, and the project stays
//     untouched.
//   - settings in `.mouaif.json`: files at
//     <project>/.mouaif/artifacts/<chatId>/<name>, usable by shell and file
//     tools. The folder is the source of truth, so a file a command writes there
//     is an artifact. `.artifacts.json` adds what a file cannot say about itself.
//
// Both stores speak the same small interface and the same row shape; everything
// above it (names, limits, links, mentions) is in src/artifacts.js.
//
//   row: { name, mimeType, size, description, createdBy, createdAt, updatedAt,
//          revision, path?, absolutePath? }   (the paths: file store only)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { err } = require('./util.js');
const { isTextBuffer } = require('./tags.js');

const ROOT_DIR = '.mouaif/artifacts';
const META_FILE = '.artifacts.json';
const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const MIME = Object.freeze({
  '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.xml': 'application/xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2'
});

function mimeOf(name, head) {
  return MIME[path.extname(name).toLowerCase()] || (isTextBuffer(head.subarray(0, 8192)) ? 'text/plain' : 'application/octet-stream');
}

function checkChatId(chatId) {
  if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) throw err('EBADINPUT', 'A chat id is required');
}

// ---- App DB ---------------------------------------------------------------

const CREATE = `
  CREATE TABLE IF NOT EXISTS chat_artifact (
    project_dir TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    content     BLOB NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    revision    TEXT NOT NULL,
    PRIMARY KEY (project_dir, chat_id, name)
  )
`;
// Everything but the content: a listing must not load every file into memory.
const COLUMNS = 'name, mime_type, size, description, created_by, created_at, updated_at, revision';

let ensured = null;
function sql() {
  const d = require('./settings.js').getDb();
  if (ensured !== d) {
    d.exec(CREATE);
    ensured = d;
  }
  return d;
}

// One project is one key, whether a caller holds its path as typed or its real
// path (the app tools resolve symlinks, chat records do not).
function projectKey(projectDir) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw err('EBADINPUT', 'projectDir must be an absolute path');
  try { return fs.realpathSync(projectDir); }
  catch { return path.resolve(projectDir); }
}

function keys(projectDir, chatId) {
  checkChatId(chatId);
  return [projectKey(projectDir), chatId];
}

function fromDbRow(row) {
  return {
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision
  };
}

const dbStore = {
  id: 'db',
  list(projectDir, chatId) {
    return sql().prepare('SELECT ' + COLUMNS + ' FROM chat_artifact WHERE project_dir = ? AND chat_id = ? ORDER BY updated_at DESC, name')
      .all(...keys(projectDir, chatId)).map(fromDbRow);
  },
  meta(projectDir, chatId, name) {
    const row = sql().prepare('SELECT ' + COLUMNS + ' FROM chat_artifact WHERE project_dir = ? AND chat_id = ? AND name = ?')
      .get(...keys(projectDir, chatId), name);
    return row ? fromDbRow(row) : null;
  },
  read(projectDir, chatId, name) {
    const row = sql().prepare('SELECT content FROM chat_artifact WHERE project_dir = ? AND chat_id = ? AND name = ?')
      .get(...keys(projectDir, chatId), name);
    return row ? row.content : null;
  },
  write(projectDir, chatId, name, bytes, fields) {
    sql().prepare(`INSERT INTO chat_artifact (project_dir, chat_id, name, content, mime_type, size, description, created_by, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_dir, chat_id, name) DO UPDATE SET content = excluded.content, mime_type = excluded.mime_type, size = excluded.size,
        description = excluded.description, created_by = excluded.created_by, created_at = excluded.created_at,
        updated_at = excluded.updated_at, revision = excluded.revision`)
      .run(...keys(projectDir, chatId), name, bytes, mimeOf(name, bytes), bytes.length, fields.description, fields.createdBy,
        fields.createdAt, fields.updatedAt, crypto.randomBytes(8).toString('hex'));
  },
  setDescription(projectDir, chatId, name, description) {
    sql().prepare('UPDATE chat_artifact SET description = ? WHERE project_dir = ? AND chat_id = ? AND name = ?')
      .run(description, ...keys(projectDir, chatId), name);
  },
  remove(projectDir, chatId, name) {
    sql().prepare('DELETE FROM chat_artifact WHERE project_dir = ? AND chat_id = ? AND name = ?').run(...keys(projectDir, chatId), name);
  },
  rename(projectDir, chatId, name, next) {
    const key = keys(projectDir, chatId);
    const d = sql();
    const { content } = d.prepare('SELECT content FROM chat_artifact WHERE project_dir = ? AND chat_id = ? AND name = ?').get(...key, name);
    d.prepare('UPDATE chat_artifact SET name = ?, mime_type = ?, revision = ? WHERE project_dir = ? AND chat_id = ? AND name = ?')
      .run(next, mimeOf(next, content), crypto.randomBytes(8).toString('hex'), ...key, name);
  },
  removeChat(projectDir, chatId) {
    sql().prepare('DELETE FROM chat_artifact WHERE project_dir = ? AND chat_id = ?').run(...keys(projectDir, chatId));
  },
  chats(projectDir) {
    return sql().prepare('SELECT DISTINCT chat_id FROM chat_artifact WHERE project_dir = ?').all(projectKey(projectDir)).map(row => row.chat_id);
  },
  emptied() {}
};

// ---- Project folder -------------------------------------------------------

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// The chat's folder, without following a symlink out of the project: `.mouaif`
// is project-controlled, like the folder the on-the-fly app store guards.
function locate(projectDir, chatId) {
  checkChatId(chatId);
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw err('EBADINPUT', 'projectDir must be an absolute path');
  const root = fs.realpathSync(projectDir);
  const dir = path.join(root, ...ROOT_DIR.split('/'), chatId);
  for (const part of [path.join(root, '.mouaif'), path.join(root, ...ROOT_DIR.split('/')), dir]) {
    if (fs.existsSync(part) && !isInside(root, fs.realpathSync(part))) throw err('EBADINPUT', 'Artifact storage must stay inside the project');
  }
  return { dir, rel: ROOT_DIR + '/' + chatId };
}

// A regular file only: a symlink here could expose anything on the machine.
function statFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch { return null; }
}

function readMeta(where) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(where.dir, META_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeAtomic(file, data) {
  const temp = path.join(path.dirname(file), '.tmp-' + crypto.randomBytes(6).toString('hex'));
  fs.writeFileSync(temp, data, { mode: 0o600 });
  try { fs.renameSync(temp, file); }
  catch (e) { fs.rmSync(temp, { force: true }); throw e; }
}

function writeMeta(where, meta) {
  writeAtomic(path.join(where.dir, META_FILE), JSON.stringify(meta, null, 2));
}

function fromFile(where, name, stat, meta) {
  const file = path.join(where.dir, name);
  const known = MIME[path.extname(name).toLowerCase()];
  let mimeType = known;
  if (!known) {
    const head = Buffer.alloc(8192);
    const fd = fs.openSync(file, 'r');
    try { mimeType = mimeOf(name, head.subarray(0, fs.readSync(fd, head, 0, 8192, 0))); }
    finally { fs.closeSync(fd); }
  }
  const entry = meta[name] && typeof meta[name] === 'object' ? meta[name] : {};
  return {
    name,
    mimeType,
    size: stat.size,
    description: typeof entry.description === 'string' ? entry.description : '',
    createdBy: entry.createdBy === 'agent' || entry.createdBy === 'user' ? entry.createdBy : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    revision: stat.size + ':' + stat.mtimeMs,
    path: where.rel + '/' + name,
    absolutePath: file
  };
}

const fileStore = {
  id: 'files',
  list(projectDir, chatId) {
    const where = locate(projectDir, chatId);
    let names;
    try { names = fs.readdirSync(where.dir); } catch { return []; }
    const meta = readMeta(where);
    const out = [];
    for (const name of names) {
      if (!NAME_RE.test(name)) continue;
      const stat = statFile(path.join(where.dir, name));
      if (stat) out.push(fromFile(where, name, stat, meta));
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  },
  meta(projectDir, chatId, name) {
    const where = locate(projectDir, chatId);
    const stat = statFile(path.join(where.dir, name));
    return stat ? fromFile(where, name, stat, readMeta(where)) : null;
  },
  read(projectDir, chatId, name) {
    const file = path.join(locate(projectDir, chatId).dir, name);
    return statFile(file) ? fs.readFileSync(file) : null;
  },
  write(projectDir, chatId, name, bytes, fields) {
    const where = locate(projectDir, chatId);
    fs.mkdirSync(where.dir, { recursive: true, mode: 0o700 });
    const file = path.join(where.dir, name);
    writeAtomic(file, bytes);
    // Moving between stores keeps the time an artifact last changed.
    const updated = new Date(fields.updatedAt);
    if (!Number.isNaN(updated.getTime())) fs.utimesSync(file, updated, updated);
    const meta = readMeta(where);
    meta[name] = { description: fields.description, createdBy: fields.createdBy, createdAt: fields.createdAt };
    writeMeta(where, meta);
  },
  setDescription(projectDir, chatId, name, description) {
    const where = locate(projectDir, chatId);
    const meta = readMeta(where);
    meta[name] = { ...(meta[name] || {}), description };
    writeMeta(where, meta);
  },
  remove(projectDir, chatId, name) {
    const where = locate(projectDir, chatId);
    fs.rmSync(path.join(where.dir, name));
    const meta = readMeta(where);
    if (meta[name]) { delete meta[name]; writeMeta(where, meta); }
  },
  rename(projectDir, chatId, name, next) {
    const where = locate(projectDir, chatId);
    fs.renameSync(path.join(where.dir, name), path.join(where.dir, next));
    const meta = readMeta(where);
    if (meta[name]) { meta[next] = meta[name]; delete meta[name]; writeMeta(where, meta); }
  },
  removeChat(projectDir, chatId) {
    fs.rmSync(locate(projectDir, chatId).dir, { recursive: true, force: true });
  },
  chats(projectDir) {
    const root = path.join(fs.realpathSync(projectDir), ...ROOT_DIR.split('/'));
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return entries.filter(entry => entry.isDirectory() && CHAT_ID_RE.test(entry.name)).map(entry => entry.name);
  },
  // Leaves no empty folders behind in a project that was moved out of. Only ever
  // removes a folder that is empty: `.mouaif/` can also hold the project's config.
  emptied(projectDir) {
    const root = fs.realpathSync(projectDir);
    for (const dir of [path.join(root, ...ROOT_DIR.split('/')), path.join(root, '.mouaif')]) {
      try { fs.rmdirSync(dir); } catch { return; }
    }
  }
};

// The store this project's configuration asks for.
function storeFor(projectDir) {
  return require('./settings.js').isDbBacked(projectDir) ? dbStore : fileStore;
}

module.exports = { dbStore, fileStore, storeFor, NAME_RE };
