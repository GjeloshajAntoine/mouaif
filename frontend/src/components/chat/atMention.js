// mouaif web — @-mention autocomplete for the composer
//
// Detects when the user types @ in the textarea and shows a popup
// overlay with matching items: project files, agents, project actions,
// native tools, MCP tools, and the active model.
//
// The popup appears above the textarea and stays visible until the
// user dismisses it with Escape, taps outside, or completes a
// selection with Enter/Tab.

import { fetchJson } from '../../api.js';

// ---- Categories ---------------------------------------------------------

const CATEGORY = { FILES: 'files', AGENTS: 'agents', ACTIONS: 'actions', TOOLS: 'tools', MCP: 'mcp', MODEL: 'model' };
const ICON_MAP = { file: '📄', agent: '🧑‍🔧', action: '⚡', tool: '🛠️', mcp: '🔌', model: '🤖' };
const MAX_FILE_RESULTS = 200;
// At rest (empty query), show only this many items per category so the
// Files section doesn't push Agents/Actions/Tools/MCP/Model out of view. Typing a
// query drops the per-category cap entirely.
const REST_PER_CATEGORY = 4;

// ---- Module-level state -------------------------------------------------

let uiState = null;
let popup = null;
let textarea = null;
let items = [];
let filtered = [];
let query = '';
let range = null;
let selectedIdx = 0;
let visible = false;
let scanCache = null;
let projectCacheKey = '';
// Category filter bar. null = mixed "All" view; otherwise one of the
// CATEGORY values. Only applies while the user hasn't typed a query.
let activeFilter = null;
const FILTER_ORDER = [
  { key: CATEGORY.FILES, label: 'Files' },
  { key: CATEGORY.AGENTS, label: 'Agents' },
  { key: CATEGORY.ACTIONS, label: 'Actions' },
  { key: CATEGORY.TOOLS, label: 'Tools' },
  { key: CATEGORY.MCP, label: 'MCP' },
  { key: CATEGORY.MODEL, label: 'Model' },
];

// After selecting a tool from the popup, we keep an "arg bar" visible
// below the textarea showing remaining optional parameters the user can
// tap to append. The bar lives in a dedicated DOM node that the caller
// provides via mountAtMention's 4th argument.
let argBar = null;          // DOM element for the arg chips
let activeToolParams = null; // { properties, required } from the selected tool
let activeToolArgs = [];    // arg names already filled by the user

// Resolve the registered project id from a projectDir.
// Tags API uses the short id, not the absolute path.
let projectIdCache = null;
let projectDirForId = '';

