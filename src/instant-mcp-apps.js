'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { err } = require('./util.js');
const { MAX_HTML_BYTES } = require('./mcp-apps.js');

const APP_DIR = '.mouaif/mcp-apps';
const MAX_SOURCE_BYTES = 512 * 1024;
// An app with data links carries that data inline (docs/features/chat-artifacts.md).
const MAX_LINKED_HTML_BYTES = 8 * 1024 * 1024;

function projectRoot(projectDir) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) throw err('EBADINPUT', 'projectDir is required');
  const root = fs.realpathSync(projectDir);
  if (!fs.statSync(root).isDirectory()) throw err('EBADINPUT', 'projectDir must be an existing directory');
  return root;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function sourceKind(filename) {
  if (typeof filename !== 'string') throw err('EBADINPUT', 'filename is required for app source');
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.js' || extension === '.mjs') return 'js';
  throw err('EBADINPUT', 'Choose a single .html, .htm, .js or .mjs browser file');
}

function checkSource(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw err('EBADINPUT', 'App source must be non-empty and at most 512 KiB');
  }
}

// The dependency's self-contained browser bundle stays inline: no CDN, build,
// eval, Node execution, or network permission is needed for an imported app.
// `options.link` turns an HTML source's artifact links into inline data.
function renderHtml(authored, kind, name, options = {}) {
  checkSource(authored);
  if (kind !== 'html' && kind !== 'js') throw err('EBADINPUT', 'Invalid app source kind');
  const source = options.link && kind === 'html' ? options.link(authored) : authored;
  const limit = source === authored ? MAX_HTML_BYTES : MAX_LINKED_HTML_BYTES;
  const sdk = fs.readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const binding = sdk.match(/(?:,|\{)([\w$]+) as App(?:,|\})/);
  if (!binding) throw err('EMCP_APP_RESOURCE', 'Unsupported MCP Apps browser bundle');
  const setup = sdk + '\nconst mouaifApp = new ' + binding[1] + '(' + JSON.stringify({ name, version: '1' })
    + ', {}, { autoResize: true });\nwindow.mouaifApp = mouaifApp;\n'
    + 'mouaifApp.addEventListener("toolinput", params => window.dispatchEvent(new CustomEvent("mouaif-app-input", { detail: params })));\n'
    + 'mouaifApp.addEventListener("toolresult", params => window.dispatchEvent(new CustomEvent("mouaif-app-message", { detail: params })));\n'
    + 'window.mouaifAppReady = mouaifApp.connect();\n'
    + 'window.mouaifAppReady.then(() => window.dispatchEvent(new Event("mouaif-app-ready"))).catch(console.error);\n';
  const moduleScript = code => '<script type="module">' + code.replace(/<\/script/gi, '<\\/script') + '</script>';
  const script = moduleScript(setup) + (kind === 'js' ? moduleScript(source) : '');
  let html;
  if (kind === 'js') {
    html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>html,body{background:transparent}body{margin:0;padding:1rem;font-family:system-ui,sans-serif}button,input,select{min-height:2.75rem;max-width:100%}*{box-sizing:border-box}</style>'
      + '</head><body><main id="app"></main>' + script + '</body></html>';
  } else {
    // Module scripts execute in document order. Put the bridge before any
    // author modules, preserving the document's doctype and existing markup.
    const head = source.match(/<head\b[^>]*>/i);
    const doctype = source.match(/^\s*<!doctype[^>]*>/i);
    const offset = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
    html = source.slice(0, offset) + script + source.slice(offset);
  }
  if (Buffer.byteLength(html, 'utf8') > limit) {
    throw err('EBADINPUT', limit === MAX_HTML_BYTES ? 'Rendered app exceeds the 1 MiB limit' : 'The app and its linked data exceed the 8 MiB limit; link a smaller artifact');
  }
  return html;
}

function readSource(projectDir, filename) {
  const root = projectRoot(projectDir);
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename)) throw err('EBADINPUT', 'path must be project-relative');
  const target = fs.realpathSync(path.resolve(root, filename));
  if (!inside(root, target)) throw err('EBADINPUT', 'App path must stay inside the project');
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw err('EBADINPUT', 'Choose a browser file of at most 512 KiB');
  const source = fs.readFileSync(target, 'utf8');
  checkSource(source);
  return { source, kind: sourceKind(filename) };
}

