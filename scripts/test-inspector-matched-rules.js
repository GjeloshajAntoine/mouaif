'use strict';
// Test for the Inspector Styles panel "Matched rules" model.
//
// The matched-rules section is the read-only answer to "which class or rule
// put this value here?". Two sources feed it — CDP
// `CSS.getMatchedStylesForNode` and an in-page scan fallback — and both are
// normalized by frontend/src/components/inspector/matchedRules.js. That
// module is pure (plain object in, plain object out), so the ordering, the
// property cleanup, the origin classification, the inheritance captions, and
// the caps can all be asserted here without a browser.
//
// The behaviour these assertions lock in, and why each one matters on a
// 360 px phone:
//   * element.style first, then the most specific author rule — the rule
//     that is winning is the one the user needs at the top of the list, and
//     CDP hands them over least-specific first;
//   * implicit (shorthand-expanded) declarations dropped — `margin: 40px`
//     must stay one row, not four;
//   * browser-default rules classified, not hidden here — the panel counts
//     them so its "Show N browser default rules" toggle can name a real number
//     while keeping them out of the list;
//   * inherited rules captioned with the ancestor label, matched to Chrome's
//     inheritance chain index for index;
//   * caps applied with the overflow reported rather than silently dropped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/matchedRules.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const { normalizeMatchedRules, propsOf, selectorTextOf, mediaTextOf } = context;
// The caps are top-level `const`s, which a vm script binds lexically rather
// than exposing as properties of the context object — read them by name.
const MAX_RULES = vm.runInContext('MAX_RULES', context);
const MAX_PROPS_PER_RULE = vm.runInContext('MAX_PROPS_PER_RULE', context);

// The module under test runs in a separate vm realm, so every array and every
// object it returns carries that realm's prototype and would fail
// assert.deepStrictEqual against a host-realm literal. Re-create each one with
// Array.from / spread before comparing.
const arr = (x) => Array.from(x);

// rule — a minimal CDP CSSRule shape.
function rule(selector, props, extra) {
  return Object.assign({
    selectorList: { selectors: [{ text: selector }] },
    origin: 'regular',
    style: { cssProperties: props.map(([name, value, opts]) => Object.assign({ name, value }, opts || {})) }
  }, extra || {});
}

// cssStyle — a minimal CDP CSSStyle shape for an inline style.
function cssStyle(props) {
  return { cssProperties: props.map(([name, value]) => ({ name, value })) };
}

