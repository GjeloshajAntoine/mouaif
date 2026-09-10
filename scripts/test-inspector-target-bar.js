'use strict';

// Inspector TargetBar — target, rules and write target.
//
// The bar answers three questions the Styles panel only implies: which element
// is selected, which rule is responsible for a value, and where an edit lands.
// Every one of those answers is computed by the pure module
// frontend/src/components/inspector/targetBar.js, so this test can assert the
// decisions directly instead of regex-matching a JSX file. The component is
// then rendered in a miniature hooks runtime for the parts that are structural
// (which rows appear, what the chips say, that a rule chip taps through).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const barSource = strip(read('frontend/src/components/inspector/TargetBar.jsx'));
const modelSource = strip(read('frontend/src/components/inspector/targetBar.js'));
const inspectorSource = read('frontend/src/components/Inspector.jsx');
const stylesSource = read('frontend/src/components/inspector/StylesPanel.jsx');
const css = read('frontend/src/inspector.css');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- the pure model ----------------------------------------------------

// `const` at the top level of a VM script is script-scoped, not a property of
// the context object — so the caps and the write-target list are re-exported
// onto the context by appending one statement to the same script (it shares
// the scope, so the names resolve).
const ctx = vm.createContext({});
vm.runInContext(modelSource + '\n;globalThis.TB = { MAX_CRUMBS, MAX_RULE_CHIPS, CRUMB_MAX, WRITE_TARGETS, INLINE_TARGET };\n', ctx);
check('the caps and targets are re-exported for the test', !!ctx.TB && !!ctx.TB.MAX_CRUMBS);

// A representative inspection: the element carries one inline declaration,
// three rules match it (inline, an author class, a UA default), one ancestor
// rule is inherited, and the tree has a couple of ancestors.
function sampleInfo(over) {
  return Object.assign({
    label: 'section#hero.card.tall',
    size: '373×40',
    declared: [{ prop: 'margin', value: '0px 0px 18px' }],
    tree: { ancestors: [{ label: 'form.compare', levels: 2 }, { label: 'body', levels: 3 }] },
    rules: {
      counts: { total: 4, author: 3, userAgent: 1 },
      trunc: 0,
      rules: [
        { id: 'inline', selector: 'element.style', origin: 'inline', group: 'author', props: [{ name: 'margin', value: '0px 0px 18px' }], more: 0 },
        { id: 'own-m1', selector: '.card', origin: 'regular', group: 'author', props: [{ name: 'padding', value: '16px' }], more: 11 },
        { id: 'inh0-m0', selector: '.compare-row', origin: 'regular', group: 'author', inherited: 'form.compare', props: [{ name: 'gap', value: '12px' }], more: 0 },
        { id: 'own-m2', selector: '.extra', origin: 'regular', group: 'author', props: [{ name: 'color', value: 'red' }], more: 0 },
        { id: 'own-m0', selector: 'section', origin: 'user-agent', group: 'user-agent', props: [{ name: 'display', value: 'block' }], more: 1 }
      ]
    }
  }, over || {});
}

{
  const bar = ctx.buildTargetBar(sampleInfo());
  check('tag chip is the element name', bar.tag === 'section');
  check('id is split out', bar.id === 'hero');
  check('classes are split out, in order', bar.classes.join(',') === 'card,tall', bar.classes.join(','));
  check('box size is carried through', bar.size === '373×40');
  check('the write target is element.style', bar.targetLabel === 'element.style');
  // A box that could not be measured prints as `— × —`; that is noise, not data.
  check('an unmeasurable box size is dropped',
    ctx.cleanSize('— × —') === '' && ctx.cleanSize('') === '' && ctx.cleanSize(null) === '');
  check('a real box size is kept', ctx.cleanSize('373×40') === '373×40');
  check('the write target is marked editable-looking (inline)', bar.targetNote.indexOf('wins') >= 0, bar.targetNote);
}

