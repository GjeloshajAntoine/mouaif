// mouaif web — Settings → Project → Tool wording (its own page)
//
// Named wording sets for the tools the model is told about
// (docs/features/tool-overrides.md). One picker lists Built-in (the read-only
// wording every tool ships with) and the project's sets; whatever is picked
// is shown below it, with its tools. + New copies the picked entry (or starts
// empty), and one entry is the default for the project's chats. A set holds
// replacement descriptions and replacement names for a tool's top-level fields.
//
// Everything edits a draft; nothing is written until Save in the bar at the
// bottom. Nothing here changes what a tool does — the server renames a call's
// fields back before it runs.
import { h, Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { sectionIcon } from './settingsProjectUi.js';
import { settingsLink, backHref, backTarget } from './settings/projectNavigation.js';
import {
  LEGACY_SET_ID, MAX_DESCRIPTION_CHARS, MAX_SETS, MAX_SET_NAME, changedTools, diffStats, diffWords, differsFromBuiltIn,
  effectiveEntry, exportText, fieldList, fieldProblem, initialSelection, newSetId, newSetTools, normalizeWording,
  parseImport, renameProblems, searchTools, selectionAfterDelete, uniqueSetName, wordingChanges, wordingFromResolved
} from './settings/toolOverrides.js';

const BUILTIN = '';

// diffSpans(parts, keep) -> the diff as inline spans; `keep` filters the ops a
// column shows (the left column hides insertions, the right one deletions).
function diffSpans(parts, keep) {
  return parts.filter((p) => keep.includes(p.op)).map((p, i) => (
    p.op === 'same' ? p.text
      : h(p.op === 'ins' ? 'ins' : 'del', { key: i, class: 'tool-ov__' + p.op }, p.text)
  ));
}

function DiffColumns({ left, right, leftLabel, rightLabel }) {
  const parts = useMemo(() => (left === right ? null : diffWords(left, right)), [left, right]);
  const stats = useMemo(() => (parts ? diffStats(parts) : null), [parts]);
  return h(Fragment, null,
    h('div', { class: 'tool-ov__compare' },
      h('div', { class: 'tool-ov__col' },
        h('div', { class: 'tool-ov__col-title' }, leftLabel),
        h('p', { class: 'tool-ov__text' }, parts ? diffSpans(parts, ['same', 'del']) : (left || '—'))
      ),
      h('div', { class: 'tool-ov__col tool-ov__col--sent' },
        h('div', { class: 'tool-ov__col-title' }, rightLabel),
        h('p', { class: 'tool-ov__text' }, parts ? diffSpans(parts, ['same', 'ins']) : (right || '—'))
      )
    ),
    h('div', { class: 'settings-project__item-note' },
      stats ? '+' + stats.added + ' −' + stats.removed + ' words' : 'Same text.')
  );
}

// The description of one tool inside the set being edited. A tool the set
// has no description for uses the built-in text; Copy built-in text / Start
// blank add one. `editing` keeps a just-started blank box open.
function SetDescription({ tool, value, onChange }) {
  const builtIn = tool.description || '';
  const [editing, setEditing] = useState(!!value);
  const area = useRef(null);
  const focusNext = useRef(false);
  const parts = useMemo(() => (value && value !== builtIn ? diffWords(builtIn, value) : []), [builtIn, value]);
  const stats = useMemo(() => diffStats(parts), [parts]);
  const showBox = editing || !!value;

  // Grow with the text (capped by CSS), so long descriptions read without a
  // tiny scroll box; focus the box right after it is added.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
    if (focusNext.current) { focusNext.current = false; el.focus(); }
  }, [value, showBox]);

  function start(text) {
    focusNext.current = true;
    setEditing(true);
    onChange(text);
  }

  if (!showBox) {
    return h('div', { class: 'tool-ov__descbox' },
      h('span', { class: 'settings-project__item-title' }, 'Description'),
      h('div', { class: 'settings-project__item-note' }, 'Not in this set — the built-in description is sent, and follows built-in updates.'),
      h('div', { class: 'tool-ov__create' },
        builtIn ? h('button', { class: 'btn btn--primary', type: 'button', onClick: () => start(builtIn) }, 'Copy built-in text') : null,
        h('button', { class: 'btn', type: 'button', onClick: () => start('') }, builtIn ? 'Start blank' : 'Write a description')
      )
    );
  }

  const note = !value.trim()
    ? 'Empty — the built-in description is sent until you type one.'
    : value.trim() === builtIn.trim() ? 'Same as built-in today (a frozen copy).' : '+' + stats.added + ' −' + stats.removed + ' words vs built-in';

  return h('div', { class: 'tool-ov__descbox' },
    h('label', { class: 'settings-project__item-title', for: 'to-d-' + tool.name }, 'Description'),
    h('textarea', {
      ref: area,
      class: 'input settings-project__mono tool-ov__desc tool-ov__desc--grow',
      id: 'to-d-' + tool.name,
      rows: 4,
      maxLength: MAX_DESCRIPTION_CHARS,
      spellcheck: false,
      placeholder: 'Describe the tool for the model.',
      value,
      onInput: (e) => onChange(e.currentTarget.value),
      'aria-label': 'Description of ' + tool.name + ' in this set'
    }),
    h('div', { class: 'tool-ov__descfoot' },
      h('span', { class: 'settings-project__item-note' }, note),
      h('span', { class: 'tool-ov__count' + (value.length >= MAX_DESCRIPTION_CHARS ? ' tool-ov__count--full' : '') },
        value.length + ' / ' + MAX_DESCRIPTION_CHARS)
    ),
    h('div', { class: 'tool-ov__actions tool-ov__actions--plain' },
      h('button', { class: 'btn', type: 'button', onClick: () => { setEditing(false); onChange(''); } }, 'Reset to built-in')
    )
  );
}

