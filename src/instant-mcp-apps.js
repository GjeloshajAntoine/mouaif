'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { err } = require('./util.js');
const { MAX_HTML_BYTES } = require('./mcp-apps.js');

const APP_DIR = '.mouaif/mcp-apps';
const MAX_SOURCE_BYTES = 512 * 1024;

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
function renderHtml(source, kind, name) {
  checkSource(source);
  if (kind !== 'html' && kind !== 'js') throw err('EBADINPUT', 'Invalid app source kind');
  const sdk = fs.readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const binding = sdk.match(/(?:,|\{)([\w$]+) as App(?:,|\})/);
  if (!binding) throw err('EMCP_APP_RESOURCE', 'Unsupported MCP Apps browser bundle');
  const setup = sdk + '\nconst mouaifApp = new ' + binding[1] + '(' + JSON.stringify({ name, version: '1' })
    + ', {}, { autoResize: true });\nwindow.mouaifApp = mouaifApp;\n'
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
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw err('EBADINPUT', 'Rendered app exceeds the 1 MiB limit');
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
    + 'send user text with window.mouaifApp.sendMessage({role:"user",content:[{type:"text",text:"..."}]}). '
    + 'Do not implement another MCP bridge. The only server tool is view. '
    + 'Finish by explaining how to import the file in project Settings → MCP servers → On-the-fly app. '
    + 'Do not register servers or enable MCP Apps without the user importing the file.';
}

// Shared by the Settings HTTP routes and the model-facing native tool.
// Settings imports (`registerServer: true`, the default) register a stopped
// project MCP server; the chat tool (`registerServer: false`) keeps the app
// scoped to the current chat's tool card without adding a project MCP server.
function createApp(projectDir, body, options = {}) {
  const root = projectRoot(projectDir);
  const name = body.name === undefined ? 'On-the-fly app' : body.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw err('EBADINPUT', 'App name must be 1–100 characters');
  const title = name.trim();
  const inputs = ['request', 'path', 'source'].filter(key => body[key] !== undefined);
  if (inputs.length !== 1) throw err('EBADINPUT', 'Provide exactly one request, path or source');
  if (inputs[0] !== 'source' && body.filename !== undefined) throw err('EBADINPUT', 'filename is only used with source');
  if (inputs[0] === 'request') {
    if (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 16000) throw err('EBADINPUT', 'App request must be 1–16000 characters');
    const filename = newSourcePath(root);
    const chats = require('./chats.js');
    const chat = chats.createChat(root, { title: 'Build app: ' + title });
    chats.updateChat(root, chat.id, { draft: developmentDraft(body.request.trim(), filename) });
    return { chatId: chat.id, path: filename, url: '#/chat/' + encodeURIComponent(chat.id) };
  }
  let filename;
  if (inputs[0] === 'path') {
    const { source, kind } = readSource(root, body.path);
    renderHtml(source, kind, title);
    filename = body.path;
  } else {
    const kind = sourceKind(body.filename);
    renderHtml(body.source, kind, title);
    filename = newSourcePath(root, kind);
    fs.writeFileSync(path.join(root, filename), body.source, { flag: 'wx', mode: 0o600 });
  }
  if (options.registerServer === false) {
    return { name: title, path: filename };
  }
  const server = require('./mcp.js').addServer(root, { scope: 'project', name: title,
    command: process.execPath, args: [path.join(__dirname, 'instant-mcp-app-server.js'), root, filename, title], cwd: root });
  return { server, path: filename };
}

module.exports = { APP_DIR, MAX_SOURCE_BYTES, projectRoot, sourceKind, renderHtml, readSource, newSourcePath, developmentDraft, createApp };