// Breadcrumb: oldest first, current element last and flagged, and each crumb
// keeps the hop count the panel's selectAncestor expects.
{
  const bar = ctx.buildTargetBar(sampleInfo());
  check('breadcrumb is root-to-element',
    bar.crumbs.map((c) => c.label).join(' > ') === 'body > form.compare > section#hero.card.tall',
    bar.crumbs.map((c) => c.label).join(' > '));
  check('the current element is the only isHere crumb',
    bar.crumbs.filter((c) => c.isHere).length === 1 && bar.crumbs[bar.crumbs.length - 1].isHere);
  check('ancestor crumbs keep their hop count',
    bar.crumbs[0].levels === 3 && bar.crumbs[1].levels === 2,
    JSON.stringify(bar.crumbs.map((c) => c.levels)));
  check('the current element has no hop count (it is not a hop)',
    bar.crumbs[bar.crumbs.length - 1].levels === undefined);
}

// Deep trees are capped without losing the root or the immediate parent.
{
  const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((label, i) => ({ label, levels: 7 - i }));
  const crumbs = ctx.buildCrumbs('now', deep, 'now');
  check('a deep path is capped', crumbs.length <= ctx.TB.MAX_CRUMBS, String(crumbs.length));
  check('the capped path keeps the root', crumbs[0].label === 'g', crumbs[0].label);
  check('the capped path keeps the current element last', crumbs[crumbs.length - 1].label === 'now');
  check('the capped path keeps the immediate parent', crumbs[crumbs.length - 2].label === 'a', crumbs[crumbs.length - 2].label);
  check('the elided middle is marked, not silently dropped',
    crumbs.filter((c) => c.elided).length === 1);
  check('the elided marker is not tappable (no levels)', crumbs.find((c) => c.elided).levels === undefined);
  check('a short path is not elided',
    ctx.buildCrumbs('x', [{ label: 'y', levels: 1 }], 'x').filter((c) => c.elided).length === 0);
  check('no ancestors and no label produces no crumbs', ctx.buildCrumbs('', [], '').length === 0);
}

// Rule chips: ranked (write target first, browser defaults last), capped, and
// carrying the real declaration count.
{
  const bar = ctx.buildTargetBar(sampleInfo());
  check('rule chips are capped', bar.ruleChips.length === ctx.TB.MAX_RULE_CHIPS, String(bar.ruleChips.length));
  check('the write target is the first chip', bar.ruleChips[0].isTarget && bar.ruleChips[0].label === 'element.style');
  check('an author rule on the element comes next', bar.ruleChips[1].label === '.card');
  check('an author rule on the element outranks an inherited one',
    bar.ruleChips[1].label === '.card' && bar.ruleChips[2].label === '.extra',
    JSON.stringify(bar.ruleChips.map((c) => c.label)));
  check('chip counts include declarations cut by the per-rule cap',
    bar.ruleChips[1].count === 12, String(bar.ruleChips[1].count));
  // Browser-default rules are never chipped: their selector for an element like
  // `div` is the whole HTML element list, which wraps the row to five lines.
  check('browser-default rules are never chipped',
    bar.ruleChips.every((c) => !c.isUa) && bar.ruleChips.every((c) => c.label !== 'section'),
    JSON.stringify(bar.ruleChips.map((c) => c.label)));
  // Ranking, isolated: inline > author-on-element > inherited > browser default.
  {
    const ranked = ctx.buildRuleChips([
      { group: 'user-agent', origin: 'user-agent', selector: 'section', props: [{ name: 'display' }] },
      { group: 'author', origin: 'regular', inherited: 'body', selector: '.from-parent', props: [{ name: 'gap' }] },
      { group: 'author', origin: 'regular', selector: '.own', props: [{ name: 'padding' }] },
      { group: 'author', origin: 'inline', selector: 'element.style', props: [{ name: 'margin' }] }
    ]);
    check('chips rank inline, then on-element, then inherited',
      ranked.chips.map((c) => c.label).join(' > ') === 'element.style > .own > .from-parent',
      ranked.chips.map((c) => c.label).join(' > '));
    check('an inherited chip is marked as inherited', ranked.chips[2].inherited === 'body');
    check('a browser default is counted, not chipped', ranked.hiddenUa === 1);
  }
  check('hidden author rules are reported as a count', bar.rulesHidden === 1, String(bar.rulesHidden));
  check('hidden browser-default rules are counted separately', bar.rulesHiddenUa === 1, String(bar.rulesHiddenUa));
  check('the rule total counts author rules (the chippable set)', bar.rulesTotal === 4, String(bar.rulesTotal));
}

