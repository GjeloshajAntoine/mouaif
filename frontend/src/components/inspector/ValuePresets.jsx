import { h } from 'preact';
import { useState } from 'preact/hooks';
import { valuePresets } from './touchValues.js';

// Separate from the page's measured suggestions: these are examples/keywords,
// not claims about this site's design scale. Reachable even with no page index.
export function ValuePresets({ prop, value, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const supports = typeof CSS !== 'undefined' && CSS.supports ? (p, v) => CSS.supports(p, v) : null;
  const presets = valuePresets(prop, supports);
  if (!prop || !presets.length) return null;
  const filtered = presets.filter((v) => v.toLowerCase().includes(query.toLowerCase()));
  const shown = expanded ? filtered : presets.slice(0, 8);
  return h('div', { class: 'inspector__value-presets' },
    h('div', { class: 'inspector__value-preset-head' },
      h('strong', null, 'Suggested values'),
      presets.length > 8 ? h('button', {
        class: 'inspector__shape-chip', type: 'button', 'aria-expanded': String(expanded),
        onClick: () => { setExpanded(!expanded); setQuery(''); }
      }, expanded ? 'Show less' : 'Show all ' + presets.length) : null
    ),
    h('p', { class: 'inspector__shape-note' }, 'Common values and keywords — not values measured on this page.'),
    expanded ? h('input', { class: 'input', type: 'search', value: query,
      'aria-label': 'Search suggested values', placeholder: 'Find a value…',
      onInput: (e) => setQuery(e.currentTarget.value) }) : null,
    h('div', { class: 'inspector__value-preset-chips', role: 'group', 'aria-label': 'Suggested values for ' + prop },
      shown.map((v) => h('button', { class: 'inspector__shape-chip' + (v === value ? ' is-on' : ''),
        type: 'button', key: v, 'aria-pressed': String(v === value), title: 'Use ' + v,
        onClick: () => onChange(v) }, v))
    ),
    !shown.length ? h('p', { class: 'inspector__shape-note' }, 'No matching suggestions. Exact typing is still available.') : null
  );
}
