// Inspector target & origin model.
//
// The user's question while editing CSS is never "what is this property":
// it is "which element am I changing, which rule is my change landing in,
// and what was supplying the value before?". Three different answers:
//
//   * the element      — the Styles panel shows a `tag#id.class` label with
//                        no ancestors, so a class-only selector gives no clue
//                        which `.card` on the page is selected;
//   * the rules        — they live in a collapsed "Matched rules" section, so
//                        "is a class winning this?" costs an expand;
//   * the write target — implicit in the panel's behaviour (everything lands
//                        on element.style) and never stated.
//
// This module computes all three as plain data, so the bar that renders them
// is a dumb view and the decisions are unit-testable:
//
//   buildTargetBar(info) -> { tag, size, crumbs, ruleChips, target, origin, scope }
//
// `info` is what StylesPanel publishes after a selection: the label/box from
// `buildNodeModel`, the rules from `normalizeMatchedRules`, the tree from
// `readElementTree`, and the inline declarations from `readElementStyles`.

// MAX_CRUMBS — ancestors shown in the breadcrumb. A deep tree wraps to three
// lines on a phone and pushes the rule row out of the card. The cap elides
// the middle (see buildCrumbs): "where in the document" is answered by the
// root plus the last few hops.
export const MAX_CRUMBS = 5;

// MAX_RULE_CHIPS — rules shown as chips. Past this the row is wider than the
// screen and stops being readable at a glance, so the remainder is reported
// as a count. The chips are ranked (see buildRuleChips), so what is dropped
// is the least useful part.
export const MAX_RULE_CHIPS = 3;

// WRITE_TARGETS — where an edit can land, in the order the bar offers them.
//
// Inline only, for now: `element.style` wins the cascade on the element and
// is fully reversible. Editing a stylesheet rule needs `CSS.setStyleTexts`
// plus stylesheet source parsing — a substantially larger change — so it is
// listed (disabled) instead of left out, which is what stops "why won't my
// class change?" being a mystery.
export const WRITE_TARGETS = [
  { id: 'inline', label: 'element.style', editable: true, note: 'wins for this element only' },
  { id: 'rule', label: 'stylesheet rule', editable: false, note: 'editing rules is not enabled yet' }
];

// INLINE_TARGET — the write target every edit from this panel uses.
export const INLINE_TARGET = 'inline';

