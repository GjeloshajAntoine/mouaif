'use strict';

// Regression test: an `image_gen` tool result must paint the generated
// picture, and a result whose bytes are gone must say so.
//
// The tool attaches the generated picture as an `image` content block (see
// src/tools/image.js) so a vision model receives it and the chat card can
// render exactly what the model produced. Four things are checked here:
//
//   1. the card renders one tappable `<img>` per generated picture, from the
//      data URL — never `innerHTML`, never a JSON dump;
//   2. it names the file each picture was saved to;
//   3. a non-saving run (the Settings preview) says so instead of naming a
//      path that does not exist;
//   4. a result that reached the UI as text (a replayed transcript row, a
//      nested subagent row) says the bytes are not part of this result
//      instead of painting an empty frame.
//
// The renderer is loaded the way the read_file image test loads it: import
// lines are stripped and tools.js + imageGeneration.js + toolRender.js run in
// one VM context backed by a tiny DOM stub. The two helpers toolRender.js
// imports (dataUrlFor / imageBlocksFromResult) come from the real
// frontend/src/imageGeneration.js, so the card and the helpers cannot drift.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');
const SRC_DIR = path.join(__dirname, '../frontend/src');
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
    _listeners: listeners,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null
  };
  return node;
}

function findAllText(node) {
  const parts = [];
  if (node._text) parts.push(node._text);
  for (const child of node.children) parts.push(findAllText(child));
  return parts.join('\n');
}

function findAll(node, pred, out) {
  const acc = out || [];
  if (pred(node)) acc.push(node);
  for (const child of node.children) findAll(child, pred, acc);
  return acc;
}

// installContext() -> { mod, documentBody }
function installContext() {
  const documentBody = makeNode('body');
  const documentStub = {
    body: documentBody,
    createElement: makeNode,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, setTimeout, clearTimeout, URLSearchParams,
    document: documentStub,
    publishWebPreview() {},
    fetchJson() { return Promise.resolve({ status: 200, body: {} }); }
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  const load = (dir, file) => {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: file });
  };
  load(SRC_DIR, 'imageGeneration.js');
  load(CHAT_DIR, 'tools.js');
  load(CHAT_DIR, 'toolRender.js');
  vm.runInContext('this.renderToolResultBody = renderToolResultBody;'
    + ' this.formatResultSummary = formatResultSummary;'
    + ' this.imageBlocksFromResult = imageBlocksFromResult;'
    + ' this.dataUrlFor = dataUrlFor;'
    + ' this.imageBlockToElement = imageBlockToElement;', context, { filename: 'exports.js' });
  return { mod: context, documentBody };
}

// ---- The result shapes ----------------------------------------------

function generatedResult(extras) {
  return Object.assign({
    ok: true,
    kind: 'image',
    model: { id: 'openai-image · gpt-image-1', provider: 'openai-compatible' },
    prompt: 'a red fox in snow',
    relPath: 'generated/a-red-fox.png',
    note: 'The generated picture is attached to this tool result as an image part.',
    images: [{ relPath: 'generated/a-red-fox.png', mimeType: 'image/png', bytes: 70 }],
    content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png', relPath: 'generated/a-red-fox.png' }]
  }, extras || {});
}

