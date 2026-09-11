// Inspector matched-rules model.
//
// A pure, unit-testable normalizer that turns a cascade description into
// the flat, mobile-sized list the Styles panel renders. Two sources produce
// the same input shape:
//
//   * CDP `CSS.getMatchedStylesForNode` (the accurate path — it knows about
//     shadow DOM, adopted stylesheets, and whether an @media actually
//     applies), and
//   * the in-page scan fallback (`Runtime.callFunctionOn` walking
//     `document.styleSheets`), used when the DOM domain is unavailable or
//     `DOM.requestNode` maps the element to nodeId 0.
//
// Keeping the shape identical means there is exactly one normalizer to test
// and the panel never has to care which source answered.
//
// Nothing here touches the network or the DOM: it takes a plain object and
// returns a plain object, so `scripts/test-inspector-matched-rules.js` can
// cover the ordering, the property cleanup, and the caps directly.

// ORIGIN_LABEL — short chip text for a rule's origin. Chrome reports
// `regular` for author rules, `user-agent` for the browser's own defaults,
// `injected` for extensions, and `inspector` for styles the DevTools front
// end wrote. Author rules get no chip: they are the boring majority.
// The browser-default chip is spelled out — "UA" is DevTools shorthand that
// reads as nothing at all next to a selector, and both the chip and the
// toggle that reveals these rules need to say the same thing.
export const ORIGIN_LABEL = {
regular: '',
'user-agent': 'browser',
injected: 'ext',
inspector: 'inspector',
inline: 'inline'
};

// Author/default classification. The panel hides UA rules by default: a
// typical page has a dozen browser-default rules per element and they are
// almost never what the user came to change, so showing them by default
// buries the one author rule that matters.
export const ORIGIN_GROUP = {
  regular: 'author',
  injected: 'author',
  inspector: 'author',
  inline: 'author',
  'user-agent': 'user-agent'
};

// Caps. A single element can match dozens of rules, each with dozens of
// declarations; an uncapped list would be a slower, longer version of the
// computed wall the panel already has. Overflow is reported as a count so
// the panel can say what it left off instead of silently truncating.
export const MAX_RULES = 40;
export const MAX_PROPS_PER_RULE = 24;

// selectorTextOf — the rule's selector list as one line. Chrome returns
// `{ selectorList: { selectors: [{ text }] } }`; a comma-separated list is
// kept intact because that is how the author wrote it.
export function selectorTextOf(rule) {
  const list = (rule && rule.selectorList && rule.selectorList.selectors) || [];
  const parts = list.map((s) => (s && s.text ? String(s.text).trim() : '')).filter(Boolean);
  if (parts.length) return parts.join(', ');
  const raw = (rule && rule.selectorList && rule.selectorList.text) || '';
  return String(raw).trim();
}

// mediaTextOf — the rule's @media condition(s), if any. Chrome nests one
// entry per enclosing `@media`, so a rule inside two of them reads as
// `(min-width: 600px) and (prefers-color-scheme: dark)`. Returns '' for an
// unconditional rule so the caller can skip the chip entirely.
export function mediaTextOf(rule) {
  const media = (rule && rule.media) || [];
  const parts = media.map((m) => (m && m.text ? String(m.text).trim() : '')).filter(Boolean);
  return parts.join(' and ');
}

// propsOf — the declarations of one CSSStyle, cleaned for display.
//
// `implicit: true` marks a longhand that the engine generated from a
// shorthand the author actually wrote. Dropping them keeps `margin: 40px`
// as one readable row instead of four, which matters when the whole section
// has to stay scannable on a phone. Disabled declarations survive (with
// their state) because "this rule sets it, but the declaration is off" is
// exactly the sort of thing that is invisible everywhere else.
export function propsOf(style) {
  const props = (style && style.cssProperties) || [];
  const out = [];
  for (const p of props) {
    if (!p || !p.name || p.implicit) continue;
    out.push({
      name: String(p.name),
      value: String(p.value == null ? '' : p.value),
      important: !!p.important,
      disabled: !!p.disabled
    });
  }
  return out;
}

