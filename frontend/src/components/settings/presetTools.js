// mouaif web — Chat preset tool-selection math
//
// The Custom prompts screen has a "Chat preset" tool tree that bundles a tool
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
// Two families of tools are left UNCHECKED on a fresh baseline (see
// PRESET_DEFAULT_OFF_TOOLS): the grouped file operations. Everything else
// still starts checked. The baseline is therefore not literally "every id"
// — it is `presetDefaultSelection(allIds)`, which this module owns so the
// rendered tree, the first-uncheck snapshot, and the "collapse back to the
// baseline" step all agree on the same target.
//
// The persisted format has no "grants zero tools" either — `normalizePreset()`
// in src/prompts.js collapses an empty `tools` list to "absent", and a
// preset with no tools, no agent files and no skills normalizes to "no
// preset". That is the correct end state for an explicitly-empty selection:
// a chat already has every tool, so granting none is the same as not
// attaching a preset at all.
//
// These helpers keep the two states apart and snapshot the implicit default
// set on the first uncheck, the same move the chat Tools card makes when
// `chat.tools` is null (frontend/src/components/chat/cards.js).

// Tools the preset tree leaves unchecked on a fresh prompt. The grouped file
// operations are opt-in: a preset is expected to advertise the single-file
// tools, and a chat that wants the batch tools checks them on. Kept here so
// the rule has one home (rendering, first-uncheck snapshot, and the
// collapse-to-baseline step all read it).
export const PRESET_DEFAULT_OFF_TOOLS = ['group_read', 'group_edit'];

// presetDefaultSelection(allIds, defaultOff) -> string[]
//
// The baseline set: every rendered id except the default-off family. This is
// what a `null` preset selection resolves to, and what a selection must match
// to collapse back to `null`.
export function presetDefaultSelection(allIds, defaultOff = PRESET_DEFAULT_OFF_TOOLS) {
  const off = new Set(Array.isArray(defaultOff) ? defaultOff : []);
  return (Array.isArray(allIds) ? allIds : [])
    .filter((id) => typeof id === 'string' && !off.has(id));
}

// presetToolSelection(tools, allIds, defaultOff) -> string[] | null
//
// The value to hand `buildToolGroups`. A Set becomes the explicit allowlist.
// A null/undefined selection — the implicit baseline — becomes the default
// selection (every id except the default-off family), so the grouped tools
// render unchecked without the caller having to seed an explicit list. With
// no `allIds` yet (catalog still loading) it stays `null`, the tree's own
// all-on value, so the first paint is unchanged.
export function presetToolSelection(tools, allIds, defaultOff = PRESET_DEFAULT_OFF_TOOLS) {
  if (tools instanceof Set) return Array.from(tools);
  if (Array.isArray(allIds) && allIds.length) return presetDefaultSelection(allIds, defaultOff);
  return null;
}

// commitTools(tools, allIds, defaultOff) -> Set | null
//
// Collapse an explicit selection that matches the baseline back to `null` so
// a preset never pins a stale full snapshot the way a long allowlist would.
// Mirrors the chat Tools card, which prefers `null` when the set covers the
// catalog. A selection that also flips the default-off tools on is NOT the
// baseline, so it stays an explicit Set (collapsing it would drop the user's
// intent, since `null` renders those rows unchecked again).
export function commitTools(tools, allIds, defaultOff = PRESET_DEFAULT_OFF_TOOLS) {
  const set = tools instanceof Set ? tools : new Set(tools || []);
  const baseline = presetDefaultSelection(allIds, defaultOff);
  if (baseline.length > 0 && set.size === baseline.length && baseline.every((id) => set.has(id))) {
    return null;
  }
  return set;
}

// applyToolToggle({ tools, allIds, ids, checked, defaultOff }) -> Set | null
//
// One toggle (a single row, or a whole group's ids) against the current
// selection. `tools` is `null` for the baseline, so an uncheck while there
// starts from the default selection instead of from nothing; checking a row
// already in the baseline keeps the baseline.
export function applyToolToggle({ tools, allIds, ids, checked, defaultOff = PRESET_DEFAULT_OFF_TOOLS }) {
  const list = Array.isArray(ids) ? ids : [ids];
  const every = Array.isArray(allIds) ? allIds : [];
  const next = tools instanceof Set ? new Set(tools) : new Set(presetDefaultSelection(every, defaultOff));

  for (const id of list) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return commitTools(next, every, defaultOff);
}
