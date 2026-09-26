// mouaif web — Chat preset tool-selection math
//
// The Custom prompts screen has a "Chat preset" switch that bundles a tool
// selection (plus agent files / skills) onto a saved prompt. The tool tree
// it renders is the same `buildToolGroups` the chat Tools card uses, and
// that builder reads its selection like this (ToolTree.jsx):
//
//   null            -> "everything on"
//   ['shell', ...]  -> an explicit allowlist ([] = every row unchecked)
//
// A preset is ADDITIVE — it can only ever grant tools, never restrict a
// chat — so switching it on has to start from the all-on baseline, and the
// neutral value for that is `null`. An empty Set is NOT that value: it is a
// real, explicit "this preset grants nothing" state which has to stay
// distinguishable, or unchecking the last row would silently flip the tree
// back to all-on.
//
// The persisted format has no "grants zero tools" either — `normalizePreset()`
// in src/prompts.js collapses an empty `tools` list to "absent", and a
// preset with no tools, no agent files and no skills normalizes to "no
// preset". That is the correct end state for an explicitly-empty selection:
// a chat already has every tool, so granting none is the same as not
// attaching a preset at all.
//
// These helpers keep the two states apart and snapshot the implicit all-on
// set on the first uncheck, the same move the chat Tools card makes when
// `chat.tools` is null (frontend/src/components/chat/cards.js).

// presetToolSelection(tools) -> string[] | null
//
// The value to hand `buildToolGroups`. `null`/undefined is the implicit
// "all on" baseline; a Set becomes the explicit allowlist.
export function presetToolSelection(tools) {
  if (tools instanceof Set) return Array.from(tools);
  return null;
}

// commitTools(tools, allIds) -> Set
//
// Collapse an explicit selection that covers every rendered tool back to
// `null` — the all-on baseline — so a preset never pins a stale full
// snapshot the way a long allowlist would. Mirrors the chat Tools card,
// which prefers `null` when the set covers the whole catalog.
export function commitTools(tools, allIds) {
  const set = tools instanceof Set ? tools : new Set(tools || []);
  const total = Array.isArray(allIds) ? allIds.length : 0;
  if (total > 0 && set.size >= total) return null;
  return set;
}

// applyToolToggle({ tools, allIds, ids, checked }) -> Set | null
//
// One toggle (a single row, or a whole group's ids) against the current
// selection. `tools` is `null` for the all-on baseline, so an uncheck while
// there starts from every rendered id instead of from nothing; checking a
// row while already all-on stays at the baseline.
export function applyToolToggle({ tools, allIds, ids, checked }) {
  const list = Array.isArray(ids) ? ids : [ids];
  const every = Array.isArray(allIds) ? allIds : [];

  if (!(tools instanceof Set)) {
    if (checked) return null; // already all-on
    const next = new Set(every);
    for (const id of list) next.delete(id);
    return commitTools(next, every);
  }

  const next = new Set(tools);
  for (const id of list) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return commitTools(next, every);
}
