// mouaif web — Settings → Project → Tool wording (its own page)
//
// Named wording sets for the tools the model is told about
// (docs/features/tool-overrides.md). Built-in is the read-only wording every
// tool ships with; a project creates its own sets (empty, a frozen copy of
// Built-in, or a copy of another set), edits them, compares any two, imports
// and exports them, and picks the one its chats use. A set holds replacement
// descriptions and replacement names for a tool's top-level fields.
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
  effectiveEntry, exportText, fieldList, fieldProblem, newSetId, normalizeWording, parseImport,
  renameProblems, searchTools, snapshotBuiltIn, uniqueSetName, wordingChanges, wordingFromResolved
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
    h('div', { class: 'settings-project__item-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => { setEditing(false); onChange(''); } }, 'Use built-in instead')
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

// A <select> over every set, with Built-in first unless `builtIn` is false.
function SetSelect({ id, value, sets, onChange, label, builtIn = true }) {
  return h('select', {
    class: 'input tool-ov__select',
    id,
    value,
    'aria-label': label,
    onChange: (e) => onChange(e.currentTarget.value)
  },
    builtIn ? h('option', { value: BUILTIN }, 'Built-in') : null,
    Object.keys(sets).map((setId) => h('option', { key: setId, value: setId }, sets[setId].name))
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
  // 'builtin' | 'set' | 'compare'; on 'set', `editingId` (picked in the
  // Sets tab's dropdown) is the set on screen.
  const [tab, setTab] = useState('builtin');
  const [editingId, setEditingId] = useState('');
  const [compareLeft, setCompareLeft] = useState(BUILTIN);
  const [compareRight, setCompareRight] = useState(BUILTIN);
  const [query, setQuery] = useState('');
  const [onlyDiffering, setOnlyDiffering] = useState(false);
  const [openRows, setOpenRows] = useState({});
  const [panel, setPanel] = useState('');   // '' | 'new' | 'import'
  const [newName, setNewName] = useState('');
  const [newFrom, setNewFrom] = useState('builtin');   // 'builtin' | 'empty' | 'set:<id>'
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
        const first = loaded.wording.active || Object.keys(loaded.wording.sets)[0] || '';
        if (first) { setTab('set'); setEditingId(first); setCompareRight(first); }
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
  // `chosen` is the set picked in the management dropdown above the tabs;
  // `editing` is the same set while the list shows it (the middle tab).
  const chosen = editingId && sets[editingId] ? sets[editingId] : null;
  const editing = tab === 'set' ? chosen : null;
  // A deleted set: the Sets dropdown moves to another set, a Compare side
  // falls back to Built-in.
  useEffect(() => {
    if (!sets[editingId] && (editingId || setIds.length)) setEditingId(setIds[0] || '');
    if (compareLeft && !sets[compareLeft]) setCompareLeft(BUILTIN);
    if (compareRight && !sets[compareRight]) setCompareRight(BUILTIN);
  }, [editingId, sets, compareLeft, compareRight]);

  const changes = useMemo(() => wordingChanges(draft, saved), [draft, saved]);
  const dirtyCount = changes.count + (legacy ? 1 : 0);
  const dirtyTools = useMemo(() => {
    if (!editing) return new Set();
    const was = saved.sets[editingId];
    return new Set(changedTools(normalizeWording({ sets: { x: editing } }).sets.x.tools, was ? was.tools : {}));
  }, [editing, editingId, saved]);
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
    setDraft(saved);
    setLegacy(false);
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

  // ---- tools in the set on screen ----
  function updateTool(name, entry) {
    const id = editingId;
    edit((next) => {
      const set = next.sets[id];
      const toolsMap = Object.assign({}, set.tools);
      const hasFields = entry && entry.fields && Object.keys(entry.fields).length;
      if (entry && (entry.description || hasFields)) toolsMap[name] = entry;
      else delete toolsMap[name];
      next.sets[id] = { name: set.name, tools: toolsMap };
    });
    if (!entry) bump(name);
  }

  function revertTool(name) {
    const id = editingId;
    const was = saved.sets[id] && saved.sets[id].tools[name];
    edit((next) => {
      const set = next.sets[id];
      const toolsMap = Object.assign({}, set.tools);
      if (was) toolsMap[name] = was; else delete toolsMap[name];
      next.sets[id] = { name: set.name, tools: toolsMap };
    });
    bump(name);
  }

  // ---- sets ----
  function openNew(fromKey) {
    setPanel('new');
    setNewFrom(fromKey);
    const base = fromKey === 'builtin' ? 'Copy of Built-in' : fromKey === 'empty' ? 'New set' : 'Copy of ' + sets[fromKey.slice(4)].name;
    setNewName(uniqueSetName(base, sets));
  }

  function createSet() {
    if (setIds.length >= MAX_SETS) return;
    const name = uniqueSetName(newName, sets);
    const id = newSetId(name, sets);
    const toolsMap = newFrom === 'builtin' ? snapshotBuiltIn(tools)
      : newFrom === 'empty' ? {}
        : JSON.parse(JSON.stringify(sets[newFrom.slice(4)].tools));
    edit((next) => { next.sets[id] = { name, tools: toolsMap }; });
    setPanel('');
    setTab('set');
    setEditingId(id);
    setCompareRight(id);
    say('Created “' + name + '”. Edit it, tap Make default to use it in chats, then Save.');
  }

  function renameSet(id, value) {
    edit((next) => { next.sets[id] = { name: value.slice(0, MAX_SET_NAME), tools: next.sets[id].tools }; });
  }
  // On blur: an empty or duplicate name becomes a unique one.
  function settleName(id) {
    const set = sets[id];
    if (!set) return;
    const name = uniqueSetName(set.name, sets, id);
    if (name !== set.name) renameSet(id, name);
  }

  function deleteSet(id) {
    if (!window.confirm('Delete the set “' + sets[id].name + '”? It is removed when you Save.')) return;
    edit((next) => {
      delete next.sets[id];
      if (next.active === id) next.active = BUILTIN;
    });
  }

  function makeDefault(id) {
    edit((next) => { next.active = id; });
  }

  // Picking a set above the tabs also shows it in the list.
  function pickSet(id) {
    setEditingId(id);
    setTab('set');
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
    setPanel('');
    setTab('set');
    setEditingId(id);
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
      say('Copy is blocked here; the JSON is in the import box instead.', '');
    }
  }

  function downloadExport(id) {
    const url = URL.createObjectURL(new Blob([exportText(sets[id])], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = newSetId(sets[id].name) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toggleRow(name, open) {
    setOpenRows((rows) => (!!rows[name] === open ? rows : Object.assign({}, rows, { [name]: open })));
  }

  // ---- what each row shows ----
  const entryOf = (id, name) => (id && sets[id] ? sets[id].tools[name] : undefined);
  const labelOf = (id) => (id && sets[id] ? sets[id].name : 'Built-in');
  const differs = (tool) => {
    if (editing) return differsFromBuiltIn(tool, editing.tools[tool.name]) || dirtyTools.has(tool.name);
    if (tab === 'compare') {
      const a = effectiveEntry(tool, entryOf(compareLeft, tool.name));
      const b = effectiveEntry(tool, entryOf(compareRight, tool.name));
      return a.description !== b.description || JSON.stringify(a.fields) !== JSON.stringify(b.fields);
    }
    return false;
  };
  const shown = useMemo(() => {
    if (tab === 'set' && !editing) return [];
    const base = onlyDiffering && tab !== 'builtin' ? (tools || []).filter(differs) : (tools || []);
    return searchTools(base, query);
  }, [tools, query, onlyDiffering, tab, editingId, draft, compareLeft, compareRight, dirtyTools]);
  const chosenDiffering = useMemo(() => (tools && chosen ? tools.filter((t) => differsFromBuiltIn(t, chosen.tools[t.name])).length : 0),
    [tools, chosen]);
  const differingCount = useMemo(() => (tools && tab !== 'builtin' ? tools.filter(differs).length : 0),
    [tools, tab, editingId, draft, compareLeft, compareRight, dirtyTools]);
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

  // The middle tab is named after the set chosen in its dropdown.
  const tabs = [['builtin', 'Built-in'], ['set', editingId && sets[editingId] ? sets[editingId].name : 'Sets'], ['compare', 'Compare']];
  // The dot marks the default: Built-in, or the set shown on the middle tab.
  const usedTab = !draft.active ? 'builtin' : draft.active === editingId ? 'set' : '';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref(context), class: 'view-back', 'aria-label': back.label, onClick: guardLeave }, '←'),
      h('h2', { class: 'view-title' }, 'Tool wording')
    ),
    h('section', { class: 'settings-project' },
      h('p', { class: 'settings-project__lede' },
        'Change what the model is told about each tool: its description and the names of its fields. Keep several wording sets and make one the default for this project’s chats. A tool still does exactly what it did — a call is mapped back to the original field names before it runs.'),

      // ---- Sets: what chats use, New set, Import ----
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'Wording sets'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About wording sets' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Built-in is the wording each tool ships with and cannot be edited. A set copied from Built-in is a frozen copy of every description: later built-in changes do not reach it, and Compare shows where they drifted. A tool a set does not include uses the built-in wording.'),
              h('p', null, 'Changes stay unsaved until you tap Save in the bar at the bottom; the default set applies from the next message of every chat in this project. Only top-level fields can be renamed. A tool that is Off, or an MCP server that is not running, is not sent to the model.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          // Three tiers: the default for chats, the set picker with its
          // create/import buttons, and one card — the chosen set, or the
          // New set / Import form in its place.
          h('li', { class: 'settings-project__item settings-project__item--col tool-ov__manage' },
            h('div', { class: 'tool-ov__block' },
              h('div', { class: 'tool-ov__kv' },
                h('span', { class: 'tool-ov__label' }, 'Default for chats'),
                h('span', { class: 'tool-ov__kv-value' },
                  h('span', { class: 'tool-ov__tab-dot', 'aria-hidden': 'true' }),
                  draft.active ? labelOf(draft.active) : 'Built-in'),
                draft.active
                  ? h('button', { class: 'btn tool-ov__kv-action', type: 'button', onClick: () => makeDefault(BUILTIN) }, 'Use Built-in')
                  : null
              ),
              status && !dirtyCount
                ? h('div', { class: 'settings-project__item-status', 'data-state': statusState || undefined, role: 'status', 'aria-live': 'polite' }, status)
                : null
            ),
            h('div', { class: 'tool-ov__block' },
              h('label', { class: 'tool-ov__label', for: 'to-set-pick' }, 'Sets'),
              h('div', { class: 'tool-ov__picker' },
                setIds.length
                  ? h(SetSelect, { id: 'to-set-pick', value: editingId, sets, label: 'Set to manage', builtIn: false, onChange: pickSet })
                  : h('span', { class: 'settings-project__item-note tool-ov__picker-empty' }, 'No sets yet — create one or import one.'),
                h('div', { class: 'tool-ov__btns' },
                  h('button', { class: 'btn' + (panel === 'new' ? ' btn--primary' : ''), type: 'button', disabled: !tools || setIds.length >= MAX_SETS, 'aria-expanded': panel === 'new' ? 'true' : 'false', onClick: () => (panel === 'new' ? setPanel('') : openNew('builtin')) }, '+ New set'),
                  h('button', { class: 'btn' + (panel === 'import' ? ' btn--primary' : ''), type: 'button', disabled: !tools || setIds.length >= MAX_SETS, 'aria-expanded': panel === 'import' ? 'true' : 'false', onClick: () => setPanel(panel === 'import' ? '' : 'import') }, 'Import…')
                )
              ),
              note ? h('div', { class: 'settings-project__item-status', 'data-state': noteState || undefined, role: 'status', 'aria-live': 'polite' }, note) : null,

              panel === 'new'
                ? h('div', { class: 'tool-ov__card' },
                  h('div', { class: 'tool-ov__card-head' }, h('span', { class: 'tool-ov__card-title' }, 'New set')),
                  h('div', { class: 'tool-ov__field-group' },
                    h('label', { class: 'tool-ov__label', for: 'to-new-name' }, 'Name'),
                    h('input', { class: 'input', id: 'to-new-name', type: 'text', maxLength: MAX_SET_NAME, value: newName, onInput: (e) => setNewName(e.currentTarget.value) })
                  ),
                  h('div', { class: 'tool-ov__field-group' },
                    h('span', { class: 'tool-ov__label', id: 'to-new-from-label' }, 'Start from'),
                    h('div', { class: 'tool-ov__choices', role: 'radiogroup', 'aria-labelledby': 'to-new-from-label' },
                      [['builtin', 'Copy of Built-in', 'Every tool’s current description, frozen.']]
                        .concat(setIds.map((id) => ['set:' + id, 'Copy of ' + sets[id].name, 'Everything in that set, unsaved edits included.']))
                        .concat([['empty', 'Empty', 'Uses the built-in wording for every tool until you edit one.']])
                        .map(([key, label, hint]) => h('label', { key, class: 'tool-ov__choice' },
                          h('input', { type: 'radio', name: 'to-new-from', value: key, checked: newFrom === key, onChange: () => openNew(key) }),
                          h('span', null, h('span', { class: 'tool-ov__choice-label' }, label), h('span', { class: 'settings-project__item-note' }, hint))
                        ))
                    )
                  ),
                  h('div', { class: 'tool-ov__actions tool-ov__actions--end' },
                    h('button', { class: 'btn', type: 'button', onClick: () => setPanel('') }, 'Cancel'),
                    h('button', { class: 'btn btn--primary', type: 'button', disabled: !newName.trim(), onClick: createSet }, 'Create set')
                  )
                )
                : null,

              panel === 'import'
                ? h('div', { class: 'tool-ov__card' },
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
                    h('button', { class: 'btn btn--primary', type: 'button', disabled: !importText.trim(), onClick: applyImport }, 'Import as new set')
                  )
                )
                : null,

              // The chosen set's card steps aside while a form is open.
              chosen && !panel
                ? h('div', { class: 'tool-ov__card' + (draft.active === editingId ? ' tool-ov__card--default' : '') },
                  h('div', { class: 'tool-ov__card-head' },
                    h('span', { class: 'tool-ov__card-title' }, chosen.name || 'Untitled'),
                    draft.active === editingId
                      ? h('span', { class: 'tool-ov__badge' }, 'default for chats')
                      : h('button', { class: 'btn btn--primary', type: 'button', onClick: () => makeDefault(editingId) }, 'Make default')
                  ),
                  h('div', { class: 'settings-project__item-note' },
                    tools ? (chosenDiffering + ' of ' + tools.length + ' tools differ from built-in · ' + Object.keys(chosen.tools).length + ' in this set') : ''),
                  h('div', { class: 'tool-ov__field-group' },
                    h('label', { class: 'tool-ov__label', for: 'to-set-name' }, 'Name'),
                    h('input', {
                      class: 'input', id: 'to-set-name', type: 'text', maxLength: MAX_SET_NAME, value: chosen.name,
                      onInput: (e) => renameSet(editingId, e.currentTarget.value),
                      onBlur: () => settleName(editingId)
                    })
                  ),
                  h('div', { class: 'tool-ov__actions' },
                    h('button', { class: 'btn', type: 'button', disabled: setIds.length >= MAX_SETS, onClick: () => openNew('set:' + editingId) }, 'Duplicate'),
                    h('button', { class: 'btn', type: 'button', onClick: () => copyExport(editingId) }, 'Copy JSON'),
                    h('button', { class: 'btn', type: 'button', onClick: () => downloadExport(editingId) }, 'Download'),
                    h('span', { class: 'tool-ov__spacer' }),
                    h('button', { class: 'btn btn--danger', type: 'button', onClick: () => deleteSet(editingId) }, 'Delete set')
                  )
                )
                : null
            )
          )
        )
      ),

      // ---- Tabs over the tool list: what the rows show ----
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'tool-ov__tabs', role: 'tablist', 'aria-label': 'Wording to show' },
          tabs.map(([key, label]) => h('button', {
            key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === key ? 'true' : 'false',
            class: 'tool-ov__tab' + (tab === key ? ' tool-ov__tab--on' : ''),
            onClick: () => setTab(key)
          },
            label,
            key === usedTab ? h('span', { class: 'tool-ov__tab-dot', title: 'Default for chats', 'aria-label': '(default for chats)' }) : null
          ))
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            tab === 'builtin'
              ? h('div', { class: 'settings-project__item-note' }, 'The wording each tool ships with. Read-only — create a set above to change it.')
              : null,
            tab === 'set' && !editing
              ? h('div', { class: 'settings-project__item-note' }, 'No set yet — create or import one above.')
              : null,
            tab === 'compare'
              ? h('div', { class: 'tool-ov__pair' },
                h(SetSelect, { id: 'to-cmp-a', value: compareLeft, sets, label: 'Compare from', onChange: setCompareLeft }),
                h('button', { class: 'btn', type: 'button', 'aria-label': 'Swap sides', onClick: () => { setCompareLeft(compareRight); setCompareRight(compareLeft); } }, '⇄'),
                h(SetSelect, { id: 'to-cmp-b', value: compareRight, sets, label: 'Compare to', onChange: setCompareRight }),
                h('span', { class: 'settings-project__item-note' }, tools ? differingCount + ' tools differ' : '')
              )
              : null,
            tab === 'set' && !editing ? null : h('input', {
              class: 'input',
              type: 'search',
              value: query,
              placeholder: 'Search tools',
              'aria-label': 'Search tools',
              onInput: (e) => setQuery(e.currentTarget.value)
            }),
            tab === 'compare' || editing
              ? h('label', { class: 'tool-ov__filter' },
                h('input', { type: 'checkbox', checked: onlyDiffering, onChange: (e) => setOnlyDiffering(e.currentTarget.checked) }),
                tab === 'compare' ? ' Show only tools that differ' : ' Show only tools that differ from built-in'
              )
              : null
          )
        ),
        tools
          ? h('div', { class: 'tool-ov__list' },
            shown.length
              ? shown.map((tool) => {
                const mode = tab === 'compare' ? 'compare' : editing ? 'set' : 'builtin';
                const entry = mode === 'set' ? editing.tools[tool.name] : undefined;
                return h(ToolRow, {
                  key: tool.name + '|' + tab + '|' + (tab === 'set' ? editingId : '') + '|' + generation + '|' + (revs[tool.name] || 0),
                  tool,
                  mode,
                  entry,
                  left: entryOf(compareLeft, tool.name),
                  right: entryOf(compareRight, tool.name),
                  leftLabel: labelOf(compareLeft),
                  rightLabel: labelOf(compareRight),
                  badge: mode === 'set' ? (differsFromBuiltIn(tool, entry) ? 'changed' : '') : mode === 'compare' ? (differs(tool) ? 'differs' : '') : '',
                  dirty: mode === 'set' && dirtyTools.has(tool.name),
                  open: !!openRows[tool.name],
                  onToggle: toggleRow,
                  onChange: updateTool,
                  onRevert: revertTool
                });
              })
              : tab === 'set' && !editing ? null : h('div', { class: 'settings-project__item-note tool-ov__empty' }, onlyDiffering && !query ? 'No tool differs.' : 'No tool matches.'))
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
