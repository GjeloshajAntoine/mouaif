// Styles panel row ordering — a pure module so the "changed values first"
// behaviour is unit-testable without a DOM.
//
// Why this exists: the panel lists the element's inline ("Declared styles")
// properties and its resolved ("Computed") properties, and the computed list
// is a ~400-row alphabetical wall. After an edit the property the user just
// changed is somewhere in that wall, so the panel gives no answer to the only
// question worth asking — "what did I change, and what is it now?".
//
// So edits made in this session are tracked by property name and:
//   - hoisted to the top of both lists, most recently changed first, and
//   - rendered with a highlight (see `.inspector__styles-row--changed`).
//
// `changed` is a plain array of property names, most recent first. An array
// (not a Set) because the order IS the sort key: the last thing you touched
// is the thing you are most likely to be looking at.

// markChanged — record a property as just-changed, moving it to the front.
// Returns a new array; never mutates the caller's list.
export function markChanged(changed, prop) {
  const name = String(prop || '').trim();
  if (!name) return changed;
  const next = changed.filter((p) => p !== name);
  next.unshift(name);
  return next;
}

// unmarkChanged — forget a property (it was removed, so there is nothing
// left to highlight).
export function unmarkChanged(changed, prop) {
  const name = String(prop || '').trim();
  if (!name) return changed;
  if (!changed.includes(name)) return changed;
  return changed.filter((p) => p !== name);
}

// changedRank — the sort rank of one property: 0 for the most recently
// changed, 1 for the next, and Infinity for everything untouched. Untouched
// rows therefore keep their original relative order (Array.prototype.sort is
// stable), which is what the alphabetical computed list and the inline-style
// insertion order both want.
function changedRank(changed, prop) {
  const i = changed.indexOf(prop);
  return i === -1 ? Infinity : i;
}

// orderChangedFirst — a copy of `rows` with the changed properties hoisted to
// the top, most recently changed first. `rows` are objects carrying a `prop`;
// `key` lets a caller order by something else (defaults to `prop`).
export function orderChangedFirst(rows, changed, key) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!Array.isArray(changed) || changed.length === 0) return list;
  const keyOf = key || ((row) => row && row.prop);
  return list.sort((a, b) => changedRank(changed, keyOf(a)) - changedRank(changed, keyOf(b)));
}

// isChanged — whether a property is in the changed list.
export function isChanged(changed, prop) {
  return Array.isArray(changed) && changed.includes(prop);
}
