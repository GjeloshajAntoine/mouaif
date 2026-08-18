// Inspector JsConsole — an editable JavaScript console for the
// inspected page.
//
// A CodeMirror editor sits below the log scroller. Expressions typed
// into it are evaluated in the inspected page over the same CDP
// connection the console uses (`Runtime.evaluate` with
// `includeCommandLineAPI: true`, so `$0` / `$` / `$$` / `inspect`
// behave like the real Chrome console). Results are appended to the
// Console panel as new rows, reusing its virtual list so the live
// log and the user's own evaluations share one stream.
//
// Autosuggestion comes from three layers:
//   1. A snapshot of the page's globals (`Runtime.globalLexicalScopeNames`),
//      property-completed on demand via `Runtime.getProperties`.
//   2. Live DOM references: element IDs and common element globals
//      (`window.<id>`), so `#foo` / `document.getElementById` targets
//      appear by name.
//   3. Browser APIs and console helpers that are usually reachable in
//      the inspected page, plus JS keywords / literals.
//
// The source function is async, so the expensive global snapshot is
// fetched once and `Runtime.getProperties` only runs when the user is
// mid-property (e.g. after typing `document.`). The returned
// completions are CodeMirror `Completion` objects with `detail`,
// `type`, and `info` so the picker reads like DevTools, not a bare
// word list.
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';

// ---- Static completion tables -----------------------------------------
// Browser APIs most useful in a page console. Kept as a small curated
// list rather than a huge dump so the picker stays scannable. `detail`
// carries the kind, `type` drives the icon, `info` is the hover text.
const BROWSER_GLOBALS = [
  ['window', 'global object', 'variable'],
  ['document', 'the DOM document', 'variable'],
  ['location', 'current URL', 'variable'],
  ['history', 'session history', 'variable'],
  ['navigator', 'browser/device info', 'variable'],
  ['screen', 'screen metrics', 'variable'],
  ['localStorage', 'persistent storage', 'variable'],
  ['sessionStorage', 'session storage', 'variable'],
  ['fetch', 'fetch network requests', 'function'],
  ['alert', 'show an alert dialog', 'function'],
  ['confirm', 'show a confirm dialog', 'function'],
  ['prompt', 'show a prompt dialog', 'function'],
  ['setTimeout', 'schedule after a delay', 'function'],
  ['setInterval', 'schedule repeatedly', 'function'],
  ['requestAnimationFrame', 'schedule before next paint', 'function'],
  ['getComputedStyle', 'computed style of an element', 'function'],
  ['matchMedia', 'media query match', 'function'],
  ['getSelection', 'current text selection', 'function'],
  ['structuredClone', 'deep clone a value', 'function'],
  ['URL', 'URL constructor', 'class'],
  ['URLSearchParams', 'query-string parsing', 'class'],
  ['Date', 'date constructor', 'class'],
  ['JSON', 'JSON helpers', 'variable'],
  ['Math', 'math helpers', 'variable'],
  ['Object', 'Object constructor', 'class'],
  ['Array', 'Array constructor', 'class'],
  ['Map', 'Map constructor', 'class'],
  ['Set', 'Set constructor', 'class'],
  ['Promise', 'Promise constructor', 'class'],
  ['RegExp', 'regex constructor', 'class'],
  ['Error', 'Error constructor', 'class'],
  ['console', 'console API', 'variable']
].map(([label, detail, type]) => ({ label, detail, type }));

// Console command-line helpers. `includeCommandLineAPI` makes these
// available in the page during evaluate; listing them teaches the user
// they exist on the first keystroke.
const CONSOLE_HELPERS = [
  ['$', 'last evaluated result', 'variable'],
  ['$$', 'querySelectorAll shorthand', 'function'],
  ['$x', 'XPath query shorthand', 'function'],
  ['$0', 'currently selected element', 'variable'],
  ['$1', 'previously selected element', 'variable'],
  ['$_', 'most recent evaluated value', 'variable'],
  ['inspect', 'open a value in DevTools', 'function'],
  ['clear', 'clear the console', 'function'],
  ['copy', 'copy a value to the clipboard', 'function'],
  ['keys', 'object keys', 'function'],
  ['values', 'object values', 'function'],
  ['debug', 'set a breakpoint on a function', 'function'],
  ['monitor', 'log calls to a function', 'function']
].map(([label, detail, type]) => ({ label, detail, type }));

const KEYWORDS = ['await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield'].map((label) => ({ label, type: 'keyword' }));

