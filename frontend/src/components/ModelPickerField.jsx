// mouaif web — shared model picker field
//
// A Preact version of the chat top bar's model picker: a two-line
// trigger (model id over provider id) that opens the same modal the
// chat head shows — search input, per-provider filter chips, model
// sections grouped by provider, a refresh button, and an inline
// empty-state card. It is the drop-in replacement for the old single
// <select> model dropdowns that only listed project model ids.
//
// Used by:
//   - the subagent authorization card (project + live catalog union)
//   - the Settings → Project → Agents editor (project models only)
//
// It intentionally reuses the chat picker's look (same class shapes)
// but is self-contained: no dependency on the chat state hook or the
// imperative chat picker module. Pinned / recently-used bookmarks are
// a chat-history concept and are NOT shown here.
import { h } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';

// modelsForField(list) — normalize a flat model list into
// { id, provider, label } rows, dropping falsy entries and defaulting
// a missing provider to '' (rendered under an "Other" section).
function normalizeModels(list) {
const out = new Map();
for (const m of (list || [])) {
if (!m || !m.id) continue;
const provider = m.provider || '';
const key = provider + '\u0000' + m.id;
if (out.has(key)) continue;
out.set(key, { id: m.id, provider, label: m.label || '' });
}
return Array.from(out.values());
}

// groupByProvider(rows) — [{ provider, items }] sorted by provider,
// each section's items sorted by id. '' provider becomes 'Other'.
function groupByProvider(rows) {
const map = new Map();
for (const m of rows) {
const bucket = map.get(m.provider) || [];
bucket.push(m);
map.set(m.provider, bucket);
}
const out = [];
for (const [provider, items] of map) {
items.sort((a, b) => a.id.localeCompare(b.id));
out.push({ provider, items });
}
out.sort((a, b) => (a.provider || 'Other').localeCompare(b.provider || 'Other'));
return out;
}

function matches(m, q) {
if (!q) return true;
return (m.id || '').toLowerCase().indexOf(q) >= 0
|| (m.label || '').toLowerCase().indexOf(q) >= 0;
}

// ModelPickerField
//
// props:
//   models       — array of { id, provider?, label? } (initial list)
//   getModels    — optional () => fresh list, re-read after refresh
//   value        — { providerId, modelId } | null | undefined
//   onChange     — (selection | null) => void
//   allowClear   — bool, show a "clear/inherit" action row at the top
//   clearLabel   — string for that row (default "Inherit chat model")
//   placeholder  — trigger text when no value and no clear row
//   label        — optional field label above the trigger
//   refresh      — optional async () => {} to re-fetch the catalog
//   refreshEmpty — optional status text for the no-models empty state
//   disabled     — bool
//   ariaLabel    — trigger aria-label (default "Pick model")
export function ModelPickerField(props) {
const {
models,
getModels,
value,
onChange,
allowClear = false,
clearLabel = 'Inherit chat model',
placeholder = 'Pick a model',
label,
refresh,
refreshEmpty = 'Refresh models',
disabled = false,
ariaLabel = 'Pick model'
} = props;

const [list, setList] = useState(() => normalizeModels(models));
const [open, setOpen] = useState(false);
const [q, setQ] = useState('');
const [providerFilter, setProviderFilter] = useState('all');
const [refreshing, setRefreshing] = useState(false);
const rootRef = useRef(null);
const searchRef = useRef(null);

const [sel, setSel] = useState(() =>
(value && (value.providerId || value.modelId))
? { providerId: value.providerId || '', modelId: value.modelId || '' }
: null);

// Sync the displayed selection whenever the parent hands us a new value
// (the Agents editor re-renders with a fresh modelId; the authorization
// card keeps its selection in a closure and only mutates it here).
useEffect(() => {
setSel((value && (value.providerId || value.modelId))
? { providerId: value.providerId || '', modelId: value.modelId || '' }
: null);
}, [value]);

// Refresh the local list whenever the parent hands us a new model set
// (relevant for the reactive Agents editor) and after a refresh() call.
useEffect(() => {
setList(normalizeModels(models));
}, [models]);

// Close on outside click and Escape.
useEffect(() => {
if (!open) return;
const onDocClick = (ev) => {
if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false);
};
const onKey = (ev) => {
if (ev.key === 'Escape') setOpen(false);
};
document.addEventListener('mousedown', onDocClick);
document.addEventListener('touchstart', onDocClick);
document.addEventListener('keydown', onKey);
return () => {
document.removeEventListener('mousedown', onDocClick);
document.removeEventListener('touchstart', onDocClick);
document.removeEventListener('keydown', onKey);
};
}, [open]);

// Focus the search input when the sheet opens.
useEffect(() => {
if (open && searchRef.current) searchRef.current.focus();
}, [open]);

const providers = useMemo(() => {
const set = [];
for (const m of list) {
if (m.provider && set.indexOf(m.provider) < 0) set.push(m.provider);
}
return set.sort((a, b) => a.localeCompare(b));
}, [list]);

