import { h } from 'preact';

// Each input is one argv entry: no shell parsing, trimming, or expansion.
export function McpArguments({ value, onChange }) {
  return h('div', { class: 'row' },
    h('span', { class: 'label' }, 'Arguments'),
    h('span', { class: 'hint hint--compact' }, 'One argument per field. Spaces, quotes, backslashes, and empty values are preserved exactly. Do not add shell quotes around paths.'),
    value.map((argument, index) => h('div', { key: index, class: 'row row--inline' },
      h('input', {
        class: 'input', type: 'text', value: argument,
        style: 'flex:1;min-width:0', 'aria-label': 'Argument ' + (index + 1),
        onInput: (event) => onChange(value.map((item, i) => i === index ? event.target.value : item))
      }),
      h('button', {
        class: 'btn', type: 'button', 'aria-label': 'Remove argument ' + (index + 1),
        onClick: () => onChange(value.filter((_, i) => i !== index))
      }, 'Remove')
    )),
    h('button', { class: 'btn', type: 'button', onClick: () => onChange([...value, '']) }, 'Add argument')
  );
}
