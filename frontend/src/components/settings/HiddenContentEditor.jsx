import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, gutter, GutterMarker, Decoration, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { charSpanCount, describeChars, describeRanges, isValidCharSpan, lineIsSelected, normalizeChars, normalizeRanges, toggleChar, toggleLine } from './hiddenRanges.js';
import './hiddenContent.css';
// Retain only line numbers (never file content) across in-app navigation.
// Explicit Cancel/Save clears the draft; a reload clears this in-memory cache.
const drafts = new Map();
// Pick a CodeMirror language extension from a file path, mirroring the file
// editor so code previews highlight the same way. Unknown extensions fall
// back to a plain text buffer.
function langExtForPath(filePath) {
if (!filePath) return null;
const lower = filePath.toLowerCase();
const name = lower.split('/').pop() || lower;
if (name === 'dockerfile') return null; // plain text is fine
const ext = (name.match(/\.[a-z0-9]+$/) || [''])[0];
switch (ext) {
case '.js': case '.jsx': case '.mjs': case '.cjs':
return javascript({ jsx: ext === '.jsx' });
case '.ts': case '.tsx':
return javascript({ jsx: ext === '.tsx', typescript: true });
case '.html': case '.htm': case '.svg': case '.xml': case '.mdx':
return html();
case '.css': case '.scss': case '.sass': case '.less':
return css();
case '.json':
return json();
case '.md': case '.markdown':
return markdown();
case '.py':
return python();
default:
return null;
}
}
// Turn a pair of document offsets into the canonical character-span shape,
// clamped to the document. Shared by the editor-state path and the
// native-selection path so both produce identical spans.
function spanFromPositions(doc, from, to) {
const lo = Math.max(0, Math.min(from, to));
const hi = Math.min(doc.length, Math.max(from, to));
if (hi <= lo) return null;
const fromLine = doc.lineAt(lo);
const toLine = doc.lineAt(hi);
return {
startLine: fromLine.number,
endLine: toLine.number,
startCol: lo - fromLine.from + 1,
endCol: hi - toLine.from + 1
};
}
// Turn the editor's current selection into a character span, and report
// whether there is a non-empty selection at all. A selection that spans
// multiple lines hides from the first column on the start line through the
// last column on the end line (the middle lines are fully hidden).
function selectionInfo(view) {
const sel = view.state.selection.main;
if (sel.empty) return { hasSelection: false, span: null };
const span = spanFromPositions(view.state.doc, sel.from, sel.to);
return span ? { hasSelection: true, span } : { hasSelection: false, span: null };
}
// The browser's own selection, mapped to a span. CodeMirror only copies a
// native selection into its state while the content DOM is focused (its
// selectionchange observer bails out otherwise) and a long-press selection on
// a phone does not always leave it focused, so the editor state can lag behind
// what the user sees highlighted. Reading the live DOM range keeps the hide
// action working off the same text the user selected.
function domSelectionSpan(view) {
if (!view.root || typeof view.root.getSelection !== 'function') return null;
const sel = view.root.getSelection();
if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
const range = sel.getRangeAt(0);
if (!view.contentDOM.contains(range.startContainer) || !view.contentDOM.contains(range.endContainer)) return null;
try {
return spanFromPositions(
view.state.doc,
view.posAtDOM(range.startContainer, range.startOffset),
view.posAtDOM(range.endContainer, range.endOffset)
);
} catch (e) {
return null; // Selection rooted in a widget or an unmapped node.
}
}

