'use strict';

// The Inspector's JavaScript console on a phone.
//
// The console card is the one Inspector surface that is *typed into*, and on a
// phone that means a soft keyboard: no Tab, no Ctrl-Space, no Shift+Enter, and a
// keyboard the user wants to dismiss again as soon as the expression has been
// sent. Two things follow from that, and neither is visible to the CDP-shaped
// tests:
//
//   1. the card is sized by its content — one line tall when it is empty, as
//      tall as the expression is, with the overflow living on CodeMirror's own
//      scroller. The old fixed 108 px box was dead space on a phone *and* it hid
//      a long expression behind a clipped `overflow: hidden`;
//   2. every action the entry needs is also a button: **Run** (which carries the
//      empty state) and a **Tab** that inserts the same indent the hardware key
//      would, so the console is usable with the on-screen keyboard alone.
//
// The component runs in a VM against a miniature CodeMirror and a small hook
// store, so the assertions *drive* it — type, tap Run, tap Tab — rather than
// matching source text. The last section checks the CSS invariants a later
// refactor could quietly break.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { readInspectorCss } = require('./inspector-css.js');

const css = readInspectorCss();
const fullscreenCss = read('frontend/src/inspector-fullscreen.css');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- The miniature editor -------------------------------------------------
// A one-buffer document with the four things the strip touches — `toString`,
// `length`, `lineAt`, `changeByRange` — and a `dispatch` that applies the spec
// and notifies the update listener. That notification is what makes Run's
// disabled state observable from here, so the test can assert it the way the
// component does: from the document, not from a keystroke.

function mountConsole() {
  const hooks = [];
  let hookIndex = 0;
  let text = '';
  let caret = 0;
  let listener = null;

  const box = { evaluated: [], reRenders: 0, effects: [] };

  const doc = {
    toString: () => text,
    get length() { return text.length; },
    lineAt(pos) {
      const start = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
      const at = text.indexOf('\n', pos);
      const end = at === -1 ? text.length : at;
      return { from: start, to: end, text: text.slice(start, end) };
    }
  };
  const state = {
    doc,
    get selection() { return { main: { from: caret, to: caret, anchor: caret, head: caret } }; },
    replaceSelection(insert) { return { replace: insert }; },
    changeByRange(fn) {
      const e = fn({ from: caret, to: caret, anchor: caret, head: caret });
      return { ranged: e.changes };
    }
  };

  function apply(spec) {
    if (!spec || typeof spec !== 'object') return false;
    if (typeof spec.replace === 'string') {
      text = text.slice(0, caret) + spec.replace + text.slice(caret);
      caret += spec.replace.length;
      return true;
    }
    if (spec.ranged && typeof spec.ranged.insert === 'string') {
      text = text.slice(0, spec.ranged.from) + spec.ranged.insert + text.slice(spec.ranged.to);
      caret = spec.ranged.from + spec.ranged.insert.length;
      return true;
    }
    if (spec.changes && typeof spec.changes === 'object') {
      const insert = typeof spec.changes.insert === 'string' ? spec.changes.insert : '';
      text = text.slice(0, spec.changes.from) + insert + text.slice(spec.changes.to);
      caret = spec.changes.from + insert.length;
      return true;
    }
    return false;
  }

  const view = {
    state,
    focus() { box.focused = true; },
    dispatch(spec) {
      if (!apply(spec)) return;
      if (listener) listener({ docChanged: true, state });
    },
    destroy() { box.destroyed = true; }
  };
  // Test-side typing: a change the update listener sees, exactly like a
  // keystroke, without a DOM input pipeline.
  box.type = (str) => {
    text += str;
    caret = text.length;
    if (listener) listener({ docChanged: true, state });
  };
  box.caretAtEnd = () => { caret = text.length; };
  box.text = () => text;
  box.keymap = null;

  const sandbox = {
    EditorState: { create: () => state },
    EditorSelection: { cursor: (anchor) => ({ anchor }) },
    EditorView: Object.assign(
      function EditorView(opts) { box.parent = opts.parent; return view; },
      {
        theme: () => ({}),
        lineWrapping: {},
        updateListener: { of: (cb) => { listener = cb; return {}; } }
      }
    ),
    keymap: { of: (keys) => { box.keymap = keys; return {}; } },
    lineNumbers: () => ({}),
    highlightActiveLineGutter: () => ({}),
    highlightActiveLine: () => ({}),
    drawSelection: () => ({}),
    history: () => ({}),
    indentOnInput: () => ({}),
    bracketMatching: () => ({}),
    syntaxHighlighting: () => ({}),
    autocompletion: () => ({}),
    closeBrackets: () => ({}),
    javascript: () => ({}),
    oneDark: {},
    oneDarkHighlightStyle: {},
    placeholder: () => ({}),
    indentWithTab: { key: 'Tab', run: () => true },
    defaultKeymap: [], historyKeymap: [], completionKeymap: [], closeBracketsKeymap: [],
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hookIndex++;
      if (!hooks[i]) hooks[i] = { v: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[i];
      return [slot.v, (next) => {
        const value = typeof next === 'function' ? next(slot.v) : next;
        if (value === slot.v) return;
        slot.v = value;
        box.rerender();
      }];
    },
    useRef: (initial) => {
      const i = hookIndex++;
      // A null initial value becomes a truthy placeholder, the same trick the
      // other Inspector tests use: the component's effect bails out when its
      // host ref is null, and nothing in this harness ever attaches a real DOM
      // node. The action refs are overwritten by the effect itself, so by the
      // time a test taps a button they hold the real functions.
      if (!hooks[i]) hooks[i] = { v: { current: initial === null || initial === undefined ? {} : initial } };
      return hooks[i].v;
    },
    useEffect: (fn) => { box.effects.push(fn); },
    document: { createElement: () => ({ style: { setProperty() {} }, appendChild() {} }) },
    Promise, Object, Array, String, Number, JSON, Error, isNaN, Date, RegExp, Math
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const source = read('frontend/src/components/inspector/JsConsole.jsx')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(source + '; this.__console = JsConsole;', ctx);

  const render = () => {
    hookIndex = 0;
    box.reRenders++;
    return ctx.__console({ onEvaluate: (code) => box.evaluated.push(code) });
  };
  box.tree = render();
  for (const fn of box.effects) fn();
  box.effects.length = 0;
  box.rerender = () => { box.tree = render(); };
  return box;
}

// ---- Vnode helpers --------------------------------------------------------
// Depth-first search for the first node whose `props[key]` contains `needle`
// (props are matched as strings, which is how `class` and `aria-label` arrive).
function findByProp(node, key, needle) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByProp(child, key, needle); if (hit) return hit; }
    return null;
  }
  if (typeof node !== 'object') return null;
  const value = node.props && node.props[key];
  if (typeof value === 'string' && value.includes(needle)) return node;
  return findByProp(node.children, key, needle);
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return String(node);
  return textOf(node.children);
}

