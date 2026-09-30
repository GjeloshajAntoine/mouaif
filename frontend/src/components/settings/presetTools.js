// mouaif web — Custom prompts: chat-preset tool selection helpers.
//
// A prompt's chat preset is RESTRICTIVE: the tool tree starts with every
// tool ticked, and each unticked tool is saved in `preset.disabledTools`.
// A chat attached to the prompt starts with those tools switched off; the
// user can tick them again in the chat's Tools card (the server writes the
// restriction onto the chat's own tool list once, at attach time — see
// src/prompts.js presetChatTools).
//
// The editor keeps the unticked ids as a Set (`disabled`). An empty Set is
// the same as "no restriction", so the tree and the saved record agree:
// what is ticked is what the chat gets.
//
// Pure helpers, unit-tested by scripts/test-preset-tools.js.

// presetToolSelection(disabled, allIds) -> string[] | null
//
// The value to hand `buildToolGroups` (an allowlist, `null` = all ticked).
export function presetToolSelection(disabled, allIds) {
  const off = disabled instanceof Set ? disabled : new Set(disabled || []);
  if (!off.size) return null;
  return (Array.isArray(allIds) ? allIds : []).filter((id) => typeof id === 'string' && !off.has(id));
}

// applyToolToggle({ disabled, ids, checked }) -> Set
//
// One toggle (a single row, or a whole group's ids): ticking removes the
// ids from the disabled set, unticking adds them.
export function applyToolToggle({ disabled, ids, checked }) {
  const next = new Set(disabled instanceof Set ? disabled : (disabled || []));
  for (const id of (Array.isArray(ids) ? ids : [ids])) {
    if (typeof id !== 'string' || !id) continue;
    if (checked) next.delete(id);
    else next.add(id);
  }
  return next;
}

// presetBody(preset) -> { disabledTools?, agentFiles?, skills? } | null
//
// The wire shape saved on the prompt. Agent files and skills are only sent
// when ticked: a preset can turn them on, never off. Nothing selected ->
// null ("no preset").
export function presetBody(preset) {
  if (!preset) return null;
  const out = {};
  const disabled = preset.disabled instanceof Set ? Array.from(preset.disabled) : [];
  if (disabled.length) out.disabledTools = disabled.sort();
  if (preset.agentFiles === true) out.agentFiles = true;
  if (preset.skills === true) out.skills = true;
  return Object.keys(out).length ? out : null;
}

// presetFromRecord(raw) -> { disabled: Set, agentFiles, skills }
//
// Editor state for a saved prompt's preset (null/legacy -> nothing set).
export function presetFromRecord(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    disabled: new Set(Array.isArray(p.disabledTools) ? p.disabledTools.filter((t) => typeof t === 'string') : []),
    agentFiles: p.agentFiles === true,
    skills: p.skills === true
  };
}

// presetsEqual(a, b) -> boolean — compares the saved shapes.
export function presetsEqual(a, b) {
  return JSON.stringify(presetBody(a)) === JSON.stringify(presetBody(b));
}
