'use strict';

// The app-wide tool-group model, server side.
//
// `frontend/src/toolGroups.js` is the one list that decides which tool
// belongs to which group; scripts/build-tool-groups.js mirrors it to
// frontend/build/toolGroups.json so this module can read the same names the
// UI renders (the feature summary prints `[Chats](off|ask|allow) → …`, which has to
// match the tree row a user sees). Editing groups means editing that one file
// and re-running the generator; scripts/test-tool-groups.js fails if the two
// ever drift.
//
// The mirror is optional at runtime: without it this module falls back to the
// last group names compiled into the tree, so a partial install still reports
// the standard set instead of an empty summary.

const path = require('node:path');

// Fallback used only when the generated mirror is missing or unreadable:
// the two chat / app families, built from the server's own tool table.
const { DEFINITIONS, TOOL_NAMES } = require('./tools/appToolNames.js');
const FALLBACK = Object.freeze([
  { id: 'chats', name: 'Chats', source: 'chats', authKey: 'chats' },
  { id: 'mouaif-settings', name: 'mouaif', source: 'mouaif', authKey: 'mouaif' }
].map((group) => Object.assign(group, { tools: TOOL_NAMES.filter((name) => DEFINITIONS[name].source === group.source) })));

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

const modeLabel = (cfg) => cfg.mode + (cfg.mode === 'allowlist'
  ? ' (' + (Array.isArray(cfg.allowlist) ? cfg.allowlist.length : 0) + ' patterns)'
  : '');

// One family line for the feature summary, or null when the family is off
// or none of its tools is in the catalog this process advertises. A leaf
// whose own mode is `off` is left out of the list, like it is left out of
// the advertised tools.
function summaryLine(id, catalog, authTools) {
  const group = groups().find((entry) => entry.id === id);
  if (!group || !group.authKey) return null;
  const tools = authTools || {};
  const gate = tools[group.authKey] || { mode: 'ask' };
  if (gate.mode === 'off') return null;
  const known = new Set((catalog || []).map((tool) => tool && tool.name));
  const names = group.tools.filter((name) => known.has(name) && !(tools[name] && tools[name].mode === 'off'));
  if (!names.length) return null;
  return '[' + group.name + '](off|ask|allow) → ' + modeLabel(gate) + ' — ' + names.join(', ');
}

// summaryLines(catalog, authTools, skip) -> string[]
//
// One feature-summary line per multi-tool family (one gate, several
// leaves), in group order. `skip` holds gate keys the caller already
// reports on its own line (the file family keeps its legacy wording).
function summaryLines(catalog, authTools, skip = new Set()) {
  const lines = [];
  for (const group of groups()) {
    if (!group.authKey || group.tools.length < 2 || skip.has(group.authKey)) continue;
    const line = summaryLine(group.id, catalog, authTools);
    if (line) lines.push(line);
  }
  return lines;
}

module.exports = { groups, summaryLine, summaryLines };
