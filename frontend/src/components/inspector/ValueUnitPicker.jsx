import { h } from 'preact';
import { useState } from 'preact/hooks';
import { touchUnitOptions } from './touchValues.js';

export function ValueUnitPicker({ prop, value, ctx, onChange, accepts }) {
  const [mode, setMode] = useState('choose');
  const options = touchUnitOptions(prop, value, ctx, mode).map((o) => {
    if (!o.ok || !accepts || o.current) return o;
    return accepts(o.value) ? o : { ...o, ok: false, reason: 'Not valid in this declaration.' };
  });
  if (options.length < 2) return null;
  const pick = (unit) => {
    const option = options.find((o) => o.unit === unit);
    if (option && option.ok && !option.current) onChange(option.value);
  };
  const current = options.find((o) => o.current);
  const common = options.filter((o) => ['', 'px', 'rem', 'em', '%', 'vw', 'vh', 'dvh', 'fr', 'ms', 's', 'deg', 'turn', 'rad'].includes(o.unit) || o.current);
  return h('div', { class: 'inspector__value-units' },
    h('div', { class: 'inspector__value-modes', role: 'group', 'aria-label': 'Unit action for ' + prop },
      ['choose', 'convert'].map((id) => h('button', {
        class: 'inspector__shape-chip' + (mode === id ? ' is-on' : ''), type: 'button', key: id,
        'aria-pressed': String(mode === id), onClick: () => setMode(id)
      }, id === 'choose' ? 'Choose unit' : 'Convert unit'))
    ),
    h('p', { class: 'inspector__shape-note' }, mode === 'choose'
      ? 'Keeps the number, changes its meaning. Apply commits the new value.'
      : 'Preserves the value only when its basis is known. Unmeasured conversions are disabled.'),
    h('div', { class: 'inspector__value-unit-chips', role: 'group', 'aria-label': 'Unit for ' + prop },
      common.map((o) => h('button', {
        class: 'inspector__unitchip' + (o.current ? ' is-on' : ''), key: o.unit, type: 'button',
        'aria-pressed': String(o.current), disabled: !o.ok || o.current,
        title: o.ok ? (mode === 'choose' ? 'Choose ' : 'Convert to ') + o.label + ': ' + o.value : o.reason,
        'aria-label': o.label + (o.ok ? ', ' + o.value : ', unavailable: ' + o.reason),
        onClick: () => pick(o.unit)
      }, o.label))
    ),
    options.length > common.length ? h('label', { class: 'inspector__value-unit-select' },
      h('span', null, 'All units'),
      h('select', {
      class: 'input', 'aria-label': 'All units for ' + prop, value: current ? current.unit : '__choose__',
      onChange: (e) => {
      pick(e.currentTarget.value);
      // The field may remain a keyword until a first valid choice. Keep
      // the select honest after a blocked/no-op change as well.
      e.currentTarget.value = current ? current.unit : '__choose__';
      }
      },
        h('option', { value: '__choose__', disabled: true }, 'Select a unit'),
        options.map((o) => h('option', { key: o.unit, value: o.unit, disabled: !o.ok },
          o.label + (o.ok ? ' — ' + o.value : ' — ' + o.reason)))
      )
    ) : null
  );
}
