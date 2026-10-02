'use strict';

// The app-wide tool-group model, server side.
//
// `frontend/src/toolGroups.js` is the one list that decides which tool
// belongs to which group; scripts/build-tool-groups.js mirrors it to
// frontend/build/toolGroups.json so this module can read the same names the
// UI renders (the feature summary prints `[chats] list_chats …`, which has to
// match the tree row a user sees). Editing groups means editing that one file
// and re-running the generator; scripts/test-tool-groups.js fails if the two
// ever drift.
//
// The mirror is optional at runtime: without it this module falls back to the
// last group names compiled into the tree, so a partial install still reports
// the standard set instead of an empty summary.

const path = require('node:path');

// Fallback used only when the generated mirror is missing or unreadable.
// Kept to ids and names: membership for the summary comes from the catalog's
// own `source` (which the server builds), so the ids are what matter here.
const FALLBACK = Object.freeze([
  { id: 'chats', name: 'Chats', source: 'chats' },
  { id: 'mouaif-settings', name: 'mouaif', source: 'mouaif' }
]);

let cached = null;

function groups() {
  if (cached) return cached;
  try {
    const file = path.join(__dirname, '..', 'frontend', 'build', 'toolGroups.json');
    const raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty tool group mirror');
    cached = raw.filter((group) => group && typeof group.id === 'string' && Array.isArray(group.tools));
    if (!cached.length) cached = FALLBACK.slice();
  } catch {
    cached = FALLBACK.slice();
  }
  return cached;
}

// One group row for the feature summary, or null when the group's tools are
// not in the catalog this process advertises.
function summaryLine(id, catalog) {
  const group = groups().find((entry) => entry.id === id);
  if (!group) return null;
  const known = new Set((catalog || []).map((tool) => tool && tool.name));
  const tools = group.tools.filter((name) => known.has(name));
  if (!tools.length) return null;
  return '[' + group.name + '] ' + tools.join(', ');
}

// summaryLines(catalog) -> string[]
//
// The feature-summary lines for every category group, in group order. A
// group with no member in the catalog is skipped, so a build without a
// tool module never claims a group it cannot serve.
function summaryLines(catalog) {
  const lines = [];
  for (const group of groups()) {
    if (group.kind !== 'category') continue;
    const line = summaryLine(group.id, catalog);
    if (line) lines.push(line);
  }
  return lines;
}

module.exports = { groups, summaryLine, summaryLines };
