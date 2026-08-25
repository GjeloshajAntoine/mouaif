// mouaif web — custom action launcher above the composer
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
export function ActionSheet({ actions = [], onRun, onClose }) {
const sheetRef = useRef(null);
useEffect(() => {
function onKey(event) { if (event.key === 'Escape') onClose(); }
document.addEventListener('keydown', onKey);
return () => document.removeEventListener('keydown', onKey);
}, [onClose]);
return h('div', { class: 'action-sheet__overlay', role: 'presentation', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
h('div', { ref: sheetRef, class: 'action-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Custom actions' },
h('div', { class: 'action-sheet__head' },
h('div', null, h('div', { class: 'action-sheet__title' }, 'Custom actions'), h('div', { class: 'action-sheet__hint' }, 'CLI and MCP shortcuts for this project')),
h('button', { class: 'action-sheet__close', type: 'button', onClick: onClose, 'aria-label': 'Close custom actions' }, '×')
),
h('div', { class: 'action-sheet__list' },
actions.length ? actions.map((action) => h('button', {
key: action.id, type: 'button', class: 'action-sheet__item',
onClick: () => { onClose(); onRun(action); }
},
h('span', { class: 'action-sheet__icon', 'aria-hidden': 'true' }, action.kind === 'mcp' ? 'M' : '›_'),
h('span', { class: 'action-sheet__body' },
h('span', { class: 'action-sheet__label' }, action.label || action.id),
h('span', { class: 'action-sheet__meta' }, '@' + action.id + ' · ' + (action.kind === 'mcp' ? 'MCP' : 'CLI')),
action.description ? h('span', { class: 'action-sheet__description' }, action.description) : null
)
)) : h('div', { class: 'action-sheet__empty' }, 'No custom actions. Add one in Project settings.')
)
)
);
}