function newSourcePath(projectDir, kind = 'html') {
  const root = projectRoot(projectDir);
  // Never follow a project-controlled .mouaif symlink outside the project.
  const directory = path.join(root, APP_DIR);
  for (const part of [path.join(root, '.mouaif'), directory]) {
    if (fs.existsSync(part) && !inside(root, fs.realpathSync(part))) throw err('EBADINPUT', 'App storage must stay inside the project');
  }
  fs.mkdirSync(directory, { recursive: true });
  return APP_DIR + '/' + crypto.randomBytes(12).toString('hex') + (kind === 'js' ? '.js' : '.html');
}

function developmentDraft(request, filename) {
  return 'Build a mobile-first, self-contained MCP App for this request:\n\n' + request
    + '\n\nWrite the finished single HTML file to ' + filename + '. Do not install dependencies, run a server, or change unrelated files. '
    + 'Inline CSS and browser JavaScript only; no external resources, network requests, Node APIs, or eval. '
    + 'Touch targets must be at least 44px and fit a 360px viewport. Keep html/body backgrounds transparent so the host backdrop shows through, unless the request needs an opaque background. '
    + 'The host injects the official MCP Apps SDK and connects it automatically. '
    + 'If host messaging is needed, use window.mouaifApp after the mouaif-app-ready event; '
    + 'send user text with window.mouaifApp.sendMessage({role:"user",content:[{type:"text",text:"..."}]}) and receive agent updates via window.mouaifApp.addEventListener("toolresult", params => ...) or window.addEventListener("mouaif-app-message", e => ...). '
    + 'Do not implement another MCP bridge. '
    + 'Finish by calling create_mcp_app with path: ' + JSON.stringify(filename) + ' to open the interactive app view in this chat. '
    + 'Do not register MCP servers or change tool permissions.';
}

function writeExistingSource(root, filename, source) {
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename)) throw err('EBADINPUT', 'path must be project-relative');
  const resolved = path.resolve(root, filename);
  if (!fs.existsSync(resolved)) throw err('EBADINPUT', 'App path must be an existing file');
  const target = fs.realpathSync(resolved);
  if (!inside(root, target)) throw err('EBADINPUT', 'App path must stay inside the project');
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw err('EBADINPUT', 'App path must be an existing file');
  fs.writeFileSync(target, source, { mode: stat.mode & 0o777 });
}

// An app's source, in the project or, for `artifact:<name>`, with the chat's artifacts.
function readAppSource(projectDir, chatId, filename) {
  const artifacts = require('./artifacts.js');
  if (typeof filename !== 'string' || !filename.startsWith(artifacts.LINK_PREFIX)) return readSource(projectDir, filename);
  const kind = sourceKind(filename);
  const source = artifacts.readBytes(projectDir, chatId, filename).bytes.toString('utf8');
  checkSource(source);
  return { source, kind };
}

function writeAppSource(projectDir, chatId, filename, source) {
  const artifacts = require('./artifacts.js');
  if (filename.startsWith(artifacts.LINK_PREFIX)) artifacts.save(projectDir, chatId, filename, source);
  else writeExistingSource(projectRoot(projectDir), filename, source);
}

