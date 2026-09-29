import { h } from 'preact';
import { numericParts, replaceNumericPart, scalarValue } from './touchValues.js';
import { formatNumber } from './valueKinds.js';
import { ValueUnitPicker } from './ValueUnitPicker.jsx';

export function NumericValueParts({ prop, value, ctx, onChange }) {
  if (scalarValue(value)) return null;
  const parts = numericParts(value);
  if (!parts.length) return null;
  const valid = (next) => {
    if (typeof CSS === 'undefined' || !CSS.supports) return true;
    return CSS.supports(prop, next);
  };
  return h('div', { class: 'inspector__value-parts' },
    h('strong', null, 'Numeric parts'),
    h('p', { class: 'inspector__shape-note' }, 'Change one number or unit without rewriting the surrounding value. Colours, strings, URLs and variables stay intact.'),
    parts.map((part, index) => {
      const update = (next) => onChange(replaceNumericPart(value, part, next));
      const accepts = (next) => valid(replaceNumericPart(value, part, next));
      const step = ['rem', 'em', 'fr', 's', 'turn', 'rad'].includes(part.unit) || !part.unit ? 0.1 : 1;
      return h('div', { class: 'inspector__value-part', key: index },
        h('div', { class: 'inspector__value-part-head' },
          h('span', null, 'Part ' + (index + 1)), h('code', null, part.raw)),
        h('div', { class: 'inspector__value-part-number' },
          [-1, 1].map((dir) => {
            const next = formatNumber(part.number + dir * step) + part.unit;
            return h('button', { class: 'inspector__style-step', type: 'button', key: dir,
              'aria-label': (dir < 0 ? 'Decrease' : 'Increase') + ' numeric part ' + (index + 1),
              disabled: !accepts(next), onClick: () => update(next) }, dir < 0 ? '−' : '+');
          }),
          h('input', { class: 'input', type: 'number', step: 'any', value: part.number,
            'aria-label': 'Number for part ' + (index + 1),
            onInput: (e) => {
              const raw = e.currentTarget.value;
              if (raw !== '' && Number.isFinite(Number(raw))) update(formatNumber(Number(raw)) + part.unit);
            } })
        ),
        h(ValueUnitPicker, { prop, value: part.raw, ctx, onChange: update, accepts })
      );
    })
  );
}
