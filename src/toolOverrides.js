'use strict';

// Per-project tool wording overrides (docs/features/tool-overrides.md).
//
// A project can re-word what the model is told about a tool without touching
// what the tool does: a replacement description, and a replacement name for
// any top-level parameter ("field"). A project keeps named wording sets and
// picks one (or Built-in) in the resolved setting `toolWording`:
//
//   { active: "<set id>" | "", sets: { "<set id>": { name, tools: OVERRIDES } } }
//   OVERRIDES = { "<tool>": { description?: string, fields?: { "<field>": "<new name>" } } }
//
// A project saved before sets existed has a flat `toolOverrides` (one
// OVERRIDES map), which applies until the project has any set.
//
// The model only ever sees the overridden spec; the app only ever sees the
// original one. `applyToSpecs` rewrites the advertised specs (as copies — the
// SPEC constants in src/tools/* are shared and must never be mutated), and
// `restoreArgs` renames a call's arguments back before anything dispatches.
// Tool names, authorization, grouping and nested parameters are not touched.

const MAX_DESCRIPTION_CHARS = 4000;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// normalize(raw) -> a clean overrides object. Reads defensively: a hand-edited
// project file may hold anything, and a bad entry is dropped rather than
// failing the chat. A rename that is not a valid name, repeats another
// rename of the same tool, or maps to a different field's own name is
// ignored, so the renamed schema can never collide with itself.
function normalize(raw) {
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
        const name = entry.fields[field];
        if (typeof name !== 'string') continue;
        const next = name.trim();
        if (!next || next === field || !FIELD_NAME.test(next) || taken.has(next)) continue;
        if (next in entry.fields && next !== field) continue;
        taken.add(next);
        fields[field] = next;
      }
      if (Object.keys(fields).length) clean.fields = fields;
    }
    if (clean.description || clean.fields) out[tool] = clean;
  }
  return out;
}

// activeOverrides(resolved) -> the overrides a resolved settings object puts
// in effect. Wording sets (`toolWording`) win once a project has any: the
// active set's tools, or none when `active` is '' (Built-in) or names a set
// that is gone. A project without sets still reads the legacy flat
// `toolOverrides`, so wording saved before sets existed keeps applying.
function activeOverrides(resolved) {
  const wording = resolved && resolved.toolWording;
  if (isPlain(wording) && isPlain(wording.sets) && Object.keys(wording.sets).length) {
    const set = typeof wording.active === 'string' && wording.active
      && Object.prototype.hasOwnProperty.call(wording.sets, wording.active) ? wording.sets[wording.active] : null;
    return isPlain(set) ? normalize(set.tools) : {};
  }
  return normalize(resolved && resolved.toolOverrides);
}

// overridesFor(projectDir) -> normalized overrides of the resolved settings,
// or {} when the project is unknown or its settings cannot be read.
function overridesFor(projectDir) {
  if (!projectDir) return {};
  try { return activeOverrides(require('./settings.js').getResolved(projectDir)); }
  catch { return {}; }
}

// prune(specs, overrides) -> overrides limited to what the advertised specs can
// honour: entries for tools that are not advertised are dropped, and so is a
// rename onto a name the tool's schema already uses, which would merge two
// fields into one. Apply and restore both run on the pruned set, so they agree.
function prune(specs, overrides) {
  const out = {};
  const byName = new Map();
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (spec && spec.function && spec.function.name) byName.set(spec.function.name, spec.function);
  }
  for (const tool of Object.keys(overrides || {})) {
    const fn = byName.get(tool);
    if (!fn) continue;
    const entry = Object.assign({}, overrides[tool]);
    const props = fn.parameters && isPlain(fn.parameters.properties) ? fn.parameters.properties : {};
    if (entry.fields) {
      const fields = {};
      for (const field of Object.keys(entry.fields)) {
        if (field in props && !(entry.fields[field] in props)) fields[field] = entry.fields[field];
      }
      if (Object.keys(fields).length) entry.fields = fields; else delete entry.fields;
    }
    if (entry.description || entry.fields) out[tool] = entry;
  }
  return out;
}

// applyToSpec(spec, entry) -> a copy of one `{ type, function }` spec with the
// override applied. Fields the spec does not have are ignored.
function applyToSpec(spec, entry) {
  if (!spec || !spec.function || !entry) return spec;
  const fn = Object.assign({}, spec.function);
  if (entry.description) fn.description = entry.description;
  const params = fn.parameters;
  if (entry.fields && isPlain(params) && isPlain(params.properties)) {
    const rename = (key) => (Object.prototype.hasOwnProperty.call(entry.fields, key) ? entry.fields[key] : key);
    const properties = {};
    for (const key of Object.keys(params.properties)) properties[rename(key)] = params.properties[key];
    const next = Object.assign({}, params, { properties });
    if (Array.isArray(params.required)) next.required = params.required.map(rename);
    fn.parameters = next;
  }
  return Object.assign({}, spec, { function: fn });
}

// applyToSpecs(specs, overrides) -> new array; specs without an override are
// passed through by reference.
function applyToSpecs(specs, overrides) {
  if (!Array.isArray(specs) || !isPlain(overrides) || !Object.keys(overrides).length) return specs;
  return specs.map((spec) => {
    const name = spec && spec.function && spec.function.name;
    return name && overrides[name] ? applyToSpec(spec, overrides[name]) : spec;
  });
}

// restoreArgs(tool, args, overrides) -> the call's arguments under the tool's
// original field names. Unknown keys pass through untouched.
function restoreArgs(tool, args, overrides) {
  const entry = overrides && overrides[tool];
  if (!entry || !entry.fields || !isPlain(args)) return args;
  const back = {};
  for (const field of Object.keys(entry.fields)) back[entry.fields[field]] = field;
  const out = {};
  for (const key of Object.keys(args)) {
    out[Object.prototype.hasOwnProperty.call(back, key) ? back[key] : key] = args[key];
  }
  return out;
}

module.exports = { MAX_DESCRIPTION_CHARS, FIELD_NAME, normalize, activeOverrides, overridesFor, prune, applyToSpec, applyToSpecs, restoreArgs };
