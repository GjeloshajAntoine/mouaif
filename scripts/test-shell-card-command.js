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

  // ---- 2. A command is shown even when the head "fits" ---------------
  //
  // The head ellipsizes its TEXT at TOOL_ARGS_PREVIEW_CHARS, but CSS also
  // clips it to the row width. A 120-character command is under the text
  // cap yet still renders as `cd /home/ubuntu/mouaif && git diff --ca…` on
  // a 390 px screen, so deciding "the head already showed it" from the
  // length alone kept the command hidden on most cards. The block is now
  // unconditional: if there are arguments, the expanded card shows them.
  {
    const midCmd = 'y'.repeat(120);
    const body = makeNode('div');
    mod.renderShellToolResult(body, {
      ok: true, stdout: 'a\nb\n', stderr: '', exitCode: 0, identity: 'bash', durationMs: 5
    }, { cmd: midCmd });
    const pre = body.querySelector('.tool-preview__pre--args');
    check('a command under the head text cap is still shown in full',
      !!pre && pre.textContent === midCmd, pre ? String(pre.textContent.length) : 'missing');
    check('its output renders as before',
      /a\nb/.test(textOf(body.querySelector('.tool-preview__terminal'))));
    check('a shown command still flags the body as flat',
      body.classList.contains('tool-preview--with-args'), body.className);
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
  // box, so the class tracks the presence of the command block.
  {
    const withCmd = makeNode('div');
    mod.renderShellToolResult(withCmd, {
      ok: true, stdout: 'o\n', stderr: '', exitCode: 0, identity: 'bash'
    }, { cmd: LONG_CMD });
    check('a command flags the body as showing arguments',
      withCmd.classList.contains('tool-preview--with-args'), withCmd.className);

    const shortCmd = makeNode('div');
    mod.renderShellToolResult(shortCmd, {
      ok: true, stdout: 'o\n', stderr: '', exitCode: 0, identity: 'bash'
    }, { cmd: 'ls -la' });
    check('a short command also flags the body (the head clips it too)',
      shortCmd.classList.contains('tool-preview--with-args'), shortCmd.className);

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

  // ---- 7. The card keeps ONE visible surface ------------------------
  //
  // A shell card that shows a command is one bounded terminal against the
  // page. The surface must live on the body (`.tool-card__body`, which is
  // also the `.tool-preview` element — `renderToolResultBody` sets
  // `body.className = 'tool-card__body'` and then adds the preview classes
  // to that SAME element), not on either child, because the child that
  // carries it depends on render order — and on the error path the status
  // line is rendered BETWEEN the command and the output, so a border on a
  // child would split one card into two.
  //
  // Two regressions this guards, both of which shipped:
  //   1. the surface was removed from the output pre when a command block
  //      was present and never re-added anywhere, leaving the body
  //      transparent over a --bg page and therefore invisible;
  //   2. the surface was re-added as `.tool-preview--terminal.tool-preview--
  //      with-args` alone (specificity 0,2,0), which LOSES to the existing
  //      `.tool-card.is-expanded .tool-card__body` rule (0,3,0). The rule
  //      was present, and inert. Checking for the rule's existence is not
  //      enough — the selector has to name the body class so it can win.
  //
  // Colours are not resolvable in this JS harness, so the cascade is
  // checked by comparing selector specificity against the rule that
  // actually paints the body transparent.
  {
    const css = fs.readFileSync(path.join(__dirname, '../frontend/src/tool-cards.css'), 'utf8');
    // `a.b.c` -> [0, 3, 0]; `a.b .c` -> [0, 2, 1]. Enough to compare the
    // plain class selectors involved here (no ids, no inline styles).
    const specificity = (sel) => {
      const classes = (sel.match(/\.[A-Za-z0-9_-]+/g) || []).length;
      const elements = (sel.match(/(^|[\s>+~])[a-z][a-z0-9-]*/gi) || []).length;
      return classes * 100 + elements;
    };

    const container = /^([^\n{]*\.tool-preview--with-args)\s*\{([^}]*)\}/m.exec(css);
    check('the shell card container declares a surface', !!container, String(container));
    if (container) {
      const selector = container[1].trim();
      const body = container[2];
      check('its surface has a background', /background:\s*var\(--bg\)/.test(body), body);
      check('its surface has a border', /border:\s*1px solid var\(--border\)/.test(body), body);
      // The body is the element the surface has to land on.
      check('the surface selector names the card body',
        /\.tool-card__body/.test(selector), selector);

      // …and it has to beat the rule that paints that body transparent.
      const competitor = /^([^\n{]*)\{[^}]*background:\s*transparent[^}]*\}/m.exec(css);
      const competitorSel = competitor ? competitor[1].trim().split(',')[0].trim() : '';
      check('the transparent body rule is found', !!competitor, String(competitor));
      check('the surface outranks the rule that clears the body background',
        specificity(selector) >= specificity(competitorSel),
        selector + ' (' + specificity(selector) + ') vs ' + competitorSel + ' (' + specificity(competitorSel) + ')');
    }

    // Both children must be flush inside that one surface — no border of
    // their own to reintroduce the divider line. The selector is split over
    // two lines, so match the rule block and inspect its selector text.
    const flush = /([^\n{]*(?:\.tool-preview__pre--args)[^{]*)\{([^}]*)\}/m.exec(css);
    check('both sections are flush inside the shared surface', !!flush, String(flush));
    if (flush) {
    check('the flush rule covers the output block too',
      /\.tool-preview__terminal/.test(flush[1]), flush[1]);
    check('the command block has no border of its own',
      /border:\s*0\b/.test(flush[2]), flush[2]);
    check('the output block has no border of its own',
      /border:\s*0\b/.test(flush[2]), flush[2]);
    check('the flush rule is scoped to the surface, not the base class',
      /\.tool-preview--with-args/.test(flush[1]), flush[1]);
    }
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
