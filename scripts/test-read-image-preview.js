'use strict';

// Regression test: `read_file` on a picture must paint the picture.
//
// The tool attaches the file's pixels as an `image` content block (see
// src/tools/files.js) so a vision model receives them and the chat card can
// render exactly what the model got. Four things are checked here:
//
//   1. the plain-text envelope of an image result parses back into
//      `kind: 'image'` + mime type + size (the replay / subagent-nested path
//      re-parses the model-facing header);
//   2. `renderReadFileToolResult` renders a tappable `<img>` from the data
//      URL — never `innerHTML`, never a JSON dump;
//   3. tapping it opens a full-screen lightbox that closes on the button,
//      on Escape and on a tap outside the picture;
//   4. a result that reached the UI as text (bytes gone) says so instead of
//      rendering an empty frame.
//
// The renderer is loaded the way the transcript tests load it: the import
// blocks are stripped and tools.js + toolRender.js run in one VM context
// backed by a tiny DOM stub.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BASE64 = PNG_DATA_URL.split(',')[1];

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- DOM stub --------------------------------------------------------

function makeNode(tag) {
  const classes = new Set();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    attributes: {},
    _text: '',
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      for (const n of String(value || '').split(/\s+/)) if (n) classes.add(n);
    },
    get textContent() { return this._text; },
    set textContent(value) { this._text = value == null ? '' : String(value); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    _fire(type, event) { for (const fn of (listeners[type] || [])) fn(event || {}); },
    querySelector(selector) { return query(node, selector)[0] || null; },
    querySelectorAll(selector) { return query(node, selector); }
  };
  return node;
}

// Class-only selectors, which is all this renderer uses.
function query(root, selector) {
  const cls = String(selector).replace(/^\./, '');
  const out = [];
  const visit = (node) => {
    for (const child of node.children) {
      if (child.classList.contains(cls)) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function allText(node) {
  const parts = [];
  if (node._text) parts.push(node._text);
  for (const child of node.children) parts.push(allText(child));
  return parts.join('\n');
}

// installContext() -> { mod, documentBody, documentListeners }
//
// tools.js and toolRender.js share one context whose `document` is the stub.
// `documentListeners` records the document-level handlers the lightbox adds
// (that is how Escape is wired), so a test can fire them.
function installContext() {
  const documentBody = makeNode('body');
  const documentListeners = {};
  const documentStub = {
    body: documentBody,
    createElement: makeNode,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = documentListeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
  };
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, setTimeout, clearTimeout,
    document: documentStub,
    publishWebPreview() {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  const load = (file) => {
    const source = fs.readFileSync(path.join(CHAT_DIR, file), 'utf8')
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: file });
  };
  load('tools.js');
  load('toolRender.js');
  vm.runInContext('this.parsePlainFileToolResult = parsePlainFileToolResult;'
    + ' this.renderReadFileToolResult = renderReadFileToolResult;'
    + ' this.renderListFilesToolResult = renderListFilesToolResult;'
    + ' this.renderGenericToolResult = renderGenericToolResult;'
    + ' this.formatResultSummary = formatResultSummary;', context, { filename: 'exports.js' });
  return { mod: context, documentBody, documentListeners };
}

// ---- The result shapes -----------------------------------------------

const IMAGE_HEADER = '# File: assets/shot.png\n# Kind: image (image/png, 70 bytes)\n# The picture is attached to this tool result as an image part.';

function imageResult() {
  return {
    relPath: 'assets/shot.png',
    kind: 'image',
    mimeType: 'image/png',
    bytes: 70,
    note: 'The picture is attached to this tool result as an image part.',
    content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }]
  };
}