const runButton = (box) => findByProp(box.tree, 'aria-label', 'Run');
const tabButton = (box) => findByProp(box.tree, 'aria-label', 'indent');

// ---------------------------------------------------------------------------
(() => {
  // ===== 1. The strip's touch affordances ================================
  {
    const box = mountConsole();
    const run = runButton(box);
    const tab = tabButton(box);

    check('the strip renders a Run button', !!run);
    check('Run is a real button', !!run && run.type === 'button');
    check('Run is the accent action',
      !!run && /inspector__jsconsole-btn--run/.test(run.props.class), run && run.props.class);
    check('Tab is a real button', !!tab && tab.type === 'button');
    check('Run names what it does for assistive tech',
      !!run && /evaluate in the page/i.test(run.props['aria-label']), run && run.props['aria-label']);
    check('Tab names what it does for assistive tech',
      !!tab && /indent/i.test(tab.props['aria-label']), tab && tab.props['aria-label']);
    check('both actions sit in their own group',
      !!findByProp(box.tree, 'class', 'inspector__jsconsole-actions'));
    check('Run is disabled while the editor is empty', !!run && run.props.disabled === true);
    check('Tab is never disabled (it works on an empty box)',
      !!tab && !tab.props.disabled);
    check('the keyboard hint is still on the strip',
      /Enter to run/.test(textOf(box.tree)) && /Ctrl\+Space/.test(textOf(box.tree)),
      textOf(box.tree));
    check('the editor is mounted against its host node', box.parent !== undefined);
  }

  // ===== 2. Run sends the expression and empties the box =================
  {
    const box = mountConsole();
    box.type('1 + 1');
    check('typing enables Run', runButton(box).props.disabled === false,
      String(runButton(box).props.disabled));

    runButton(box).props.onClick();
    check('Run evaluates the expression', box.evaluated.length === 1 && box.evaluated[0] === '1 + 1',
      JSON.stringify(box.evaluated));
    check('Run leaves the editor focused', box.focused === true);
    check('Run clears the box', box.text() === '', JSON.stringify(box.text()));
    check('an emptied box disables Run again', runButton(box).props.disabled === true);

    // Whitespace only is not an expression: the card must not claim it can run.
    box.type('   ');
    check('whitespace alone still runs nothing',
      (runButton(box).props.onClick(), box.evaluated.length === 1),
      JSON.stringify(box.evaluated));
  }

  // ===== 3. Tab indents without a keyboard ===============================
  {
    const box = mountConsole();
    box.type('if (x) {');
    tabButton(box).props.onClick();
    check('Tab inserts a newline and the line\'s own indent',
      box.text() === 'if (x) {\n', JSON.stringify(box.text()));

    // A nested line keeps its indentation, so a body typed on a phone lines up
    // with the block it belongs to.
    box.type('  ');
    box.caretAtEnd();
    tabButton(box).props.onClick();
    check('Tab copies the current line\'s leading whitespace',
      box.text() === 'if (x) {\n  \n  ', JSON.stringify(box.text()));
    check('Tab leaves the editor focused', box.focused === true);
    check('Tab does not evaluate anything', box.evaluated.length === 0);
  }

  // ===== 4. The hardware keys still work =================================
  {
    const box = mountConsole();
    const enter = (box.keymap || []).find((b) => b.key === 'Enter');
    check('Enter is bound in the keymap', !!enter);
    check('Enter runs the expression', !!enter && enter.run({ state: { doc: { toString: () => '2 + 2', length: 5 } }, dispatch() {} }) === true);
    check('Shift+Enter inserts a newline', !!enter && typeof enter.shift === 'function');
    check('Tab is still bound to the editor indent',
      (box.keymap || []).some((b) => b && b.key === 'Tab'));
  }

  // ===== 5. CSS invariants ==============================================
  {
    const wrap = (/\.inspector__jsconsole-editor \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the editor wrapper is content-height', /height:\s*auto/.test(wrap), wrap.trim());
    check('the fixed 108 px editor box is gone', !/height:\s*108px/.test(css));
    check('the wrapper no longer caps its own height',
      !/max-height:/.test(wrap), (wrap.match(/max-height[^;]*/) || [''])[0]);

    // The cap has to live on the element CodeMirror styles with `height: 100%`
    // — a max-height anywhere else is overflowed and clipped instead of binding.
    const scroller = (/\.inspector__jsconsole-editor \.cm-scroller \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the scroller caps the editor height', /max-height:\s*32dvh/.test(scroller), scroller.trim());
    check('the scroller owns the vertical overflow', /overflow-y:\s*auto/.test(scroller));
    check('the scroller never scrolls sideways', /overflow-x:\s*hidden/.test(scroller));
    check('the editor height is inline (not a fixed 100%)',
      /'&': \{ height: 'auto'/.test(read('frontend/src/components/inspector/JsConsole.jsx')));

    const bar = (/\.inspector__jsconsole-bar \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the bar wraps rather than clipping its actions', /flex-wrap:\s*wrap/.test(bar), bar.trim());
    const hint = (/\.inspector__jsconsole-hint \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the hint ellipsizes instead of pushing the buttons off',
      /text-overflow:\s*ellipsis/.test(hint));
    check('the hint may shrink to make room', /min-width:\s*0/.test(hint));

    const btn = (/\.inspector__jsconsole-btn \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the actions meet the 44 px floor',
    /min-height:\s*var\(--tap\)/.test(btn) && /min-width:\s*var\(--tap\)/.test(btn), btn.trim());
    // Declaration-level, because `min-width` contains the substring `width`:
    // the buttons reserve the 44 px floor, and nothing forces them wider than
    // their label, which is what keeps the hint on the same line at 360 px.
    const decls = btn.split(';').map((d) => d.trim());
    check('the actions are not forced wider than the 44 px minimum',
    !decls.some((d) => d.startsWith('width:')), btn.trim());
    check('Run is painted with the accent token',
      /\.inspector__jsconsole-btn--run \{[^}]*background:\s*var\(--accent\)/.test(css));

    // Full screen: the strip stays reachable at the end of the card, and the
    // wrapper is bounded so the log above it keeps the leftover height.
    check('full screen bounds the console wrapper',
      /\.inspector__fs \.inspector__panel-body \.inspector__console-wrap \{[^}]*flex:\s*0 1 auto/.test(fullscreenCss));
    check('full screen pushes the editor strip to the end of the card',
      /\.inspector__fs \.inspector__jsconsole \{[^}]*margin-top:\s*auto/.test(fullscreenCss));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
