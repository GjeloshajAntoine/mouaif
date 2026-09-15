'use strict';
// Regression test: an expanded shell card shows the command in full.
//
// The collapsed card head is one ellipsized line capped at
// TOOL_ARGS_PREVIEW_CHARS (220), which is fine for `ls -la` and useless
// for what the model actually runs most of the time — a heredoc commit
// message, a compound `&&` chain. The head for one real commit call read
// `cd /home/ubuntu/mouaif && git commit -q -F - <<'MSG' feat(ch…` and the
// other 1.7 kB of the command were nowhere on screen: the expanded body
// showed only the result (the commit hash), because the result renderer
// painted the tool's output and nothing else.
//
// The expanded card now renders the full arguments above that output when
// — and only when — the head had to truncate them. The tests below pin
// both halves of that rule:
//
//   * a long command is present in the expanded body, in full, with its
//     line breaks (a shell command's structure is its newlines), and is
//     placed above the output so the card reads "what ran, then what came
//     back";
//   * a short command that the head already showed in full is NOT
//     repeated in the body, so the expand of an ordinary call is unchanged;
//   * the failing-result path keeps the same order, since an error card is
//     auto-expanded and is exactly where the command matters most.
//
// toolRender.js is loaded the way the sibling transcript tests load it:
// the import block is stripped and the body runs in a VM whose globals
// supply the module's helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

// ---- DOM stub --------------------------------------------------------

function makeNode(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    _text: '',
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      for (const part of String(value || '').split(/\s+/)) if (part) classes.add(part);
    },
    get textContent() { return node._text; },
    set textContent(value) {
      node._text = value == null ? '' : String(value);
      node.children.length = 0;
    },
    get childElementCount() { return node.children.length; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = node;
      const at = node.children.indexOf(ref);
      if (at === -1) node.children.push(child);
      else node.children.splice(at, 0, child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    querySelector(selector) { return querySelector(node, selector)[0] || null; },
    querySelectorAll(selector) { return querySelector(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

// Supports the selectors toolRender.js uses: `.class` and `tag`.
function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

function querySelector(root, selector) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// ---- Module loader ---------------------------------------------------

function installContext() {
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    document: {
      createElement: makeNode,
      querySelector: () => null,
      querySelectorAll: () => []
    },
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
  vm.runInContext(
    fs.readFileSync(path.join(CHAT_DIR, 'toolRender.js'), 'utf8')
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export /gm, '')
    + '; this.renderShellToolResult = renderShellToolResult;',
    context,
    { filename: 'toolRender.js' }
  );
  return context;
}

// ---- Assertions ------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const LONG_CMD = [
  "cd /home/ubuntu/mouaif && git commit -q -F - <<'MSG'",
  'feat(chat): reuse transcript rows instead of rebuilding them',
  '',
  'The transcript was rebuilt by destroying every child of the message',
  'area and re-creating it from state.messages on each pass.',
  'MSG',
  'git log --oneline -1'
].join('\n');

function classesOf(body) {
  return body.children.map((c) => c.className);
}

function textOf(node) {
  const parts = [];
  if (node._text) parts.push(node._text);
  for (const child of node.children) parts.push(textOf(child));
  return parts.join('\n');
}

function main() {
  const mod = installContext();

  // ---- 1. A long command is shown in full, above the output --------
  {
    const body = makeNode('div');
    mod.renderShellToolResult(body, {
      ok: true, stdout: '8e358e08 feat(chat): reuse transcript rows\n', stderr: '',
      exitCode: 0, identity: 'mouaif shell · linux · bash (/bin/bash)', durationMs: 33
    }, { cmd: LONG_CMD });
    const pre = body.querySelector('.tool-preview__pre--args');
    check('a long command renders in the expanded body', !!pre);
    check('the command is complete, not truncated to the head budget',
      !!pre && pre.textContent === LONG_CMD, pre ? String(pre.textContent.length) : 'missing');
    check('the command keeps its line breaks',
      !!pre && pre.textContent.split('\n').length === LONG_CMD.split('\n').length);
    const out = body.querySelector('.tool-preview__terminal');
    check('the output is still rendered', !!out && /8e358e08/.test(out.textContent));
    const order = classesOf(body);
    check('the command comes before the output',
      order.indexOf('tool-preview__args') !== -1
      && order.indexOf('tool-preview__args') < order.lastIndexOf('tool-preview__terminal'),
      order.join(' | '));
  }

  // ---- 2. A short command is not repeated ---------------------------
  {
    const body = makeNode('div');
    mod.renderShellToolResult(body, {
      ok: true, stdout: 'a\nb\n', stderr: '', exitCode: 0, identity: 'bash', durationMs: 5
    }, { cmd: 'ls -la' });
    check('a command the head showed in full is not duplicated',
      !body.querySelector('.tool-preview__pre--args'));
    check('its output renders as before',
      /a\nb/.test(textOf(body.querySelector('.tool-preview__terminal'))));
  }

  // ---- 3. The failing-result path keeps the same order --------------
  {
    const body = makeNode('div');
    mod.renderShellToolResult(body, {
      ok: false, error: 'command failed', exitCode: 2, identity: 'bash', durationMs: 9
    }, { cmd: LONG_CMD });
    const order = classesOf(body);
    check('an error card shows the command too', !!body.querySelector('.tool-preview__pre--args'));
    check('the command precedes the failure text',
      order.indexOf('tool-preview__args') < order.lastIndexOf('tool-preview__terminal'),
      order.join(' | '));
  }

  // ---- 4. No call arguments available: nothing is invented ----------
  {
    const body = makeNode('div');
    mod.renderShellToolResult(body, {
      ok: true, stdout: 'x\n', stderr: '', exitCode: 0, identity: 'bash'
    }, null);
    check('a result without call arguments renders only its output',
      !body.querySelector('.tool-preview__pre--args'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
