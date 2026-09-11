// Inspector Suggestions — the values and tokens this page already uses.
//
// The type switch changes *how* a value is written (length, number, percentage,
// keyword) and the unit cycle rewrites the same value in another unit. Neither
// can answer "what should this be?", which is the question that actually stalls
// on a phone: the user has a keyboard, a value, and no idea whether the rest of
// the design uses 12, 14 or 16px.
//
// This component answers it from the page itself (see valueIndex.js): the values
// already declared for this property, most-used first, each with the rule that
// supplies it; the design tokens that resolve to a valid value for it; and the
// page's numeric step when its values share one.
//
// Tapping a chip only rewrites the sheet's value field — Apply still commits — so
// a suggestion is as reversible as anything typed.
import { h } from 'preact';
import { valuesFor, tokensFor, scaleFor, scaleNote } from './valueIndex.js';

// MAX_CHIPS — values shown. The list is a choice, not an inventory: a phone chip
// row can present a handful, and past that the long tail says nothing about the
// scale. The group header reports how many were actually seen.
const MAX_CHIPS = 6;
const MAX_TOKEN_CHIPS = 4;

export function Suggestions(props) {
  const index = props.index;
  const prop = props.prop || '';
  if (!index || !prop) return null;
  const values = valuesFor(index, prop, MAX_CHIPS);
  const tokens = tokensFor(index, prop, MAX_TOKEN_CHIPS);
  const scale = scaleFor(index, prop);
  if (!values.length && !tokens.length) return null;
  return h('div', { class: 'inspector__suggest' },
    values.length
      ? h('div', { class: 'grp' },
        h('div', { class: 'gh' }, 'On this page',
          h('span', null, ' · ' + values.length + (values.length === 1 ? ' value' : ' values')
            + (scale && scale.step ? ' · steps of ' + scale.step + (scale.unit || '') : ''))
        ),
        h('div', { class: 'opts' },
          values.map((v) => h('button', {
            class: 'opt' + (v.isCurrent ? ' is-current' : ''),
            type: 'button',
            key: 'v-' + v.value,
            title: v.value + ' — used ' + v.count + (v.count === 1 ? ' time' : ' times')
              + (v.selector ? ' (' + v.selector + ')' : '')
              + (v.inherited ? ', inherited from ' + v.inherited : '')
              + (v.isCurrent ? ' · the value in force' : ''),
            'aria-label': 'Use ' + v.value + ', used ' + v.count + (v.count === 1 ? ' time' : ' times') + ' on this page',
            onClick: () => props.onPick(v.value)
          },
            h('span', { class: 'inspector__suggest-value' }, v.value),
            h('span', { class: 'inspector__suggest-ev' }, v.count + '×')
          ))
        )
      )
      : null,
    tokens.length
      ? h('div', { class: 'grp' },
        h('div', { class: 'gh' }, 'Tokens', h('span', null, ' · from this page')),
        h('div', { class: 'opts' },
          tokens.map((t) => h('button', {
            class: 'opt inspector__suggest-token',
            type: 'button',
            key: 't-' + t.name,
            title: t.name + ' = ' + t.value + (t.selector ? ' (' + t.selector + ')' : ''),
            'aria-label': 'Use ' + t.name + ', which resolves to ' + t.value,
            onClick: () => props.onPick(t.name)
          },
            h('span', { class: 'inspector__suggest-value' }, t.name),
            h('span', { class: 'inspector__suggest-ev' }, '= ' + t.value)
          ))
        )
      )
      : null,
    scale && scale.values.length > 1
      ? h('p', { class: 'inspector__suggest-note' }, scaleNote(scale))
      : null
  );
}
