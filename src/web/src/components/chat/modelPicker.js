// mouaif web — Chat model picker
//
// The picker replaces the old provider + model <select>s + refresh
// icon. The trigger button shows the current model id and provider
// and opens the picker; the popover holds a search input, an
// All/<provider> filter, one section per provider, and a header
// refresh button.

import { fetchJson, fetchLiveModels, invalidateModelsCache } from '../../api.js';

// mergeModelLists(projectList, liveList) — dedupes by id, project
// entries win on conflict (user-defined slugs preserve their label
// / provider). Sort is alphabetical by id. Returned shape mirrors
// /api/ai/models: { id, provider, label, auth }.
export function mergeModelLists(projectList, liveList) {
  const out = new Map();
  for (const m of (projectList || [])) {
    if (m && m.id) out.set(m.id, m);
  }
  for (const m of (liveList || [])) {
    if (!m || !m.id) continue;
    if (!out.has(m.id)) out.set(m.id, m);
  }
  return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// groupModelsByProvider(list) — groups a flat model list into an
// array of { provider, items: [..] } sorted alphabetically by
// provider, with each section's items sorted by id. Empty / falsy
// entries are dropped. Used by the model-picker popover to render
// one section per provider.
export function groupModelsByProvider(list) {
  const map = new Map();
  for (const m of (list || [])) {
    if (!m || !m.id || !m.provider) continue;
    let bucket = map.get(m.provider);
    if (!bucket) { bucket = []; map.set(m.provider, bucket); }
    bucket.push(m);
  }
  const out = [];
  for (const [provider, items] of map) {
    items.sort((a, b) => a.id.localeCompare(b.id));
    out.push({ provider, items });
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

// activeProviderId(state) -> string
export function activeProviderId(state) {
  const c = state.chat;
  return c && c.providerId ? c.providerId : '';
}

// modelsForPicker(state) -> [{ id, provider, label }]
//
// Flat list of { id, provider, label } for the model-picker
// popover. Built from the union of the per-provider live cache
// and the project-level models, deduped by (provider, id) with
// project entries winning. Empty / falsy rows are dropped.
export function modelsForPicker(state) {
  const out = new Map();
  for (const m of (state.models || [])) {
    if (!m || !m.id || !m.provider) continue;
    out.set(m.provider + '\u0000' + m.id, { id: m.id, provider: m.provider, label: m.label });
  }
  const live = state.liveByProvider || {};
  for (const provider of Object.keys(live)) {
    for (const m of (live[provider] || [])) {
      if (!m || !m.id) continue;
      const key = provider + '\u0000' + m.id;
      if (out.has(key)) continue;
      out.set(key, { id: m.id, provider, label: m.label });
    }
  }
  return Array.from(out.values());
}

// updateModelTrigger(refs, state)
//
// Refresh the label on the picker trigger button (the head element
// that opens the picker). Two lines: the model id (or "(pick a
// model)") and the provider id (or empty). Falls back to "no
// providers" when the chat has no providers configured.
export function updateModelTrigger(refs, state) {
  const trig = refs.modelPickerTrigger.current;
  if (!trig) return;
  const c = state.chat;
  const modelId = c && c.modelId ? c.modelId : '';
  const providerId = c && c.providerId ? c.providerId : '';
  const idEl = trig.querySelector('.chat-view__model-id');
  const provEl = trig.querySelector('.chat-view__model-provider');
  if (idEl) idEl.textContent = modelId || '(pick a model)';
  if (provEl) provEl.textContent = providerId || (state.providers.length ? '' : 'add a provider in Settings → Providers');
  trig.classList.toggle('is-empty', !modelId);
  trig.classList.toggle('no-providers', !state.providers.length);
}

// updatePickerChips(state, refs, visibleList, activeFilter)
//
// Set the .is-active class on the right filter chip and append
// the per-provider model count. Counts reflect the unfiltered
// list (q is ignored) so the user can see how many models each
// provider has regardless of the search.
export function updatePickerChips(state, refs, visibleList, activeFilter) {
  const pop = refs.modelPickerPop.current;
  if (!pop) return;
  const chipsHost = pop.querySelector('.chat-view__picker-chips');
  if (!chipsHost) return;
  const all = modelsForPicker(state);
  const counts = { all: all.length };
  for (const m of all) counts[m.provider] = (counts[m.provider] || 0) + 1;
  const providers = state.providers.map((p) => p && p.id).filter(Boolean);
  // Make sure every provider that already has models shows up,
  // even if it has zero live entries (so the user can still
  // refresh that section).
  for (const p of providers) if (!counts.hasOwnProperty(p)) counts[p] = 0;
  const chips = [
    { id: 'all', label: 'All' },
    ...providers.map((p) => ({ id: p, label: p }))
  ];
  chipsHost.innerHTML = '';
  for (const c of chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-view__picker-chip';
    if (c.id === activeFilter) chip.classList.add('is-active');
    const label = document.createElement('span');
    label.className = 'chat-view__picker-chip-label';
    label.textContent = c.label;
    const count = document.createElement('span');
    count.className = 'chat-view__picker-chip-count';
    count.textContent = String(counts[c.id] || 0);
    chip.appendChild(label); chip.appendChild(count);
    chip.addEventListener('click', (ev) => {
      // Stop the click from bubbling to the document-level
      // outside-click handler: renderModelPicker() removes the
      // chip from the DOM (chipsHost.innerHTML = ''), and once
      // the click reaches `document` e.target is no longer a
      // descendant of the popover, which the handler would read
      // as "clicked outside — close". Stopping propagation
      // short-circuits that path; the chip's effect is the
      // filter change plus a popover re-render that stays open.
      ev.stopPropagation();
      state.pickerFilter = { q: state.pickerFilter.q, provider: c.id };
      renderModelPicker(state, refs);
    });
    chipsHost.appendChild(chip);
  }
}

// renderModelPicker(state, refs)
//
// Rebuild the popover list section. The search input + provider
// filter chips are static markup; this only updates the scrollable
// list area. Called when the picker opens, when the user types,
// when the provider filter changes, after a refresh, and after a
// chat save that changes the active selection.
export function renderModelPicker(state, refs) {
  const list = refs.modelPickerList.current;
  if (!list) return;
  list.innerHTML = '';
  const f = state.pickerFilter || { q: '', provider: 'all' };
  const q = (f.q || '').trim().toLowerCase();
  const providerFilter = f.provider || 'all';
  let all = modelsForPicker(state);
  if (providerFilter !== 'all') all = all.filter((m) => m.provider === providerFilter);
  if (q) all = all.filter((m) => (m.id || '').toLowerCase().indexOf(q) >= 0 || (m.label || '').toLowerCase().indexOf(q) >= 0);
  const groups = groupModelsByProvider(all);
  // If the active provider is not in the list (e.g. the chat
  // references a model that's no longer available) still surface
  // it as a virtual "current" section so the user can see what
  // they had and either re-pick it or clear it.
  const c = state.chat;
  if (c && c.providerId && c.modelId && !all.some((m) => m.id === c.modelId && m.provider === c.providerId)) {
    groups.unshift({ provider: c.providerId, items: [{ id: c.modelId, provider: c.providerId, label: '', ghost: true }] });
  }
  // Update the filter chips to show counts (so the user knows how
  // many models live behind each chip without opening it).
  updatePickerChips(state, refs, all, providerFilter);
  if (!groups.length) {
    renderPickerEmpty(state, refs, list, q, providerFilter);
    return;
  }
  const activeProvider = c && c.providerId ? c.providerId : '';
  const activeModel = c && c.modelId ? c.modelId : '';
  for (const g of groups) {
    const section = document.createElement('section');
    section.className = 'chat-view__picker-section';
    const header = document.createElement('div');
    header.className = 'chat-view__picker-section-head';
    const title = document.createElement('span');
    title.className = 'chat-view__picker-section-title';
    title.textContent = g.provider;
    const count = document.createElement('span');
    count.className = 'chat-view__picker-section-count';
    count.textContent = String(g.items.length);
    header.appendChild(title); header.appendChild(count);
    section.appendChild(header);
    for (const m of g.items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chat-view__picker-row';
      if (m.provider === activeProvider && m.id === activeModel) row.classList.add('is-active');
      if (m.ghost) row.classList.add('is-ghost');
      const id = document.createElement('span');
      id.className = 'chat-view__picker-row-id';
      id.textContent = m.id;
      row.appendChild(id);
      if (m.label && m.label !== m.id) {
        const label = document.createElement('span');
        label.className = 'chat-view__picker-row-label';
        label.textContent = m.label;
        row.appendChild(label);
      }
      const meta = document.createElement('span');
      meta.className = 'chat-view__picker-row-meta';
      meta.textContent = m.ghost ? 'unavailable' : m.provider;
      row.appendChild(meta);
      row.addEventListener('click', () => {
        if (state._onPickerPick) state._onPickerPick(m.provider, m.id);
        else onPickerPick(state, refs, m.provider, m.id, state._updateChat);
      });
      section.appendChild(row);
    }
    list.appendChild(section);
  }
}

// onPickerSearch(refs, state)
//
// Read the search input on every keystroke and re-render. Wired
// to the input's `onInput` from the main view.
export function onPickerSearch(refs, state) {
  if (!refs.modelPickerSearch.current) return;
  state.pickerFilter = { q: refs.modelPickerSearch.current.value || '', provider: state.pickerFilter.provider };
  renderModelPicker(state, refs);
}

// renderPickerEmpty(state, refs, list, q, providerFilter)
//
// Renders the empty state card in place of the list. The card is
// a centered surface with a small accent-tinted icon tile, a
// short title, a one-line body, and (when relevant) an inline
// action that mirrors the head's ↻ button. The previous copy
// was a single muted line of text; the card makes the next step
// obvious without making the user hunt for the head button.
function renderPickerEmpty(state, refs, list, q, providerFilter) {
  const empty = document.createElement('div');
  empty.className = 'chat-view__picker-empty';
  // Title + body come in three flavors depending on the cause:
  //   - a non-empty query that matched nothing
  //   - the chat has no providers configured at all (navigate
  //     to Settings)
  //   - the active filter is too narrow, or the catalog hasn't
  //     been fetched yet (refresh in place)
  let title, body, actionLabel, actionKind;
  if (q) {
    title = 'No matches';
    body = 'No model matches "' + q + '". Try a shorter query, clear the search, or pick a different provider.';
    actionLabel = 'Clear search';
    actionKind = 'clear';
  } else if (!state.providers.length) {
    title = 'No providers';
    body = 'Add a provider connection in Settings → Providers, then come back here to pick a model.';
    actionLabel = 'Open Settings';
    actionKind = 'settings';
  } else if (providerFilter !== 'all') {
    title = 'No ' + providerFilter + ' models';
    body = 'The ' + providerFilter + ' provider has no models in the current catalog. Refresh to fetch the latest list.';
    actionLabel = 'Refresh models';
    actionKind = 'refresh';
  } else {
    title = 'No models yet';
    body = 'The model catalog is empty. Pull the latest list from every configured provider with one tap.';
    actionLabel = 'Refresh models';
    actionKind = 'refresh';
  }
  // Icon tile. A small magnifying glass for "no matches" and the
  // provider-gear glyph for everything else. The icon is purely
  // decorative (`aria-hidden`) so the title still drives the
  // accessible name.
  const icon = document.createElement('div');
  icon.className = 'chat-view__picker-empty-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = q
    ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 4a6 6 0 1 0 3.65 10.74l4.5 4.5 1.4-1.42-4.5-4.5A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg>';
  empty.appendChild(icon);
  const titleEl = document.createElement('p');
  titleEl.className = 'chat-view__picker-empty-title';
  titleEl.textContent = title;
  empty.appendChild(titleEl);
  const bodyEl = document.createElement('p');
  bodyEl.className = 'chat-view__picker-empty-text';
  bodyEl.textContent = body;
  empty.appendChild(bodyEl);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'chat-view__picker-empty-action';
  action.textContent = actionLabel;
  action.addEventListener('click', async () => {
    if (actionKind === 'clear') {
      // Clear the search input + filter and re-render. Reuse the
      // existing onPickerSearch code path so the input's value
      // and the renderer's filter stay in sync.
      if (refs.modelPickerSearch.current) refs.modelPickerSearch.current.value = '';
      state.pickerFilter = { q: '', provider: state.pickerFilter.provider };
      renderModelPicker(state, refs);
      if (refs.modelPickerSearch.current) refs.modelPickerSearch.current.focus();
    } else if (actionKind === 'settings') {
      // Close the picker and navigate to the providers tab. The
      // chat view doesn't own navigation, so it just closes; the
      // user taps the bottom Settings tab.
      closeModelPicker(refs);
      window.location.hash = '#/settings/providers';
    } else {
      // Refresh. Reuse the head's ↻ action by reusing the
      // bound callback if the view exposed it, otherwise call
      // refreshAllProviders directly.
      action.disabled = true;
      try {
        if (typeof state._onRefreshAllProviders === 'function') {
          await state._onRefreshAllProviders();
        } else if (typeof state._refreshAll === 'function') {
          await state._refreshAll();
        }
      } finally {
        // Re-render unconditionally so the empty card is replaced
        // by the fresh list (or a new empty card if the refresh
        // returned no models).
        renderModelPicker(state, refs);
        action.disabled = false;
      }
    }
  });
  empty.appendChild(action);
  list.appendChild(empty);
}

// iOS keeps fixed-position sheets sized to the layout viewport while
// the on-screen keyboard shrinks the visual viewport. Size this sheet
// from visualViewport.height instead, so its own list is the only
// scroll container and bottom rows can be reached with the keyboard up.
function syncKeyboardInset(pop) {
  if (!pop) return;
  const vv = window.visualViewport;
  if (!vv) {
    pop.style.removeProperty('--model-picker-viewport-height');
    pop.style.removeProperty('--model-picker-viewport-top');
    return;
  }
  pop.style.setProperty('--model-picker-viewport-height', vv.height.toFixed(0) + 'px');
  pop.style.setProperty('--model-picker-viewport-top', Math.max(0, vv.offsetTop).toFixed(0) + 'px');
}

function bindKeyboardInset(pop) {
  if (!pop || pop._modelPickerKeyboardCleanup) return;
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => syncKeyboardInset(pop);
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  window.addEventListener('orientationchange', update);
  pop._modelPickerKeyboardCleanup = () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    window.removeEventListener('orientationchange', update);
    pop._modelPickerKeyboardCleanup = null;
  };
  update();
}

function unbindKeyboardInset(pop) {
  if (!pop) return;
  if (pop._modelPickerKeyboardCleanup) pop._modelPickerKeyboardCleanup();
  pop.style.removeProperty('--model-picker-viewport-height');
  pop.style.removeProperty('--model-picker-viewport-top');
}

// openModelPicker / closeModelPicker
export function openModelPicker(state, refs) {
  const pop = refs.modelPickerPop.current;
  const trig = refs.modelPickerTrigger.current;
  if (!pop || !trig) return;
  pop.hidden = false;
  bindKeyboardInset(pop);
  trig.setAttribute('aria-expanded', 'true');
  renderModelPicker(state, refs);
  if (refs.modelPickerSearch.current) {
    refs.modelPickerSearch.current.value = state.pickerFilter.q || '';
    refs.modelPickerSearch.current.focus();
    syncKeyboardInset(pop);
    // Move the caret to the end so a previously typed query is
    // easy to extend (vs overwriting the first char).
    const v = refs.modelPickerSearch.current.value;
    refs.modelPickerSearch.current.setSelectionRange(v.length, v.length);
  }
}

export function closeModelPicker(refs) {
  const pop = refs.modelPickerPop.current;
  const trig = refs.modelPickerTrigger.current;
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  unbindKeyboardInset(pop);
  if (trig) trig.setAttribute('aria-expanded', 'false');
  if (refs.modelPickerSearch.current && refs.modelPickerSearch.current === document.activeElement) {
    refs.modelPickerSearch.current.blur();
  }
}

// onPickerPick — user tapped a row. Persist the pair to the chat,
// update the head trigger label, and close the picker. A pick on
// the "ghost" row (an unavailable active model) clears the chat's
// modelId so the user re-picks on the next open — keeping a dead
// reference around just means the chat sends a request to a model
// that no longer exists.
export async function onPickerPick(state, refs, providerId, modelId, updateChat) {
  if (!providerId || !modelId) return;
  closeModelPicker(refs);
  if (state.chat && state.chat.providerId === providerId && state.chat.modelId === modelId) return;
  state.chat = Object.assign({}, state.chat, { providerId, modelId });
  updateModelTrigger(refs, state);
  await updateChat({ providerId, modelId });
}

// fetchLiveForProvider(provider, state) — single /api/ai/models/live
// call. On success it writes the catalog into liveByProviderRef and
// re-renders the picker. On failure it returns the typed error
// body so the caller can surface a useful status pill.
export async function fetchLiveForProvider(provider, state) {
  const res = await fetchLiveModels(provider);
  if (res && res.error) return { provider, ok: false, body: res.error, status: res.status || 0 };
  const live = Array.isArray(res && res.models) ? res.models : [];
  state.liveByProvider = Object.assign({}, state.liveByProvider, { [provider]: live });
  return { provider, ok: true, count: live.length, cached: !!(res && res.cached) };
}

// refreshActiveProvider — fetch the live catalog for the chat's
// currently selected provider (so a brand-new chat opens with
// more than just the hand-typed project slugs). Errors are
// silent: a stale list is still usable, and the user can retry
// via the picker ↻ button.
export async function refreshActiveProvider(state, refs) {
  const provider = activeProviderId(state);
  if (!provider) return;
  const res = await fetchLiveForProvider(provider, state);
  if (res.ok) renderModelPicker(state, refs);
}

// refreshAllProviders(state, refs, setChatStatus)
//
// Pull the live catalog for every configured provider in parallel
// and surface a one-line summary on the head. Used by the picker's
// ↻ button.
export async function refreshAllProviders(state, refs, setChatStatus) {
  if (refs.modelPickerRefresh.current) refs.modelPickerRefresh.current.disabled = true;
  setChatStatus('refreshing models…', 'busy');
  invalidateModelsCache();
  const providers = state.providers.map((p) => p && p.id).filter(Boolean);
  if (!providers.length) {
    setChatStatus('add a provider in Settings → Providers', 'error');
    if (refs.modelPickerRefresh.current) refs.modelPickerRefresh.current.disabled = false;
    return;
  }
  const results = await Promise.all(
    providers.map((p) => fetchLiveForProvider(p, state)
      .catch((err) => ({ provider: p, ok: false, body: { error: String(err), code: 'ELIVE' }, status: 0 })))
  );
  let total = 0, failed = 0, primary = null;
  for (const r of results) {
    if (r.ok) total += r.count;
    else failed++;
  }
  const active = activeProviderId(state);
  primary = results.find((r) => r.provider === active);
  if (primary && !primary.ok) {
    const code = primary.body && primary.body.code;
    const msg = primary.body && primary.body.error;
    let pill;
    if (code === 'ENO_APIKEY')      pill = 'add API key in Settings → Providers';
    else if (code === 'EUNREACHABLE') pill = (primary.provider === 'ollama')
      ? 'ollama not running on ' + (window.__mouaif_ollama_url || '127.0.0.1:11434')
      : (primary.provider + ' unreachable');
    else if (code === 'EABORTED')    pill = 'timeout — ' + primary.provider + ' did not respond in 8s';
    else if (code === 'EUPSTREAM')   pill = (primary.provider + ' returned ' + (primary.status || '?'));
    else if (code === 'ENO_LIST')    pill = (primary.provider + ' has no model list endpoint');
    else                              pill = 'model list failed (' + (primary.status || '?') + ')';
    setChatStatus(pill + (msg && msg !== pill ? ' — ' + msg : ''), 'error');
  } else {
    setChatStatus('models: ' + total + (failed ? ' (' + failed + ' failed)' : ''), failed ? 'error' : 'success');
  }
  renderModelPicker(state, refs);
  if (refs.modelPickerRefresh.current) refs.modelPickerRefresh.current.disabled = false;
}
