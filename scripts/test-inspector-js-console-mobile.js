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
//   2. Enter inserts a newline and `Ctrl`/`Cmd`+Enter evaluates. Enter is the
//      one key a phone's soft keyboard always offers and an entry is often
//      several lines, so Enter belongs to the text; evaluating is the modifier
//      form, the same split the chat composer uses. A single strip button adds
//      the indent a soft keyboard cannot type.
//
// The component runs in a VM against a miniature CodeMirror and a small hook
// store, so the assertions *drive* it — type, press the keymap bindings, tap the
// strip button — rather than matching source text. The last section checks the
// CSS invariants a later refactor could quietly break.

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
  // `Mod-Enter` identifies itself to the test as `Ctrl-Enter`, which is what a
  // non-Apple keyboard sends.
  box.bindings = () => (box.keymap || []).map((b) => (b && b.key === 'Mod-Enter' ? { ...b, key: 'Ctrl-Enter' } : b));
  // The keymap handlers receive the editor at the moment of the keypress.
  box.view = view;
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
    // The component's own imports are stripped before it runs here, so the
    // harness supplies `EditorSelection`. That makes a name the component
    // *forgot* to import invisible to this VM, which is why a source-level
    // assertion below checks that every name the component uses is imported.
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
    autocompletion: (opts) => { box.autocompletion = opts; return {}; },
    closeBrackets: () => ({}),
    javascript: () => ({}),
    oneDark: {},
    oneDarkHighlightStyle: {},
    placeholder: () => ({}),
    indentWithTab: { key: 'Tab', run: () => true },
    // Stubbed so the newline bindings can be asserted by identity: the real
    // command is CodeMirror's, and the wiring is what matters here.
    insertNewlineAndIndent: function insertNewlineAndIndent() { return true; },
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

const indentButton = (box) => findByProp(box.tree, 'aria-label', 'indent');

// Find a keymap binding by key. `Mod-Enter` is normalised to `Ctrl-Enter` on the
// way out of the harness, so the test reads the way a keyboard behaves.
const binding = (box, key) => (box.bindings() || []).find((b) => b && b.key === key);

// Fire a binding the way CodeMirror would: the handler gets the live view and
// runs the command. `insertNewlineAndIndent` is stubbed, so a newline binding is
// asserted by identity plus a dispatch, and the evaluate binding by its effect.
function press(box, key) {
  const b = binding(box, key);
  if (!b) return { found: false };
  const view = box.view;
  const ran = b.run(view);
  return { found: true, ran };
}