function main() {
  const { mod } = installContext();

  // ---- 1. The card paints the generated picture ----------------------
  {
    const body = makeNode('div');
    mod.renderToolResultBody(body, { name: 'image_gen', result: generatedResult() }, () => false);
    const imgs = findAll(body, (n) => n.tagName === 'IMG');
    check('the card renders exactly one picture', imgs.length === 1, String(imgs.length));
    check('the picture src is the data URL the tool returned',
      imgs[0] && imgs[0].src === PNG_DATA_URL, imgs[0] && String(imgs[0].src).slice(0, 40));
    check('the picture is lazy-loaded', imgs[0] && imgs[0].loading === 'lazy');
    const buttons = findAll(body, (n) => n.tagName === 'BUTTON');
    check('the picture is wrapped in a tap target', buttons.length === 1, String(buttons.length));
    check('the tap target is labelled', buttons[0] && /full screen/.test(buttons[0].getAttribute('aria-label') || ''),
      buttons[0] && buttons[0].getAttribute('aria-label'));
    check('the model that ran is named',
      /gpt-image-1/.test(findAllText(body)), findAllText(body).slice(0, 160));
  }

  // ---- 2. The saved path is named ------------------------------------
  {
    const body = makeNode('div');
    mod.renderToolResultBody(body, { name: 'image_gen', result: generatedResult() }, () => false);
    const text = findAllText(body);
    check('the card names the saved file', /generated\/a-red-fox\.png/.test(text), text.slice(0, 200));
    check('the card says the picture was sent to the model', /sent to the model/.test(text), text.slice(0, 200));
  }

  // ---- 3. A non-saving run says so -----------------------------------
  {
    const body = makeNode('div');
    const result = generatedResult({
      relPath: null,
      images: [{ relPath: null, mimeType: 'image/png', bytes: 70 }],
      content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }]
    });
    mod.renderToolResultBody(body, { name: 'image_gen', result }, () => false);
    const text = findAllText(body);
    check('a preview run says it was not saved', /Not saved to the project/.test(text), text.slice(0, 200));
    check('a preview run shows no fake path', !/generated\//.test(text), text.slice(0, 200));
    check('a preview run still paints the picture',
      findAll(body, (n) => n.tagName === 'IMG').length === 1);
  }

  // ---- 4. Multiple pictures ------------------------------------------
  {
    const body = makeNode('div');
    const result = generatedResult({
      images: [
        { relPath: 'generated/a.png', mimeType: 'image/png', bytes: 70 },
        { relPath: 'generated/a-2.png', mimeType: 'image/png', bytes: 70 }
      ],
      content: [
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png', relPath: 'generated/a.png' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png', relPath: 'generated/a-2.png' }
      ]
    });
    mod.renderToolResultBody(body, { name: 'image_gen', result }, () => false);
    check('two pictures render two thumbnails', findAll(body, (n) => n.tagName === 'IMG').length === 2);
    check('both saved paths are listed',
      /generated\/a\.png/.test(findAllText(body)) && /generated\/a-2\.png/.test(findAllText(body)),
      findAllText(body).slice(0, 240));
  }

  // ---- 5. Bytes gone (a replayed / nested row) -----------------------
  {
    const body = makeNode('div');
    const result = generatedResult({ content: undefined });
    mod.renderToolResultBody(body, { name: 'image_gen', result }, () => false);
    check('a result with no bytes says so',
      /Image bytes are not part of this result/.test(findAllText(body)), findAllText(body).slice(0, 200));
    check('a result with no bytes paints nothing',
      findAll(body, (n) => n.tagName === 'IMG').length === 0);
  }

  // ---- 6. An error result -------------------------------------------
  {
    const body = makeNode('div');
    mod.renderToolResultBody(body, {
      name: 'image_gen',
      result: { error: { code: 'ENO_IMAGE_MODEL', message: 'No image model configured.' } }
    }, () => false);
    check('an error result shows the message',
      /No image model configured/.test(findAllText(body)), findAllText(body).slice(0, 200));
  }

  // ---- 7. The collapsed summary -------------------------------------
  {
    const saved = mod.formatResultSummary('image_gen', generatedResult());
    check('the collapsed summary names the count, size and save state',
      /1 image/.test(saved) && /saved/.test(saved), saved);
    const unsaved = mod.formatResultSummary('image_gen', generatedResult({ images: [{ relPath: null, bytes: 2048, mimeType: 'image/png' }] }));
    check('the collapsed summary says "not saved" for a preview',
      /not saved/.test(unsaved), unsaved);
    check('an error result has no summary',
      mod.formatResultSummary('image_gen', { error: { code: 'EIMAGE' } }) === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main();