const JS_KEYWORDS = [
  ['async function', 'async function expression', 'keyword'],
  ['arrow function', 'arrow function expression', 'keyword'],
  ['class', 'class expression', 'keyword'],
  ['for loop', 'for loop', 'keyword'],
  ['function', 'function expression', 'keyword'],
  ['if', 'if statement', 'keyword'],
  ['try/catch', 'try/catch statement', 'keyword'],
  ['while', 'while loop', 'keyword']
].map(([label, detail, type]) => ({ label, detail, type }));

// ---- Element reference collection --------------------------------------
// Return candidate element globals from the inspected page. Querying
// `getElementById` over the *entire* document is O(n) but runs in the
// page and is capped, so the console stays responsive on huge pages.
const ELEMENT_REFS_EXPR = `(() => {
  const out = [];
  const ids = new Set();
  const push = (id) => { if (id && !ids.has(id)) { ids.add(id); out.push(id); } };
  for (const el of document.querySelectorAll('[id]')) push(el.id);
  for (const n of ['documentElement', 'head', 'body', 'title', 'activeElement']) {
    try { const el = document[n]; if (el && el.id) push(el.id); } catch {}
  }
  return out.slice(0, 300);
})()`;

// ---- Global completion source ------------------------------------------
function makeConsoleCompletionSource(getEval) {
  let globalsPromise = null;
  let globals = null;

  // Element references change as the page mutates, so they are cached
  // for a short window (2s) instead of forever — enough to avoid a CDP
  // round-trip on every keystroke, short enough to stay current.
  let refsCache = null;
  let refsCacheAt = 0;
  async function loadElementRefs() {
    const now = Date.now();
    if (refsCache && now - refsCacheAt < 2000) return refsCache;
    try {
      const r = await getEval('__mouaif_console_refs__', {
        expression: ELEMENT_REFS_EXPR,
        returnByValue: true,
        objectGroup: 'mouaif-console-refs'
      });
      const ids = r && r.result && r.result.value;
      refsCache = Array.isArray(ids) ? ids : [];
    } catch { refsCache = []; }
    refsCacheAt = Date.now();
    return refsCache;
  }

  function loadGlobals() {
    if (globalsPromise) return globalsPromise;
    globalsPromise = (async () => {
      try {
        const r = await getEval('__mouaif_console_globals__', {
          expression: '(typeof globalThis !== "undefined" ? Object.getOwnPropertyNames(globalThis) : [])',
          returnByValue: true,
          objectGroup: 'mouaif-console-globals'
        });
        const v = r && r.result && r.result.value;
        if (Array.isArray(v)) {
          globals = v
            .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
            .sort()
            .map((label) => ({ label, type: 'variable' }));
        }
      } catch { /* page may have gone away; fall back to static tables */ }
      if (!globals) globals = [];
      return globals;
    })();
    return globalsPromise;
  }

  // Property completion: given `document.` we ask the page for
  // `Object.getOwnPropertyNames(document)` and map them to
  // completions. Runs on demand, only when the user is in a property
  // position, so the CDP round-trip is not spent on every keystroke.
  async function completeProperty(baseText) {
    let r;
    try {
      r = await getEval('__mouaif_console_props__', {
        expression: '(() => { try { const o = (' + baseText + '); return { ok: true, desc: String(o), props: (o == null ? [] : Object.getOwnPropertyNames(Object(o))) }; } catch (e) { return { ok: false, desc: "", props: [] }; } })()',
        returnByValue: true,
        objectGroup: 'mouaif-console-props'
      });
    } catch { return []; }
    const v = r && r.result && r.result.value;
    if (!v || v.ok !== true || !Array.isArray(v.props)) return [];
    const desc = typeof v.desc === 'string' ? v.desc.slice(0, 40) : '';

    return v.props
      .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
      .slice(0, 250)
      .map((label) => ({
        label,
        type: 'property',
        detail: desc || undefined
      }));
  }

  return async function consoleCompletionSource(context) {
    const word = context.matchBefore(/[\w$]+$/);
    if (!word) {
      // Explicit (Ctrl-Space) at a bare position — show globals.
      if (context.explicit) {
        const g = await loadGlobals();
        return { from: context.pos, options: g.slice(0, 200), validFor: /^[\w$]*$/ };
      }
      return null;
    }

    // Property position: the token immediately before the word is a dot.
    const before = context.state.sliceDoc(Math.max(0, word.from - 1), word.from);
    if (before === '.') {
      const lineStart = context.state.doc.lineAt(context.pos).from;
      const base = context.state.sliceDoc(lineStart, word.from).replace(/\.$/, '').trim();
      const baseMatch = base.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
      if (baseMatch) {
        const options = await completeProperty(baseMatch[0]);
        if (!options.length) return null;
        return { from: word.from, options, validFor: /^[\w$]*$/ };
      }
    }

    const typed = word.text;

    // Merge: static browser globals + console helpers + live globals +
    // element references. Live globals are fetched once and filtered
    // by the typed prefix (case-insensitive like DevTools).
    const staticOptions = BROWSER_GLOBALS
      .concat(CONSOLE_HELPERS)
      .filter((c) => c.label.toLowerCase().startsWith(typed.toLowerCase()))
      .slice(0, 80);

    const g = await loadGlobals();
    const liveOptions = g
      .filter((c) => c.label.toLowerCase().startsWith(typed.toLowerCase()) && c.label !== typed)
      .slice(0, 120);

  const ids = await loadElementRefs();
  const elementOptions = ids
    .filter((id) => id.toLowerCase().startsWith(typed.toLowerCase()))
    .slice(0, 60)
    .map((id) => ({ label: id, type: 'variable', detail: '#' + id }));

    const options = [];
    const seen = new Set();
    for (const c of staticOptions.concat(liveOptions, elementOptions)) {
      if (seen.has(c.label)) continue;
      seen.add(c.label);
      options.push(c);
    }
    if (!options.length) return null;
    return { from: word.from, options: options.slice(0, 300), validFor: /^[\w$]*$/ };
  };
}