function main() {
  const { mod, documentBody, documentListeners } = installContext();

  // ---- 1. The plain-text envelope parses back ------------------------
  {
    const parsed = mod.parsePlainFileToolResult(IMAGE_HEADER);
    check('a text image result parses to kind=image', parsed.kind === 'image', JSON.stringify(parsed));
    check('the mime type survives the text round trip', parsed.mimeType === 'image/png', parsed.mimeType);
    check('the byte count survives the text round trip', parsed.bytes === 70, String(parsed.bytes));
    check('the collapsed summary names the format and size',
      mod.formatResultSummary('read_file', parsed) === 'PNG · 70 B',
      String(mod.formatResultSummary('read_file', parsed)));
  }

  // ---- 2. The card paints the received picture -----------------------
  const body = makeNode('div');
  mod.renderReadFileToolResult(body, imageResult());
  const button = body.querySelector('.tool-card__image-button');
  const img = body.querySelector('.tool-card__image');
  check('the card wraps the thumbnail in a tap target', !!button && !!img);
  check('the thumbnail src is the data URL of the attached bytes',
    !!img && img.src === PNG_DATA_URL, img && String(img.src).slice(0, 40));
  check('the thumbnail alt names the file', !!img && img.alt === 'Image assets/shot.png', img && img.alt);
  check('the base64 never lands in a text node',
    !allText(body).includes(PNG_BASE64.slice(0, 32)), 'base64 leaked into the card');
  check('the meta line carries path, mime type and size',
    allText(body).includes('assets/shot.png') && allText(body).includes('image/png') && allText(body).includes('70 B'),
    allText(body));
  check('the card says the model received the picture',
    allText(body).includes('Sent to the model as an image.'), allText(body));

  // ---- 3. Tapping opens a lightbox that closes three ways ------------
  button._fire('click');
  const overlay = documentBody.children[0];
  check('tapping the thumbnail opens a full-screen lightbox',
    !!overlay && overlay.classList.contains('image-lightbox'));
  check('the lightbox is a labelled dialog',
    !!overlay && overlay.getAttribute('role') === 'dialog' && overlay.getAttribute('aria-modal') === 'true'
      && overlay.getAttribute('aria-label') === 'Image assets/shot.png');
  const big = overlay && overlay.querySelector('.image-lightbox__image');
  check('the lightbox shows the same picture larger', !!big && big.src === PNG_DATA_URL);
  const close = overlay && overlay.querySelector('.image-lightbox__close');
  check('the lightbox has a close button', !!close && String(close.textContent).length > 0);

  close._fire('click');
  check('the close button removes the lightbox', documentBody.children.length === 0,
    String(documentBody.children.length));

  // Tap outside the picture.
  button._fire('click');
  const overlay2 = documentBody.children[0];
  overlay2._fire('click', { target: overlay2 });
  check('a tap outside the picture closes it', documentBody.children.length === 0,
    String(documentBody.children.length));

  // Escape.
  button._fire('click');
  check('the lightbox reopens', documentBody.children.length === 1);
  const keyHandlers = (documentListeners.keydown || []).slice();
  check('an Escape listener is registered while open', keyHandlers.length > 0, String(keyHandlers.length));
  for (const fn of keyHandlers) fn({ key: 'Escape' });
  check('Escape closes the lightbox', documentBody.children.length === 0, String(documentBody.children.length));
  check('the Escape listener is removed again', (documentListeners.keydown || []).length === 0,
    String((documentListeners.keydown || []).length));

  // ---- 4. A text-only result admits the bytes are gone ---------------
  {
    const b2 = makeNode('div');
    mod.renderReadFileToolResult(b2, IMAGE_HEADER);
    check('a text-only image result renders no <img>', !b2.querySelector('.tool-card__image'));
    check('a text-only image result says the bytes are missing',
      allText(b2).includes('Image bytes are not part of this result.'), allText(b2));
  }

  // ---- 5. list_files flags image rows -------------------------------
  {
    const b3 = makeNode('div');
    mod.renderListFilesToolResult(b3, { entries: [{ path: 'assets/shot.png', image: true }, { path: 'src/a.js' }] });
    check('an image row is marked in the list preview',
      allText(b3).includes('shot.png (image)') && allText(b3).includes('a.js'), allText(b3));
    const b4 = makeNode('div');
    mod.renderListFilesToolResult(b4, { entries: [], pattern: '' });
    check('the empty list preview no longer claims text-only',
      allText(b4).includes('all text and image files'), allText(b4));
  }

  // ---- 6. MCP / generic tool images open full screen too -----------
  //
  // The generic renderer used to paint a bare 220 px <img>, so an MCP
  // screenshot, chart or diagram could not be enlarged on a phone. Both MCP
  // image shapes — a top-level `image` block and an image `resource` —
  // now share read_file's tap-to-zoom button.
  {
    const b5 = makeNode('div');
    mod.renderGenericToolResult(b5, { content: [
      { type: 'text', text: 'Rendered chart' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'chart://q3', blob: PNG_BASE64, mimeType: 'image/png' } }
    ] });
    const buttons = b5.querySelectorAll('.tool-card__image-button');
    check('each MCP image is wrapped in a tap target', buttons.length === 2, String(buttons.length));
    check('an image resource names its uri in the button label',
      buttons.length === 2 && buttons[1].getAttribute('aria-label') === 'Open chart://q3 full screen',
      buttons[1] && buttons[1].getAttribute('aria-label'));
    check('MCP text blocks still render beside the images', allText(b5).includes('Rendered chart'), allText(b5));
    buttons[0]._fire('click');
    const overlay = documentBody.children[0];
    check('tapping an MCP image opens the lightbox',
      !!overlay && overlay.classList.contains('image-lightbox')
      && overlay.querySelector('.image-lightbox__image').src === PNG_DATA_URL);
    for (const fn of (documentListeners.keydown || []).slice()) fn({ key: 'Escape' });
    check('the MCP image lightbox closes on Escape', documentBody.children.length === 0);
  }

  console.log('---');
  console.log('read_file image preview: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main();