// A tool's fields: read-only (Built-in), a rename box each (a set), or the
// name on each side (Compare).
function FieldList({ tool, fields, mode, renames, left, right }) {
  if (!fields.length) return h('div', { class: 'settings-project__item-note' }, 'This tool takes no fields.');
  const properties = {};
  for (const f of fields) properties[f.name] = true;
  return h(Fragment, null,
    h('div', { class: 'settings-project__item-title tool-ov__fields-title' }, 'Field names'),
    mode === 'set' ? h('div', { class: 'settings-project__item-note' }, 'Type a new name to rename a field; leave it empty to keep the original.') : null,
    h('ul', { class: 'tool-ov__fields' }, fields.map((f) => {
      const value = (mode === 'set' && renames.fields[f.name]) || '';
      const problem = mode === 'set' ? fieldProblem(f.name, value, properties, renames.fields) : '';
      const a = mode === 'compare' ? (left[f.name] || f.name) : '';
      const b = mode === 'compare' ? (right[f.name] || f.name) : '';
      return h('li', { key: f.name, class: 'tool-ov__field' },
        h('div', { class: 'tool-ov__field-head' },
          mode === 'compare'
            ? (a === b
              ? h(Fragment, null, h('code', null, a), h('span', { class: 'tool-ov__type' }, 'same'))
              : h(Fragment, null, h('code', { class: 'tool-ov__del' }, a), h('span', { 'aria-hidden': 'true' }, '→'), h('code', { class: 'tool-ov__ins' }, b)))
            : h('code', null, f.name),
          f.type ? h('span', { class: 'tool-ov__type' }, f.type) : null,
          f.required ? h('span', { class: 'tool-ov__type' }, 'required') : null
        ),
        f.description && mode !== 'compare' ? h('div', { class: 'settings-project__item-note' }, f.description) : null,
        mode === 'set'
          ? h('input', {
            class: 'input settings-project__mono',
            type: 'text',
            value,
            placeholder: f.name,
            autocapitalize: 'off',
            autocomplete: 'off',
            spellcheck: false,
            'aria-label': 'Custom name for field ' + f.name + ' of ' + tool.name,
            'aria-invalid': problem ? 'true' : undefined,
            onInput: (e) => renames.set(f.name, e.currentTarget.value)
          })
          : null,
        problem ? h('div', { class: 'settings-project__item-status', 'data-state': 'error', role: 'alert' }, problem) : null
      );
    }))
  );
}

// One tool row. `mode` is 'builtin' (read-only), 'set' (edit `entry` in the
// set on screen) or 'compare' (`left` vs `right` entries). `open` lives on the
// page so a revert or discard, which remounts the row, keeps it open.
function ToolRow({ tool, mode, entry, left, right, leftLabel, rightLabel, badge, dirty, open, onToggle, onChange, onRevert }) {
  const fields = useMemo(() => fieldList(tool), [tool]);
  const current = entry || {};
  const renameMap = current.fields || {};

  function setDescription(value) {
    onChange(tool.name, { description: value, fields: renameMap });
  }
  function setField(original, value) {
    const next = Object.assign({}, renameMap);
    if (value) next[original] = value; else delete next[original];
    onChange(tool.name, { description: current.description || '', fields: next });
  }

  let body = null;
  if (open) {
    const description = mode === 'builtin'
      ? h('div', { class: 'tool-ov__descbox' },
        h('span', { class: 'settings-project__item-title' }, 'Description'),
        h('p', { class: 'tool-ov__text tool-ov__diff' }, tool.description || 'No built-in description.'))
      : mode === 'set'
        ? h(SetDescription, { tool, value: current.description || '', onChange: setDescription })
        : h('div', { class: 'tool-ov__descbox' },
          h('span', { class: 'settings-project__item-title' }, 'Description'),
          h(DiffColumns, {
            left: effectiveEntry(tool, left).description,
            right: effectiveEntry(tool, right).description,
            leftLabel,
            rightLabel
          }));
    body = h('div', { class: 'tool-ov__body' },
      description,
      h(FieldList, {
        tool,
        fields,
        mode,
        renames: { fields: renameMap, set: setField },
        left: (left && left.fields) || {},
        right: (right && right.fields) || {}
      }),
      mode === 'set' && (dirty || entry)
        ? h('div', { class: 'settings-project__item-actions' },
          dirty ? h('button', { class: 'btn', type: 'button', onClick: () => onRevert(tool.name) }, 'Revert this tool') : null,
          entry ? h('button', { class: 'btn', type: 'button', onClick: () => onChange(tool.name, null) }, 'Remove from set') : null
        )
        : null
    );
  }

  return h('details', {
    class: 'tool-ov__row' + (badge ? ' tool-ov__row--custom' : '') + (dirty ? ' tool-ov__row--dirty' : ''),
    open,
    onToggle: (e) => onToggle(tool.name, e.currentTarget.open)
  },
    h('summary', { class: 'tool-ov__summary' },
      h('code', { class: 'tool-ov__name' }, tool.name),
      badge ? h('span', { class: 'tool-ov__badge' }, badge) : null,
      dirty ? h('span', { class: 'tool-ov__badge tool-ov__badge--dirty' }, 'unsaved') : null,
      h('span', { class: 'tool-ov__source' }, tool.source || '')
    ),
    body
  );
}

