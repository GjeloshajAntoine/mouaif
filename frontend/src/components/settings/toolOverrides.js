// mouaif web — tool wording overrides, client side
//
// Pure helpers for Settings → Project → Tool wording
// (docs/features/tool-overrides.md). The stored shape and the rules mirror
// src/toolOverrides.js, which re-applies them on the server whenever a chat
// advertises its tools. A project keeps named wording sets and one active
// set ('' = Built-in):
//
//   toolWording = { active: "<id>" | "", sets: { "<id>": { name, tools: OVERRIDES } } }
//   OVERRIDES   = { "<tool>": { description?: string, fields?: { "<field>": "<new name>" } } }

export const MAX_DESCRIPTION_CHARS = 4000;
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const MAX_SET_NAME = 60;
export const MAX_SETS = 20;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// fieldProblem(original, next, properties, fields) -> '' or why `next` cannot
// replace `original`. `properties` is the tool's own field map and `fields`
// the draft renames, so a name already in use (as an original or as another
// rename) is caught while the user types, not silently dropped on save.
export function fieldProblem(original, next, properties = {}, fields = {}) {
  const name = String(next || '').trim();
  if (!name || name === original) return '';
  if (!FIELD_NAME.test(name)) return 'Use letters, digits, _ or -, starting with a letter or _.';
  if (name in properties) return 'The tool already has a field called ' + name + '.';
  for (const other of Object.keys(fields)) {
    if (other !== original && String(fields[other] || '').trim() === name) return 'Another field is already renamed to ' + name + '.';
  }
  return '';
}

// normalizeOverrides(raw) -> clean overrides; anything unusable is dropped.
export function normalizeOverrides(raw) {
  const out = {};
  if (!isPlain(raw)) return out;
  for (const tool of Object.keys(raw)) {
    const entry = raw[tool];
    if (!tool || !isPlain(entry)) continue;
    const clean = {};
    if (typeof entry.description === 'string' && entry.description.trim()) {
      clean.description = entry.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    }
    if (isPlain(entry.fields)) {
      const fields = {};
      const taken = new Set();
      for (const field of Object.keys(entry.fields)) {
        const next = typeof entry.fields[field] === 'string' ? entry.fields[field].trim() : '';
        if (!next || next === field || !FIELD_NAME.test(next) || taken.has(next) || next in entry.fields) continue;
        taken.add(next);
        fields[field] = next;
      }
      if (Object.keys(fields).length) clean.fields = fields;
    }
    if (clean.description || clean.fields) out[tool] = clean;
  }
  return out;
}

// overridesFromResolved(resolved) -> the saved overrides of a resolved
// settings object.
export function overridesFromResolved(resolved) {
  return normalizeOverrides(resolved && resolved.toolOverrides);
}

// parseImport(text) -> { overrides, name, tools, skipped, error }
//
// Accepts an exported set ({ "name", "tools": { "<tool>": {…} } }), a bare
// tools map ({ "<tool>": {…} }), the same wrapped in { "toolOverrides": {…} }
// (a legacy project file), and a list [{ name, description, fields }]. `name`
// is the set's name when the document carries one. `skipped` counts entries that held nothing
// usable, so the page can say what it ignored instead of importing silently.
export function parseImport(text) {
  const source = String(text || '').trim();
  if (!source) return { overrides: {}, tools: 0, skipped: 0, error: 'Paste JSON or choose a file first.' };
  let data;
  try { data = JSON.parse(source); }
  catch (error) { return { overrides: {}, tools: 0, skipped: 0, error: 'Not valid JSON: ' + error.message }; }
  let name = '';
  if (isPlain(data) && isPlain(data.tools) && (typeof data.name === 'string' || Object.keys(data).length === 1)) {
    name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_SET_NAME) : '';
    data = data.tools;
  } else if (isPlain(data) && isPlain(data.toolOverrides)) data = data.toolOverrides;
  if (Array.isArray(data)) {
    const map = {};
    for (const item of data) if (isPlain(item) && typeof item.name === 'string' && item.name) map[item.name] = item;
    data = map;
  }
  if (!isPlain(data)) return { overrides: {}, tools: 0, skipped: 0, error: 'Expected an object keyed by tool name.' };
  const overrides = normalizeOverrides(data);
  const total = Object.keys(data).length;
  const tools = Object.keys(overrides).length;
  if (!tools) return { overrides, name, tools, skipped: total, error: 'No usable tool entries found.' };
  return { overrides, name, tools, skipped: total - tools, error: '' };
}

// mergeOverrides(current, incoming) -> incoming entries replace the same
// tool's current entry; every other tool is kept.
export function mergeOverrides(current, incoming) {
  return Object.assign({}, current, incoming);
}

// exportText(set) -> the JSON document the page copies / downloads for one
// set: { name, tools }. parseImport reads it back, name included.
export function exportText(set) {
  return JSON.stringify({ name: (set && set.name) || '', tools: normalizeOverrides(set && set.tools) }, null, 2) + '\n';
}

