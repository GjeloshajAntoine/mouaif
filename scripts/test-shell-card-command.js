// toolRender.js is loaded the way the sibling transcript tests load it:
// the import block is stripped and the body runs in a VM whose globals
// supply the module's helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

function camelAttr(name) {
  return String(name).replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

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
    attributes: {},
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); },
      toggle(name) {
        if (classes.has(name)) { classes.delete(name); return false; }
        classes.add(name);
        return true;
      }
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
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
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
    replaceChild(fresh, old) {
    const at = node.children.indexOf(old);
    if (at === -1) return node.appendChild(fresh);
    fresh.parentNode = node;
    old.parentNode = null;
    node.children[at] = fresh;
    return old;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    matches(selector) { return matchesSelector(node, selector); },
    closest(selector) {
      let cur = node.parentNode;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelector(selector) { return querySelector(node, selector)[0] || null; },
    querySelectorAll(selector) { return querySelector(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

// Supports the selectors the transcript code actually uses: `.class`,
// `[data-x="value"]`, and `:scope > .class` (direct children only).
function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith(':scope > ')) return false; // handled by the caller
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf('=');
    const name = (eq === -1 ? inner : inner.slice(0, eq)).trim();
    const raw = eq === -1 ? null : inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    const value = node.dataset[camelAttr(name)];
    return raw == null ? value != null : value === raw;
  }
  return node.tagName === sel.toUpperCase();
}

function querySelector(root, selector) {
  const sel = String(selector).trim();
  const direct = sel.startsWith(':scope > ');
  const target = direct ? sel.slice(':scope > '.length) : sel;
  const out = [];
  const visit = (node, depth) => {
    for (const child of node.children) {
      if (matchesSelector(child, target) && (!direct || depth === 0)) out.push(child);
      if (!direct || depth === 0) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function textOf(node) {
  const parts = [];
  if (node._text) parts.push(node._text);
  for (const child of node.children) parts.push(textOf(child));
  return parts.join('\n');
}

function findPre(body, className) {
  return querySelector(body, '.tool-preview__pre').find((el) => el.classList.contains(className)) || null;
}

// ---- Module loader ---------------------------------------------------

function installContext() {
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    document: {
      createElement: makeNode,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    // Real implementations the render path depends on. The Proxy below
    // auto-stubs anything else the modules import.
    cssEscape: (value) => String(value),
    publishWebPreview() {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  // tools.js and toolRender.js first: transcript.js resolves their
  // exports (renderToolResultBody, coerceToolResult, ...) as globals.
  const load = (file) => {
    const source = fs.readFileSync(path.join(CHAT_DIR, file), 'utf8')
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: file });
  };
  load('tools.js');
  load('toolRender.js');
  const transcript = fs.readFileSync(path.join(CHAT_DIR, 'transcript.js'), 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(
    transcript + '; this.appendToolCallCard = appendToolCallCard; this.appendToolResultCard = appendToolResultCard;'
      + ' this.renderMessageRow = renderMessageRow; this.toolCallArgsFor = toolCallArgsFor;',
    context,
    { filename: 'transcript.js' }
  );
  return context;
}

// makeRefs() -> the transcript ref object renderMessageRow expects.
function makeRefs() {
  const transcript = makeNode('div');
  transcript.className = 'chat-view__transcript';
  return {
    transcript: { current: transcript },
    pinnedToBottom: { current: true },
    _insertAnchor: null,
    _suspendScrollPin: false,
    _lastInsertedRow: null
  };
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

  // ---- 5. The command block is flagged, so the body can go flat -----
  //
  // A shell card that shows a command AND its output is one continuous
  // terminal: no border lines in the body (the CSS keys off
  // `.tool-preview--with-args`). A card that shows output alone keeps its
  // box, so the class must be added only when the command block exists.
  {
    const withCmd = makeNode('div');
    mod.renderShellToolResult(withCmd, {
      ok: true, stdout: 'o\n', stderr: '', exitCode: 0, identity: 'bash'
    }, { cmd: LONG_CMD });
    check('a truncated command flags the body as showing arguments',
      withCmd.classList.contains('tool-preview--with-args'), withCmd.className);

    const shortCmd = makeNode('div');
    mod.renderShellToolResult(shortCmd, {
      ok: true, stdout: 'o\n', stderr: '', exitCode: 0, identity: 'bash'
    }, { cmd: 'ls -la' });
    check('a short command does not flag the body as showing arguments',
      !shortCmd.classList.contains('tool-preview--with-args'), shortCmd.className);

    const noArgs = makeNode('div');
    mod.renderShellToolResult(noArgs, {
      ok: true, stdout: 'o\n', stderr: '', exitCode: 0, identity: 'bash'
    }, null);
    check('a result with no arguments does not flag the body',
      !noArgs.classList.contains('tool-preview--with-args'), noArgs.className);
  }

  // ---- 6. The command survives either render order ------------------
  //
  // Regression: the args recovery in renderMessageRow was gated to
  // `write_file`, so a shell card built from its RESULT row (tail-first
  // chunked render, a pagination page, a rebuild that lost the stashed
  // args) had no command to render, while a card built from its CALL row
  // did. Same data, same chat — different result depending on which row
  // the render reached first.
  {
    const transcriptMod = installContext();
    const result = {
      ok: true, stdout: '8e358e08 feat(chat): reuse transcript rows\n', stderr: '',
      exitCode: 0, identity: 'mouaif shell · linux · bash (/bin/bash)', durationMs: 33
    };
    const callRow = { role: 'tool', phase: 'call', toolCallId: 'call_shell_1', name: 'shell', args: { cmd: LONG_CMD } };
    const resultRow = {
      role: 'tool', phase: 'result', toolCallId: 'call_shell_1', name: 'shell', ok: 1,
      content: JSON.stringify(result)
    };
    const state = { messages: [callRow, resultRow] };

    const expandAndRead = (refs) => {
      const card = refs.transcript.current.children[0];
      if (typeof card._lazyBody === 'function') card._lazyBody();
      const pre = card.querySelector('.tool-preview__pre--args');
      return { present: !!pre, full: !!pre && pre.textContent === LONG_CMD, rows: refs.transcript.current.children.length };
    };

    // Result row first: the call row is still in the backfill when the
    // card is built, so it has to recover the args from state.messages.
    {
      const refs = makeRefs();
      transcriptMod.renderMessageRow(state, refs, resultRow);
      const facts = expandAndRead(refs);
      check('a result-first shell card recovers the command', facts.present && facts.full,
        JSON.stringify(facts));
      // The late call row must not add a second, command-less card.
      transcriptMod.renderMessageRow(state, refs, callRow);
      check('the late call row still does not duplicate the card',
        refs.transcript.current.children.length === 1,
        String(refs.transcript.current.children.length));
    }

    // Call row first: the live-stream order, which already worked.
    {
      const refs = makeRefs();
      transcriptMod.renderMessageRow(state, refs, callRow);
      transcriptMod.renderMessageRow(state, refs, resultRow);
      const facts = expandAndRead(refs);
      check('a call-first shell card shows the same command', facts.present && facts.full,
        JSON.stringify(facts));
    }
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