// The one list of wording: Built-in first, then the project's sets, then the
// create and import entries. Picking an entry is the page's only selection.
// Also picks the other side of Compare: `exclude` drops the entry already
// on screen, and without `onNew` there is no New / Import.
function WordingPicker({ id = 'to-pick', labelText = 'Wording', placeholder = 'Built-in', selected, sets, active, panel = '', exclude, onPick, onNew, onImport }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (fn) => () => { setOpen(false); fn(); };
  const option = (id, label, tags) => {
    const on = !panel && id === selected;
    return h('button', {
      key: id || 'builtin',
      type: 'button',
      class: 'prompts__picker-option' + (on ? ' is-selected' : ''),
      role: 'option',
      'aria-selected': String(on),
      onClick: choose(() => onPick(id))
    },
      h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, on ? '✓' : ''),
      h('span', { class: 'prompts__picker-option-label' },
        h('span', null, label),
        tags.filter(Boolean).map((t) => h('span', { key: t, class: 'prompts__picker-preset' }, t)))
    );
  };
  const label = panel === 'new' ? 'New set' : panel === 'import' ? 'Import a set'
    : selected && sets[selected] ? sets[selected].name : exclude === BUILTIN ? placeholder : 'Built-in';
  const isDefault = !panel && selected === active && (selected === BUILTIN ? exclude !== BUILTIN : !!sets[selected]);

  const setIds = Object.keys(sets).filter((key) => key !== exclude);

  return h('div', { class: 'row prompts__picker' },
    h('span', { class: 'label', id: id + '-label' }, labelText),
    h('div', { class: 'prompts__picker-row' },
      h('div', { class: 'prompts__picker-control', ref: box },
        h('button', {
          type: 'button',
          class: 'input prompts__select',
          id,
          'aria-labelledby': id + '-label ' + id,
          'aria-haspopup': 'listbox',
          'aria-expanded': String(open),
          onClick: () => setOpen((o) => !o)
        },
          h('span', { class: 'prompts__select-label' }, label, isDefault ? h('span', { class: 'prompts__picker-preset' }, ' · default') : null),
          h('span', { class: 'prompts__select-caret', 'aria-hidden': 'true' }, '⌄')
        ),
        open
          ? h('div', { class: 'prompts__picker-menu', role: 'listbox', 'aria-labelledby': id + '-label' },
            exclude === BUILTIN ? null : option(BUILTIN, 'Built-in', ['read-only', active === BUILTIN ? 'default' : '']),
            setIds.length ? h('div', { class: 'prompts__picker-section', role: 'presentation' }, 'Sets') : null,
            setIds.map((key) => option(key, sets[key].name || 'Untitled', [active === key ? 'default' : ''])),
            onNew ? h('button', { type: 'button', class: 'prompts__picker-option', role: 'option', 'aria-selected': 'false', onClick: choose(onNew) },
              h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, ''), h('span', null, '+ New set')) : null,
            onImport ? h('button', { type: 'button', class: 'prompts__picker-option', role: 'option', 'aria-selected': 'false', onClick: choose(onImport) },
              h('span', { class: 'prompts__picker-check', 'aria-hidden': 'true' }, ''), h('span', null, 'Import a set…')) : null
          )
          : null
      ),
      onNew ? h('button', { class: 'btn', type: 'button', onClick: onNew }, '+ New') : null
    )
  );
}