// fieldList(tool) -> [{ name, type, required, description }] for the tool's
// top-level parameters, in schema order.
export function fieldList(tool) {
  const params = tool && tool.parameters;
  const props = params && isPlain(params.properties) ? params.properties : {};
  const required = new Set(Array.isArray(params && params.required) ? params.required : []);
  return Object.keys(props).map((name) => {
    const spec = isPlain(props[name]) ? props[name] : {};
    return {
      name,
      type: Array.isArray(spec.type) ? spec.type.join(' | ') : (typeof spec.type === 'string' ? spec.type : ''),
      required: required.has(name),
      description: typeof spec.description === 'string' ? spec.description : ''
    };
  });
}

// isCustomized(entry) -> true when the entry changes anything.
export function isCustomized(entry) {
  return !!(entry && (entry.description || (entry.fields && Object.keys(entry.fields).length)));
}

// searchTools(tools, query) -> tools whose name or description contains every
// word of the query (case-insensitive).
export function searchTools(tools, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tools;
  return tools.filter((tool) => {
    const hay = (tool.name + ' ' + (tool.description || '')).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

// Above this many word pairs the middle of a word diff is shown as one
// replaced span; descriptions are capped at 4000 characters so real ones stay
// well under it.
const MAX_DIFF_CELLS = 4e6;

// diffWords(before, after) -> [{ op: 'same' | 'del' | 'ins', text }]
//
// A word-level diff (whitespace kept attached to the token before it) for the
// built-in vs custom comparison. Common prefix and suffix are trimmed first so
// the LCS table only covers the region that actually changed.
export function diffWords(before, after) {
  const a = String(before || '').match(/\s+|[^\s]+/g) || [];
  const b = String(after || '').match(/\s+|[^\s]+/g) || [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = [];
  const push = (op, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  push('same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_DIFF_CELLS) {
    push('del', midA.join(''));
    push('ins', midB.join(''));
  } else if (n && m) {
    // lcs[i * (m + 1) + j] = LCS length of midA[i..] and midB[j..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = midA[i] === midB[j]
          ? lcs[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push('same', midA[i]); i++; j++; }
      else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) push('del', midA[i++]);
      else push('ins', midB[j++]);
    }
    push('del', midA.slice(i).join(''));
    push('ins', midB.slice(j).join(''));
  } else {
    push('del', midA.join(''));
    push('ins', midB.join(''));
  }
  push('same', a.slice(endA).join(''));
  return out;
}

// diffStats(parts) -> { added, removed } word counts, for the row summary.
export function diffStats(parts) {
  const words = (text) => (text.match(/[^\s]+/g) || []).length;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.op === 'ins') added += words(part.text);
    else if (part.op === 'del') removed += words(part.text);
  }
  return { added, removed };
}

// changedTools(a, b) -> names whose entry differs between two finalized
// documents (field order ignored), i.e. the tools with unsaved changes.
export function changedTools(a, b) {
  const key = (entry) => {
    if (!entry) return '';
    const fields = entry.fields || {};
    return JSON.stringify([entry.description || '', Object.keys(fields).sort().map((f) => [f, fields[f]])]);
  };
  const names = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
  return [...names].filter((name) => key((a || {})[name]) !== key((b || {})[name])).sort();
}

// renameProblems(draft, tools) -> names of tools whose draft renames break the
// field rules; Save stays off until they are fixed instead of dropping them.
export function renameProblems(draft, tools) {
  const out = [];
  for (const tool of tools || []) {
    const fields = draft && draft[tool.name] && draft[tool.name].fields;
    if (!fields) continue;
    const properties = {};
    for (const f of fieldList(tool)) properties[f.name] = true;
    if (Object.keys(fields).some((f) => fieldProblem(f, fields[f], properties, fields))) out.push(tool.name);
  }
  return out;
}

// ---- wording sets ---------------------------------------------------------

// normalizeWording(raw) -> { active, sets } with every set's name and tools
// cleaned; an `active` id that names no set becomes '' (Built-in).
export function normalizeWording(raw) {
  const sets = {};
  const source = isPlain(raw) && isPlain(raw.sets) ? raw.sets : {};
  for (const id of Object.keys(source)) {
    const set = source[id];
    if (!id || !isPlain(set)) continue;
    const name = typeof set.name === 'string' && set.name.trim() ? set.name.trim().slice(0, MAX_SET_NAME) : id;
    sets[id] = { name, tools: normalizeOverrides(set.tools) };
  }
  const active = isPlain(raw) && typeof raw.active === 'string' && sets[raw.active] ? raw.active : '';
  return { active, sets };
}

// LEGACY_SET_ID — the set a project's flat `toolOverrides` becomes.
export const LEGACY_SET_ID = 'custom';

// wordingFromResolved(resolved) -> { wording, legacy }. A project with no sets
// but a flat `toolOverrides` map is shown as one active set called "Custom";
// `legacy` tells the page to drop the flat map when it saves.
export function wordingFromResolved(resolved) {
  const wording = normalizeWording(resolved && resolved.toolWording);
  if (Object.keys(wording.sets).length) return { wording, legacy: false };
  const flat = normalizeOverrides(resolved && resolved.toolOverrides);
  if (!Object.keys(flat).length) return { wording, legacy: false };
  return { wording: { active: LEGACY_SET_ID, sets: { [LEGACY_SET_ID]: { name: 'Custom', tools: flat } } }, legacy: true };
}

// newSetId(name, sets) -> a short id from the name, unique among `sets`. Ids
// never change after creation, so renaming a set keeps it active.
export function newSetId(name, sets = {}) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'set';
  let id = base;
  for (let n = 2; Object.prototype.hasOwnProperty.call(sets, id); n++) id = base + '-' + n;
  return id;
}

