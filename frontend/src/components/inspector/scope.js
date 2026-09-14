// Inspector edit scope and receipt.
//
// Every edit this panel makes lands on `element.style` for one property. That
// is the safest possible target, but the user cannot see it: the panel shows a
// highlighted row and a "changed" chip, which says *something* happened and
// nothing about what was kept, what was added, or how to get back.
//
// This module computes the two answers as plain data:
//
//   scopeSummary({declared, edited, rules}) -> { changed, kept, added, rulesEdited, elements }
//   recordChange(receipt, change)           -> a new receipt array
//   undoPlan(entry)                         -> { kind: 'set' | 'remove', prop, value }
//   describeChange(change)                  -> { prop, from, to, text }
//
// The receipt is the important half. An entry remembers the value the property
// had *before this session touched it* — not the value it had before the last
// apply — so a chain of edits on one property undoes in one step back to the
// original, and a property that did not exist before is removed rather than set
// to an empty string (which `style.setProperty(prop, '')` would treat as a
// removal anyway, silently).
//
// Nothing here touches the DOM or CDP: plain objects in, plain objects out.

// MAX_RECEIPT — entries kept in the strip. The list is a review affordance, not
// a history log: past this the oldest are dropped, with the count still
// reported so nothing is silently lost from the summary.
export const MAX_RECEIPT = 20;

// scopeSummary — the "only one thing changes" block.
//
//   declared  the element's own declarations right now (before the pending
//             write), as `{ prop, value }` rows.
//   edited    the property the pending write targets ('' for none).
//   rules     the matched-rules result, used only for its counts.
//
// `changed` is 1 while a write is pending, `added` tells whether that write
// creates a property that did not exist (which the user should know: it is the
// difference between overriding a value and introducing one), and `kept` is
// every other declaration, which the write cannot touch because it calls
// `setProperty` for one property.
export function scopeSummary(opts) {
  const o = opts || {};
  const declared = (o.declared || []).filter((r) => r && (r.prop || r.name));
  const pending = String(o.edited || '').trim();
  const lower = pending.toLowerCase();
  const exists = declared.some((r) => String((r.prop || r.name) || '').toLowerCase() === lower);
  return {
    changed: pending ? 1 : 0,
    added: pending && !exists ? 1 : 0,
    kept: Math.max(0, declared.length - (pending && exists ? 1 : 0)),
    rulesEdited: 0,
    elements: pending ? 1 : 0
  };
}

// describeChange — one receipt line: what property, from what, to what.
//
// `from` is kept as the literal text the property had ('' when it did not
// exist), so the line can print `padding 10px → 14px` or `padding — → 14px`
// honestly instead of inventing a previous value.
export function describeChange(change) {
  const c = change || {};
  const prop = String(c.prop || '');
  const from = normalize(c.from);
  const to = normalize(c.to);
  return {
    prop,
    from,
    to,
    wasSet: from !== '',
    isRemoval: to === '',
    text: prop + ' ' + (from === '' ? '—' : from) + ' → ' + (to === '' ? '(removed)' : to)
  };
}

function normalize(value) {
  if (value == null) return '';
  return String(value).trim();
}

// recordChange — fold a write into the receipt.
//
// Re-applying the same property updates its `to` and **keeps the original
// `from`**: undo has to reach the state before this session started editing,
// not the state before the last tap. A removal of a property that was never
// declared is a no-op (nothing to undo), so it is dropped.
export function recordChange(receipt, change) {
  const list = Array.isArray(receipt) ? receipt.slice() : [];
  const prop = String((change && change.prop) || '').trim();
  if (!prop) return list;
  // A declaration's priority is part of its identity in the cascade, so it is
  // tracked with the value: an edit that only adds `!important` to a declaration
  // that already had that value is a real change (it can start winning a fight it
  // was losing), and must not be misread as a no-op.
  const fromPriority = change && change.fromPriority === 'important' ? 'important' : '';
  const toPriority = change && change.toPriority === 'important' ? 'important' : '';
  const key = prop.toLowerCase();
  const at = list.findIndex((e) => String(e.prop || '').toLowerCase() === key);
  if (at < 0) {
  const entry = { prop, from: normalize(change.from), to: normalize(change.to), fromPriority, toPriority };
  // Nothing was written, and nothing to undo: a no-op (applying the value the
  // property already had, or a removal of something that was not there) must
  // not put an "undo" in front of the user for a change that did not happen.
  // Same value *and* same priority is that no-op; same value with a different
  // priority is not.
  if (entry.from === entry.to && entry.fromPriority === entry.toPriority) return list;
  list.push(entry);
  return list.slice(-MAX_RECEIPT);
  }
  const prev = list[at];
  // `from`/`fromPriority` are kept from the earliest entry for this property, so
  // undo reaches the state before the session started rather than before the last
  // tap; only `to`/`toPriority` move.
  const next = { prop: prev.prop, from: prev.from, to: normalize(change.to), fromPriority: prev.fromPriority || '', toPriority };
  // A change that ends where it started — value and priority both — is not a
  // change: drop the entry, so "type 16 then type it back" leaves no line and no
  // undo to offer.
  if (next.from === next.to && (next.fromPriority || '') === next.toPriority) {
  list.splice(at, 1);
  return list;
  }
  list[at] = next;
  return list;
  }

// undoPlan — what to call to reverse one entry.
//
// A property that was not set before is removed rather than set to '', because
// the two are the same to the browser but very different to read in a diff.
//
// The plan carries the *priority* to restore as well as the value. An undo that
// put the value back but not its `!important` would leave the element in a state
// this session never created — a declaration that used to win now losing to the
// rule it beat — so the priority the entry recorded before the write travels
// with it.
export function undoPlan(entry) {
const e = entry || {};
  const prop = String(e.prop || '');
  const from = normalize(e.from);
  const priority = e.fromPriority === 'important' ? 'important' : '';
  if (!prop) return null;
  if (from === '') return { kind: 'remove', prop, value: '' };
  return { kind: 'set', prop, value: from, priority };
  }

// undoOrder — the entries to reverse, newest first.
//
// Reversing in write order would mean an earlier entry for the same property
// could restore a value written later; newest-first is the order a user expects
// from "undo all" and it terminates at the original state in one pass.
export function undoOrder(receipt) {
  return (Array.isArray(receipt) ? receipt.slice() : []).reverse();
}

// summarizeReceipt — the strip's header: how many changes, and whether any of
// them created a property rather than overriding one.
export function summarizeReceipt(receipt) {
  const list = Array.isArray(receipt) ? receipt : [];
  let added = 0;
  let removed = 0;
  for (const e of list) {
    if (normalize(e && e.from) === '') added++;
    if (normalize(e && e.to) === '') removed++;
  }
  return { count: list.length, added, removed, hasChanges: list.length > 0 };
}

// receiptRows — the display rows for the strip, newest first (the thing the
// user just did is the thing they are most likely to reverse).
export function receiptRows(receipt) {
  return undoOrder(receipt).map((e, i) => {
    const d = describeChange(e);
    return { key: (d.prop || 'row') + '-' + i, prop: d.prop, from: d.from, to: d.to, text: d.text, wasSet: d.wasSet, isRemoval: d.isRemoval };
  });
}