// Origin: an inline value wins; a class-supplied value names the rule and says
// what editing does; a value nobody declares says so.
{
  const inline = ctx.buildTargetBar(sampleInfo({ editing: 'margin' }));
  check('an inline value is reported as the value in force',
    /margin: 0px 0px 18px is set on element\.style/.test(inline.origin), inline.origin);
  check('the inline sentence says it wins for this element only',
    /wins this value for this element only/.test(inline.origin), inline.origin);

  const fromClass = ctx.buildTargetBar(sampleInfo({ editing: 'padding' }));
  check('a class-supplied value names the rule',
    /padding comes from the stylesheet rule \.card \(16px\)/.test(fromClass.origin), fromClass.origin);
  check('the class sentence says editing overrides it for this element only',
    /Editing element\.style overrides it for this element only\./.test(fromClass.origin), fromClass.origin);

  const inherited = ctx.buildTargetBar(sampleInfo({ editing: 'gap' }));
  check('an inherited value names the ancestor',
    /gap comes from an inherited rule on form\.compare/.test(inherited.origin), inherited.origin);

  const ua = ctx.buildTargetBar(sampleInfo({ editing: 'display' }));
  check('a browser default is called out as such',
    /display comes from the browser default section/.test(ua.origin), ua.origin);

  const undeclared = ctx.buildTargetBar(sampleInfo({ editing: 'font-size', computedValue: '16px' }));
  check('an undeclared value falls back to the resolved one',
    /font-size is not declared by any matching rule — the browser resolves it to 16px/.test(undeclared.origin),
    undeclared.origin);

  const nothing = ctx.buildTargetBar(sampleInfo({ editing: 'z-index' }));
  check('a property with no declaration and no resolution still explains itself',
    /z-index has no declaration on this element/.test(nothing.origin), nothing.origin);
}

// The property the origin line describes follows the user's attention:
// editing > last changed > first own declaration > nothing.
{
  check('the property being edited wins',
    ctx.pickFocusProperty({ editing: 'padding', changed: ['color'], declared: [{ prop: 'margin' }] }) === 'padding');
  check('then the last change this session',
    ctx.pickFocusProperty({ changed: ['color', 'gap'], declared: [{ prop: 'margin' }] }) === 'color');
  check('then the element’s first own declaration',
    ctx.pickFocusProperty({ declared: [{ prop: 'margin' }, { prop: 'color' }] }) === 'margin');
  check('nothing to describe yields an empty property',
    ctx.pickFocusProperty({}) === '');
  // An element with no inline styles is the common case, so the rule list is
  // the last fallback — otherwise the bar has nothing to explain exactly when
  // the user asks "where do this element's values come from?".
  const sheetRules = sampleInfo().rules.rules.filter((r) => r.origin !== 'inline');
  check('the focus falls back to the first author-rule declaration',
    ctx.pickFocusProperty({ declared: [], rules: sheetRules }) === 'padding',
    ctx.pickFocusProperty({ declared: [], rules: sheetRules }));
  check('the fallback prefers a class rule over an inherited one', (() => {
    const p = ctx.pickFocusProperty({ declared: [], rules: [
      { group: 'author', origin: 'regular', inherited: 'body', props: [{ name: 'gap' }] },
      { group: 'author', origin: 'regular', props: [{ name: 'padding' }] }
    ] });
    return p === 'padding';
  })());
  check('a browser default never becomes the focus property',
    ctx.firstAuthorProperty([{ group: 'user-agent', props: [{ name: 'display' }] }]) === '');
  check('the focus skips browser-default declarations',
    ctx.firstAuthorProperty([
      { group: 'user-agent', props: [{ name: 'display' }] },
      { group: 'author', props: [{ name: 'padding' }] }
    ]) === 'padding');
  check('no focus property means no origin sentence',
    ctx.buildTargetBar({ label: 'div', declared: [], rules: { rules: [] } }).origin === '');
}