const counts = useMemo(() => {
const c = { all: list.length };
for (const m of list) c[m.provider] = (c[m.provider] || 0) + 1;
return c;
}, [list]);

const filtered = useMemo(() => {
let rows = list;
if (providerFilter !== 'all') rows = rows.filter((m) => m.provider === providerFilter);
const qq = q.trim().toLowerCase();
if (qq) rows = rows.filter((m) => matches(m, qq));
return rows;
}, [list, providerFilter, q]);

const groups = useMemo(() => groupByProvider(filtered), [filtered]);

const selectedKey = sel ? (sel.providerId + '\u0000' + sel.modelId) : null;

function pick(m) {
setOpen(false);
setSel({ providerId: m.provider, modelId: m.id });
if (onChange) onChange({ providerId: m.provider, modelId: m.id });
}

function pickClear() {
setOpen(false);
setSel(null);
if (onChange) onChange(null);
}

async function doRefresh() {
if (!refresh) return;
setRefreshing(true);
try {
await refresh();
if (getModels) setList(normalizeModels(getModels()));
} finally {
setRefreshing(false);
}
}

const trigId = sel ? sel.modelId : (allowClear ? clearLabel : placeholder);
const trigProvider = sel ? sel.providerId : '';
const isEmpty = !sel && !allowClear;

return h('div', { class: 'mp', ref: rootRef },
label ? h('label', { class: 'mp__label' }, label) : null,
h('button', {
type: 'button',
class: 'mp__trigger' + (isEmpty ? ' is-empty' : '') + (!list.length ? ' is-empty' : ''),
disabled: !!disabled,
'aria-label': ariaLabel,
'aria-haspopup': 'dialog',
'aria-expanded': String(open),
onClick: () => setOpen((v) => !v)
},
h('span', { class: 'mp__stack' },
h('span', { class: 'mp__id' }, trigId),
h('span', { class: 'mp__provider' }, trigProvider)
),
h('span', { class: 'mp__caret', 'aria-hidden': 'true' }, '▾')
),
open ? h('div', { class: 'mp__pop', role: 'dialog', 'aria-label': ariaLabel },
h('div', { class: 'mp__head' },
h('input', {
ref: searchRef,
class: 'mp__search',
type: 'search',
placeholder: 'Search models',
'aria-label': 'Search models',
value: q,
onInput: (e) => setQ(e.currentTarget.value)
}),
refresh ? h('button', {
type: 'button',
class: 'mp__refresh',
'aria-label': 'Refresh model lists',
title: 'Refresh model lists',
disabled: refreshing,
onClick: doRefresh
},
h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
)
) : null,
h('button', {
type: 'button',
class: 'mp__close',
'aria-label': 'Close',
title: 'Close',
onClick: () => setOpen(false)
}, '×')
),
providers.length ? h('div', { class: 'mp__chips', role: 'tablist', 'aria-label': 'Filter by provider' },
[{ id: 'all', label: 'All' }].concat(providers.map((p) => ({ id: p, label: p }))).map((c) =>
h('button', {
key: c.id,
type: 'button',
class: 'mp__chip' + (providerFilter === c.id ? ' is-active' : ''),
onClick: () => setProviderFilter(c.id)
},
h('span', { class: 'mp__chip-label' }, c.label),
h('span', { class: 'mp__chip-count' }, String(counts[c.id] || 0))
)
)
) : null,
h('div', { class: 'mp__list' },
allowClear ? h('div', {
class: 'mp__clear' + (!sel ? ' is-active' : ''),
role: 'button',
tabindex: '0',
onClick: pickClear
},
h('span', { class: 'mp__clear-id' }, clearLabel),
h('span', { class: 'mp__clear-meta' }, 'use the default')
) : null,
!groups.length ? h('div', { class: 'mp__empty' },
h('p', { class: 'mp__empty-title' }, q ? 'No matches' : (list.length ? 'No models for this provider' : 'No models yet')),
h('p', { class: 'mp__empty-text' }, q
? 'No model matches "' + q + '". Try a shorter query or clear the search.'
: refreshEmpty),
refresh ? h('button', {
type: 'button',
class: 'mp__empty-action',
disabled: refreshing,
onClick: doRefresh
}, refreshing ? 'Refreshing…' : refreshEmpty) : null
) : groups.map((g) =>
h('section', { class: 'mp__section', key: g.provider || 'other' },
h('div', { class: 'mp__section-head' },
h('span', { class: 'mp__section-title' }, g.provider || 'Other'),
h('span', { class: 'mp__section-count' }, String(g.items.length))
),
g.items.map((m) => {
const key = m.provider + '\u0000' + m.id;
return h('div', {
key,
class: 'mp__row' + (key === selectedKey ? ' is-active' : ''),
role: 'button',
tabindex: '0',
onClick: () => pick(m)
},
h('span', { class: 'mp__row-id' }, m.id),
m.label && m.label !== m.id ? h('span', { class: 'mp__row-label' }, m.label) : null,
h('span', { class: 'mp__row-meta' }, m.provider || '')
);
})
)
)
)
) : null
);
}

export { normalizeModels, groupByProvider };