function main() {
  // --- selector / media readers -------------------------------------
  assert.strictEqual(selectorTextOf(rule('.a', [])), '.a');
  assert.strictEqual(
    selectorTextOf({ selectorList: { selectors: [{ text: '.a' }, { text: '.b' }] } }),
    '.a, .b',
    'a selector list stays one line, as the author wrote it');
  assert.strictEqual(selectorTextOf({ selectorList: { selectors: [{ text: '  .trim  ' }] } }), '.trim');
  assert.strictEqual(selectorTextOf({}), '');
  assert.strictEqual(mediaTextOf(rule('.a', [], { media: [{ text: '(min-width: 600px)' }] })), '(min-width: 600px)');
  assert.strictEqual(
    mediaTextOf(rule('.a', [], { media: [{ text: '(min-width: 600px)' }, { text: '(min-height: 400px)' }] })),
    '(min-width: 600px) and (min-height: 400px)',
    'nested @media conditions read as one condition');
  assert.strictEqual(mediaTextOf(rule('.a', [])), '', 'an unconditional rule has no media caption');

  // --- property cleanup --------------------------------------------
  const props = propsOf({ cssProperties: [
    { name: 'margin', value: '40px' },
    { name: 'margin-top', value: '40px', implicit: true },
    { name: 'color', value: 'red', important: true },
    { name: 'border', value: '0', disabled: true },
    { name: '', value: 'junk' },
    null
  ] });
  assert.deepStrictEqual(arr(props).map((p) => p.name), ['margin', 'color', 'border'],
    'shorthand expansions (implicit) and nameless entries are dropped');
  assert.strictEqual(props[1].important, true, '!important is preserved');
  assert.strictEqual(props[2].disabled, true, 'a disabled declaration is kept and marked');
  assert.deepStrictEqual(arr(propsOf(null)), [], 'a missing style yields no properties');

  // --- ordering and origins -----------------------------------------
  const out = normalizeMatchedRules({
    inlineStyle: cssStyle([['color', 'red']]),
    matchedCSSRules: [
      { rule: rule('body', [['font-family', 'system-ui']]) },
      { rule: rule('.card', [['padding', '10px']]) },
      { rule: rule('#hero.card', [['padding-top', '16px']], { origin: 'user-agent' }) }
    ],
    inherited: []
  }, { ancestors: [] });
  assert.deepStrictEqual(arr(out.rules).map((r) => r.selector),
    ['element.style', '#hero.card', '.card', 'body'],
    'element.style first, then the matched rules most specific first (CDP order reversed)');
  assert.strictEqual(out.rules[0].origin, 'inline');
  assert.strictEqual(out.rules[0].group, 'author', 'element.style is an author origin');
  assert.strictEqual(out.rules[1].group, 'user-agent', 'browser-default rules are classified, not dropped by the normalizer');
  assert.deepStrictEqual({ ...out.counts }, { total: 4, author: 3, userAgent: 1 },
    'the counts describe the uncapped list so the panel can label its browser-defaults toggle');
  // The chip that marks a browser-default rule is the same word as the toggle
  // that reveals it: "UA" is DevTools shorthand that reads as nothing beside a
  // selector, and the two controls have to agree on what they call these rules.
  assert.strictEqual(vm.runInContext("ORIGIN_LABEL['user-agent']", context), 'browser',
    'the browser-default chip is spelled out, not abbreviated to UA');
  assert.strictEqual(out.truncated, 0);

  // A rule with no usable declarations is not a row.
  const bare = normalizeMatchedRules({
    matchedCSSRules: [{ rule: rule('.empty', []) }, { rule: rule('.real', [['color', 'blue']]) }]
  }, {});
  assert.deepStrictEqual(arr(bare.rules).map((r) => r.selector), ['.real'], 'a rule with no displayable declaration is skipped');
  assert.deepStrictEqual(arr(normalizeMatchedRules(null, {}).rules), [], 'a null response yields no rules');
  assert.deepStrictEqual(arr(normalizeMatchedRules({}, {}).rules), [], 'an empty response yields no rules');

  // --- inherited rules ----------------------------------------------
  const inh = normalizeMatchedRules({
    matchedCSSRules: [{ rule: rule('.card', [['padding', '10px']]) }],
    inherited: [
      { inlineStyle: cssStyle([['color', 'inherit-ish']]), matchedCSSRules: [{ rule: rule('main', [['display', 'block']]) }] },
      { matchedCSSRules: [{ rule: rule('body', [['margin', '0']]) }] }
    ]
  }, { ancestors: [{ label: 'main#app', levels: 1 }, { label: 'body', levels: 2 }] });
  assert.deepStrictEqual(arr(inh.rules).map((r) => [r.selector, r.inherited]), [
    ['.card', ''],
    ['element.style', 'main#app'],
    ['main', 'main#app'],
    ['body', 'body']
  ], 'inherited rules are captioned with the matching ancestor label, nearest first');
  const noLabels = normalizeMatchedRules({
    inherited: [{ matchedCSSRules: [{ rule: rule('main', [['display', 'block']]) }] }]
  }, {});
  assert.strictEqual(noLabels.rules[0].inherited, 'ancestor',
    'an inherited rule with no ancestor label still says it is inherited');

  // --- media caption and overflow -----------------------------------
  const media = normalizeMatchedRules({
    matchedCSSRules: [{ rule: rule('.card', [['padding', '10px']], { media: [{ text: '(min-width: 600px)' }, { text: '(min-height: 400px)' }] }) }]
  }, {});
  assert.strictEqual(media.rules[0].media, '(min-width: 600px) and (min-height: 400px)',
    'the @media condition travels with the rule so an inapplicable-looking value is explained');

  const many = Array.from({ length: MAX_PROPS_PER_RULE + 5 }, (_, i) => ['prop-' + i, String(i)]);
  const capped = normalizeMatchedRules({ matchedCSSRules: [{ rule: rule('.wide', many) }] }, {});
  assert.strictEqual(capped.rules[0].props.length, MAX_PROPS_PER_RULE, 'a rule is capped per property count');
  assert.strictEqual(capped.rules[0].more, 5, 'the per-rule overflow is reported, not silently dropped');

  const lots = Array.from({ length: MAX_RULES + 7 }, (_, i) => ({ rule: rule('.r' + i, [['color', 'red']]) }));
  const truncated = normalizeMatchedRules({ matchedCSSRules: lots }, {});
  assert.strictEqual(truncated.rules.length, MAX_RULES, 'the rule list is capped');
  assert.strictEqual(truncated.truncated, 7, 'the rule overflow is reported');
  assert.deepStrictEqual({ ...truncated.counts }, { total: MAX_RULES + 7, author: MAX_RULES + 7, userAgent: 0 },
    'the counts still describe the full list, not the capped one');

  // --- keys are unique ----------------------------------------------
  const keys = new Set(arr(inh.rules).map((r) => r.id));
  assert.strictEqual(keys.size, inh.rules.length, 'every rule has a unique key (Preact reconciliation)');

  console.log('PASS inspector matched rules model (ordering, origins, implicit props, inheritance captions, caps)');
}

main();
