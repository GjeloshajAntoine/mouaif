// Inspector TargetBar — "which element, which rule, and where does my edit go?"
//
// A read-mostly strip that sits above the panels while a target is attached:
//
//   [div .header-menu-wrap  464×27]              ✕  ↻  ◎
//   html › section.input-section › div.setup-header
//   RULE  [element.style 44] [.card 12] [+2 · 1 UA]
//   padding comes from the stylesheet rule .card (16px). Editing element.style
//   overrides it for this element only.
//
// It adds no logic of its own — `buildTargetBar` (targetBar.js) computes every
// field, so this file is layout and wiring. That keeps the interesting
// decisions unit-testable without a browser.
//
// Mobile-first: the strip is a fixed-height column of small rows, every
// interactive element is a ≥44 px target, the breadcrumb *wraps* rather than
// scrolling sideways (a horizontal scroller inside a vertical page steals the
// vertical gesture — see inspector.css), and nothing here scrolls: the panels
// below keep the only scroller.
//
// The whole strip is also **collapsible**, because four 44 px rows above the
// panels is ~200 px of a 667 px screen. Collapsed keeps the identity row (what
// is selected) and the rule chips (where an edit lands) and hides the path and
// the origin sentence; the choice persists. Expanded is the default, so the
// explanation of where a value comes from is there for a first-time user
// rather than behind a control they have no reason to look for.
import { h } from 'preact';

const COLLAPSED_KEY = 'mouaif:inspector:targetbar:collapsed';

function loadCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
function saveCollapsed(value) {
  try { localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'); } catch { /* ignore */ }
}


// Crumbs — the ancestor path. Tapping an ancestor selects it, which is far
// faster on a phone than re-picking an overlapping element on the preview.
function Crumbs(props) {
  if (!props.crumbs || !props.crumbs.length) return null;
  return h('div', { class: 'inspector__crumbs', role: 'group', 'aria-label': 'Element path' },
    props.crumbs.map((c, i) => {
      const base = 'inspector__crumb';
      if (c.elided) {
        return h('span', { class: base + ' is-elided', key: 'e' + i, 'aria-hidden': 'true' }, '…');
      }
      if (c.isHere) {
      return h('span', { class: base + ' is-here', key: 'h', 'aria-current': 'true', title: c.title || c.label }, c.label);
      }
      return h('button', {
      class: base,
      type: 'button',
      key: 'c' + i,
      title: 'Select ' + (c.title || c.label),
      'aria-label': 'Select ancestor ' + (c.title || c.label),
      onClick: () => props.onSelectAncestor && props.onSelectAncestor(c)
      }, c.label);
    })
  );
}

// RuleChips — the cascade without expanding a section: `element.style` (the
// write target), then the author rules that matter, then a count for the rest.
// Browser-default rules are counted, never chipped (see buildRuleChips).
function RuleChips(props) {
  const chips = props.ruleChips || [];
  const showRow = chips.length || props.rulesHidden || props.rulesHiddenUa;
  if (!showRow) return null;
  const more = [];
  if (props.rulesHidden) more.push('+' + props.rulesHidden);
  return h('div', { class: 'inspector__rulerow', role: 'group', 'aria-label': 'Matching rules' },
    h('span', { class: 'inspector__rulerow-label' }, 'Rule'),
    chips.map((c) => h('button', {
      class: 'inspector__rulechip'
        + (c.isTarget ? ' is-target' : '')
        + (c.isUa ? ' is-ua' : '')
        + (c.inherited ? ' is-inherited' : ''),
      type: 'button',
      key: c.id,
      // Which rule supplies the value is the question; tapping a chip reveals
      // the cascade in the Styles panel rather than pretending the chip itself
      // can be edited.
      title: c.label + (c.inherited ? ' (inherited from ' + c.inherited + ')' : '')
        + ' — ' + c.count + ' declaration' + (c.count === 1 ? '' : 's')
        + (c.isTarget ? ' · where edits land' : ''),
      'aria-label': (c.isTarget ? 'Write target, ' : '') + c.label + ', ' + c.count + ' declarations',
      onClick: () => props.onRuleTap && props.onRuleTap(c)
    },
      h('span', { class: 'inspector__rulechip-name' }, c.label),
      h('span', { class: 'inspector__rulechip-n' }, String(c.count))
    )),
    more.length
      ? h('span', { class: 'inspector__rulerow-more', title: 'Other author rules that match this element' }, more.join(' '))
      : null,
    props.rulesHiddenUa
      ? h('span', {
        class: 'inspector__rulerow-more',
        title: props.rulesHiddenUa + ' browser-default rule' + (props.rulesHiddenUa === 1 ? '' : 's')
          + ' also match — the Styles panel lists them behind its UA toggle'
      }, props.rulesHiddenUa + ' UA')
      : null
  );
}

// TargetBar — the strip itself. `model` is buildTargetBar's output; the three
// header handlers mirror the Styles panel's own buttons so the bar is a
// shortcut and not a second implementation.
export function TargetBar(props) {
  const model = props.model;
  if (!model || !model.label) return null;
  const collapsed = props.collapsed === undefined ? false : !!props.collapsed;
  return h('section', { class: 'inspector__targetbar' + (collapsed ? ' is-collapsed' : ''), 'aria-label': 'Selected element and edit target' },
    h('div', { class: 'inspector__targetbar-head' },
      h('span', { class: 'inspector__tagchip', title: model.label },
        h('span', { class: 'inspector__tagchip-name' }, model.tag),
        model.id ? h('span', { class: 'inspector__tagchip-dim' }, '#' + model.id) : null,
        model.classes.map((c) => h('span', { class: 'inspector__tagchip-dim', key: c }, '.' + c)),
        model.size ? h('span', { class: 'inspector__tagchip-size' }, model.size) : null
      ),
      h('span', { class: 'inspector__targetbar-spacer' }),
      // Collapse/expand. The label states what is being hidden rather than
      // "more"/"less", so the row explains itself when closed.
      props.onToggleCollapsed
        ? h('button', {
          class: 'icon-btn inspector__targetbar-btn',
          type: 'button',
          'aria-expanded': String(!collapsed),
          title: collapsed
            ? 'Show the element path and where its values come from'
            : 'Hide the element path and the origin line',
          'aria-label': collapsed ? 'Show element path and origin' : 'Hide element path and origin',
          onClick: props.onToggleCollapsed
        }, collapsed ? '▾' : '▴')
        : null,
      props.onClear
        ? h('button', {
          class: 'icon-btn inspector__targetbar-btn',
          type: 'button',
          title: 'Clear the selected element',
          'aria-label': 'Clear the selected element',
          onClick: props.onClear
        }, '✕')
        : null,
      props.onRefresh
        ? h('button', {
          class: 'icon-btn inspector__targetbar-btn',
          type: 'button',
          title: 'Re-read this element',
          'aria-label': 'Re-read this element',
          onClick: props.onRefresh
        }, '↻')
        : null,
      props.onPick
        ? h('button', {
          class: 'icon-btn inspector__targetbar-btn' + (props.pickMode ? ' is-on' : ''),
          type: 'button',
          title: props.pickMode ? 'Stop picking' : 'Pick an element on the preview',
          'aria-label': props.pickMode ? 'Stop picking an element' : 'Pick an element on the preview',
          'aria-pressed': String(!!props.pickMode),
          onClick: props.onPick
        }, '◎')
        : null
    ),
    // Rule chips stay visible when collapsed: "where does my edit land" is the
    // question the bar exists to answer, so it never costs a tap.
    h(RuleChips, {
      ruleChips: model.ruleChips,
      rulesHidden: model.rulesHidden,
      rulesHiddenUa: model.rulesHiddenUa,
      onRuleTap: props.onRuleTap
    }),
    collapsed
      ? null
      : h(Crumbs, { crumbs: model.crumbs, onSelectAncestor: props.onSelectAncestor }),
    // The origin line: the one sentence that says why the value is what it is
    // and where the edit lands. Rendered as a status so a screen reader hears
    // it when the selection changes.
    (collapsed || !model.origin)
      ? null
      : h('p', { class: 'inspector__origin', role: 'status' }, model.origin)
  );
}