// The scope summary — the "nothing else changes" claim, in numbers.
{
  const edited = ctx.buildTargetBar(sampleInfo({ editing: 'margin' }));
  check('only the edited property counts as changed', edited.scope.changed === 1);
  check('other declarations are counted as kept', edited.scope.kept === 0, String(edited.scope.kept));
  check('no stylesheet rule is edited', edited.scope.rulesEdited === 0);
  check('only this element is affected', edited.scope.elements === 1);

  const kept = ctx.buildTargetBar(sampleInfo({
    editing: 'padding',
    declared: [{ prop: 'margin', value: '0' }, { prop: 'border-radius', value: '8px' }]
  }));
  check('kept counts the declarations that stay', kept.scope.kept === 2, String(kept.scope.kept));

  const none = ctx.buildTargetBar({ label: 'div', declared: [], rules: { rules: [] } });
  check('no selection scope claims nothing changed', none.scope.changed === 0 && none.scope.elements === 0);
}

// The write-target list states the honest position about rule editing.
{
  check('inline is offered as the target', ctx.TB.WRITE_TARGETS[0].id === 'inline' && ctx.TB.WRITE_TARGETS[0].editable === true);
  check('stylesheet rule editing is listed but marked unavailable',
    ctx.TB.WRITE_TARGETS[1].id === 'rule' && ctx.TB.WRITE_TARGETS[1].editable === false);
  check('inline is the default target', ctx.TB.INLINE_TARGET === 'inline');
}

// Crumb labels are truncated so the path stays one line on a phone, with the
// full label kept for the tooltip/accessible name.
{
  check('a short crumb label is left alone', ctx.crumbLabel('body') === 'body');
  const long = 'div#standalone-api-panel.standalone-api-panel';
  const short = ctx.crumbLabel(long);
  check('a long crumb label is truncated', short.length <= ctx.TB.CRUMB_MAX && /…$/.test(short), short);
  // The tag and the head of the id survive; the full label is on the crumb's
  // title (and in the Styles panel's own breadcrumb).
  check('truncation keeps the tag and the head of the id', /^div#standalone/.test(short), short);
  const crumbs = ctx.buildCrumbs('div#standalone-api-panel.standalone-api-panel',
    [{ label: 'body', levels: 1 }], 'div#standalone-api-panel.standalone-api-panel');
  check('crumbs carry the full label for the tooltip',
    crumbs[crumbs.length - 1].title === long && crumbs[crumbs.length - 1].label !== long);
  check('the total crumb text stays inside one phone line',
    crumbs.reduce((n, c) => n + c.label.length, 0) <= 46,
    String(crumbs.reduce((n, c) => n + c.label.length, 0)));
}

// An ancestor's inline style is not a "stylesheet rule": the sentence has to
// say where the declaration actually lives.
{
  const info = sampleInfo({ editing: 'color' });
  info.declared = [];
  info.rules.rules = [
    { id: 'inh0-inline', selector: 'element.style', origin: 'inline', group: 'author', inherited: 'html',
      props: [{ name: 'color', value: '#f4f7fb' }], more: 0 }
  ];
  const bar = ctx.buildTargetBar(info);
  check('an inherited inline style names the ancestor, not "rule … element.style"',
    /color is set on the ancestor html \(its inline style\) and inherits down/.test(bar.origin), bar.origin);
  check('it still says what editing does',
    /Editing element\.style overrides it for this element only\./.test(bar.origin), bar.origin);
}

// ---- the component -----------------------------------------------------

function renderBar(props) {
  const nodes = [];
  const ctx2 = vm.createContext({
    // Preact calls function components; the harness has to as well, or the
    // Crumbs / RuleChips sub-trees stay as opaque nodes.
    h: (type, attrs, ...children) => {
      const props2 = Object.assign({}, attrs || {});
      if (typeof type === 'function') return type(Object.assign(props2, { children }));
      const n = { type, props: props2, children };
      nodes.push(n);
      return n;
    }
  });
  vm.runInContext(modelSource, ctx2);
  vm.runInContext(barSource, ctx2);
  return { tree: ctx2.TargetBar(props), nodes };
}
const walk = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
};
const cls = (n) => String((n.props && n.props.class) || '');
const byClass = (tree, c) => walk(tree).filter((n) => cls(n).split(/\s+/).includes(c));
const text = (tree) => walk(tree)
  .map((n) => (typeof n === 'string' ? n : (n.children || []).filter((c) => typeof c === 'string').join('')))
  .join(' ');