// uniqueSetName(name, sets, exceptId) -> `name`, or `name (2)`, … so two
// sets never share a name.
export function uniqueSetName(name, sets = {}, exceptId = '') {
  const base = String(name || '').trim().slice(0, MAX_SET_NAME) || 'Untitled';
  const taken = new Set(Object.keys(sets).filter((id) => id !== exceptId).map((id) => sets[id].name.toLowerCase()));
  let next = base;
  for (let n = 2; taken.has(next.toLowerCase()); n++) next = base + ' (' + n + ')';
  return next;
}

// snapshotBuiltIn(tools) -> a set's tools map holding every tool's current
// built-in description. A copy is frozen: later built-in changes do not
// reach it (Compare shows the drift).
export function snapshotBuiltIn(tools) {
  const out = {};
  for (const tool of tools || []) {
    if (tool && tool.name && typeof tool.description === 'string' && tool.description.trim()) {
      out[tool.name] = { description: tool.description.trim().slice(0, MAX_DESCRIPTION_CHARS) };
    }
  }
  return out;
}

// effectiveEntry(tool, entry) -> { description, fields } the model is sent
// for `tool` under a set entry (or Built-in when there is none).
export function effectiveEntry(tool, entry) {
  return {
    description: (entry && typeof entry.description === 'string' && entry.description.trim()) ? entry.description : (tool.description || ''),
    fields: (entry && entry.fields) || {}
  };
}

// differsFromBuiltIn(tool, entry) -> true when the entry changes what the
// model is sent compared with the tool's current built-in wording.
export function differsFromBuiltIn(tool, entry) {
  if (!entry) return false;
  const fields = entry.fields && Object.keys(entry.fields).some((f) => entry.fields[f] && entry.fields[f] !== f);
  const description = typeof entry.description === 'string' && entry.description.trim()
    && entry.description.trim() !== String(tool.description || '').trim();
  return !!(fields || description);
}

// wordingChanges(draft, saved) -> what Save would write, for the Save bar:
// { count, active, sets: [{ id, name, kind: 'new' | 'deleted' | 'edited', tools: [names], renamed }] }.
export function wordingChanges(draft, saved) {
  const a = normalizeWording(draft);
  const b = normalizeWording(saved);
  const sets = [];
  const ids = new Set(Object.keys(a.sets).concat(Object.keys(b.sets)));
  for (const id of [...ids].sort()) {
    const now = a.sets[id];
    const was = b.sets[id];
    if (now && !was) sets.push({ id, name: now.name, kind: 'new', tools: Object.keys(now.tools), renamed: false });
    else if (!now && was) sets.push({ id, name: was.name, kind: 'deleted', tools: [], renamed: false });
    else {
      const tools = changedTools(now.tools, was.tools);
      const renamed = now.name !== was.name;
      if (tools.length || renamed) sets.push({ id, name: now.name, kind: 'edited', tools, renamed });
    }
  }
  const active = a.active !== b.active;
  return { count: sets.length + (active ? 1 : 0), active, sets };
}

// The page has one selection: Built-in ('') or a set id.

// initialSelection(wording) -> what the page opens on: the default set, else
// the first set, else Built-in.
export function initialSelection(wording) {
  const w = normalizeWording(wording);
  if (w.active && w.sets[w.active]) return w.active;
  return Object.keys(w.sets)[0] || '';
}

// selectionAfterDelete(sets, deletedId, active) -> what to select once
// `deletedId` is gone: the default set if it remains, else the next set in
// list order, else the previous one, else Built-in.
export function selectionAfterDelete(sets, deletedId, active = '') {
  if (active && active !== deletedId && sets[active]) return active;
  const ids = Object.keys(sets);
  const at = ids.indexOf(deletedId);
  const rest = ids.filter((id) => id !== deletedId);
  if (!rest.length) return '';
  return rest[Math.min(Math.max(at, 0), rest.length - 1)];
}

// newSetTools(source, tools, sets) -> the tools map a new set starts with.
// `source` is '' (a frozen copy of Built-in), 'empty', or a set id (a deep
// copy of that set, unsaved edits included).
export function newSetTools(source, tools, sets = {}) {
  if (source === 'empty') return {};
  if (source && sets[source]) return JSON.parse(JSON.stringify(sets[source].tools));
  return snapshotBuiltIn(tools);
}
