// mouaif web — shared thinking-level select field
//
// A plain <select> of the thinking presets for a model (from its
// provider-reported `thinking` descriptor), plus an "Inherit" first row.
// Used where there is no free-form custom input: the Agents editor and
// the subagent authorization card. "Inherit" (value '') means "follow the
// chat/agent default" — distinct from a specific level.
//
// props:
//   value          — current thinking level string ('' = inherit)
//   onChange       — (value) => void
//   descriptor     — optional { kind } from the model's `thinking` field
//   inheritLabel   — label for the first (inherit) option
//   disabled       — bool
//   ariaLabel      — select aria-label
import { h } from 'preact';
import { useMemo } from 'preact/hooks';
import { thinkingOptionsForSelect } from './chat/thinking.js';

export function ThinkingSelectField(props) {
const {
value,
onChange,
descriptor,
inheritLabel = 'Inherit',
disabled = false,
ariaLabel = 'Thinking level'
} = props;
// Presets exclude the '' "No thinking" row (that slot is the inherit
// row) and the '__custom__' sentinel (no free-form input here).
const options = useMemo(() =>
thinkingOptionsForSelect(descriptor).filter((o) => o.value !== ''),
[descriptor]);
const current = typeof value === 'string' ? value : '';
// If the stored value is not in the descriptor's option set (e.g. a
// custom value set elsewhere), append it as an extra row so the user
// can still see and clear it, instead of silently showing "Inherit".
const hasCurrent = current === '' || options.some((o) => o.value === current);
const opts = hasCurrent
? options
: options.concat([{ value: current, label: current }]);
return h('select', {
class: 'input thinking-select-field',
value: current,
disabled: !!disabled,
'aria-label': ariaLabel,
onChange: (e) => { if (onChange) onChange(e.currentTarget.value); }
},
h('option', { value: '' }, inheritLabel),
opts.map((o) => h('option', { key: o.value, value: o.value }, o.label))
);
}