// Build a read-only CodeMirror editor for a file with a toggle gutter.
// Everything CodeMirror-specific lives inside this factory so the module can
// be loaded (and the component rendered) in a harness without the runtime —
// the real editor is only created when this is called in the browser.
function createEditorEngine(doc, filePath, initialRanges, initialChars, onChange, onSelection, parent) {
const setHidden = StateEffect.define();
const setChars = StateEffect.define();
const hiddenRangesField = StateField.define({
create: () => initialRanges,
update(value, tr) {
for (const e of tr.effects) if (e.is(setHidden)) return e.value;
return value;
}
});
const hiddenCharsField = StateField.define({
create: () => initialChars,
update(value, tr) {
for (const e of tr.effects) if (e.is(setChars)) return e.value;
return value;
}
});

  // A check / empty marker rendered in the toggle gutter for one line.
  class HideToggleMarker extends GutterMarker {
    constructor(selected) { super(); this.selected = selected; }
    eq(other) { return other instanceof HideToggleMarker && other.selected === this.selected; }
    toDOM() {
      const el = document.createElement('span');
      el.className = 'hc__toggle-marker';
      el.textContent = this.selected ? '✓' : '+';
      el.setAttribute('aria-hidden', 'true');
      return el;
    }
  }

  // Highlight every line covered by the marked ranges. Ranges are clamped to
// the document so a stale rule (file shrunk since it was saved) never throws.
const lineDecorations = EditorView.decorations.compute(
[hiddenRangesField],
(state) => {
const deco = [];
const docLines = state.doc.lines;
for (const { start, end } of state.field(hiddenRangesField)) {
if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
const from = start, to = Math.min(end, docLines);
for (let n = from; n <= to; n++) {
deco.push(Decoration.line({ class: 'hc__line-hidden' }).range(state.doc.line(n).from));
}
}
return Decoration.set(deco, true);
}
);
// Highlight the exact characters covered by the marked char spans. Each
// span is broken into per-line pieces (a multi-line span hides the full
// middle lines and partial boundary lines) and mapped to document offsets,
// clamped to the line so a stale span never throws.
const charDecorations = EditorView.decorations.compute(
[hiddenCharsField],
(state) => {
const deco = [];
for (const span of state.field(hiddenCharsField)) {
if (!isValidCharSpan(span)) continue;
const doc = state.doc;
const startLine = Math.max(1, span.startLine);
const endLine = Math.min(doc.lines, span.endLine);
if (startLine > endLine) continue;
for (let n = startLine; n <= endLine; n++) {
const line = doc.line(n);
let from, to;
if (span.startLine === span.endLine) {
from = Math.min(span.startCol - 1, line.length);
to = Math.min(span.endCol, line.length);
} else if (n === span.startLine) {
from = Math.min(span.startCol - 1, line.length);
to = line.length;
} else if (n === span.endLine) {
from = 0;
to = Math.min(span.endCol, line.length);
} else {
from = 0;
to = line.length;
}
if (to <= from) continue;
deco.push(Decoration.mark({ class: 'hc__char-hidden' }).range(line.from + from, line.from + to));
}
}
return Decoration.set(deco, true);
}
);

  const toggleGutter = gutter({
class: 'hc__toggle',
lineMarker(view, block) {
const number = view.state.doc.lineAt(block.from).number;
return new HideToggleMarker(lineIsSelected(view.state.field(hiddenRangesField), number));
},
lineMarkerChange(update) {
return update.docChanged ||
update.transactions.some((tr) => tr.effects.some((e) => e.is(setHidden)));
},
domEventHandlers: {
click(view, block) {
const number = view.state.doc.lineAt(block.from).number;
const next = toggleLine(view.state.field(hiddenRangesField), number);
view.dispatch({ effects: setHidden.of(next) });
onChange(next);
return true;
}
}
});
const state = EditorState.create({
doc,
extensions: [
hiddenRangesField,
hiddenCharsField,
lineNumbers(),
highlightActiveLine(),
highlightActiveLineGutter(),
toggleGutter,
lineDecorations,
charDecorations,
syntaxHighlighting(oneDarkHighlightStyle),
// Keep the DOM selectable (so text can be selected and then hidden) while
// still preventing edits. `readOnly` leaves `contenteditable` on the content
// DOM, so mouse AND mobile/touch selection keep working; it only blocks the
// user-input edit pipeline, not programmatic dispatch (which is all the
// gutter toggle and char spans need). `EditorView.editable.of(false)` would
// set `contenteditable="false"`, which breaks touch text selection on mobile.
EditorState.readOnly.of(true),
EditorView.lineWrapping,
...(langExtForPath(filePath) ? [langExtForPath(filePath)] : []),
oneDark
]
});
const view = new EditorView({ state, parent });
// One reporting path for both sources: whatever the browser shows as
// selected wins, the editor state is the fallback.
function reportSelection() {
const span = domSelectionSpan(view) || selectionInfo(view).span;
onSelection(span ? { hasSelection: true, span } : { hasSelection: false, span: null });
}
view.dispatch({
effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
if (update.selectionSet || update.docChanged) reportSelection();
}))
});
const ownerDoc = view.dom.ownerDocument;
ownerDoc.addEventListener('selectionchange', reportSelection);
requestAnimationFrame(() => { if (!view.dom.isConnected) return; view.requestMeasure(); });
reportSelection();
return {
view, setHidden, setChars, hiddenRangesField, hiddenCharsField,
// The highlighted range right now, without waiting for a re-render.
selectionSpan: () => domSelectionSpan(view) || selectionInfo(view).span,
destroy() {
ownerDoc.removeEventListener('selectionchange', reportSelection);
view.destroy();
}
};
}

