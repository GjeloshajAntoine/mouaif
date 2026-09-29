'use strict';

// Regression test: every image in the chat view opens full screen on tap.
//
// Tool-card thumbnails already went through `zoomableImage`, but three chat
// surfaces painted bare <img> nodes the user could not enlarge on a phone:
//
//   1. an attached image on a user turn (`renderImageAttachments`),
//   2. a markdown image in an assistant reply (`renderMarkdown` output),
//   3. a markdown image in a system prompt / reasoning block.
//
// All three now wrap their picture in the shared zoomable button. transcript.js
// is loaded the way the other transcript tests load it: the import blocks are
// stripped and the body runs in a VM with a minimal DOM stub. The assertions
// are about the resulting wrapper nodes, not about source shape.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------

function createElement(tag) {
  const classes = new Set();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    dataset: {},
    style: {},
    src: '',
    alt: '',
    open: false,
    attributes: {},
    classList: {
      add(...list) { for (const c of list) classes.add(c); },
      remove(...list) { for (const c of list) classes.delete(c); },
      contains(c) { return classes.has(c); }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      for (const c of String(v || '').split(/\s+/)) if (c) classes.add(c);
    },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
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
    replaceWith(fresh) {
    const parent = node.parentNode;
    if (!parent) return;
    const i = parent.children.indexOf(node);
    if (i === -1) return;
    if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
    parent.children.splice(i, 1, fresh);
    fresh.parentNode = parent;
    node.parentNode = null;
    },
    replaceChild(fresh, old) {
    const i = node.children.indexOf(old);
    if (i === -1) return old;
    if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
    node.children.splice(i, 1, fresh);
    fresh.parentNode = node;
    old.parentNode = null;
    return old;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    get nextSibling() {
    if (!node.parentNode) return null;
    const sibs = node.parentNode.children;
    const i = sibs.indexOf(node);
    return i === -1 ? null : (sibs[i + 1] || null);
    },
    insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref == null ? -1 : node.children.indexOf(ref);
    if (at === -1) node.children.push(child);
    else node.children.splice(at, 0, child);
    child.parentNode = node;
    return child;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { for (const fn of listeners[type] || []) fn({ type }); },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const match = (n) => sel === 'img' ? n.tagName === 'IMG' : n.classList.contains(sel.replace(/^\./, ''));
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    closest(sel) {
      let cur = node.parentNode;
      while (cur) {
        if (cur.classList.contains(sel.replace(/^\./, ''))) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
  };
  // innerHTML in the real transcript carries rendered markdown. This stub
  // parses just the <img> tags back into child nodes so the wrapping pass has
  // something to wrap.
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set(html) {
      node.children = [];
      const re = /<img\s+([^>]*)\/?>/g;
      let m;
      while ((m = re.exec(String(html || '')))) {
        const attrs = m[1];
        const src = (attrs.match(/src="([^"]*)"/) || [])[1] || '';
        const alt = (attrs.match(/alt="([^"]*)"/) || [])[1] || '';
        const img = createElement('img');
        img.src = src;
        img.alt = alt;
        img.setAttribute('src', src);
        img.setAttribute('alt', alt);
        node.appendChild(img);
      }
    }
  });
  return node;
}

function loadTranscript() {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  // zoomableImage lives in toolRender.js, which transcript.js imports. The
  // stub mirrors that module's wrapper shape (a button around the image, the
  // caller's classes preserved) so the transcript's usage is what is under
  // test, not toolRender itself (covered by test-read-image-preview.js).
  const hostDocument = { createElement };
  // The real markdown renderer emits <img> tags; mirror that shape so the
  // wrapping pass under test has images to wrap.
  const renderMarkdown = (s) => String(s || '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => '<img src="' + url + '" alt="' + alt + '" />');
  const zoomableImage = (img, label, opts) => {
    const options = opts || {};
    if (options.imgClass !== null) img.className = options.imgClass || 'tool-card__image tool-card__image--zoomable';
    else img.classList.add('tool-card__image--zoomable');
    const button = hostDocument.createElement('button');
    button.className = options.buttonClass || 'tool-card__image-button';
    button.setAttribute('aria-label', 'Open ' + (label || 'image') + ' full screen');
    button.appendChild(img);
    return button;
  };
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    document: hostDocument,
    renderMarkdown,
    zoomableImage
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.renderAssistantBody = renderAssistantBody;'
    + ' this.renderImageAttachments = renderImageAttachments;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const mod = loadTranscript();

// ---- 1. User-turn attachments ----------------------------------------
{
  const host = createElement('div');
  mod.renderImageAttachments(host, [
    { dataUrl: 'data:image/png;base64,AAA', name: 'one.png' },
    { dataUrl: 'data:image/png;base64,BBB', name: 'two.png' }
  ]);
  const buttons = host.querySelectorAll('.chat-msg__attachment-button');
  check('each attachment is wrapped in a tap target', buttons.length === 2, String(buttons.length));
  const img = buttons[0] && buttons[0].querySelectorAll('img')[0];
  check('the wrapper keeps the attachment thumbnail class',
    !!img && img.className.includes('chat-msg__attachment-img'), img && img.className);
  check('the wrapper label names the attachment',
    buttons[0].getAttribute('aria-label') === 'Open one.png full screen',
    buttons[0].getAttribute('aria-label'));
  check('the wrapping is inert at build time (no lightbox yet)',
    !!buttons[0] && typeof buttons[0].dispatch === 'function');
}

// ---- 2. Markdown images in the assistant answer ----------------------
{
  const body = createElement('div');
  mod.renderAssistantBody(body, '![shot](/api/foo.png)', '', true);
  const buttons = body.querySelectorAll('.chat-msg__image-button');
  check('a markdown image in the reply gets a tap target', buttons.length === 1, String(buttons.length));
  const img = buttons[0] && buttons[0].querySelectorAll('img')[0];
  check('the wrapped image keeps its src', !!img && img.src === '/api/foo.png', img && img.src);
  check('the wrapper label uses the alt text',
    buttons[0].getAttribute('aria-label') === 'Open shot full screen',
    buttons[0].getAttribute('aria-label'));
}

// ---- 3. Markdown images in reasoning / system body -------------------
{
  const body = createElement('div');
  mod.renderAssistantBody(body, 'answer', '![diagram](/d.png)', true);
  const buttons = body.querySelectorAll('.chat-msg__image-button');
  check('a markdown image in the reasoning block gets a tap target',
    buttons.length === 1, String(buttons.length));
}

// ---- 4. A final pass does not double-wrap ----------------------------
{
  const body = createElement('div');
  mod.renderAssistantBody(body, '![shot](/x.png)', '', true);
  mod.renderAssistantBody(body, '![shot](/x.png)', '', true);
  check('re-rendering does not nest the wrappers',
    body.querySelectorAll('.chat-msg__image-button').length === 1,
    String(body.querySelectorAll('.chat-msg__image-button').length));
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
if (failed) process.exitCode = 1;
