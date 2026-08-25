// mouaif web — runnable custom-action list embedded in the Tools popup
import { h } from 'preact';
export function CustomActionList({ actions = [], onRun }) {
if (!actions.length) return null;
return h('section', { class: 'tool-popup__actions', 'aria-label': 'Custom actions' },
h('div', { class: 'tool-popup__section-title' }, 'Actions'),
actions.map((action) => h('button', {
key: action.id,
type: 'button',
class: 'tool-popup__action',
onClick: () => onRun && onRun(action)
},
h('span', { class: 'tool-popup__action-icon', 'aria-hidden': 'true' }, action.kind === 'mcp' ? 'M' : '›_'),
h('span', { class: 'tool-popup__action-body' },
h('span', { class: 'tool-popup__action-label' }, action.label || action.id),
h('span', { class: 'tool-popup__action-meta' }, '@' + action.id + ' · ' + (action.kind === 'mcp' ? 'MCP' : 'CLI'))
)
))
);
}