export function HiddenContentEditor({ projectDir, filePath, initialRule, onSave, onClose }) {
const draftKey = JSON.stringify([projectDir, filePath]);
const initialRanges = (initialRule && Array.isArray(initialRule.ranges)) ? initialRule.ranges.map((r) => ({ ...r })) : [];
const initialChars = (initialRule && Array.isArray(initialRule.chars)) ? initialRule.chars.map((c) => ({ ...c })) : [];
const draft = drafts.get(draftKey);
const [ranges, setRanges] = useState(() => (draft ? (draft.ranges || []) : initialRanges));
const [chars, setChars] = useState(() => (draft ? (draft.chars || []) : initialChars));
const [sel, setSel] = useState({ hasSelection: false, span: null });
const [preview, setPreview] = useState({ loading: true, content: null, error: '' });
const [reload, setReload] = useState(0);
const [error, setError] = useState('');
const [saving, setSaving] = useState(false);
const savingRef = useRef(false);
const mounted = useRef(true);
const heading = useRef(null);
const editorHost = useRef(null);
const engineRef = useRef(null);
// The "Hide selected text" button captures the editor span on pointerdown
// (before it steals focus and collapses the selection), so a real tap still
// has the text that was highlighted rather than an empty cursor.
const hideSpanRef = useRef(null);
// Timestamp of a pointerdown that already applied the toggle, so the click
// that follows it does not undo it.
const pointerActedAt = useRef(0);
const dirty = JSON.stringify(ranges) !== JSON.stringify(initialRanges) || JSON.stringify(chars) !== JSON.stringify(initialChars);
let normalized = [], validation = '';
try { normalized = normalizeRanges(ranges); } catch (e) { validation = e.message; }
const count = normalized.reduce((n, r) => n + r.end - r.start + 1, 0);
const charCount = normalizeChars(chars).length;
const selectionSummary = (count ? `${count} ${count === 1 ? 'line' : 'lines'}` : '')
+ (count && charCount ? ', ' : '')
+ (charCount ? `${charCount} ${charCount === 1 ? 'char range' : 'char ranges'}` : '')
|| 'No content selected';

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
  if (dirty) drafts.set(draftKey, { ranges, chars });
  else drafts.delete(draftKey);
  }, [draftKey, ranges, chars, dirty]);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const controller = new AbortController();
    setPreview({ loading: true, content: null, error: '' });
    fetchJson('/api/file?' + new URLSearchParams({ projectDir, path: filePath }), { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.status !== 200 || typeof r.body.content !== 'string') {
          throw new Error(r.body?.code === 'ETOOLARGE' ? 'File exceeds the 1 MiB preview limit.' : 'Could not preview this file. It may be missing or unreadable.');
        }
        setPreview({ loading: false, content: r.body.content, error: '' });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setPreview({ loading: false, content: null, error: e.message });
      });
    return () => controller.abort();
  }, [projectDir, filePath, reload]);

  // Load the file into the read-only editor once the body arrives.
  useEffect(() => {
    if (!editorHost.current || preview.content === null) return;
    if (engineRef.current) { engineRef.current.destroy(); engineRef.current = null; }
    let seed = [];
    try { seed = normalizeRanges(ranges); } catch (e) { seed = []; }
    const engine = createEditorEngine(preview.content, filePath, seed, chars, (next) => { setError(''); setRanges(next); }, (info) => setSel(info), editorHost.current);
    engineRef.current = engine;
    return () => { if (engineRef.current) { engineRef.current.destroy(); engineRef.current = null; } };
    // Rebuild only when a new file body is loaded; the gutter reads live
    // ranges through the field, so no rebuild is needed on toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.content]);

  // Push React state (manual range edits, gutter clicks, text selection)
  // into the editor so the gutter and inline highlight stay in sync without
  // re-creating the view.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    let next = [];
    try { next = normalizeRanges(ranges); } catch (e) { next = []; }
    engine.view.dispatch({ effects: [engine.setHidden.of(next), engine.setChars.of(normalizeChars(chars))] });
  }, [ranges, chars]);

  // Toggle a character span for the current text selection. Called from the
  // "Hide selected text" action; a non-empty selection adds (or removes, on
  // a second tap) a char span, updating the inline highlight and the footer.
  // The span is resolved from the editor itself — the browser's live selection
  // first — because a tap collapses the editor selection before the click
  // handler runs, and CodeMirror may never have mirrored a touch selection.
  function currentSpan() {
    const live = engineRef.current ? engineRef.current.selectionSpan() : null;
    return live || (sel.hasSelection ? sel.span : null);
  }
  function hideSpan(span) {
    if (!span) return false;
    setError('');
    setChars(toggleChar(chars, span));
    return true;
  }
  // Act on pointerdown: on touch the same tap dismisses the active selection,
  // and a browser may swallow the click that follows it, which left the
  // highlighted text unhidden. The click handler below stays for keyboard and
  // assistive-technology activation and skips a click this already handled.
  function onHidePointerDown(event) {
    if (event && event.button > 0) return;
    const span = currentSpan();
    hideSpanRef.current = span;
    if (hideSpan(span)) pointerActedAt.current = Date.now();
  }
  function onHideClick() {
    if (pointerActedAt.current && Date.now() - pointerActedAt.current < 1000) {
    pointerActedAt.current = 0;
    return;
  }
    pointerActedAt.current = 0;
    hideSpan(currentSpan() || hideSpanRef.current);
  }

  function onRangeField(index, field, value) {
    setError('');
    setRanges(ranges.map((range, i) => i === index ? { ...range, [field]: value } : range));
  }
  function onBack() {
    if (!savingRef.current) onClose(); // Keep an unsaved draft for a return visit.
  }
  function onCancel() {
    if (savingRef.current || (dirty && !window.confirm('Discard your unsaved line selection?'))) return;
    drafts.delete(draftKey);
    onClose();
  }
  async function onSubmit(event) {
  event.preventDefault();
  if (savingRef.current) return;
  let next;
  try { next = normalizeRanges(ranges); } catch (e) { setError(e.message); return; }
  const hasAny = next.length || normalizeChars(chars).length;
  const hadAny = initialRanges.length || initialChars.length;
  if (!hasAny && hadAny && !window.confirm('Stop hiding content in this file?')) return;
  savingRef.current = true;
  setSaving(true);
  setError('');
  try {
  await onSave(filePath, { ranges: next, chars: normalizeChars(chars) });
  const draftVal = drafts.get(draftKey);
if (draftVal && draftVal.ranges === ranges && draftVal.chars === chars) drafts.delete(draftKey);
  if (mounted.current) onClose();
  } catch (e) {
  if (mounted.current) setError((e.message || 'Could not save.') + ' Your selection is kept; you can retry.');
  } finally {
  savingRef.current = false;
  if (mounted.current) setSaving(false);
  }
  }

  return h(Fragment, null,
    h('div', { class: 'view-head hidden-content__head' },
      h('button', { class: 'view-back', type: 'button', disabled: saving, onClick: onBack, 'aria-label': 'Back to hidden files' }, '←'),
      h('h2', { class: 'view-title', tabIndex: -1, ref: heading }, 'Select hidden lines')
    ),
    h('form', { class: 'hidden-content', onSubmit, noValidate: true },
      h('p', { class: 'hidden-content__path' }, filePath),
      h('p', { class: 'hidden-content__intro' }, 'Tap a line number in the left gutter to hide the whole line, or drag to select text and hide just that span. Either way, the redacted text is replaced with [hidden] for the agent file tools.'),
      h('p', { class: 'hidden-content__scope' }, 'Only read_file and search_files are filtered—not shell, MCP, or other access. This preview shows the original file to you; saving does not edit it.'),
      h('fieldset', { class: 'hidden-content__fields', disabled: saving },
        h('legend', { class: 'hidden-content__sr-only' }, 'Hidden line selection'),
        preview.loading ? h('p', { role: 'status' }, 'Loading file preview…')
          : preview.error ? h('div', { class: 'hidden-content__preview-error' },
              h('p', { role: 'alert' }, preview.error + ' You can still edit ranges manually.'),
              h('button', { class: 'btn', type: 'button', onClick: () => setReload((n) => n + 1) }, 'Retry preview')
            )
          : h(Fragment, null,
              h('div', { class: 'hidden-content__editor', ref: editorHost, role: 'region', 'aria-label': 'Numbered file content', 'aria-describedby': 'hidden-content-editor-help' }),
              h('div', { class: 'hidden-content__toolbar' },
              h('p', { id: 'hidden-content-editor-help', class: 'hidden-content__muted' }, 'Tap a line in the gutter to hide or show it, or drag to select text and tap Hide selected text in the footer. The file is read-only.')
              )
            ),
        h('details', { class: 'hidden-content__manual', open: !!preview.error },
          h('summary', null, 'Enter line ranges manually'),
          h('p', { class: 'hidden-content__muted' }, 'From and To are inclusive. Use the same number to hide one line.'),
          ranges.map((range, index) => h('div', { class: 'hidden-content__range', key: index },
            ...['start', 'end'].map((field) => h('label', { key: field }, field === 'start' ? 'From' : 'To',
              h('input', {
                class: 'input', type: 'number', min: 1, step: 1,
                'aria-label': `${field === 'start' ? 'From' : 'To'} line for range ${index + 1}`,
                value: range[field], onInput: (e) => onRangeField(index, field, e.target.value)
              })
            )),
            h('button', { class: 'btn', type: 'button', 'aria-label': `Remove range ${index + 1}`, onClick: () => { setError(''); setRanges(ranges.filter((_, i) => i !== index)); } }, '×')
          )),
          h('button', { class: 'btn', type: 'button', onClick: () => {
            const start = normalized.length ? normalized[normalized.length - 1].end + 1 : 1;
            setRanges([...ranges, { start, end: start }]);
          } }, '+ Add range')
        ),
        validation && h('p', { class: 'hidden-content__error', role: 'alert' }, validation)
      ),
      h('footer', { class: 'hidden-content__footer' },
        h('div', { class: 'hidden-content__selection', role: 'status' },
          h('strong', null, selectionSummary),
          h('span', { class: 'hidden-content__muted' }, validation ? 'Fix the range values to continue.' : (describeRanges(normalized) + (chars.length ? ' · ' + describeChars(normalizeChars(chars)) : ''))),
          dirty && h('span', { class: 'hidden-content__muted' }, 'Unsaved selection')
        ),
        error && h('p', { class: 'hidden-content__error', role: 'alert' }, error),
        h('div', { class: 'hidden-content__actions' },
        h('button', {
        class: 'btn hidden-content__hide-action', type: 'button',
        disabled: saving || !sel.hasSelection,
        onPointerDown: onHidePointerDown,
        onClick: onHideClick,
        'aria-label': 'Hide selected text',
        'aria-describedby': 'hidden-content-editor-help'
        }, 'Hide selected text'),
        h('button', { class: 'btn', type: 'button', disabled: saving, onClick: onCancel }, 'Cancel'),
        h('button', { class: 'btn btn--primary', type: 'submit', disabled: saving || !!validation || (!dirty && !initialRanges.length) }, saving ? 'Saving…' : 'Save')
        )
      )
    )
  );
}