{
  const { tree } = renderBar({ model: ctx.buildTargetBar(sampleInfo({ editing: 'padding' })) });
  check('the bar renders a tag chip', byClass(tree, 'inspector__tagchip').length === 1);
  check('the bar renders one crumb per path entry, current one flagged',
    byClass(tree, 'inspector__crumb').length === 3 && byClass(tree, 'inspector__crumb').filter((c) => cls(c).includes('is-here')).length === 1);
  check('the bar renders the cascade chips', byClass(tree, 'inspector__rulechip').length === 3);
  check('the write target chip is marked', byClass(tree, 'inspector__rulechip').filter((c) => cls(c).includes('is-target')).length === 1);
  // Two counters: the author rules past the cap, and how many browser defaults
  // match (counted, never chipped).
  const counters = byClass(tree, 'inspector__rulerow-more').map((n) => n.children.join(''));
  check('the hidden-rule count is shown', counters.some((t) => t === '+1'), JSON.stringify(counters));
  check('the browser-default count is shown', counters.some((t) => /UA/.test(t)), JSON.stringify(counters));
  check('the origin sentence is rendered as a status',
    byClass(tree, 'inspector__origin').length === 1
    && byClass(tree, 'inspector__origin')[0].props.role === 'status');
  check('the origin sentence names the rule', /stylesheet rule \.card/.test(text(tree)));
}

{
  // No label means nothing to describe: the bar renders nothing at all rather
  // than an empty shell.
  const { tree } = renderBar({ model: ctx.buildTargetBar({ label: '', declared: [], rules: { rules: [] } }) });
  check('no selection renders no bar', tree === null);
  const { tree: t2 } = renderBar({ model: null });
  check('a null model renders no bar', t2 === null);
}

{
  // Interactions: an ancestor crumb taps through, and a rule chip reveals the
  // cascade. Both are asserted through the callbacks the parent passes.
  let ancestorTapped = null;
  let ruleTapped = null;
  const { tree } = renderBar({
    model: ctx.buildTargetBar(sampleInfo()),
    onSelectAncestor: (c) => { ancestorTapped = c; },
    onRuleTap: (r) => { ruleTapped = r; }
  });
  const crumbs = byClass(tree, 'inspector__crumb').filter((n) => n.type === 'button');
  check('ancestor crumbs are buttons (the current element is not)',
    crumbs.length === 2 && byClass(tree, 'inspector__crumb').length === 3);
  crumbs[crumbs.length - 1].props.onClick();
  check('tapping an ancestor passes the crumb with its hop count',
    ancestorTapped && ancestorTapped.label === 'form.compare' && ancestorTapped.levels === 2,
    JSON.stringify(ancestorTapped));
  const chip = byClass(tree, 'inspector__rulechip')[1];
  chip.props.onClick();
  check('tapping a rule chip passes the rule', ruleTapped && ruleTapped.label === '.card', JSON.stringify(ruleTapped));
  check('rule chips say how many declarations they hold',
    /1[12] declarations/.test(chip.props['aria-label'] || ''), chip.props['aria-label']);
  check('the write-target chip says so in its accessible name',
    /Write target, element\.style/.test(byClass(tree, 'inspector__rulechip')[0].props['aria-label'] || ''));
  check('rule chips are labelled on screen, not icon-only',
    byClass(tree, 'inspector__rulechip-name').length === 3);
}

