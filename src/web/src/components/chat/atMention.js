// mouaif web — @-mention autocomplete for the composer
//
// Detects when the user types @ in the textarea and shows a popup
// overlay with matching items: project files, tools/actions, and
// the active agent/model.
//
// The popup appears above the textarea and stays visible until the
// user dismisses it with Escape, taps outside, or completes a
// selection with Enter/Tab.

import { fetchJson } from '../../api.js';

// ---- Categories ---------------------------------------------------------

const CATEGORY = { FILES: 'files', ACTIONS: 'actions', AGENT: 'agent' };
const CATEGORY_LABELS = { files: 'Files', actions: 'Actions', agent: 'Agent' };
const ICON_MAP = { file: '📄', action: '⚡', agent: '🤖' };

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
          const label = relPath.split('/').pop();
          out.push({
            id: 'file:' + relPath,
            label,
            subtitle: relPath,
            category: CATEGORY.FILES, icon: 'file',
            insert: relPath,
            searchText: (label + ' ' + relPath + ' ' + (entry.tags || []).join(' ')).toLowerCase()
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
  const taggedPaths = new Set(out.filter(i => i.category === CATEGORY.FILES).map(i => i.subtitle));
  let fileCount = 0;
  for (const f of scanned) {
    if (fileCount >= 200) break;
    if (!f.path || taggedPaths.has(f.path)) continue;
    if (f.binary) continue;
    const label = f.path.split('/').pop();
    out.push({
      id: 'file:' + f.path,
      label,
      subtitle: f.path,
      category: CATEGORY.FILES, icon: 'file',
      insert: f.path,
      searchText: (label + ' ' + f.path).toLowerCase()
    });
    fileCount++;
  }

  // 3. Actions (tools from catalog)
  const toolNames = new Set();
  const tools = uiState && uiState.tools;
  if (tools && Array.isArray(tools.catalog)) {
    for (const t of tools.catalog) {
      if (!t || !t.name || toolNames.has(t.name)) continue;
      toolNames.add(t.name);
      out.push({
        id: 'action:' + t.name,
        label: t.name,
        subtitle: t.description || 'tool',
        category: CATEGORY.ACTIONS, icon: 'action',
        insert: t.name,
        searchText: (t.name + ' ' + (t.description || '')).toLowerCase()
      });
    }
  }

  // 4. Agent (current model)
  const chat = uiState && uiState.chat;
  if (chat && chat.modelId) {
    out.push({
      id: 'agent:model',
      label: chat.modelId,
      subtitle: chat.providerId || 'model',
      category: CATEGORY.AGENT, icon: 'agent',
      insert: chat.modelId,
      searchText: (chat.modelId + ' ' + (chat.providerId || '')).toLowerCase()
    });
  }

  out.sort((a, b) => {
    const catOrder = { files: 0, agent: 1, actions: 2 };
    const ca = catOrder[a.category] ?? 3;
    const cb = catOrder[b.category] ?? 3;
    if (ca !== cb) return ca - cb;
    return a.label.localeCompare(b.label);
  });
  return out;
}

// ---- Rendering ----------------------------------------------------------

function renderPopup() {
  if (!popup) return;
  const f = filtered;

  if (!visible || !f.length) {
    popup.hidden = true;
    return;
  }
  popup.hidden = false;

  if (selectedIdx >= f.length) selectedIdx = 0;
  if (selectedIdx < 0) selectedIdx = f.length - 1;

  const sections = [];
  let currentCat = null;
  for (let i = 0; i < f.length; i++) {
    const item = f[i];
    if (item.category !== currentCat) {
      currentCat = item.category;
      sections.push({ type: 'header', label: CATEGORY_LABELS[currentCat] || currentCat });
    }
    sections.push({ type: 'item', index: i, item });
  }

  popup.innerHTML = '';
  for (const sec of sections) {
    if (sec.type === 'header') {
      const h = document.createElement('div');
      h.className = 'at-mention__header';
      h.textContent = sec.label;
      popup.appendChild(h);
    } else {
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
        const sub = document.createElement('div');
        sub.className = 'at-mention__subtitle';
        sub.textContent = sec.item.subtitle;
        textWrap.appendChild(sub);
      }

      row.appendChild(textWrap);
      row.addEventListener('click', () => selectItem(sec.index));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      popup.appendChild(row);
    }
  }
}

// ---- Selection ---------------------------------------------------------

function selectItem(idx) {
  const item = filtered[idx];
  if (!item || !textarea || !range) return;

  const ta = textarea;
  const before = ta.value.slice(0, range.start);
  const after = ta.value.slice(range.end);

  const insert = '@' + item.insert + ' ';
  ta.value = before + insert + after;

  const newPos = before.length + insert.length;
  ta.selectionStart = ta.selectionEnd = newPos;

  hide();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

function hide() {
  visible = false;
  filtered = [];
  range = null;
  if (popup) popup.hidden = true;
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

  filtered = items.filter(item => {
    if (!q) return true;
    return item.searchText.indexOf(q) >= 0;
  });

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

export function mountAtMention(ta, popupEl, preactState) {
  textarea = ta;
  popup = popupEl;
  uiState = preactState;
  visible = false;
  items = [];
  filtered = [];
  query = '';
  range = null;
  selectedIdx = 0;

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
        const q = query;
        filtered = items.filter(item => {
          if (!q) return true;
          return item.searchText.indexOf(q) >= 0;
        });
        renderPopup();
      }
    }).catch(() => {});
  }
}

export function isAtMentionActive() {
  return visible;
}