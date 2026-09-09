import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { describeRanges, lineIsSelected, normalizeRanges, toggleLine } from './hiddenRanges.js';

// Retain only line numbers (never file content) across in-app navigation.
// Explicit Cancel/Save clears the draft; a reload clears this in-memory cache.
const drafts = new Map();
const PAGE_SIZE = 100;

export function HiddenContentEditor({ projectDir, filePath, initialRanges, onSave, onClose }) {
  const draftKey = JSON.stringify([projectDir, filePath]);
  const [ranges, setRanges] = useState(() => drafts.get(draftKey) || initialRanges.map((r) => ({ ...r })));
  const [preview, setPreview] = useState({ loading: true, content: null, error: '' });
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState('');
  const [jumpTarget, setJumpTarget] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const heading = useRef(null);
  const viewer = useRef(null);
  const dirty = JSON.stringify(ranges) !== JSON.stringify(initialRanges);
  const lines = useMemo(() => preview.content === null ? [] : preview.content.split('\n'), [preview.content]);
  const pageCount = Math.max(1, Math.ceil(lines.length / PAGE_SIZE));
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
        setPage(0);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setPreview({ loading: false, content: null, error: e.message });
      });
    return () => controller.abort();
  }, [projectDir, filePath, reload]);
  useEffect(() => { if (viewer.current) viewer.current.scrollTop = 0; }, [page]);
  useEffect(() => {
    if (jumpTarget === null) return;
    const line = viewer.current?.querySelector(`[data-line="${jumpTarget}"]`);
    if (line) {
      line.focus({ preventScroll: true });
      const offset = line.getBoundingClientRect().top - viewer.current.getBoundingClientRect().top;
      viewer.current.scrollTop += offset;
    }
    setJumpTarget(null);
  }, [page, jumpTarget]);

  function onChange(next) { setError(''); setRanges(next); }
  function onRangeField(index, field, value) {
    onChange(ranges.map((range, i) => i === index ? { ...range, [field]: value } : range));
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
      // A user can still use browser Back during a request. Do not pull
      // them back from another screen or delete a newer draft on return.
      if (drafts.get(draftKey) === ranges) drafts.delete(draftKey);
      if (mounted.current) onClose();
      } catch (e) {
      if (mounted.current) setError((e.message || 'Could not save.') + ' Your selection is kept; you can retry.');
      } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
      }
  }
  function onJump() {
    const line = Number(jump);
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
      setError(`Choose a line between 1 and ${lines.length}.`);
      return;
    }
    setPage(Math.floor((line - 1) / PAGE_SIZE));
    setJumpTarget(line);
    setError('');
  }

  return h(Fragment, null,
    h('div', { class: 'view-head hidden-content__head' },
      h('button', { class: 'view-back', type: 'button', disabled: saving, onClick: onBack, 'aria-label': 'Back to hidden files' }, '←'),
      h('h2', { class: 'view-title', tabIndex: -1, ref: heading }, 'Select hidden lines')
    ),
    h('form', { class: 'hidden-content', onSubmit, noValidate: true },
      h('p', { class: 'hidden-content__path' }, filePath),
      h('p', { class: 'hidden-content__intro' }, 'Tap a line to hide it; tap again to show it. Highlighted lines will be replaced with [hidden] for the agent file tools.'),
      h('p', { class: 'hidden-content__scope' }, 'Only read_file and search_files are filtered—not shell, MCP, or other access. This preview shows the original file to you; saving does not edit it.'),
      h('fieldset', { class: 'hidden-content__fields', disabled: saving },
        h('legend', { class: 'hidden-content__sr-only' }, 'Hidden line selection'),
        preview.loading ? h('p', { role: 'status' }, 'Loading file preview…')
          : preview.error ? h('div', { class: 'hidden-content__preview-error' },
            h('p', { role: 'alert' }, preview.error + ' You can still edit ranges manually.'),
            h('button', { class: 'btn', type: 'button', onClick: () => setReload((n) => n + 1) }, 'Retry preview')
          ) : h(Fragment, null,
            h('p', { class: 'hidden-content__muted' }, `Original file · ${lines.length} lines`),
            h('div', { class: 'hidden-content__viewer', ref: viewer, role: 'region', 'aria-label': 'Numbered file content' },
              lines.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((text, index) => {
                const line = page * PAGE_SIZE + index + 1;
                const selected = lineIsSelected(normalized, line);
                return h('button', {
                  key: line, type: 'button', class: 'hidden-content__line', 'data-line': line,
                  'aria-pressed': selected, 'aria-label': `${selected ? 'Show' : 'Hide'} line ${line}`,
                  'aria-describedby': `hidden-content-line-${line}`,
                  disabled: !!validation,
                  onClick: () => onChange(toggleLine(ranges, line))
                },
                  h('span', { class: 'hidden-content__line-number', 'aria-hidden': 'true' }, line),
                  h('code', { id: `hidden-content-line-${line}` }, text || ' '),
                  h('span', { class: 'hidden-content__line-mark', 'aria-hidden': 'true' }, selected ? '✓' : '+')
                );
              })
            ),
            pageCount > 1 && h('div', { class: 'hidden-content__pagination' },
              h('button', { class: 'btn', type: 'button', disabled: page === 0, onClick: () => setPage((p) => p - 1) }, 'Previous'),
              h('span', { role: 'status' }, `${page + 1} / ${pageCount}`),
              h('button', { class: 'btn', type: 'button', disabled: page >= pageCount - 1, onClick: () => setPage((p) => p + 1) }, 'Next'),
              h('label', null, 'Go to line', h('input', {
                class: 'input', type: 'number', min: 1, max: lines.length, step: 1, value: jump,
                onInput: (e) => setJump(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onJump(); } }
              })),
              h('button', { class: 'btn', type: 'button', onClick: onJump }, 'Go')
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
            h('button', { class: 'btn', type: 'button', 'aria-label': `Remove range ${index + 1}`, onClick: () => onChange(ranges.filter((_, i) => i !== index)) }, '×')
          )),
          h('button', { class: 'btn', type: 'button', onClick: () => {
            const start = normalized.length ? normalized[normalized.length - 1].end + 1 : 1;
            onChange([...ranges, { start, end: start }]);
          } }, '+ Add range')
        ),
        h('p', { class: 'hidden-content__muted' }, 'Rules follow line numbers, not text. Review them after editing the file.'),
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
