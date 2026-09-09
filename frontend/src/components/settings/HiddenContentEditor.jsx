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
import { describeRanges, lineIsSelected, normalizeRanges, toggleLine } from './hiddenRanges.js';
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
// Build a read-only CodeMirror editor for a file with a toggle gutter.
// Everything CodeMirror-specific lives inside this factory so the module can
// be loaded (and the component rendered) in a harness without the runtime —
// the real editor is only created when this is called in the browser.
function createEditorEngine(doc, filePath, initialRanges, onChange, parent) {
const setHidden = StateEffect.define();
const hiddenRangesField = StateField.define({
    create: () => initialRanges,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setHidden)) return e.value;
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
lineNumbers(),
highlightActiveLine(),
highlightActiveLineGutter(),
toggleGutter,
lineDecorations,
syntaxHighlighting(oneDarkHighlightStyle),
EditorState.readOnly.of(true),
EditorView.lineWrapping,
...(langExtForPath(filePath) ? [langExtForPath(filePath)] : []),
oneDark
]
});
  const view = new EditorView({ state, parent });
  requestAnimationFrame(() => { if (!view.dom.isConnected) return; view.requestMeasure(); });
  return { view, setHidden, hiddenRangesField };
}

export function HiddenContentEditor({ projectDir, filePath, initialRanges, onSave, onClose }) {
  const draftKey = JSON.stringify([projectDir, filePath]);
  const [ranges, setRanges] = useState(() => drafts.get(draftKey) || initialRanges.map((r) => ({ ...r })));
  const [preview, setPreview] = useState({ loading: true, content: null, error: '' });
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const heading = useRef(null);
  const editorHost = useRef(null);
  const engineRef = useRef(null);
  const dirty = JSON.stringify(ranges) !== JSON.stringify(initialRanges);
  let normalized = [], validation = '';
  try { normalized = normalizeRanges(ranges); } catch (e) { validation = e.message; }
  const count = normalized.reduce((n, r) => n + r.end - r.start + 1, 0);

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (dirty) drafts.set(draftKey, ranges);
    else drafts.delete(draftKey);
  }, [draftKey, ranges, dirty]);

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
    if (engineRef.current) { engineRef.current.view.destroy(); engineRef.current = null; }
    let seed = [];
    try { seed = normalizeRanges(ranges); } catch (e) { seed = []; }
    const engine = createEditorEngine(preview.content, filePath, seed, (next) => { setError(''); setRanges(next); }, editorHost.current);
    engineRef.current = engine;
    return () => { if (engineRef.current) { engineRef.current.view.destroy(); engineRef.current = null; } };
    // Rebuild only when a new file body is loaded; the gutter reads live
    // ranges through the field, so no rebuild is needed on toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.content]);

  // Push React state (manual range edits, gutter clicks) into the editor.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    let next = [];
    try { next = normalizeRanges(ranges); } catch (e) { next = []; }
    engine.view.dispatch({ effects: engine.setHidden.of(next) });
  }, [ranges]);

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
    if (!next.length && initialRanges.length && !window.confirm('Stop hiding all lines in this file?')) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(filePath, next);
      if (drafts.get(draftKey) === ranges) drafts.delete(draftKey);
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
      h('p', { class: 'hidden-content__intro' }, 'Tap a line number in the left gutter to hide it; tap again to show it. Highlighted lines are replaced with [hidden] for the agent file tools.'),
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
              h('p', { id: 'hidden-content-editor-help', class: 'hidden-content__muted' }, 'Tap a line in the gutter to hide or show it. The text is read-only.')
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
          h('strong', null, count ? `${count} ${count === 1 ? 'line' : 'lines'} selected` : 'No lines selected'),
          h('span', { class: 'hidden-content__muted' }, validation ? 'Fix the range values to continue.' : describeRanges(normalized)),
          dirty && h('span', { class: 'hidden-content__muted' }, 'Unsaved selection')
        ),
        error && h('p', { class: 'hidden-content__error', role: 'alert' }, error),
        h('div', { class: 'hidden-content__actions' },
          h('button', { class: 'btn', type: 'button', disabled: saving, onClick: onCancel }, 'Cancel'),
          h('button', { class: 'btn btn--primary', type: 'submit', disabled: saving || !!validation || (!dirty && !initialRanges.length) }, saving ? 'Saving…' : 'Save')
        )
      )
    )
  );
}