// ---------------------------------------------------------------------------
(() => {
  // ===== 1. The strip's touch affordance =================================
  {
    const box = mountConsole();
    const indent = indentButton(box);

    check('the strip renders the indent button', !!indent);
    check('the indent button is a real button', !!indent && indent.type === 'button');
    check('the indent button names what it does for assistive tech',
      !!indent && /new line/i.test(indent.props['aria-label']), indent && indent.props['aria-label']);
    check('the indent button is never disabled (it works on an empty box)',
      !!indent && !indent.props.disabled);
    check('the strip no longer offers a Run button',
      !findByProp(box.tree, 'aria-label', 'Run'));
    check('the strip no longer wraps its actions in their own group',
      !findByProp(box.tree, 'class', 'inspector__jsconsole-actions'));
    check('the hint describes the real bindings',
      /Enter for newline/.test(textOf(box.tree)) && /Ctrl\+Enter to run/.test(textOf(box.tree)),
      textOf(box.tree));
    check('the hint does not open by promising bare Enter runs',
      !/^Enter to run/.test(textOf(box.tree)), textOf(box.tree));
    check('the editor is mounted against its host node', box.parent !== undefined);
  }

  // ===== 2. Enter inserts, Ctrl+Enter evaluates ==========================
  {
    const box = mountConsole();
    check('Enter is bound', !!binding(box, 'Enter'));
    check('Enter is bound to a newline, not to evaluate',
      !!binding(box, 'Enter') && binding(box, 'Enter').run !== undefined
      && binding(box, 'Enter').run.name !== 'runCode',
      binding(box, 'Enter') && String(binding(box, 'Enter').run));
    check('Shift+Enter is bound to the same newline',
      !!binding(box, 'Shift-Enter') && binding(box, 'Shift-Enter').run === binding(box, 'Enter').run);
    check('Ctrl+Enter is bound', !!binding(box, 'Ctrl-Enter'));
    check('Ctrl+Enter evaluates the expression', (() => {
      box.type('1 + 1');
      press(box, 'Ctrl-Enter');
      return box.evaluated.length === 1 && box.evaluated[0] === '1 + 1';
    })(), JSON.stringify(box.evaluated));
    check('evaluating clears the box', box.text() === '', JSON.stringify(box.text()));
    check('a whitespace-only box evaluates nothing', (() => {
      box.type('   ');
      press(box, 'Ctrl-Enter');
      return box.evaluated.length === 1;
    })(), JSON.stringify(box.evaluated));
    check('Tab is still bound to the editor indent',
      (box.bindings() || []).some((b) => b && b.key === 'Tab'));
    check('Ctrl+Space autocomplete still comes from CodeMirror',
      !!box.autocompletion, JSON.stringify(box.autocompletion && Object.keys(box.autocompletion)));
  }

  // ===== 3. The indent button adds a line without a keyboard =============
  {
    const box = mountConsole();
    box.type('if (x) {');
    indentButton(box).props.onClick();
    check('the indent button inserts a newline',
      box.text() === 'if (x) {\n', JSON.stringify(box.text()));

    // A nested line keeps its indentation, so a body typed on a phone lines up
    // with the block it belongs to.
    box.type('  ');
    box.caretAtEnd();
    indentButton(box).props.onClick();
    check('the indent button copies the current line\'s leading whitespace',
      box.text() === 'if (x) {\n  \n  ', JSON.stringify(box.text()));
    check('the indent button leaves the editor focused', box.focused === true);
    check('the indent button does not evaluate anything', box.evaluated.length === 0);
  }

  // ===== 4. CSS invariants ==============================================
  {
    const wrap = (/\.inspector__jsconsole-editor \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the editor wrapper is content-height', /height:\s*auto/.test(wrap), wrap.trim());
    check('the fixed 108 px editor box is gone', !/height:\s*108px/.test(css));
    check('the wrapper no longer caps its own height', !/max-height:/.test(wrap));

    // The cap has to live on the element CodeMirror styles with `height: 100%`
    // — a max-height anywhere else is overflowed and clipped instead of binding.
    const scroller = (/\.inspector__jsconsole-editor \.cm-scroller \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the scroller caps the editor height', /max-height:\s*32dvh/.test(scroller), scroller.trim());
    check('the scroller owns the vertical overflow', /overflow-y:\s*auto/.test(scroller));
    check('the scroller never scrolls sideways', /overflow-x:\s*hidden/.test(scroller));
    check('the editor height is inline (not a fixed 100%)',
      /'&': \{ height: 'auto'/.test(read('frontend/src/components/inspector/JsConsole.jsx')));

    const bar = (/\.inspector__jsconsole-bar \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the bar rolls its one action onto a second line when the hint fills the row',
    /flex-wrap:\s*wrap/.test(bar), bar.trim());
    check('the strip reserves no vertical padding around its tap target',
    /padding:\s*0 4px 0 10px/.test(bar), bar.trim());
    const hint = (/\.inspector__jsconsole-hint \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the hint ellipsizes instead of pushing the button off',
    /text-overflow:\s*ellipsis/.test(hint));
    check('the hint may shrink to make room', /min-width:\s*0/.test(hint));
    // The hint is a long string; on a 360 px card it must be able to share the
    // row's leftover with the button rather than claiming a row of its own.
    check('the hint shares the row instead of taking all of it',
    /flex:\s*1 1 120px/.test(hint), hint.trim());

    const btn = (/\.inspector__jsconsole-btn \{([^}]*)\}/.exec(css) || ['', ''])[1];
    check('the strip button meets the 44 px floor',
      /min-height:\s*var\(--tap\)/.test(btn) && /min-width:\s*var\(--tap\)/.test(btn), btn.trim());
    const decls = btn.split(';').map((d) => d.trim());
    check('the strip button is not forced wider than the 44 px minimum',
      !decls.some((d) => d.startsWith('width:')), btn.trim());
    check('the Run button\'s accent style is gone',
      !/jsconsole-btn--run/.test(css) && !/jsconsole-btn--run/.test(read('frontend/src/components/inspector/JsConsole.jsx')));

    // The VM harness strips the component's imports and supplies these names
    // itself, so a missed import is invisible to every driven assertion above.
    // Grep for it instead: dropping `EditorSelection` when the Run button went
    // away left the indent handler throwing a ReferenceError in the real bundle
    // while this harness stayed green.
    const jsConsoleSource = read('frontend/src/components/inspector/JsConsole.jsx');
    const imports = (jsConsoleSource.match(/^import .*$/gm) || []).join('\n');
    check('EditorSelection is imported, not just used',
    /EditorSelection[^}]*\} from '@codemirror\/state'/.test(imports), imports);
    const body = jsConsoleSource.replace(/^import .*$/gm, '');
    check('every CodeMirror name the component uses is imported',
    ['EditorState', 'EditorSelection', 'EditorView', 'insertNewlineAndIndent', 'indentWithTab']
      .filter((n) => new RegExp('\\b' + n + '\\b').test(body))
      .every((n) => new RegExp('\\b' + n + '\\b').test(imports)),
    imports);

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
