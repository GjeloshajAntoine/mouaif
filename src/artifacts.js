'use strict';

// Chat artifacts: files kept with one chat (docs/features/chat-artifacts.md).
//
// Where they live follows the project's own configuration (src/artifactStores.js):
// the app DB for a project that keeps its settings there, otherwise a folder in
// the project. This module is everything that does not depend on which.
//
// `@artifact:<name>` in a message attaches one for that turn. `artifact:<name>`
// in an app's HTML is a data link, resolved when the app mounts: refreshing an
// app's data never means sending its HTML again.

const path = require('node:path');
const { err } = require('./util.js');
const hideFileContent = require('./hideFileContent.js');
const { isTextBuffer } = require('./tags.js');
const { dbStore, fileStore, storeFor } = require('./artifactStores.js');

const LINK_PREFIX = 'artifact:';
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACTS = 200;
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_IMAGE_MENTION_BYTES = 6 * 1024 * 1024;
const DEFAULT_MENTION_BYTES = 256 * 1024;
const DEFAULT_READ_CHARS = 64 * 1024;
const MAX_READ_CHARS = 200 * 1000;
const MAX_EDITOR_BYTES = 1024 * 1024; // the same limit as a project file in the editor

// No whitespace (an @-mention ends at whitespace), no separators, no leading dot.
const NAME = '[\\p{L}\\p{N}_][\\p{L}\\p{N}._-]*';
const NAME_RE = new RegExp('^' + NAME + '$', 'u');
// The name ends where the quote ends, so `artifact:a.json"` never reads `a.json"`.
const SCRIPT_LINK = new RegExp('<script\\b([^>]*?)\\bsrc\\s*=\\s*(["\'])artifact:(' + NAME + ')\\2([^>]*)>\\s*</script\\s*>', 'giu');
const ATTR_LINK = new RegExp('\\b(src|href|poster)\\s*=\\s*(["\'])artifact:(' + NAME + ')\\2', 'giu');
const CSS_LINK = new RegExp('url\\(\\s*(["\']?)artifact:(' + NAME + ')\\1\\s*\\)', 'giu');
const MENTION = /(?:^|\s)@artifact:([^\s]+)/gu;

// What a model can look at directly, and what a page can safely draw itself.
const RASTER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const APP_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs']);

// ---- Names and paths ------------------------------------------------------

function checkName(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFC') : '';
  if (name.startsWith(LINK_PREFIX)) return checkName(name.slice(LINK_PREFIX.length));
  if (!name || name.length > MAX_NAME_CHARS || !NAME_RE.test(name) || name.endsWith('.')) {
    throw err('EBADINPUT', 'Artifact names are 1–' + MAX_NAME_CHARS + ' letters, digits, ".", "_" or "-", with no spaces or folders');
  }
  return name;
}

// A person's filename becomes a valid name; a folder in it is still refused.
function cleanName(raw) {
  if (typeof raw !== 'string') throw err('EBADINPUT', 'name is required');
  const value = raw.startsWith(LINK_PREFIX) ? raw.slice(LINK_PREFIX.length) : raw;
  if (/[\\/]/.test(value)) throw err('EBADINPUT', 'Artifact names cannot contain folders');
  return checkName(value.normalize('NFC').trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+\./g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, MAX_NAME_CHARS));
}

// ---- Store ----------------------------------------------------------------

function kindOf(mimeType) {
  if (RASTER_IMAGES.has(mimeType)) return 'image';
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'image/svg+xml') return 'text';
  return 'binary';
}