{
  // The header controls are optional: each is only rendered when the parent
  // wires it, so the bar degrades instead of showing dead buttons.
  const { tree: bare } = renderBar({ model: ctx.buildTargetBar(sampleInfo()) });
  check('no dead header buttons when nothing is wired',
    byClass(bare, 'inspector__targetbar-btn').length === 0);
  const { tree: full } = renderBar({
    model: ctx.buildTargetBar(sampleInfo()),
    onClear: () => {}, onRefresh: () => {}, onPick: () => {}
  });
  check('all three header controls render when wired',
    byClass(full, 'inspector__targetbar-btn').length === 3);
  const { tree: picking } = renderBar({
    model: ctx.buildTargetBar(sampleInfo()),
    pickMode: true, onPick: () => {}
  });
  check('the pick control reflects pick mode',
    byClass(picking, 'inspector__targetbar-btn').some((b) => cls(b).includes('is-on'))
    && byClass(picking, 'inspector__targetbar-btn')[0].props['aria-pressed'] === 'true');
}

{
  // Collapsed: identity + rule chips stay, path and origin go. This is what
  // keeps the bar from costing ~200 px of a 667 px screen.
  const open = renderBar({ model: ctx.buildTargetBar(sampleInfo({ editing: 'padding' })) }).tree;
  const closed = renderBar({
    model: ctx.buildTargetBar(sampleInfo({ editing: 'padding' })),
    collapsed: true,
    onToggleCollapsed: () => {}
  }).tree;
  check('expanded shows the path and the origin sentence',
    byClass(open, 'inspector__crumbs').length === 1 && byClass(open, 'inspector__origin').length === 1);
  check('collapsed hides the path and the origin sentence',
    byClass(closed, 'inspector__crumbs').length === 0 && byClass(closed, 'inspector__origin').length === 0);
  check('collapsed keeps the identity row', byClass(closed, 'inspector__tagchip').length === 1);
  check('collapsed keeps the rule chips (where an edit lands)',
    byClass(closed, 'inspector__rulechip').length === 3);
  check('the collapsed bar is marked', cls(closed).includes('is-collapsed'));
  const toggles = byClass(closed, 'inspector__targetbar-btn').filter((b) => b.props['aria-expanded'] !== undefined);
  check('the collapse control reports its state', toggles.length === 1 && toggles[0].props['aria-expanded'] === 'false');
  let toggled = 0;
  renderBar({ model: ctx.buildTargetBar(sampleInfo()), collapsed: false, onToggleCollapsed: () => { toggled++; } })
    .nodes; // no-op: assert through the node below
  const t = renderBar({ model: ctx.buildTargetBar(sampleInfo()), collapsed: false, onToggleCollapsed: () => { toggled++; } }).tree;
  byClass(t, 'inspector__targetbar-btn').find((b) => b.props['aria-expanded'] !== undefined).props.onClick();
  check('tapping the collapse control calls back', toggled === 1, String(toggled));
}

// ---- the wiring --------------------------------------------------------

check('the Styles panel publishes its selection', /onSelectionChange/.test(stylesSource));
// The label must come from the same DOM-shaped node the panel renders, not the
// wrapper model: `elementLabel` reads nodeName/attributes, and passing the
// model yields an empty label — which silently hides the whole bar.
check('the published label is read from model.node', /elementLabel\(model\.node\)/.test(stylesSource));
check('the published snapshot carries label, size, rules, tree and declared',
  /label: model \? elementLabel\(model\.node\) : ''/.test(stylesSource)
  && /size: boxSummary\(model && model\.box\)/.test(stylesSource)
  && /rules: rules \|\| null/.test(stylesSource)
  && /tree: tree \|\| null/.test(stylesSource)
  && /declared: \(model && model\.inlineProps\) \|\| \[\]/.test(stylesSource));
