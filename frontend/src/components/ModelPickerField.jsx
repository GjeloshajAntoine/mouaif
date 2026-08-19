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
//   - the chat top bar (pinned/recent sections, sheet variant,
//     max-output slot, iOS keyboard + scroll handling)
//   - the subagent authorization card (project + live catalog union)
//   - the Settings → Project → Agents editor (project models only)
//
// It is self-contained: no dependency on the chat state hook or the
// imperative chat picker module. Bookmark state (pinned/recent) is
// owned by the caller and passed in, so the field stays a pure view.
import { h } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';

// modelsForField(list) — normalize a flat model list into
// { id, provider, label, ghost } rows, dropping falsy entries and
// defaulting a missing provider to '' (rendered under an "Other"
// section). `ghost` marks an active model that is no longer in the
// catalog so the picker can still surface + clear it.
function normalizeModels(list) {
  const out = new Map();
  for (const m of (list || [])) {
    if (!m || !m.id) continue;
    const provider = m.provider || '';
    const key = provider + '\u0000' + m.id;
    if (out.has(key)) continue;
    out.set(key, { id: m.id, provider, label: m.label || '', ghost: !!m.ghost });
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

function keyOf(m) {
  return (m.provider || '') + '\u0000' + m.id;
}

// Pin glyph (filled when pinned, outline otherwise). Mirrors the old
// imperative chat picker's icon.
function PinIcon({ pinned }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true',
    fill: pinned ? 'currentColor' : 'none',
    stroke: pinned ? 'none' : 'currentColor',
    'stroke-width': pinned ? 0 : 2
  },
  h('path', { d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' })
  );
}

// ModelPickerField
//
// props:
//   models          — array of { id, provider?, label?, ghost? }
//   value           — controlled { providerId, modelId } selection
//   onChange        — (selection | null) => void; parent updates value
//   allowClear      — bool, show a "clear/inherit" action row at the top
//   clearLabel      — string for that row (default "Inherit chat model")
//   placeholder     — trigger text when no value and no clear row
//   noProviders     — bool, style the trigger as "no providers configured"
//   label           — optional field label above the trigger
//   refresh         — optional async () => {} to re-fetch the catalog
//   refreshEmpty    — optional status text for the no-models empty state
//   disabled        — bool
//   ariaLabel       — trigger aria-label (default "Pick model")
//   className       — extra class on the root `.mp` element
//   variant         — 'dropdown' | 'sheet' | 'chat'; both sheet variants
//                     use the chat picker's mobile viewport modal, while
//                     'chat' also applies the compact top-bar trigger layout
//   pinned          — Set<string> of "providerId\0modelId" bookmarks
//   onTogglePin     — (model) => void, shown when provided (pin button)
//   recent          — Array<{ provider, id, ts }> recency, newest first
//   extraProviders  — Array<string> provider ids to show as chips even
//                     when they currently have zero models
//   onOpen          — () => void, called when the sheet opens
//   children        — optional slot rendered between the head and chips
export function ModelPickerField(props) {
  const {
    models,
    value,
    onChange,
    allowClear = false,
    clearLabel = 'Inherit chat model',
    placeholder = 'Pick a model',
    noProviders = false,
    label,
    refresh,
    refreshEmpty = 'Refresh models',
    disabled = false,
    ariaLabel = 'Pick model',
    className,
    variant = 'dropdown',
    open: controlledOpen,
    onOpenChange,
    pinned,
    onTogglePin,
    recent,
    extraProviders,
    onOpen,
    children
  } = props;

  const list = useMemo(() => normalizeModels(models), [models]);
  const [open, setOpen] = useState(false);
  // Support both uncontrolled (internal state, the default for the auth
  // card / Agents editor) and controlled (chat head's `open` +
  // onOpenChange so stream.js can force it open when the chat has no
  // model). When a controlled `open` prop is present it wins.
  const isControlled = typeof controlledOpen === 'boolean';
  const effectiveOpen = isControlled ? controlledOpen : open;
  function setEffectiveOpen(v) {
    if (isControlled) { if (onOpenChange) onOpenChange(v); }
    else setOpen(v);
  }
  const [q, setQ] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const rootRef = useRef(null);
  const popRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const triggerRef = useRef(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const isSheet = variant === 'sheet' || variant === 'chat';
  // Selection and models are controlled props. Keep only transient UI
  // concerns (open/search/filter/refreshing) as local component state.
  const sel = (value && (value.providerId || value.modelId))
    ? { providerId: value.providerId || '', modelId: value.modelId || '' }
    : null;

  // Close on outside click and Escape. Returning focus to the trigger
  // keeps the sheet modal usable with a hardware keyboard as well as touch.
  useEffect(() => {
    if (!effectiveOpen) return;
    const close = () => {
      setEffectiveOpen(false);
      requestAnimationFrame(() => triggerRef.current && triggerRef.current.focus());
    };
    const onDocClick = (ev) => {
      if (rootRef.current && !rootRef.current.contains(ev.target)) close();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [effectiveOpen]);

  // Call the open hook after the first paint, then focus search. Keeping
  // these in that order lets callers populate a live catalog without the
  // component reading stale models during the opening event.
  useEffect(() => {
    if (!effectiveOpen) {
      setOptionsOpen(false);
      return;
    }
    if (onOpenRef.current) onOpenRef.current();
    requestAnimationFrame(() => searchRef.current && searchRef.current.focus());
  }, [effectiveOpen]);

  // iOS keyboard + background-scroll handling for the fixed sheet
  // variant. Mirrors the imperative syncKeyboardInset /
  // bindPickerScrollLock the chat head used to run.
  useEffect(() => {
    if (!effectiveOpen || !isSheet) return;
    const pop = popRef.current;
    if (!pop) return;
    const vv = window.visualViewport;
    const sync = () => {
      if (!vv || !vv.height) {
        pop.style.removeProperty('--model-picker-viewport-height');
        pop.style.removeProperty('--model-picker-viewport-top');
        pop.style.removeProperty('--model-picker-keyboard-inset');
        return;
      }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      pop.style.setProperty('--model-picker-viewport-height', vv.height.toFixed(0) + 'px');
      pop.style.setProperty('--model-picker-viewport-top', Math.max(0, vv.offsetTop).toFixed(0) + 'px');
      pop.style.setProperty('--model-picker-keyboard-inset', inset.toFixed(0) + 'px');
    };
    const onFocusIn = (ev) => {
      if (ev.target && searchRef.current && ev.target === searchRef.current) sync();
    };
    const onFocusOut = (ev) => {
      if (ev.target && searchRef.current && ev.target === searchRef.current) setTimeout(sync, 0);
    };
    if (vv) {
      vv.addEventListener('resize', sync);
      vv.addEventListener('scroll', sync);
    }
    window.addEventListener('orientationchange', sync);
    pop.addEventListener('focusin', onFocusIn);
    pop.addEventListener('focusout', onFocusOut);
    sync();

    // Scroll lock: keep the background transcript from scrolling while
    // the sheet's list is being dragged (and vice-versa).
    let startY = 0;
    const onTouchStart = (ev) => {
      if (ev.touches && ev.touches.length === 1) startY = ev.touches[0].clientY;
    };
    const onTouchMove = (ev) => {
      if (!ev.touches || ev.touches.length !== 1) return;
      const t = ev.target;
      if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, button')) return;
      const scroller = listRef.current && listRef.current.contains(t) ? listRef.current : null;
      if (!scroller) { ev.preventDefault(); return; }
      const dy = ev.touches[0].clientY - startY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight;
      if (scroller.scrollHeight <= scroller.clientHeight || (atTop && dy > 0) || (atBottom && dy < 0)) {
        ev.preventDefault();
      }
    };
    pop.addEventListener('touchstart', onTouchStart, { passive: true });
    pop.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      if (vv) {
        vv.removeEventListener('resize', sync);
        vv.removeEventListener('scroll', sync);
      }
      window.removeEventListener('orientationchange', sync);
      pop.removeEventListener('focusin', onFocusIn);
      pop.removeEventListener('focusout', onFocusOut);
      pop.removeEventListener('touchstart', onTouchStart);
      pop.removeEventListener('touchmove', onTouchMove);
      pop.style.removeProperty('--model-picker-viewport-height');
      pop.style.removeProperty('--model-picker-viewport-top');
      pop.style.removeProperty('--model-picker-keyboard-inset');
    };
  }, [effectiveOpen, isSheet]);

  const providers = useMemo(() => {
    const set = [];
    for (const m of list) {
      if (m.provider && set.indexOf(m.provider) < 0) set.push(m.provider);
    }
    for (const p of (extraProviders || [])) {
      if (p && set.indexOf(p) < 0) set.push(p);
    }
    return set.sort((a, b) => a.localeCompare(b));
  }, [list, extraProviders]);

  const counts = useMemo(() => {
    const c = { all: list.length };
    for (const m of list) c[m.provider] = (c[m.provider] || 0) + 1;
    for (const p of (extraProviders || [])) if (p && c[p] === undefined) c[p] = 0;
    return c;
  }, [list, extraProviders]);

  const filtered = useMemo(() => {
    let rows = list;
    if (providerFilter !== 'all') rows = rows.filter((m) => m.provider === providerFilter);
    const qq = q.trim().toLowerCase();
    if (qq) rows = rows.filter((m) => matches(m, qq));
    return rows;
  }, [list, providerFilter, q]);

  const groups = useMemo(() => groupByProvider(filtered), [filtered]);
  const selectedKey = sel ? (sel.providerId + '\u0000' + sel.modelId) : null;
  const showingFullList = providerFilter === 'all' && !q.trim().toLowerCase();

  function closeAndRestoreFocus() {
    setEffectiveOpen(false);
    requestAnimationFrame(() => triggerRef.current && triggerRef.current.focus());
  }
  function pick(m) {
    closeAndRestoreFocus();
    if (onChange) onChange({ providerId: m.provider, modelId: m.id });
  }
  function pickClear() {
    closeAndRestoreFocus();
    if (onChange) onChange(null);
  }
  async function doRefresh() {
    if (!refresh) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const trigId = sel ? sel.modelId : (allowClear ? clearLabel : placeholder);
  const trigProvider = sel ? sel.providerId : (noProviders ? 'add a provider in Settings → Providers' : '');
  const isEmpty = !sel && !allowClear;
  const rootClass = 'mp'
    + (className ? ' ' + className : '')
    + (variant === 'chat' ? ' mp--chat mp--sheet' : (variant === 'sheet' ? ' mp--sheet' : ''));

  return h('div', { class: rootClass, ref: rootRef },
    label ? h('label', { class: 'mp__label' }, label) : null,
    h('button', {
      ref: triggerRef,
      type: 'button',
      class: 'mp__trigger' + (isEmpty ? ' is-empty' : '') + (noProviders ? ' no-providers' : '') + (!list.length && !noProviders ? ' is-empty' : ''),
      disabled: !!disabled,
      'aria-label': ariaLabel,
      'aria-haspopup': 'dialog',
      'aria-expanded': String(effectiveOpen),
      onClick: () => setEffectiveOpen(!effectiveOpen)
    },
    h('span', { class: 'mp__stack' },
      h('span', { class: 'mp__id' }, trigId),
      h('span', { class: 'mp__provider' }, trigProvider)
    ),
    h('span', { class: 'mp__caret', 'aria-hidden': 'true' }, '▾')
    ),
    effectiveOpen ? h('div', {
      class: 'mp__pop',
      role: 'dialog',
      'aria-modal': isSheet ? 'true' : undefined,
      'aria-label': ariaLabel,
      ref: popRef
    },
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
        children ? h('button', {
          type: 'button',
          class: 'mp__options' + (optionsOpen ? ' is-active' : ''),
          'aria-label': optionsOpen ? 'Hide model options' : 'Show model options',
          title: 'Model options',
          'aria-expanded': String(optionsOpen),
          onClick: () => setOptionsOpen(!optionsOpen)
        },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'currentColor', 'aria-hidden': 'true' },
          h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z' })
        )
        ) : null,
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
      onClick: closeAndRestoreFocus
        }, '×')
      ),
      children ? h('div', {
        class: 'mp__options-panel',
        hidden: !optionsOpen
      }, children) : null,
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
      h('div', { class: 'mp__list', ref: listRef },
        allowClear ? h('div', {
          class: 'mp__clear' + (!sel ? ' is-active' : ''),
          role: 'button',
          tabindex: '0',
          onClick: pickClear
        },
h('span', { class: 'mp__clear-id' }, clearLabel)
) : null,
        showingFullList && pinned ? renderBookmarkSection('Pinned', list.filter((m) => pinned.has(keyOf(m)))) : null,
        showingFullList && recent ? renderRecentSection(recent, list, pinned) : null,
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
              const key = keyOf(m);
              return h('div', {
                key,
                class: 'mp__row' + (key === selectedKey ? ' is-active' : '') + (m.ghost ? ' is-ghost' : ''),
                role: 'button',
                tabindex: '0',
                onClick: () => pick(m)
              },
              !m.ghost && onTogglePin ? h('button', {
                type: 'button',
                class: 'mp__pin',
                'aria-label': 'Pin model',
                'aria-pressed': pinned && pinned.has(key) ? 'true' : 'false',
                onClick: (ev) => { ev.stopPropagation(); onTogglePin(m); }
              }, h(PinIcon, { pinned: pinned && pinned.has(key) })) : null,
              h('span', { class: 'mp__row-id' }, m.id),
              m.label && m.label !== m.id ? h('span', { class: 'mp__row-label' }, m.label) : null,
              h('span', { class: 'mp__row-meta' }, m.ghost ? 'unavailable' : (m.provider || ''))
              );
            })
          )
        )
      )
    ) : null
  );

  function renderBookmarkSection(title, items) {
    if (!items.length) return null;
    return h('section', { class: 'mp__section', key: title.toLowerCase() },
      h('div', { class: 'mp__section-head' },
        h('span', { class: 'mp__section-title' }, title),
        h('span', { class: 'mp__section-count' }, String(items.length))
      ),
      items.map((m) => {
        const key = keyOf(m);
        return h('div', {
          key,
          class: 'mp__row' + (key === selectedKey ? ' is-active' : ''),
          role: 'button',
          tabindex: '0',
          onClick: () => pick(m)
        },
        onTogglePin ? h('button', {
          type: 'button',
          class: 'mp__pin',
          'aria-label': 'Pin model',
          'aria-pressed': pinned && pinned.has(key) ? 'true' : 'false',
          onClick: (ev) => { ev.stopPropagation(); onTogglePin(m); }
        }, h(PinIcon, { pinned: pinned && pinned.has(key) })) : null,
        h('span', { class: 'mp__row-id' }, m.id),
        m.label && m.label !== m.id ? h('span', { class: 'mp__row-label' }, m.label) : null,
        h('span', { class: 'mp__row-meta' }, m.provider || '')
        );
      })
    );
  }

  function renderRecentSection(recentItems, fullList, pinnedSet) {
    if (!recentItems.length) return null;
    const seen = new Set();
    const rows = [];
    for (const r of recentItems) {
      const key = (r.provider || '') + '\u0000' + r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = fullList.find((x) => (x.provider || '') === (r.provider || '') && x.id === r.id);
      if (m && !(pinnedSet && pinnedSet.has(key))) rows.push(m);
      if (rows.length >= 5) break;
    }
    if (!rows.length) return null;
    return renderBookmarkSection('Recent', rows);
  }
}

export { normalizeModels, groupByProvider };