function present(row) {
  return {
    name: row.name,
    link: LINK_PREFIX + row.name,
    // Only an artifact that is a real file has somewhere a command can open.
    ...(row.path ? { path: row.path, absolutePath: row.absolutePath } : {}),
    mimeType: row.mimeType,
    kind: kindOf(row.mimeType),
    app: APP_EXTENSIONS.has(path.extname(row.name).toLowerCase()),
    size: row.size,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function list(projectDir, chatId) {
  return storeFor(projectDir).list(projectDir, chatId).map(present);
}

function get(projectDir, chatId, rawName) {
  const name = checkName(rawName);
  const row = storeFor(projectDir).meta(projectDir, chatId, name);
  if (!row) throw err('ENOTFOUND', 'No artifact named ' + name + ' in this chat');
  return present(row);
}

function checkDescription(description) {
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_CHARS) {
    throw err('EBADINPUT', 'description must be at most ' + MAX_DESCRIPTION_CHARS + ' characters');
  }
}

// save(projectDir, chatId, rawName, data, { description, createdBy })
// -> { artifact, created }. Replacing an artifact keeps who made it and when.
function save(projectDir, chatId, rawName, data, options = {}) {
  const name = cleanName(rawName);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : '', 'utf8');
  if (bytes.length > MAX_ARTIFACT_BYTES) throw err('ETOOLARGE', 'An artifact can be at most 16 MiB');
  if (options.description !== undefined) checkDescription(options.description);
  const store = storeFor(projectDir);
  const held = store.list(projectDir, chatId);
  const previous = held.find(row => row.name === name);
  if (!previous && held.length >= MAX_ARTIFACTS) throw err('ETOOLARGE', 'A chat can hold at most ' + MAX_ARTIFACTS + ' artifacts');
  const total = held.reduce((sum, row) => sum + row.size, 0) - (previous ? previous.size : 0) + bytes.length;
  if (total > MAX_CHAT_BYTES) throw err('ETOOLARGE', 'A chat can hold at most 256 MiB of artifacts');
  const now = new Date().toISOString();
  store.write(projectDir, chatId, name, bytes, {
    description: options.description !== undefined ? options.description : (previous ? previous.description : ''),
    createdBy: previous ? previous.createdBy : (options.createdBy || null),
    createdAt: previous ? previous.createdAt : now,
    updatedAt: now
  });
  return { artifact: get(projectDir, chatId, name), created: !previous };
}

function setDescription(projectDir, chatId, rawName, description) {
  checkDescription(description);
  const artifact = get(projectDir, chatId, rawName);
  storeFor(projectDir).setDescription(projectDir, chatId, artifact.name, description);
  return get(projectDir, chatId, artifact.name);
}

function remove(projectDir, chatId, rawName) {
  const artifact = get(projectDir, chatId, rawName);
  storeFor(projectDir).remove(projectDir, chatId, artifact.name);
  return artifact.name;
}

// Renaming keeps this chat's apps working: their links follow the artifact.
function rename(projectDir, chatId, rawName, rawNext) {
  const store = storeFor(projectDir);
  const current = get(projectDir, chatId, rawName);
  const next = cleanName(rawNext);
  if (next === current.name) return current;
  if (store.meta(projectDir, chatId, next)) throw err('EEXIST', 'This chat already has an artifact named ' + next);
  store.rename(projectDir, chatId, current.name, next);
  for (const row of store.list(projectDir, chatId)) {
    if (!present(row).app) continue;
    const { source, count } = replaceLink(store.read(projectDir, chatId, row.name).toString('utf8'), current.name, next);
    if (!count) continue;
    store.write(projectDir, chatId, row.name, Buffer.from(source, 'utf8'), {
      description: row.description, createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: new Date().toISOString()
    });
  }
  return get(projectDir, chatId, next);
}

function uniqueName(projectDir, chatId, rawName) {
  const store = storeFor(projectDir);
  const name = cleanName(rawName);
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let n = 2; store.meta(projectDir, chatId, candidate); n++) candidate = base + '-' + n + extension;
  return candidate;
}

function readBytes(projectDir, chatId, rawName) {
  const artifact = get(projectDir, chatId, rawName);
  return { artifact, bytes: storeFor(projectDir).read(projectDir, chatId, artifact.name) };
}

// The whole text. What reaches the model has the project's hidden lines hidden,
// when the artifact has a path a rule can name. The owner's editor gets the file
// as it is (`redact: false`), or saving would write the [hidden] markers into it.
function readWhole(projectDir, chatId, rawName, redact = true) {
  const { artifact, bytes } = readBytes(projectDir, chatId, rawName);
  if (artifact.kind !== 'text' && !isTextBuffer(bytes.subarray(0, 8192))) {
    throw err('EBINARY', artifact.name + ' is ' + artifact.mimeType + ', not text. ' + reachHint(artifact));
  }
  const text = bytes.toString('utf8');
  return { artifact, whole: redact && artifact.path ? hideFileContent.redactText(projectDir, artifact.path, text).text : text };
}

function reachHint(artifact) {
  return artifact.path ? 'Use its path with a shell or file tool.' : 'Use export_artifact to get it as a file.';
}