// Shared by the HTTP routes and the model-facing native tool.
// On-the-fly apps render as interactive views inside a chat card and never
// register a project MCP server or MCP tool.
//
// `context.chatId` is set when a chat's tool asks. A new app then becomes one of
// that chat's artifacts, `path` may be `artifact:<name>`, and its data links are
// checked now, so a wrong link is the tool's error rather than a broken card.
function createApp(projectDir, request, context = {}) {
  const root = projectRoot(projectDir);
  const chatId = context.chatId || null;
  const artifacts = require('./artifacts.js');
  // The path the project's configuration is keyed by, which `root` may not be:
  // it decides where this chat's artifacts live.
  const owner = context.projectDir || projectDir;
  const body = { ...request };
  if (typeof body.path === 'string' && body.path.startsWith(artifacts.LINK_PREFIX)) {
    if (!chatId) throw err('EBADINPUT', 'artifact: paths belong to a chat');
    body.path = artifacts.get(owner, chatId, body.path).link;
  }
  const linkOptions = chatId ? { link: html => artifacts.resolveLinks(owner, chatId, html) } : {};
  if (body.relink !== undefined && (body.path === undefined || body.source !== undefined || body.request !== undefined || body.message !== undefined)) {
    throw err('EBADINPUT', 'relink goes with path alone: it changes which artifact an existing app reads');
  }
  if (body.relink !== undefined && !chatId) throw err('EBADINPUT', 'relink belongs to a chat');
  // `inline`: show the app transparent and in its place in the chat (no
  // border, header or bottom pin). It only describes how a shown app looks.
  if (body.inline !== undefined && typeof body.inline !== 'boolean') throw err('EBADINPUT', 'inline must be true or false');
  if (body.inline !== undefined && (body.request !== undefined || body.message !== undefined)) {
    throw err('EBADINPUT', 'inline goes with an app being shown, not with request or message');
  }
  const name = body.name === undefined ? 'On-the-fly app' : body.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw err('EBADINPUT', 'App name must be 1–100 characters');
  const title = name.trim();
  const hasRequest = body.request !== undefined;
  const hasMessage = body.message !== undefined;
  const hasPath = body.path !== undefined;
  const hasSource = body.source !== undefined;
  const isSourceUpdate = hasPath && hasSource && !hasRequest && !hasMessage;
  const inputs = ['request', 'path', 'source', 'message'].filter(key => body[key] !== undefined);
  if (!isSourceUpdate && inputs.length !== 1) throw err('EBADINPUT', 'Provide request, message, path, source + filename, or path + source to update');
  if (!hasSource && body.filename !== undefined) throw err('EBADINPUT', 'filename is only used with source');
  if (isSourceUpdate && body.filename !== undefined && sourceKind(body.filename) !== sourceKind(body.path)) {
    throw err('EBADINPUT', 'filename extension must match path when updating an app');
  }
  if (inputs[0] === 'message') {
    if (typeof body.message !== 'string' || !body.message.trim() || Buffer.byteLength(body.message, 'utf8') > 16384) {
      throw err('EBADINPUT', 'App message must be non-empty and at most 16 KiB');
    }
    const text = body.message.trim();
    return { mode: 'message', name: title, message: text, content: [{ type: 'text', text }] };
  }
  if (inputs[0] === 'request') {
    if (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 16000) throw err('EBADINPUT', 'App request must be 1–16000 characters');
    const filename = newSourcePath(root);
    const chats = require('./chats.js');
    const chat = chats.createChat(root, { title: 'Build app: ' + title });
    chats.updateChat(root, chat.id, { draft: developmentDraft(body.request.trim(), filename) });
    return { chatId: chat.id, path: filename, url: '#/chat/' + encodeURIComponent(chat.id) };
  }
  let filename;
  let updated = false;
  let relinked;
  let links;
  if (isSourceUpdate) {
    const kind = sourceKind(body.path);
    renderHtml(body.source, kind, title, linkOptions);
    writeAppSource(owner, chatId, body.path, body.source);
    filename = body.path;
    updated = true;
    links = artifacts.listLinks(body.source);
  } else if (inputs[0] === 'path' && body.relink !== undefined) {
    const { source, kind } = readAppSource(owner, chatId, body.path);
    const next = artifacts.relink(source, body.relink);
    renderHtml(next.source, kind, title, linkOptions);
    writeAppSource(owner, chatId, body.path, next.source);
    filename = body.path;
    updated = true;
    relinked = next.relinked;
    links = artifacts.listLinks(next.source);
  } else if (inputs[0] === 'path') {
    const { source, kind } = readAppSource(owner, chatId, body.path);
    renderHtml(source, kind, title, linkOptions);
    filename = body.path;
    links = artifacts.listLinks(source);
  } else {
    const kind = sourceKind(body.filename);
    renderHtml(body.source, kind, title, linkOptions);
    links = artifacts.listLinks(body.source);
    if (chatId) {
      const artifactName = artifacts.uniqueName(owner, chatId, path.basename(body.filename));
      filename = artifacts.save(owner, chatId, artifactName, body.source, { createdBy: 'agent', description: title }).artifact.link;
    } else {
      filename = newSourcePath(root, kind);
      fs.writeFileSync(path.join(root, filename), body.source, { flag: 'wx', mode: 0o600 });
    }
  }
  return { name: title, path: filename, ...(typeof body.inline === 'boolean' ? { inline: body.inline } : {}), ...(updated ? { updated: true } : {}), ...(relinked ? { relinked } : {}), ...(links && links.length ? { links } : {}) };
}

module.exports = { APP_DIR, MAX_SOURCE_BYTES, projectRoot, sourceKind, renderHtml, readSource, readAppSource, newSourcePath, developmentDraft, createApp };