check('the snapshot is republished when the selection or the cascade changes',
  /\}, \[model, rules, tree, changed, edit\]\);/.test(stylesSource));
check('the panel exposes its own clear / refresh / ancestor actions',
  /panelHandlesRef/.test(stylesSource)
  && /clear: \(\) => clearPick\(\)/.test(stylesSource)
  && /refresh: \(\) => refreshStyles\(\)/.test(stylesSource)
  && /selectAncestor: \(crumb\)/.test(stylesSource));
check('the parent passes the selection change callback and the handles ref',
  /onSelectionChange: \(info\) => setStylesSelection\(info\)/.test(inspectorSource)
  && /panelHandlesRef: stylesHandlesRef/.test(inspectorSource));
check('the parent builds the model from the published snapshot',
  /model: buildTargetBar\(stylesSelection\)/.test(inspectorSource));
check('the bar is rendered above the panels, under the panel chips',
  inspectorSource.indexOf('h(TargetBar, {') > inspectorSource.indexOf('inspector__panelbar')
  && inspectorSource.indexOf('h(TargetBar, {') < inspectorSource.indexOf("h('div', { class: 'inspector__panels' }"));
check('the collapse choice persists like the panel visibility',
  /TARGETBAR_STATE_KEY = 'mouaif:inspector:targetbar:collapsed'/.test(inspectorSource)
  && /function loadTargetBarCollapsed/.test(inspectorSource)
  && /function saveTargetBarCollapsed/.test(inspectorSource));
check('the parent passes and toggles the collapse state',
  /collapsed: targetBarCollapsed/.test(inspectorSource)
  && /onToggleCollapsed: toggleTargetBar/.test(inspectorSource));
check('the bar hides itself when there is no selection',
  /stylesSelection && stylesSelection\.label/.test(inspectorSource));
check('the pick control toggles the same pick mode the preview uses',
  /onPick: \(\) => \{ setStylesActive\(!stylesActive\); rerender\(\); \}/.test(inspectorSource));
check('tapping a rule chip reveals the cascade instead of faking an editor',
  /if \(!visiblePanels\.has\('styles'\)\) togglePanel\('styles'\)/.test(inspectorSource));
check('clearing the bar also clears the panel selection',
  /setStylesSelection\(null\);[\s\S]{0,120}stylesHandlesRef\.current\.clear\(\)/.test(inspectorSource));

// ---- mobile-first invariants ------------------------------------------

check('the bar is styled', /\.inspector__targetbar \{/.test(css));
check('the bar does not scroll (the panels keep the only scroller)',
  !/\.inspector__targetbar \{[^}]*overflow/.test(css));
const chipRule = /\.inspector__rulechip \{([\s\S]*?)\}/.exec(css);
check('the rule chips exist in the stylesheet', !!chipRule);
if (chipRule) check('rule chips are 44 px targets', /min-height:\s*var\(--tap\)/.test(chipRule[1]));
const crumbRule = /\.inspector__crumb \{([\s\S]*?)\}/.exec(css);
if (crumbRule) check('breadcrumb crumbs are 44 px targets', /min-height:\s*var\(--tap\)/.test(crumbRule[1]));
const headBtn = /\.inspector__targetbar-btn \{([\s\S]*?)\}/.exec(css);
if (headBtn) check('header controls are 44 px targets', /width:\s*var\(--tap\)/.test(headBtn[1]));
check('the breadcrumb wraps rather than scrolling sideways',
  /\.inspector__crumbs \{[\s\S]{0,160}flex-wrap:\s*wrap/.test(css));
check('the rule row wraps too', /\.inspector__rulerow \{[\s\S]{0,120}flex-wrap:\s*wrap/.test(css));

// ---- summary -----------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' target-bar assertion(s) failed');