// The whole text for the owner's editor, or a sentence saying why it can't open.
function readForEditor(projectDir, chatId, rawName) {
  const artifact = get(projectDir, chatId, rawName);
  if (artifact.size > MAX_EDITOR_BYTES) throw err('ETOOLARGE', artifact.name + ' is too large to open in the editor (1 MiB limit). Download it instead.');
  return { artifact, text: readWhole(projectDir, chatId, artifact.name, false).whole };
}

// A page's worth at a time, so one read cannot fill a turn.
function readText(projectDir, chatId, rawName, options = {}) {
  const { artifact, whole } = readWhole(projectDir, chatId, rawName);
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, MAX_READ_CHARS) : DEFAULT_READ_CHARS;
  const text = whole.slice(offset, offset + limit);
  const end = offset + text.length;
  return { artifact, text, totalChars: whole.length, nextOffset: end < whole.length ? end : null };
}

// moveStorage(projectDir, toDb) -> how many artifacts moved. Called before a
// project's storage switch takes effect: everything is copied first and the old
// copies go last, so a failure leaves the project on its old store, complete.
function moveStorage(projectDir, toDb) {
  const from = toDb ? fileStore : dbStore;
  const to = toDb ? dbStore : fileStore;
  const chatIds = from.chats(projectDir);
  let moved = 0;
  for (const chatId of chatIds) {
    for (const row of from.list(projectDir, chatId)) {
      to.write(projectDir, chatId, row.name, from.read(projectDir, chatId, row.name), row);
      moved++;
    }
  }
  for (const chatId of chatIds) from.removeChat(projectDir, chatId);
  if (chatIds.length) from.emptied(projectDir);
  return moved;
}

// ---- Data links in an app's HTML ------------------------------------------

function listLinks(source) {
  const names = new Set();
  const text = String(source);
  for (const match of text.matchAll(ATTR_LINK)) names.add(match[3]);
  for (const match of text.matchAll(CSS_LINK)) names.add(match[2]);
  return [...names];
}

function replaceLink(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('artifact:' + escaped + '(?![\\p{L}\\p{N}._-])', 'gu');
  let count = 0;
  const updated = source.replace(pattern, () => { count++; return LINK_PREFIX + to; });
  return { source: updated, count };
}

// relink(source, map) -> { source, relinked }: only `artifact:` names change,
// so a data refresh can never change what the app's code does.
function relink(source, map) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
    throw err('EBADINPUT', 'relink maps a linked artifact name to the one to use instead');
  }
  let current = source;
  const relinked = {};
  for (const [rawFrom, rawTo] of Object.entries(map)) {
    const from = checkName(rawFrom);
    const to = checkName(rawTo);
    const result = replaceLink(current, from, to);
    if (!result.count) {
      const found = listLinks(current);
      throw err('EBADINPUT', 'This app has no link to ' + from + (found.length ? '. It links: ' + found.join(', ') : '. It has no artifact links.'));
    }
    current = result.source;
    relinked[from] = to;
  }
  return { source: current, relinked };
}

function toDataUrl(artifact, bytes) {
  return 'data:' + artifact.mimeType + ';base64,' + bytes.toString('base64');
}

// Inline an artifact in a <script> without it closing the element early. JSON
// and JavaScript have an escape for `<` that keeps their meaning; other text
// has none, so risky text is decoded into the element by a script right after.
function inlineScript(attributes, artifact, bytes) {
  if (artifact.kind === 'image' || artifact.kind === 'binary') {
    throw err('EBADINPUT', artifact.name + ' is not text, so a <script> cannot hold it. Link it from <img src> instead.');
  }
  const text = bytes.toString('utf8');
  const open = '<script' + attributes + ' data-artifact="' + artifact.name + '">';
  if (artifact.mimeType === 'application/json') return open + text.replace(/</g, '\\u003c') + '</script>';
  if (artifact.mimeType === 'text/javascript') return open + text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--') + '</script>';
  if (!/<\/script|<!--/i.test(text)) return open + text + '</script>';
  return open + '</script><script>(s=>{s.previousElementSibling.textContent=new TextDecoder().decode(Uint8Array.from(atob("'
    + bytes.toString('base64') + '"),c=>c.charCodeAt(0)));s.remove()})(document.currentScript)</script>';
}

