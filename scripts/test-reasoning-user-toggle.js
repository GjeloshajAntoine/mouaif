'use strict';

// Regression test: the "Thinking" block keeps the user's open/closed choice
// when the streamed reply is finalized.
//
// renderAssistantBody rebuilds the body on the final pass. The streaming pass
// opens the <details>, the final pass closes it — and it used to do so even
// for a block the user had re-opened to keep reading, so the reasoning folded
// away the moment the reply finished. The tap is now remembered on the body
// (which is the same element across both passes) and wins over the defaults.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tag) {
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    dataset: {},
    open: false,
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { for (const fn of listeners[type] || []) fn({ type }); },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className).split(/\s+/).includes(cls) || c.tagName === sel.toUpperCase()) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(node);
    }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set() { node.children = []; }
  });
  return node;
}

function loadTranscript() {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    document: { createElement },
    renderMarkdown: (s) => String(s || '')
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.renderAssistantBody = renderAssistantBody;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// Simulate a tap on the summary: the handler runs, then the native toggle.
function tap(details) {
  details.querySelector('SUMMARY').dispatch('click');
  details.open = !details.open;
}

const mod = loadTranscript();
const reasoningOf = (body) => body.querySelector('.chat-msg__reasoning');

{
  const body = createElement('div');
  mod.renderAssistantBody(body, '', 'step 1', false);
  check('a streaming Thinking block starts open', reasoningOf(body).open === true);
  mod.renderAssistantBody(body, 'answer', 'step 1', true);
  check('an untouched block closes when the reply is finalized', reasoningOf(body).open === false);
}

{
  const body = createElement('div');
  mod.renderAssistantBody(body, '', 'step 1', false);
  tap(reasoningOf(body)); // close
  tap(reasoningOf(body)); // re-open to keep reading
  mod.renderAssistantBody(body, 'answer', 'step 1 step 2', true);
  check('a block the user re-opened stays open after finalize', reasoningOf(body).open === true);
}

{
  const body = createElement('div');
  mod.renderAssistantBody(body, '', 'step 1', false);
  tap(reasoningOf(body)); // close mid-stream
  mod.renderAssistantBody(body, '', 'step 1 step 2', false);
  check('a block the user closed stays closed on a streaming re-render', reasoningOf(body).open === false);
  mod.renderAssistantBody(body, 'answer', 'step 1 step 2', true);
  check('a block the user closed stays closed after finalize', reasoningOf(body).open === false);
}

{
  const body = createElement('div');
  mod.renderAssistantBody(body, 'answer', 'why', true);
  tap(reasoningOf(body)); // open a settled block
  mod.renderAssistantBody(body, 'answer', 'why', true);
  check('a settled block the user opened survives a re-render', reasoningOf(body).open === true);
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
if (failed) process.exitCode = 1;