// splitLabel — `section#hero.card.tall` -> `{ tag, id, classes }`. The label
// is built by StylesPanel's elementLabel(); the bar only decomposes it for
// display (tag bold, the rest dimmed).
export function splitLabel(label) {
  const text = String(label == null ? '' : label);
  const m = /^([^#.]+)(.*)$/.exec(text);
  if (!m) return { tag: text, id: '', classes: [] };
  const rest = m[2] || '';
  const idMatch = /#([^.#]+)/.exec(rest);
  const classes = rest
    .split('.')
    .map((part) => part.replace(/#[^.#]+/, '').trim())
    .filter((part) => part && part !== '…');
  return { tag: m[1] || text, id: idMatch ? idMatch[1] : '', classes };
}

// CRUMB_MAX — how much of an ancestor label the breadcrumb prints. A deep
// class list (`div#standalone-api-panel.standalone-api-panel`) wraps the whole
// row to two lines on a 360 px screen, and the path is orientation, not
// identity: the full label is in the tag chip, the crumb's `title`, and the
// Styles panel's own breadcrumb. Truncated at the tail, so the tag and id
// survive.
export const CRUMB_MAX = 16;

// crumbLabel — the display text for one path entry.
export function crumbLabel(label, max) {
  const text = String(label == null ? '' : label);
  const limit = max || CRUMB_MAX;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

// buildCrumbs — the ancestor path plus the element, oldest first, with the
// current element flagged `isHere`. `ancestors` is `readElementTree`'s list
// (nearest first), whose entries carry `{ label, levels }` where `levels` is
// the hop count `selectAncestorNode` expects — so a crumb is directly
// actionable as long as it survives this function. Returns [] when there is no
// path, so the bar hides the row rather than printing the element twice.
//
// Over the cap the middle is replaced by one `elided` marker: the root gives
// the document context and the tail gives the immediate neighbourhood, which
// is what a wrapped two-line breadcrumb should say.
export function buildCrumbs(label, ancestors, hereLabel) {
  const here = String(hereLabel || label || '');
  const parents = (ancestors || [])
    .filter((a) => a && a.label)
    .map((a) => ({ label: String(a.label), levels: a.levels }))
    .reverse();
  const all = parents.concat(here ? [{ label: here, isHere: true }] : []);
  if (!all.length) return [];
  if (all.length <= MAX_CRUMBS) {
    return all.map((c, i) => ({
      label: crumbLabel(c.label, i === all.length - 1 ? CRUMB_MAX + 6 : CRUMB_MAX),
      title: c.label,
      levels: c.levels,
      isHere: i === all.length - 1
    }));
  }
  const out = [{ label: crumbLabel(all[0].label), title: all[0].label, levels: all[0].levels, isHere: false }];
  out.push({ label: '…', levels: undefined, elided: true, isHere: false });
  for (const c of all.slice(all.length - (MAX_CRUMBS - 2))) {
    out.push({ label: crumbLabel(c.label), title: c.label, levels: c.levels, isHere: false });
  }
  out[out.length - 1].isHere = true;
  return out;
}

// ruleCount — a rule's declaration count (what is shown, plus what the
// per-rule cap cut) so the chip number is the real total.
export function ruleCount(rule) {
  if (!rule) return 0;
  return ((rule.props || []).length) + (rule.more || 0);
}

// ruleRank — how likely a rule is to be the answer to "why is this value like
// that?". `element.style` first because it is the write target and the thing
// that wins; then author rules on the element; then inherited; then browser
// defaults. `normalizeMatchedRules` already returns cascade order, so a
// stable sort on this rank keeps the winning author rule ahead of later ones.
function ruleRank(rule) {
  if (!rule) return 9;
  if (rule.origin === 'inline') return 0;
  if (rule.group === 'user-agent') return 3;
  if (rule.inherited) return 2;
  return 1;
}

// buildRuleChips — the matching rules as chip data, best-first, capped.
//
// Browser-default (UA) rules are excluded outright: their "selector" for an
// element like `div` is the whole HTML element list (`address, blockquote,
// center, …`), which wraps to five lines on a phone and pushes the useful
// chips off the row. They are the same rules the Styles panel hides behind its
// UA toggle, so the chips stay consistent with it and the excluded count is
// reported instead.
export function buildRuleChips(rules) {
  const sorted = (rules || [])
    .filter(Boolean)
    .map((rule, i) => ({ rule, i }))
    .sort((a, b) => (ruleRank(a.rule) - ruleRank(b.rule)) || (a.i - b.i))
    .map((x) => x.rule);
  const ua = sorted.filter((r) => r.group === 'user-agent');
  const candidates = sorted.filter((r) => r.group !== 'user-agent');
  const shown = candidates.slice(0, MAX_RULE_CHIPS);
  const rest = candidates.slice(MAX_RULE_CHIPS);
  return {
    chips: shown.map((r) => ({
      id: r.id,
      label: r.selector || '(unknown)',
      count: ruleCount(r),
      origin: r.origin || 'regular',
      isUa: false,
      inherited: r.inherited || '',
      isTarget: r.origin === 'inline'
    })),
    hidden: rest.length,
    hiddenUa: ua.length,
    total: candidates.length
  };
}

// findDeclaringRule — the first (most specific) rule that declares
// `property`. Deliberately walks the cascade rather than reading computed
// styles, because the user needs the *rule* (`.card`), not the resolved value.
export function findDeclaringRule(rules, property) {
  const want = String(property || '').trim().toLowerCase();
  if (!want) return null;
  for (const rule of rules || []) {
    for (const p of (rule && rule.props) || []) {
      if (String((p && p.name) || '').toLowerCase() === want) return { rule, prop: p };
    }
  }
  return null;
}

// inlineValueOf — the element's own declared value for a property, or ''.
// `declared` is the inline declaration list from `readElementStyles`; rows are
// `{ prop, value }` (the `name` alias is accepted because the CDP-shaped rows
// carry `name`).
export function inlineValueOf(declared, property) {
  const want = String(property || '').trim().toLowerCase();
  if (!want) return '';
  for (const row of declared || []) {
    const name = String((row && (row.prop || row.name)) || '').toLowerCase();
    if (name === want) return String((row && row.value) == null ? '' : row.value);
  }
  return '';
}

// pickFocusProperty — which property the origin line describes.
//
// Order matters: what the user is editing right now is what they are asking
// about; then the last thing they changed this session (the changed list is
// most-recent-first); then the element's first own declaration; and finally —
// because an element with no inline styles is the common case — the first
// declaration of the best-ranked author rule. Without that last fallback the
// bar has nothing to explain exactly when the user most needs it ("I selected
// this div, where do its values come from?"). Returns '' when there is nothing
// to describe, and the bar then hides the origin row.
export function pickFocusProperty(opts) {
  const o = opts || {};
  const editing = String(o.editing || '').trim();
  if (editing) return editing;
  const changed = (o.changed || []).find((p) => p && String(p).trim());
  if (changed) return String(changed).trim();
  const first = (o.declared || []).find((row) => row && (row.prop || row.name));
  if (first) return String(first.prop || first.name).trim();
  const fromRule = firstAuthorProperty(o.rules);
  if (fromRule) return fromRule;
  return '';
}

// firstAuthorProperty — the first declaration of the highest-ranked author
// rule. UA rules are skipped for the same reason the chips skip them: a
// browser default is not an answer to "where does this value come from".
export function firstAuthorProperty(rules) {
  const list = (rules || []).filter(Boolean);
  const ranked = list
    .map((rule, i) => ({ rule, i }))
    .sort((a, b) => (ruleRank(a.rule) - ruleRank(b.rule)) || (a.i - b.i))
    .map((x) => x.rule);
  for (const rule of ranked) {
    if (rule.group === 'user-agent') continue;
    const p = (rule.props || []).find((x) => x && x.name);
    if (p) return String(p.name).trim();
  }
  return '';
}

// originSentence — the one line explaining where the value comes from.
//
// Four cases, and the difference between them is the point of the bar: a value
// this element already overrides inline (what the edit will be), a value a
// class supplies (why the property "won't change" by itself), a value nothing
// declares but the browser resolves (inherited/default), and no declaration at
// all.
export function originSentence(opts) {
  const o = opts || {};
  const property = String(o.property || '').trim();
  if (!property) return '';
  const target = WRITE_TARGETS.find((t) => t.id === (o.target || INLINE_TARGET)) || WRITE_TARGETS[0];
  const inline = String(o.inlineValue == null ? '' : o.inlineValue).trim();

  if (inline) {
    return property + ': ' + inline + ' is set on ' + target.label + ', which wins this value for this element only.';
  }

  const declaring = o.declaringRule;
  if (declaring && declaring.rule) {
    const rule = declaring.rule;
    const from = rule.selector || '(unknown rule)';
    const value = declaring.prop && declaring.prop.value ? ' (' + declaring.prop.value + ')' : '';
    // An ancestor's own inline style: `element.style` belongs to *that*
    // element, so calling it "an inherited rule on html element.style" reads
    // like a stylesheet rule and is wrong. Say where it actually is.
    if (rule.inherited && from === 'element.style') {
      return property + ' is set on the ancestor ' + rule.inherited + ' (its inline style) and inherits down' +
        value + '. Editing ' + target.label + ' overrides it for this element only.';
    }
    const kind = rule.group === 'user-agent' ? 'the browser default'
      : rule.inherited ? 'an inherited rule on ' + rule.inherited
        : 'the stylesheet rule';
    return property + ' comes from ' + kind + ' ' + from + value +
      '. Editing ' + target.label + ' overrides it for this element only.';
  }

  const computed = String(o.computedValue == null ? '' : o.computedValue).trim();
  if (computed) {
    return property + ' is not declared by any matching rule — the browser resolves it to ' + computed +
      '. Editing ' + target.label + ' adds a declaration for this element only.';
  }
  return property + ' has no declaration on this element. Editing ' + target.label +
    ' adds one for this element only.';
}

// cleanSize — the box-size caption, or '' when there is nothing to say.
// `boxSummary` in the panel returns `— × —` for an element with no measurable
// box (a detached node, a display:none pickup); printing that next to the tag
// is noise pretending to be data, so the chip drops the field instead.
export function cleanSize(size) {
  const text = String(size == null ? '' : size).trim();
  if (!text) return '';
  if (/^[—\-\s×x]+$/i.test(text)) return '';
  return text;
}

// selectionAcrossModes — merge the panel's live read of the selection with the
// store the Inspector keeps above it.
//
// The store exists so the target bar and the receipt survive switching a panel
// off, or away to Console / Network / Info: the selection belongs to the
// Inspector, not to the Styles panel's mount. The two can disagree for a moment
// (the panel is repainting, the store still holds the previous element), so the
// rule is "the live read wins while the panel is mounted".
//
//   live     the snapshot the Styles panel published, or null when it is not
//            mounted (its published values are cleared on unmount — see
//            StylesPanel's publish effect).
//   stored   the snapshot the Inspector retained.
//
// Returns null when both are empty, so the bar can hide itself. Returns the
// stored snapshot when the panel is gone, which is what keeps the element's
// identity and rules on screen while the user is reading Console output.
export function selectionAcrossModes(live, stored) {
  const use = (s) => s && typeof s === 'object' && String(s.label || '').trim() !== '';
  if (use(live)) return live;
  if (use(stored)) return stored;
  return null;
}

// mergeReceipts — the session receipt as seen above the panels.
//
// The Styles panel owns the writes and therefore the authoritative list, but it
// unmounts when its chip is switched off, and a freshly mounted panel has an
// empty list until the user edits again. So the rule is "the non-empty list
// wins": the panel's while it has entries, the retained one while it does not.
// (Preferring a live-but-empty list made the receipt vanish from the bar the
// moment the panel was switched off and on again, while the changes it
// described were still applied to the page.)
export function mergeReceipts(live, stored) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const l = list(live);
  if (l.length) return l;
  const s = list(stored);
  if (s.length) return s;
  return [];
}

// shouldAdopt — whether the Styles panel should re-adopt the retained selection
// on mount.
//
// The selection is published by the panel, so switching the panel off loses the
// panel's own state: the objectId, the element tree, the rule list and the
// receipt all go with the mount. The Inspector keeps the objectId in its store,
// and this is the decision to hand it back — adopt only when the panel has
// nothing selected of its own and the store names an element, so a fresh pick
// after a remount is never overwritten by the stored one.
export function shouldAdopt(liveLabel, storedObjectId) {
  if (String(liveLabel || '').trim()) return '';
  const id = String(storedObjectId || '').trim();
  return id || '';
}

// buildTargetBar — the whole model the bar renders. Every field is display
// data: the component adds no logic of its own.
export function buildTargetBar(info) {
  const i = info || {};
  const shape = splitLabel(i.label);
  const rules = (i.rules && i.rules.rules) || [];
  const chipInfo = buildRuleChips(rules);
  const declared = i.declared || [];
  const property = pickFocusProperty({ editing: i.editing, changed: i.changed, declared, rules });
  const declaringRule = findDeclaringRule(rules, property);
  return {
    label: String(i.label || ''),
    tag: shape.tag,
    id: shape.id,
    classes: shape.classes,
    size: cleanSize(i.size),
    crumbs: buildCrumbs(i.label, (i.tree && i.tree.ancestors) || [], i.label),
    ruleChips: chipInfo.chips,
    rulesHidden: chipInfo.hidden,
    rulesHiddenUa: chipInfo.hiddenUa,
    rulesTotal: chipInfo.total,
    counts: (i.rules && i.rules.counts) || { total: 0, author: 0, userAgent: 0 },
    target: INLINE_TARGET,
    targetLabel: WRITE_TARGETS[0].label,
    targetNote: WRITE_TARGETS[0].note,
    focusProperty: property,
    origin: originSentence({
      property,
      target: INLINE_TARGET,
      inlineValue: inlineValueOf(declared, property),
      declaringRule,
      computedValue: i.computedValue
    }),
    // The scope summary, in the same words the (upcoming) commit summary uses:
    // one property changes, everything else on the element is kept, no rule is
    // touched, and only this element is affected.
    scope: {
      changed: property ? 1 : 0,
      kept: Math.max(0, declared.length - (property && inlineValueOf(declared, property) ? 1 : 0)),
      rulesEdited: 0,
      elements: property ? 1 : 0
    }
  };
}