// resolveLinks(projectDir, chatId, source) -> html with every link inlined.
//   <script type="application/json" id="data" src="artifact:sales.json"></script>
//   <img src="artifact:logo.png">   background: url(artifact:bg.webp)
// An app has no network, so its data has to travel with it. A link to a missing
// artifact fails here with a sentence rather than as an empty page.
function resolveLinks(projectDir, chatId, source) {
  const loaded = new Map();
  const load = name => {
    if (!loaded.has(name)) {
      try { loaded.set(name, readBytes(projectDir, chatId, name)); }
      catch (e) {
        if (e.code === 'ENOTFOUND') throw err('EARTIFACT_MISSING', 'This app links artifact:' + name + ', which is not in this chat');
        throw e;
      }
    }
    return loaded.get(name);
  };
  return String(source)
    .replace(SCRIPT_LINK, (tag, before, quote, name, after) => {
      const { artifact, bytes } = load(name);
      return inlineScript(before.trimEnd() + (after.trim() ? ' ' + after.trim() : ''), artifact, bytes);
    })
    .replace(ATTR_LINK, (match, attribute, quote, name) => {
      const { artifact, bytes } = load(name);
      return attribute + '=' + quote + toDataUrl(artifact, bytes) + quote;
    })
    .replace(CSS_LINK, (match, quote, name) => {
      const { artifact, bytes } = load(name);
      return 'url("' + toDataUrl(artifact, bytes) + '")';
    });
}

// Changes when an app's own artifact or its linked data changes, or one goes away.
function revision(projectDir, chatId, names) {
  const store = storeFor(projectDir);
  return names.map(name => {
    const row = store.meta(projectDir, chatId, name);
    return name + ':' + (row ? row.revision : 'gone');
  }).join('|');
}

// ---- @artifact: mentions --------------------------------------------------

function mentionedNames(text) {
  if (typeof text !== 'string' || !text.includes('@artifact:')) return [];
  const names = new Set();
  // Sentence punctuation after a mention is not part of the name.
  for (const match of text.matchAll(MENTION)) names.add(match[1].replace(/[.,;:!?)\]]+$/, ''));
  return [...names].filter(Boolean);
}

// The messages a turn's @artifact: mentions add. Mirrors a mentioned file: the
// body when it fits, otherwise a note that tells the model how to reach it.
function mentionMessages(projectDir, chatId, text, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MENTION_BYTES;
  const out = [];
  for (const raw of mentionedNames(text)) {
    let artifact;
    try { artifact = get(projectDir, chatId, raw); }
    catch {
      out.push({ role: 'user', relPath: LINK_PREFIX + raw, content: '# Artifact: ' + raw + '\n# Not attached: this chat has no artifact with that name. Use list_artifacts.' });
      continue;
    }
    const head = '# Artifact: ' + artifact.name + '\n# Type: ' + artifact.mimeType + ', ' + artifact.size + ' bytes'
      + (artifact.path ? '\n# Path: ' + artifact.absolutePath : '')
      + (artifact.description ? '\n# Description: ' + artifact.description : '') + '\n';
    const entry = { role: 'user', relPath: artifact.path || artifact.link };
    if (artifact.kind === 'image' && artifact.size <= MAX_IMAGE_MENTION_BYTES) {
      const { bytes } = readBytes(projectDir, chatId, artifact.name);
      entry.content = [{ type: 'text', text: head }, { type: 'image_url', image_url: { url: toDataUrl(artifact, bytes) } }];
    } else if (artifact.kind !== 'text') {
      entry.content = head + '# Not attached: not text. ' + reachHint(artifact);
    } else if (artifact.size > maxBytes) {
      entry.content = head + '# Not attached: larger than the ' + maxBytes + '-byte mention limit. Use read_artifact to read parts of it.';
    } else {
      entry.content = head + '\n' + readWhole(projectDir, chatId, artifact.name).whole;
    }
    out.push(entry);
  }
  return out;
}

module.exports = {
  LINK_PREFIX, RASTER_IMAGES, MAX_ARTIFACT_BYTES,
  checkName, cleanName, list, get, save, setDescription, remove, rename, uniqueName,
  readBytes, readWhole, readForEditor, readText, listLinks, relink, resolveLinks, revision, moveStorage, mentionedNames, mentionMessages
};
