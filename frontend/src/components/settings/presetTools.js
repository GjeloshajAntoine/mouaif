// mouaif web — Chat preset tool-selection math
//
// The Custom prompts screen has a "Chat preset" tool tree that bundles a tool
// selection (plus agent files / skills) onto a saved prompt. A chat created
// from that prompt starts with the selection as its own tool allowlist
// (`chat.tools`, see src/chats.js createChat). The tool tree it renders is
// the same `buildToolGroups` the chat Tools card uses, and that builder reads
// its selection like this (ToolTree.jsx):
//
//   null            -> "everything on"
//   ['shell', ...]  -> an explicit allowlist ([] = every row unchecked)
//
// `null` is the baseline: a preset with no tool selection leaves new chats
// with every tool, exactly like a chat with no allowlist, so the tree shows
// every row checked. An empty Set is NOT that value: it is a real, explicit
// "new chats start with no tools" state which has to stay distinguishable,
// or unchecking the last row would silently flip the tree back to all-on.
// It persists as `tools: []`, which `normalizePreset()` in src/prompts.js
// keeps.
//
// These helpers keep the two states apart and snapshot the implicit all-on
// set on the first uncheck, the same move the chat Tools card makes when
// `chat.tools` is null (frontend/src/components/chat/cards.js).

// presetToolSelection(tools) -> string[] | null
//
// The value to hand `buildToolGroups`: a Set becomes the explicit allowlist,
// anything else is the tree's own all-on value.
export function presetToolSelection(tools) {
  return tools instanceof Set ? Array.from(tools) : null;
}

// commitTools(tools, allIds) -> Set | null
//
// Collapse an explicit selection that covers every rendered id back to
// `null`, so a preset never pins a stale full snapshot that would hide tools
// added later (a new MCP server, a new native tool).
export function commitTools(tools, allIds) {
  const set = tools instanceof Set ? tools : new Set(tools || []);
  const every = Array.isArray(allIds) ? allIds : [];
  if (every.length > 0 && every.every((id) => set.has(id))) return null;
  return set;
}

// applyToolToggle({ tools, allIds, ids, checked }) -> Set | null
//
// One toggle (a single row, or a whole group's ids) against the current
// selection. `tools` is `null` for the baseline, so an uncheck while there
// starts from every id instead of from nothing; checking a row while there
// keeps the baseline.
export function applyToolToggle({ tools, allIds, ids, checked }) {
  const list = Array.isArray(ids) ? ids : [ids];
  const every = Array.isArray(allIds) ? allIds : [];
  const next = tools instanceof Set ? new Set(tools) : new Set(every);
  for (const id of list) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return commitTools(next, every);
}