export function ToolOverridesPageView({ projectDir = '', from = '', chatId = '' } = {}) {
  const dir = projectDir || (activeProject.value && activeProject.value.dir) || '';
  const context = { projectDir: dir, chatId, from };
  const [tools, setTools] = useState(null);
  // `saved` is what the project file holds; `draft` is what the page edits.
  // Save writes the whole draft; Discard copies saved back.
  const [saved, setSaved] = useState({ active: BUILTIN, sets: {} });
  const [draft, setDraft] = useState({ active: BUILTIN, sets: {} });
  // A project saved before sets existed: its flat map is shown as a set and
  // dropped from the project file on the next save.
  const [legacy, setLegacy] = useState(false);
  // Three tabs: Built-in, the set picked in the list (`pickedSet`), and
  // Compare, which diffs that set against `compareWith` (Built-in or
  // another set).
  const [tab, setTab] = useState('builtin');   // 'builtin' | 'set' | 'compare'
  const [pickedSet, setPickedSet] = useState('');
  const [compareWith, setCompareWith] = useState(BUILTIN);
  const [query, setQuery] = useState('');
  const [onlyDiffering, setOnlyDiffering] = useState(false);
  const [openRows, setOpenRows] = useState({});
  const [panel, setPanel] = useState('');   // '' | 'new' | 'import'
  const [newName, setNewName] = useState('');
  const [newFrom, setNewFrom] = useState(BUILTIN);   // Built-in, 'empty' or a set id
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [note, setNote] = useState('');
  const [noteState, setNoteState] = useState('');
  const [status, setStatus] = useState('');
  const [statusState, setStatusState] = useState('');   // '' | 'busy' | 'success' | 'error'
  // Rows remount (dropping a half-started blank box) when their draft is
  // replaced from outside: every row on discard, one on revert / remove.
  const [generation, setGeneration] = useState(0);
  const [revs, setRevs] = useState({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!dir) { setStatus('Open this page from a project’s settings.'); setStatusState('error'); return; }
      setStatus('Loading…'); setStatusState('busy');
      try {
        const [catalog, resolved] = await Promise.all([
          fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(dir)),
          fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(dir))
        ]);
        if (cancelled) return;
        if (catalog.status !== 200) throw new Error('HTTP ' + catalog.status);
        const loaded = wordingFromResolved(resolved.status === 200 ? resolved.body.resolved : null);
        setSaved(loaded.legacy ? { active: BUILTIN, sets: {} } : loaded.wording);
        setDraft(loaded.wording);
        setLegacy(loaded.legacy);
        setPickedSet(initialSelection(loaded.wording));
        setTab(loaded.wording.active && loaded.wording.sets[loaded.wording.active] ? 'set' : 'builtin');
        setTools((catalog.body.tools || []).filter((t) => t && t.name));
        setStatus(''); setStatusState('');
        if (loaded.legacy) {
          setNote('Your earlier wording is now the set “Custom”. Save to keep it that way.');
          setNoteState('');
        }
      } catch (error) {
        if (!cancelled) {
          setStatus('Cannot load: ' + (error && error.message ? error.message : String(error)));
          setStatusState('error');
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [dir]);

  const sets = draft.sets;
  const setIds = Object.keys(sets);
  // With no set (none yet, or the last one deleted) only Built-in shows.
  const view = pickedSet && sets[pickedSet] ? tab : 'builtin';
  // `selected` is the entry the tab shows; in Compare, the right side.
  const selected = view === 'builtin' ? BUILTIN : pickedSet;
  const set = selected && sets[selected] ? sets[selected] : null;
  const comparing = view === 'compare';
  // A left side that was deleted, or is now the picked set, falls back to Built-in.
  const left = compareWith !== pickedSet && (compareWith === BUILTIN || sets[compareWith]) ? compareWith : BUILTIN;
  const mode = comparing ? 'compare' : set ? 'set' : 'builtin';

  const changes = useMemo(() => wordingChanges(draft, saved), [draft, saved]);
  const dirtyCount = changes.count + (legacy ? 1 : 0);
  const dirtyTools = useMemo(() => {
    // A set that is not saved yet is one change in the Save bar, not one per row.
    const was = saved.sets[selected];
    if (!set || !was) return new Set();
    return new Set(changedTools(normalizeWording({ sets: { x: set } }).sets.x.tools, was.tools));
  }, [set, selected, saved]);
  const problems = useMemo(() => setIds.filter((id) => renameProblems(sets[id].tools, tools).length).map((id) => sets[id].name),
    [sets, tools]);
  const saving = statusState === 'busy';

  // Unsaved edits live only on this page; warn before a reload or a link
  // away loses them.
  useEffect(() => {
    if (!dirtyCount) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);
  function guardLeave(e) {
    if (dirtyCount && !window.confirm('Discard unsaved tool wording changes?')) e.preventDefault();
  }

  function say(text, state = 'success') { setNote(text); setNoteState(state); }

  async function save() {
    if (!dirtyCount || problems.length || saving) return;
    const payload = normalizeWording(draft);
    setStatus('Saving…'); setStatusState('busy');
    try {
      const body = { projectDir: dir, toolWording: payload };
      if (legacy) body.unset = ['toolOverrides'];
      const r = await fetchJson('/api/settings/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      if (alive.current) {
        setSaved(payload);
        setLegacy(false);
        setNote('');
        setStatus('Saved — chats in this project use ' + (payload.active ? '“' + payload.sets[payload.active].name + '”' : 'Built-in') + ' from their next message.');
        setStatusState('success');
      }
    } catch (error) {
      if (alive.current) {
        setStatus('Not saved: ' + (error && error.message ? error.message : String(error)));
        setStatusState('error');
      }
    }
  }

  function discard() {
    if (!window.confirm('Discard all unsaved tool wording changes?')) return;
    setDraft(saved);
    setLegacy(false);
    if (pickedSet && !saved.sets[pickedSet]) setPickedSet(initialSelection(saved));
    setGeneration((g) => g + 1);
    setStatus(''); setStatusState('');
  }

  function edit(mutator) {
    setDraft((current) => {
      const next = { active: current.active, sets: Object.assign({}, current.sets) };
      mutator(next);
      return next;
    });
    if (statusState === 'success') { setStatus(''); setStatusState(''); }
  }

  function bump(name) {
    setRevs((r) => Object.assign({}, r, { [name]: (r[name] || 0) + 1 }));
  }

  // ---- tools in the selected set ----
  function updateTool(name, entry) {
    const id = selected;
    edit((next) => {
      const current = next.sets[id];
      const toolsMap = Object.assign({}, current.tools);
      const hasFields = entry && entry.fields && Object.keys(entry.fields).length;
      if (entry && (entry.description || hasFields)) toolsMap[name] = entry;
      else delete toolsMap[name];
      next.sets[id] = { name: current.name, tools: toolsMap };
    });
    if (!entry) bump(name);
  }

  function revertTool(name) {
    const id = selected;
    const was = saved.sets[id] && saved.sets[id].tools[name];
    edit((next) => {
      const current = next.sets[id];
      const toolsMap = Object.assign({}, current.tools);
      if (was) toolsMap[name] = was; else delete toolsMap[name];
      next.sets[id] = { name: current.name, tools: toolsMap };
    });
    bump(name);
  }

  // ---- the list ----
  // Picking a set shows it, on the set tab or as Compare's right side.
  function pick(id) {
    setPanel('');
    setNote('');
    // Picking the set Compare had on the left swaps the two sides.
    if (comparing && id === left) setCompareWith(pickedSet);
    setPickedSet(id);
    if (tab === 'builtin') setTab('set');
  }

  function showSet(id) {
    setPanel('');
    setPickedSet(id);
    setTab('set');
  }

  function sourceName(source) {
    return source === 'empty' ? 'New set' : source && sets[source] ? 'Copy of ' + sets[source].name : 'Copy of Built-in';
  }

  // New starts as a copy of whatever is selected.
  function openNew(source = selected) {
    setPanel('new');
    setNote('');
    setNewFrom(source);
    setNewName(uniqueSetName(sourceName(source), sets));
  }

  function chooseSource(source) {
    // Keep a name the user typed; follow the source while it is the default.
    if (newName === uniqueSetName(sourceName(newFrom), sets)) setNewName(uniqueSetName(sourceName(source), sets));
    setNewFrom(source);
  }

  function createSet() {
    if (setIds.length >= MAX_SETS) return;
    const name = uniqueSetName(newName, sets);
    const id = newSetId(name, sets);
    const toolsMap = newSetTools(newFrom, tools, sets);
    edit((next) => { next.sets[id] = { name, tools: toolsMap }; });
    showSet(id);
    say('Created “' + name + '”. Edit it, tap Make default to use it in chats, then Save.');
  }

  function renameSet(id, value) {
    edit((next) => { next.sets[id] = { name: value.slice(0, MAX_SET_NAME), tools: next.sets[id].tools }; });
  }
  // On blur: an empty or duplicate name becomes a unique one.
  function settleName(id) {
    const current = sets[id];
    if (!current) return;
    const name = uniqueSetName(current.name, sets, id);
    if (name !== current.name) renameSet(id, name);
  }

  function deleteSet(id) {
    if (!window.confirm('Delete the set “' + sets[id].name + '”? It is removed when you Save.')) return;
    const nextActive = draft.active === id ? BUILTIN : draft.active;
    setPickedSet(selectionAfterDelete(sets, id, nextActive));
    setNote('');
    edit((next) => {
      delete next.sets[id];
      if (next.active === id) next.active = BUILTIN;
    });
  }

  function makeDefault(id) {
    edit((next) => { next.active = id; });
    say('“' + (id && sets[id] ? sets[id].name : 'Built-in') + '” becomes the default for chats when you Save.');
  }

  function applyImport() {
    const parsed = parseImport(importText);
    if (parsed.error) { say(parsed.error, 'error'); return; }
    if (setIds.length >= MAX_SETS) { say('A project holds at most ' + MAX_SETS + ' sets.', 'error'); return; }
    const name = uniqueSetName(importName || parsed.name || 'Imported', sets);
    const id = newSetId(name, sets);
    edit((next) => { next.sets[id] = { name, tools: parsed.overrides }; });
    const known = new Set((tools || []).map((t) => t.name));
    const unlisted = Object.keys(parsed.overrides).filter((n) => !known.has(n)).length;
    const parts = ['Imported “' + name + '” with ' + parsed.tools + ' tool' + (parsed.tools === 1 ? '' : 's') + ' — review it, then Save'];
    if (parsed.skipped) parts.push(parsed.skipped + ' entr' + (parsed.skipped === 1 ? 'y' : 'ies') + ' skipped');
    if (unlisted) parts.push(unlisted + ' not in this project’s tool list (kept; used only while the tool exists)');
    say(parts.join(' · ') + '.');
    setImportText(''); setImportName('');
    showSet(id);
  }

  function onFile(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (!importName) setImportName(file.name.replace(/\.json$/i, ''));
    file.text().then(setImportText).catch(() => say('Cannot read that file.', 'error'));
  }

  async function copyExport(id) {
    const text = exportText(sets[id]);
    try {
      await navigator.clipboard.writeText(text);
      say('Copied “' + sets[id].name + '” as JSON.');
    } catch {
      setImportText(text);
      setPanel('import');
      say('Copy is blocked here. The JSON is in the box below — copy it from there, then tap Cancel.', '');
    }
  }

  function downloadExport(id) {
    const url = URL.createObjectURL(new Blob([exportText(sets[id])], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = newSetId(sets[id].name) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('Downloaded “' + sets[id].name + '” as ' + a.download + '.');
  }

  function toggleRow(name, open) {
    setOpenRows((rows) => (!!rows[name] === open ? rows : Object.assign({}, rows, { [name]: open })));
  }

  // ---- what each row shows ----
  const entryOf = (id, name) => (id && sets[id] ? sets[id].tools[name] : undefined);
  const labelOf = (id) => (id && sets[id] ? sets[id].name : 'Built-in');
  const differs = (tool) => {
    if (comparing) {
      const a = effectiveEntry(tool, entryOf(left, tool.name));
      const b = effectiveEntry(tool, entryOf(selected, tool.name));
      return a.description !== b.description || JSON.stringify(a.fields) !== JSON.stringify(b.fields);
    }
    if (set) return differsFromBuiltIn(tool, set.tools[tool.name]) || dirtyTools.has(tool.name);
    return false;
  };
  const filterable = mode !== 'builtin';
  const shown = useMemo(() => {
    const base = onlyDiffering && filterable ? (tools || []).filter(differs) : (tools || []);
    return searchTools(base, query);
  }, [tools, query, onlyDiffering, mode, selected, left, draft, dirtyTools]);
  const differingCount = useMemo(() => (tools && filterable ? tools.filter(differs).length : 0),
    [tools, mode, selected, left, draft, dirtyTools]);
  const back = backTarget(context);

  const saveSummary = [];
  if (legacy) saveSummary.push('move earlier wording into “Custom”');
  for (const c of changes.sets) {
    // The legacy move already says "Custom" is new and in use.
    if (legacy && c.id === LEGACY_SET_ID && c.kind === 'new') continue;
    if (c.kind === 'new') saveSummary.push('new set “' + c.name + '”');
    else if (c.kind === 'deleted') saveSummary.push('delete “' + c.name + '”');
    else saveSummary.push('“' + c.name + '”' + (c.tools.length ? ': ' + c.tools.length + ' tool' + (c.tools.length === 1 ? '' : 's') : '') + (c.renamed ? ' (renamed)' : ''));
  }
  if (changes.active && !(legacy && draft.active === LEGACY_SET_ID)) saveSummary.push('default: ' + (draft.active ? '“' + labelOf(draft.active) + '”' : 'Built-in'));

  const isDefault = draft.active === selected;
  const sources = [[BUILTIN, 'Copy of Built-in', 'Every tool’s current description, frozen.']]
    .concat(setIds.map((id) => [id, 'Copy of ' + sets[id].name, 'Everything in that set, unsaved edits included.']))
    .concat([['empty', 'Empty', 'Uses the built-in wording for every tool until you edit one.']]);

  // ---- the selected item, or the New / Import form in its place ----
  let card;
  if (panel === 'new') {
    card = h('div', { class: 'tool-ov__card' },
      h('div', { class: 'tool-ov__card-head' }, h('span', { class: 'tool-ov__card-title' }, 'New set')),
      h('div', { class: 'tool-ov__field-group' },
        h('label', { class: 'tool-ov__label', for: 'to-new-name' }, 'Name'),
        h('input', { class: 'input', id: 'to-new-name', type: 'text', maxLength: MAX_SET_NAME, value: newName, onInput: (e) => setNewName(e.currentTarget.value) })
      ),
      h('div', { class: 'tool-ov__field-group' },
        h('span', { class: 'tool-ov__label', id: 'to-new-from-label' }, 'Start from'),
        h('div', { class: 'tool-ov__choices', role: 'radiogroup', 'aria-labelledby': 'to-new-from-label' },
          sources.map(([key, label, hint]) => h('label', { key: key || 'builtin', class: 'tool-ov__choice' },
            h('input', { type: 'radio', name: 'to-new-from', value: key, checked: newFrom === key, onChange: () => chooseSource(key) }),
            h('span', null, h('span', { class: 'tool-ov__choice-label' }, label), h('span', { class: 'settings-project__item-note' }, hint))
          ))
        )
      ),
      h('div', { class: 'tool-ov__actions tool-ov__actions--end' },
        h('button', { class: 'btn', type: 'button', onClick: () => setPanel('') }, 'Cancel'),
        h('button', { class: 'btn btn--primary', type: 'button', disabled: !newName.trim() || !tools || setIds.length >= MAX_SETS, onClick: createSet }, 'Create set')
      ),
      setIds.length >= MAX_SETS ? h('div', { class: 'settings-project__item-note' }, 'A project holds at most ' + MAX_SETS + ' sets.') : null
    );
  } else if (panel === 'import') {
    card = h('div', { class: 'tool-ov__card' },
      h('div', { class: 'tool-ov__card-head' }, h('span', { class: 'tool-ov__card-title' }, 'Import a set')),
      h('div', { class: 'tool-ov__field-group' },
        h('label', { class: 'tool-ov__label', for: 'to-import' }, 'JSON'),
        h('textarea', {
          class: 'input settings-project__mono tool-ov__desc',
          id: 'to-import',
          rows: 6,
          spellcheck: false,
          placeholder: '{\n  "name": "Terse",\n  "tools": {\n    "shell": { "description": "Run a command", "fields": { "cmd": "command" } }\n  }\n}',
          value: importText,
          onInput: (e) => setImportText(e.currentTarget.value)
        }),
        h('div', { class: 'settings-project__item-note' }, 'Paste a set’s JSON or choose a .json file. A bare { "tool": { … } } map or an older project file also works.')
      ),
      h('div', { class: 'tool-ov__field-group' },
        h('label', { class: 'tool-ov__label', for: 'to-import-name' }, 'Name (optional)'),
        h('input', { class: 'input', id: 'to-import-name', type: 'text', maxLength: MAX_SET_NAME, value: importName, placeholder: 'From the file, or “Imported”', onInput: (e) => setImportName(e.currentTarget.value) })
      ),
      h('div', { class: 'tool-ov__actions' },
        h('label', { class: 'btn' }, 'Choose file',
          h('input', { type: 'file', accept: 'application/json,.json', class: 'tool-ov__file', onChange: onFile })
        ),
        h('span', { class: 'tool-ov__spacer' }),
        h('button', { class: 'btn', type: 'button', onClick: () => { setPanel(''); setImportText(''); setImportName(''); } }, 'Cancel'),
        h('button', { class: 'btn btn--primary', type: 'button', disabled: !importText.trim() || setIds.length >= MAX_SETS, onClick: applyImport }, 'Import as new set')
      )
    );
  } else if (comparing) {
    card = h('div', { class: 'tool-ov__card' },
      h(WordingPicker, { id: 'to-cmp', labelText: 'Compare against', selected: left, sets, active: draft.active, exclude: pickedSet, onPick: setCompareWith }),
      tools
        ? h('div', { class: 'tool-ov__cmp-summary' },
          h('span', null, '“' + labelOf(left) + '” → “' + labelOf(selected) + '”'),
          h('span', { class: 'tool-ov__cmp-count' }, differingCount + (differingCount === 1 ? ' tool differs' : ' tools differ')))
        : null
    );
  } else {
    const changed = tools && set ? tools.filter((t) => differsFromBuiltIn(t, set.tools[t.name])).length : 0;
    card = h('div', { class: 'tool-ov__card' + (isDefault ? ' tool-ov__card--default' : '') },
      h('div', { class: 'tool-ov__card-head' },
        set
          ? h('input', {
            class: 'input tool-ov__card-name', id: 'to-set-name', type: 'text', maxLength: MAX_SET_NAME, value: set.name,
            'aria-label': 'Set name',
            onInput: (e) => renameSet(selected, e.currentTarget.value),
            onBlur: () => settleName(selected)
          })
          : h('span', { class: 'tool-ov__card-title' }, 'Built-in'),
        isDefault
          ? h('span', { class: 'tool-ov__badge' }, 'default for chats')
          : h('button', { class: 'btn', type: 'button', onClick: () => makeDefault(selected) }, 'Make default')
      ),
      h('div', { class: 'settings-project__item-note' },
        set
          ? (tools ? changed + ' of ' + tools.length + ' tools differ from built-in · ' + Object.keys(set.tools).length + ' in this set' : '')
          : 'The wording each tool ships with. Read-only — tap Copy to new set to make an editable set from it.' + (setIds.length ? '' : ' Set and Compare unlock once you have a set.')),
      h('div', { class: 'tool-ov__actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => openNew(selected) }, set ? 'Duplicate' : 'Copy to new set'),
        set ? h('button', { class: 'btn', type: 'button', onClick: () => copyExport(selected) }, 'Copy JSON') : null,
        set ? h('button', { class: 'btn', type: 'button', onClick: () => downloadExport(selected) }, 'Download') : null
      ),
      set
        ? h('div', { class: 'tool-ov__actions tool-ov__actions--end tool-ov__actions--plain' },
          h('button', { class: 'btn btn--danger', type: 'button', onClick: () => deleteSet(selected) }, 'Delete set'))
        : null
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref(context), class: 'view-back', 'aria-label': back.label, onClick: guardLeave }, '←'),
      h('h2', { class: 'view-title' }, 'Tool wording')
    ),
    h('section', { class: 'settings-project tool-ov-page' },
      h('p', { class: 'settings-project__lede' },
        'Change what the model is told about each tool: its description and the names of its fields. Keep several wording sets and make one the default for this project’s chats. A tool still does exactly what it did — a call is mapped back to the original field names before it runs.'),

      // ---- The list, and the selected item ----
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'Wording sets'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About wording sets' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Built-in is the wording each tool ships with and cannot be edited. A set copied from Built-in is a frozen copy of every description: later built-in changes do not reach it, and Compare shows where they drifted. A tool a set does not include uses the built-in wording.'),
              h('p', null, 'Changes stay unsaved until you tap Save in the bar at the bottom; the default applies from the next message of every chat in this project. Only top-level fields can be renamed. A tool that is Off, or an MCP server that is not running, is not sent to the model.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col tool-ov__manage' },
            h(WordingPicker, {
              labelText: 'Set', placeholder: 'No sets yet',
              selected: pickedSet, sets, active: draft.active, panel, exclude: BUILTIN,
              onPick: pick,
              onNew: () => openNew(),
              onImport: () => { setPanel('import'); setNote(''); }
            }),
            panel ? null : h('div', { class: 'tool-ov__tabs', role: 'tablist', 'aria-label': 'Wording to show' },
              [[BUILTIN, 'builtin', 'Built-in'], [pickedSet, 'set', sets[pickedSet] ? labelOf(pickedSet) : 'Set'], ['', 'compare', 'Compare']].map(([id, key, text]) => {
                const on = view === key;
                const disabled = key !== 'builtin' && !sets[pickedSet];
                return h('button', {
                  key,
                  type: 'button',
                  role: 'tab',
                  class: 'tool-ov__tab' + (on ? ' tool-ov__tab--on' : ''),
                  'aria-selected': String(on),
                  disabled,
                  onClick: () => { setNote(''); setTab(key); }
                },
                  h('span', { class: 'tool-ov__tab-label' }, text),
                  key !== 'compare' && draft.active === id && (key === 'builtin' || sets[id])
                    ? h('span', { class: 'tool-ov__tab-dot', title: 'Default for chats', 'aria-label': '(default for chats)' })
                    : null
                );
              })
            ),
            note ? h('div', { class: 'settings-project__item-status', 'data-state': noteState || undefined, role: 'status', 'aria-live': 'polite' }, note) : null,
            status && !dirtyCount
              ? h('div', { class: 'settings-project__item-status', 'data-state': statusState || undefined, role: 'status', 'aria-live': 'polite' }, status)
              : null,
            card
          )
        )
      ),

      // ---- The selected item's tools ----
      panel ? null : h('div', { class: 'group settings-project__section' },
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('input', {
              class: 'input',
              type: 'search',
              value: query,
              placeholder: 'Search tools',
              'aria-label': 'Search tools',
              onInput: (e) => setQuery(e.currentTarget.value)
            }),
            filterable
              ? h('label', { class: 'tool-ov__filter' },
                h('input', { type: 'checkbox', checked: onlyDiffering, onChange: (e) => setOnlyDiffering(e.currentTarget.checked) }),
                comparing ? ' Show only tools that differ' : ' Show only tools that differ from built-in'
              )
              : null
          )
        ),
        tools
          ? h('div', { class: 'tool-ov__list' },
            shown.length
              ? shown.map((tool) => {
                const entry = mode === 'set' ? set.tools[tool.name] : undefined;
                return h(ToolRow, {
                  key: tool.name + '|' + mode + '|' + selected + '|' + generation + '|' + (revs[tool.name] || 0),
                  tool,
                  mode,
                  entry,
                  left: entryOf(left, tool.name),
                  right: entryOf(selected, tool.name),
                  leftLabel: labelOf(left),
                  rightLabel: labelOf(selected),
                  badge: mode === 'set' ? (differsFromBuiltIn(tool, entry) ? 'changed' : '') : mode === 'compare' ? (differs(tool) ? 'differs' : '') : '',
                  dirty: mode === 'set' && dirtyTools.has(tool.name),
                  open: !!openRows[tool.name],
                  onToggle: toggleRow,
                  onChange: updateTool,
                  onRevert: revertTool
                });
              })
              : h('div', { class: 'settings-project__item-note tool-ov__empty' }, onlyDiffering && !query ? 'No tool differs.' : 'No tool matches.'))
          : null
      ),

      tools && dirtyCount
        ? h('div', { class: 'tool-ov__savebar', role: 'region', 'aria-label': 'Save tool wording' },
          h('div', { class: 'tool-ov__savebar-text' },
            h('span', { class: 'tool-ov__savebar-count' }, 'Unsaved changes'),
            h('span', { class: 'settings-project__item-note' }, saveSummary.join(' · ')),
            problems.length
              ? h('span', { class: 'settings-project__item-status', 'data-state': 'error', role: 'alert' }, 'Fix the field names in ' + problems.join(', ') + ' to save.')
              : status && statusState
                ? h('span', { class: 'settings-project__item-status', 'data-state': statusState, role: 'status', 'aria-live': 'polite' }, status)
                : null
          ),
          h('div', { class: 'tool-ov__savebar-actions' },
            h('button', { class: 'btn', type: 'button', disabled: saving, onClick: discard }, 'Discard'),
            h('button', { class: 'btn btn--primary', type: 'button', disabled: saving || problems.length > 0, onClick: save }, saving ? 'Saving…' : 'Save')
          )
        )
        : null,

      h('div', { class: 'group settings-project__section' },
        h('a', {
          class: 'group__row settings-project__link-row',
          href: settingsLink('settings/project', context),
          'aria-label': 'Back to project settings',
          onClick: guardLeave
        },
          h('span', { class: 'group__row-body' },
            h('span', { class: 'group__row-label' }, 'Project settings'),
            h('span', { class: 'settings-project__link-sub' }, 'Tools, agents, and the rest of this project')
          ),
          h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
        )
      )
    )
  );
}