// ruleEntry — one normalized rule. `inherited` is a human label for the
// ancestor the rule was matched on, or '' when the rule applies to the
// selected element itself. `more` is how many declarations were cut by the
// per-rule cap.
function ruleEntry(rule, opts) {
  const props = propsOf(rule && rule.style);
  if (!props.length) return null;
  const shown = props.slice(0, MAX_PROPS_PER_RULE);
  const origin = opts.origin || 'regular';
  return {
    id: opts.id,
    selector: opts.selector,
    origin,
    group: ORIGIN_GROUP[origin] || 'author',
    media: mediaTextOf(rule),
    inherited: opts.inherited || '',
    props: shown,
    more: Math.max(0, props.length - shown.length)
  };
}

// entriesFromStyleList — the rules of a CDP `RuleMatch[]` (or a scanned
// ancestor's rule array) as normalized entries, most specific first.
//
// Chrome returns `matchedCSSRules` least-specific first (the cascade
// order). The panel renders the list top-down with the winning rule at the
// top — the same reading order as the desktop Styles pane — so the array is
// reversed here. `prefix` keeps Preact keys unique across the element's own
// rules and every inherited ancestor's.
function entriesFromStyleList(list, opts) {
  const rules = (list || []).map((m) => (m && m.rule) || m).filter(Boolean);
  const out = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    const entry = ruleEntry(rules[i], {
      id: opts.prefix + '-m' + i,
      selector: selectorTextOf(rules[i]) || '(unknown)',
      origin: rules[i].origin || 'regular',
      inherited: opts.inherited
    });
    if (entry) out.push(entry);
  }
  return out;
}

// normalizeMatchedRules — the one entry point. `raw` is a
// `CSS.getMatchedStylesForNode` response (or the scan fallback built to the
// same shape); `opts.ancestors` is the ancestor label list from
// `readElementTree`, nearest first, used to caption inherited rules.
//
// Returns `{ rules, counts }`. `rules` is capped at MAX_RULES with
// `truncated` reporting how many were dropped, and `counts` breaks the
// *uncapped* total down so the panel can label its "show UA rules" toggle
// with a real number even while the list itself is filtered.
export function normalizeMatchedRules(raw, opts) {
  const source = raw || {};
  const ancestors = (opts && opts.ancestors) || [];
  const rules = [];

  // element.style first — the same slot the desktop Styles pane gives it,
  // and the only origin this panel can edit.
  const inline = ruleEntry({ style: source.inlineStyle }, {
    id: 'inline',
    selector: 'element.style',
    origin: 'inline'
  });
  if (inline) rules.push(inline);

  rules.push(...entriesFromStyleList(source.matchedCSSRules, { prefix: 'own' }));

  // Inherited: one entry per ancestor, nearest first. Chrome's chain and
  // the ancestor label list are both built by walking up from the element,
  // so index i of one lines up with index i of the other.
  const inherited = source.inherited || [];
  for (let i = 0; i < inherited.length; i++) {
    const from = ancestors[i] && ancestors[i].label ? ancestors[i].label : 'ancestor';
    const group = inherited[i] || {};
    const inlineEntry = ruleEntry({ style: group.inlineStyle }, {
      id: 'inh' + i + '-inline',
      selector: 'element.style',
      origin: 'inline',
      inherited: from
    });
    if (inlineEntry) rules.push(inlineEntry);
    rules.push(...entriesFromStyleList(group.matchedCSSRules, { prefix: 'inh' + i, inherited: from }));
  }

  const counts = { total: rules.length, author: 0, userAgent: 0 };
  for (const r of rules) {
    if (r.group === 'user-agent') counts.userAgent++;
    else counts.author++;
  }

  const kept = rules.slice(0, MAX_RULES);
  return { rules: kept, counts, truncated: Math.max(0, rules.length - kept.length) };
}