async function resolveProjectId(projectDir) {
  if (!projectDir) return null;
  if (projectDir === projectDirForId && projectIdCache) return projectIdCache;
  try {
    const r = await fetchJson('/api/projects/registered');
    if (r.status === 200 && Array.isArray(r.body && r.body.projects)) {
      for (const p of r.body.projects) {
        if (p && p.path === projectDir && p.id) {
          projectIdCache = p.id;
          projectDirForId = projectDir;
          return p.id;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---- Build the item list ------------------------------------------------

function filePathParts(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const separator = normalized.lastIndexOf('/');
  return {
    name: separator >= 0 ? normalized.slice(separator + 1) : normalized,
    folder: separator >= 0 ? normalized.slice(0, separator) : 'Project root'
  };
}

// Keep the ranking within each result type, but files always occupy the
// first positions. This is applied after matching/capping so a highly
// relevant tool, action, agent, or model cannot jump ahead of a file.
export function prioritizeAtMentionFiles(candidateItems) {
  const fileItems = [];
  const otherItems = [];
  for (const item of candidateItems) {
    (item.category === CATEGORY.FILES ? fileItems : otherItems).push(item);
  }
  return fileItems.concat(otherItems);
}

async function buildItems(projectDir) {
  if (!projectDir) return [];
  const out = [];

  // Resolve project id for tags/scan endpoints
  const projId = await resolveProjectId(projectDir);

  // 1. Tagged files (only if we have a registered project id)
  if (projId) {
    try {
      const r = await fetchJson('/api/projects/' + encodeURIComponent(projId) + '/tags');
      if (r.status === 200 && r.body && r.body.tags) {
        const tagMap = r.body.tags;
        for (const relPath of Object.keys(tagMap).sort()) {
          const entry = tagMap[relPath];
          const pathParts = filePathParts(relPath);
          out.push({
            id: 'file:' + relPath,
            label: pathParts.name,
            subtitle: pathParts.folder,
            category: CATEGORY.FILES, icon: 'file',
            insert: relPath,
            searchText: (pathParts.name + ' ' + relPath + ' ' + (entry.tags || []).join(' ')).toLowerCase()
          });
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Recursive file scan via tags/scan (needs project id)
  const cacheKey = projectDir + '|' + (projId || '');
  if (cacheKey !== projectCacheKey) {
    projectCacheKey = cacheKey;
    scanCache = null;
    if (projId) {
      try {
        const r = await fetchJson('/api/projects/' + encodeURIComponent(projId) + '/tags/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (r.status === 200 && Array.isArray(r.body && r.body.files)) {
          scanCache = r.body.files;
        }
      } catch { /* ignore */ }
    }
  }
  const scanned = scanCache || [];
  const taggedPaths = new Set(out.filter(i => i.category === CATEGORY.FILES).map(i => i.insert));
  for (const f of scanned) {
    if (!f.path || taggedPaths.has(f.path)) continue;
    if (f.binary) continue;
    const pathParts = filePathParts(f.path);
    out.push({
      id: 'file:' + f.path,
      label: pathParts.name,
      subtitle: pathParts.folder,
      category: CATEGORY.FILES, icon: 'file',
      insert: f.path,
      searchText: (pathParts.name + ' ' + f.path).toLowerCase()
    });
  }

// 3. Tools from the catalog. Native model tools and MCP tools are separate
// categories so neither is confused with a saved project action.
const toolNames = new Set();
const tools = uiState && uiState.tools;
if (tools && Array.isArray(tools.catalog)) {
for (const t of tools.catalog) {
if (!t || !t.name || toolNames.has(t.name)) continue;
toolNames.add(t.name);
// Extract parameters schema if present
const params = t.parameters || (t.inputSchema) || null;
const props = (params && params.properties) || {};
const required = (params && Array.isArray(params.required)) ? params.required : [];
const isMcp = t.kind === 'mcp';
out.push({
id: (isMcp ? 'mcp:' : 'tool:') + t.name,
label: t.name,
subtitle: isMcp
? ((t.source ? t.source + ' · ' : '') + (t.description || 'MCP tool'))
: (t.description || 'Native tool'),
category: isMcp ? CATEGORY.MCP : CATEGORY.TOOLS,
icon: isMcp ? 'mcp' : 'tool',
insert: t.name,
searchText: (t.name + ' ' + (t.source || '') + ' ' + (t.description || '') + (isMcp ? ' mcp' : ' native tool')).toLowerCase(),
params: { properties: props, required }
});
}
}

  // 3b. Project custom actions — named CLI/MCP shortcuts. These are
// directly invocable even when they take no user-supplied arguments.
try {
const cr = await fetchJson('/api/actions?projectDir=' + encodeURIComponent(projectDir));
if (cr.status === 200 && Array.isArray(cr.body && cr.body.actions)) {
// Keep direct dispatch on the same fresh list the popup is rendering.
// Without this, a newly created action can appear here but fall through
// to a normal model turn because send() still has the chat-load snapshot.
if (uiState && typeof uiState._setCustomActions === 'function') uiState._setCustomActions(cr.body.actions);
else if (uiState) uiState.customActions = cr.body.actions;
for (const action of cr.body.actions) {
if (!action || !action.id) continue;
const actionLabel = action.label || action.id;
const actionSubtitle = action.description || (actionLabel !== action.id ? '@' + action.id : 'Project action');
out.push({
id: 'custom-action:' + action.id,
label: actionLabel,
subtitle: actionSubtitle,
category: CATEGORY.ACTIONS, icon: 'action',
insert: action.id,
searchText: (action.id + ' ' + actionLabel + ' ' + (action.description || '')).toLowerCase(),
params: null
});
}
}
} catch { /* no custom actions endpoint */ }
// 3c. Agents (subagent delegation personas) — selecting one inserts
// @<name> at the composer start; a leading @agent <task> dispatches
// the agent directly on send (see stream.js send()).
  try {
    const ar = await fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir));
    if (ar.status === 200 && Array.isArray(ar.body && ar.body.agents)) {
      for (const a of ar.body.agents) {
        if (!a || !a.name) continue;
        out.push({
          id: 'agent:' + a.name,
          label: a.name,
          subtitle: (a.modelId ? a.modelId + ' · ' : '') + 'agent',
          category: CATEGORY.AGENTS, icon: 'agent',
          insert: a.name,
          searchText: (a.name + ' agent ' + (a.content || '')).toLowerCase().slice(0, 200)
        });
      }
    }
  } catch { /* no agents endpoint */ }

  // 4. Model (current chat model)
  const chat = uiState && uiState.chat;
  if (chat && chat.modelId) {
    out.push({
      id: 'model:current',
      label: chat.modelId,
      subtitle: chat.providerId || 'model',
      category: CATEGORY.MODEL, icon: 'model',
      insert: chat.modelId,
      searchText: (chat.modelId + ' ' + (chat.providerId || '')).toLowerCase()
    });
  }

  out.sort((a, b) => {
const catOrder = { files: 0, agents: 1, actions: 2, tools: 3, mcp: 4, model: 5 };
const ca = catOrder[a.category] ?? 6;
const cb = catOrder[b.category] ?? 6;
    if (ca !== cb) return ca - cb;
    return a.label.localeCompare(b.label);
  });
  return out;
}

// ---- Filtering + rendering ----------------------------------------------

function filterItems(searchQuery) {
// During a search (query typed) the category filter is ignored so the
// user sees every matching result across all categories.
let matches = searchQuery
? items
: (activeFilter ? items.filter(item => item.category === activeFilter) : items);
if (searchQuery) {
matches = matches.filter(item => item.searchText.indexOf(searchQuery) >= 0);
}
// With an active query there is no per-category cap — the user is
// searching. Files still get the large global cap.
  if (searchQuery) {
    let fileCount = 0;
    const cappedMatches = matches.filter(item => {
      if (item.category !== CATEGORY.FILES) return true;
      if (fileCount >= MAX_FILE_RESULTS) return false;
      fileCount++;
      return true;
    });
    return prioritizeAtMentionFiles(cappedMatches);
  }
  if (activeFilter) {
    // Single-category view: show everything in that category.
    return prioritizeAtMentionFiles(matches);
  }
  // Mixed "All" view: cap each category so the popup surfaces every
  // section without one pushing the others out of view.
  const counts = {};
  const cappedMatches = matches.filter(item => {
    const n = counts[item.category] || 0;
    counts[item.category] = n + 1;
    return n < REST_PER_CATEGORY;
  });
  return prioritizeAtMentionFiles(cappedMatches);
}

// ---- Category filter bar ------------------------------------------------
// Renders a row of tappable type chips at the top of the popup (at rest,
// no query). Tapping a chip filters the list to a single category; tapping
// the active chip again returns to the mixed "All" view.
function renderFilterBar(root) {
// Never show the bar while the user is typing a search query.
if (query) return;
const bar = document.createElement('div');
bar.className = 'at-mention__filter';
for (const { key, label } of FILTER_ORDER) {
const chip = document.createElement('button');
chip.type = 'button';
chip.className = 'at-mention__filter-chip' + (activeFilter === key ? ' is-active' : '');
chip.textContent = label;
chip.addEventListener('click', (e) => {
e.preventDefault();
e.stopPropagation();
// Toggle: tapping the active chip resets to the mixed view.
activeFilter = activeFilter === key ? null : key;
selectedIdx = 0;
filtered = filterItems(query);
renderPopup();
});
chip.addEventListener('mousedown', (e) => e.preventDefault());
bar.appendChild(chip);
}
root.appendChild(bar);
}

function renderPopup() {
  if (!popup) return;
  const f = filtered;

  popup.hidden = false;
  // If the filter bar is shown (at rest, no query) but there are no items
  // in the active category, keep the popup open with just the filter bar so
  // the user can switch back to another type instead of losing the popup.
  if (!visible || !f.length) {
    if (visible && !query) {
      popup.innerHTML = '';
      renderFilterBar(popup);
      return;
    }
    popup.hidden = true;
    return;
  }

  if (selectedIdx >= f.length) selectedIdx = 0;
  if (selectedIdx < 0) selectedIdx = f.length - 1;

  const sections = [];
  for (let i = 0; i < f.length; i++) {
    sections.push({ type: 'item', index: i, item: f[i] });
  }

  popup.innerHTML = '';
  // Category filter bar — shown at rest (no query typed) so the user can
  // tap a type to filter the list to just that category. Hidden while
  // searching, since a query already narrows the results.
  renderFilterBar(popup);
  for (const sec of sections) {
    const row = document.createElement('div');
    row.className = 'at-mention__item' + (sec.index === selectedIdx ? ' is-selected' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', sec.index === selectedIdx ? 'true' : 'false');

    const icon = document.createElement('span');
    icon.className = 'at-mention__icon';
    icon.textContent = ICON_MAP[sec.item.icon] || '📄';
    row.appendChild(icon);

    const textWrap = document.createElement('div');
    textWrap.className = 'at-mention__text';

    const label = document.createElement('div');
    label.className = 'at-mention__label';
    label.textContent = sec.item.label;
    textWrap.appendChild(label);
    if (sec.item.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'at-mention__subtitle';
      subtitle.textContent = sec.item.subtitle;
      textWrap.appendChild(subtitle);
    }

    row.appendChild(textWrap);
    row.addEventListener('click', () => selectItem(sec.index));
    row.addEventListener('mousedown', (e) => e.preventDefault());
    popup.appendChild(row);
  }
}

// ---- Selection ---------------------------------------------------------

function selectItem(idx) {
  const item = filtered[idx];
  if (!item || !textarea || !range) return;

  const ta = textarea;
  const before = ta.value.slice(0, range.start);
  const after = ta.value.slice(range.end);

  // Tools with parameters get the colon + first required arg inserted
  // and an arg bar shown below the textarea for remaining params.
  if ((item.category === CATEGORY.TOOLS || item.category === CATEGORY.MCP) && item.params && Object.keys(item.params.properties).length > 0) {
    const props = item.params.properties;
    const required = item.params.required;
    // Pick the first required param, or the first param if none required
    const firstKey = required.length > 0 ? required[0] : Object.keys(props)[0];
    const restKeys = [];
    for (const k of Object.keys(props)) {
      if (k !== firstKey) restKeys.push(k);
    }
    const desc = (props[firstKey] && props[firstKey].description) || '';
    const isString = !props[firstKey] || props[firstKey].type === 'string' || !props[firstKey].type;
    // Insert: @toolName:firstKey=` `  (cursor between backticks when string, else after = for number/bool)
    let insert, cursorOffset;
    if (isString) {
      insert = '@' + item.insert + ':' + firstKey + '=`' + desc + '` ';
      // Cursor right after the opening backtick
      cursorOffset = before.length + 2 + item.insert.length + 2 + firstKey.length + 2;
    } else {
      insert = '@' + item.insert + ':' + firstKey + '= ';
      cursorOffset = before.length + insert.length - 1;
    }
    ta.value = before + insert + after;
    ta.selectionStart = ta.selectionEnd = cursorOffset;

    // Store remaining params for the arg bar
    activeToolParams = { properties: props, required };
    activeToolArgs = [firstKey];
    renderArgBar(props, required, [firstKey]);
    hide();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return;
  }

  // Files, model, or tools without known parameters — simple insert
  const insert = '@' + item.insert + ' ';
  ta.value = before + insert + after;
  const newPos = before.length + insert.length;
  ta.selectionStart = ta.selectionEnd = newPos;
  clearArgBar();
  activeToolParams = null;
  activeToolArgs = [];

  hide();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

// renderArgBar(props, required, filled)
//
// Shows a chip bar below the composer with arg names the user can tap
// to append the next `key=\`\`` pair. Required args that aren't yet
// filled are shown with a ** bold style.
function renderArgBar(props, required, filled) {
  if (!argBar) return;
  const filledSet = new Set(filled || []);
  argBar.innerHTML = '';
  argBar.hidden = false;
  let anyShown = false;
  for (const [key, prop] of Object.entries(props)) {
    if (filledSet.has(key)) continue;
    anyShown = true;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'at-mention__arg-chip' + (required.indexOf(key) >= 0 ? ' is-required' : '');
    chip.textContent = key;
    const desc = (prop && prop.description) || '';
    if (desc) chip.title = desc;
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      appendArg(key, prop);
    });
    argBar.appendChild(chip);
  }
  if (!anyShown) argBar.hidden = true;
}

// appendArg(key, prop)
//
// Appends ` key=\`\`` at the end of the textarea value and places the
// cursor between the backticks. Called when the user taps an arg chip.
function appendArg(key, prop) {
  if (!textarea) return;
  const isString = !prop || prop.type === 'string' || !prop.type;
  const suffix = isString ? ' ' + key + '=`' + (prop.description || '') + '`' : ' ' + key + '= ';
  const pos = textarea.value.length;
  textarea.value = textarea.value.slice(0, pos) + suffix + textarea.value.slice(pos);
  if (isString) {
    // Cursor after opening backtick
    textarea.selectionStart = textarea.selectionEnd = pos + key.length + 3;
  } else {
    textarea.selectionStart = textarea.selectionEnd = pos + suffix.length;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  activeToolArgs.push(key);
  if (activeToolParams) renderArgBar(activeToolParams.properties, activeToolParams.required, activeToolArgs);
}

function clearArgBar() {
  if (argBar) { argBar.innerHTML = ''; argBar.hidden = true; }
  activeToolParams = null;
  activeToolArgs = [];
}

function hide() {
visible = false;
filtered = [];
range = null;
activeFilter = null;
if (popup) popup.hidden = true;
// Don't clear the arg bar on hide — user may tap outside and come back
}

// ---- Input detection ---------------------------------------------------

function onInput() {
  const ta = textarea;
  if (!ta) return;

  const pos = ta.selectionStart;
  const val = ta.value;

  let start = pos - 1;
  while (start >= 0 && val[start] !== '@') start--;

  if (start < 0 || val[start] !== '@') {
    if (visible) hide();
    return;
  }

  if (start > 0 && !/\s/.test(val[start - 1]) && val[start - 1] !== '(') {
    if (visible) hide();
    return;
  }

  const afterAt = val.slice(start + 1);
  const q = afterAt.slice(0, pos - start - 1).toLowerCase();
  if (/\s/.test(q)) {
    // User typed a space after the tool name → they're entering args.
    // Keep the popup hidden and let send() handle the invocation.
    if (visible) hide();
    return;
  }

  range = { start, end: pos };
query = q;
selectedIdx = 0;
// Starting a fresh @-mention (no query): reset to the mixed "All" view.
if (!q) activeFilter = null;
filtered = filterItems(q);
visible = true;
renderPopup();
}

function onKeydown(e) {
  if (!visible) return;
  const f = filtered;
  if (!f.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx = Math.min(selectedIdx + 1, f.length - 1);
    renderPopup();
    scrollSelectedIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx = Math.max(selectedIdx - 1, 0);
    renderPopup();
    scrollSelectedIntoView();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectItem(selectedIdx);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hide();
    if (textarea) textarea.focus();
  }
}

function scrollSelectedIntoView() {
  if (!popup) return;
  const sel = popup.querySelector('.is-selected');
  if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function onDocClick(e) {
  if (!visible) return;
  if (!popup || !textarea) return;
  if (popup.contains(e.target)) return;
  if (textarea.contains(e.target)) return;
  hide();
}

// ---- Public API ---------------------------------------------------------

export function mountAtMention(ta, popupEl, preactState, argBarEl) {
  textarea = ta;
  popup = popupEl;
  uiState = preactState;
  argBar = argBarEl || null;
  if (argBar) argBar.hidden = true;
  visible = false;
items = [];
filtered = [];
query = '';
range = null;
selectedIdx = 0;
activeFilter = null;
const projectDir = preactState.props && preactState.props.projectDir;
  if (projectDir) {
    buildItems(projectDir).then(newItems => { items = newItems; }).catch(() => {});
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocClick);

  return () => {
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onDocClick);
    hide();
    uiState = null;
  };
}

export function refreshAtMentionItems() {
  const projectDir = uiState && uiState.props && uiState.props.projectDir;
  if (projectDir) {
    buildItems(projectDir).then(newItems => {
      items = newItems;
      if (visible) {
        filtered = filterItems(query);
        renderPopup();
      }
    }).catch(() => {});
  }
}

export function isAtMentionActive() {
  return visible;
}