// ---- Component ---------------------------------------------------------
// props: { onEvaluate(expression), onRun, getEval }
//   getEval(description, params) -> Promise<CDP Runtime.evaluate result>
//   onEvaluate is called on Run; the result string returned is pushed
//   to the console log by the parent (via ConsolePanel's entry array).
export function JsConsole(props) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onEvaluateRef = useRef(props.onEvaluate);
  onEvaluateRef.current = props.onEvaluate;
  const getEvalRef = useRef(props.getEval);
  getEvalRef.current = props.getEval;

  useEffect(() => {
    if (!hostRef.current) return;

    const source = makeConsoleCompletionSource((desc, params) => {
      const get = getEvalRef.current;
      if (!get) return Promise.reject(new Error('no CDP connection'));
      return get(desc, params);
    });

  const runCode = (view) => {
    const code = view.state.doc.toString();
    if (!code || !code.trim()) return true;
    const onEval = onEvaluateRef.current;
    if (onEval) {
      try { onEval(code); } catch { /* ignore evaluation errors */ }
    }
    // Clear the input after a successful dispatch, matching the
    // DevTools REPL where the entry is consumed on Enter.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length }, selection: { anchor: 0 } });
    return true;
  };

    // Run on Enter. Shift-Enter inserts a newline, matching the real
    // DevTools console and the code editors in the rest of the app.
    const consoleKeymap = [
      {
        key: 'Enter',
        run: (view) => runCode(view),
        shift: (view) => {
          view.dispatch(view.state.replaceSelection('\n'));
          return true;
        }
      },
      indentWithTab,
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...historyKeymap,
      ...defaultKeymap
    ];

    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
      syntaxHighlighting(oneDarkHighlightStyle),
        keymap.of(consoleKeymap),
        autocompletion({
          override: [source],
          activateOnTyping: true,
          defaultKeymap: true,
          maxRenderedOptions: 40,
          tooltipClass: () => 'mouaif-console-autocomplete'
        }),
        closeBrackets(),
        javascript(),
        oneDark,
        EditorView.lineWrapping,
        placeholder('Evaluate JavaScript in the page…'),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-content': { padding: '8px 0', caretColor: '#528bff' },
          '.cm-gutters': { backgroundColor: '#282c34', borderRight: '1px solid #21252b' },
          '.cm-line': { padding: '0 8px' }
        })
      ]
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  return h('div', { class: 'inspector__jsconsole' },
    h('div', { class: 'inspector__jsconsole-bar' },
      h('span', { class: 'inspector__jsconsole-hint' }, 'Enter to run · Shift+Enter for newline · Ctrl+Space to autocomplete')
    ),
    h('div', { ref: hostRef, class: 'inspector__jsconsole-editor', 'aria-label': 'JavaScript console' })
  );
}
