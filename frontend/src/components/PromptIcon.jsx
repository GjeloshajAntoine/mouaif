// Shared, safe icon catalog for custom prompts.
import { h } from 'preact';

export const PROMPT_ICONS = [
{ id: 'sparkles', label: 'Sparkles' },
{ id: 'chat', label: 'Chat' },
{ id: 'code', label: 'Code' },
{ id: 'search', label: 'Search' },
{ id: 'pencil', label: 'Writing' },
{ id: 'bug', label: 'Debug' },
{ id: 'book', label: 'Research' }
];

const ICON_PATHS = {
sparkles: ['M12 3c-.35 3.1-1.85 4.6-4.95 4.95 3.1.35 4.6 1.85 4.95 4.95.35-3.1 1.85-4.6 4.95-4.95C13.85 7.6 12.35 6.1 12 3Z', 'M5.5 14.5c-.2 1.9-1.1 2.8-3 3 1.9.2 2.8 1.1 3 3 .2-1.9 1.1-2.8 3-3-1.9-.2-2.8-1.1-3-3Z', 'M18.5 12.5c-.2 1.6-.9 2.3-2.5 2.5 1.6.2 2.3.9 2.5 2.5.2-1.6.9-2.3 2.5-2.5-1.6-.2-2.3-.9-2.5-2.5Z'],
chat: ['M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'],
code: ['M8.5 7 4 12l4.5 5', 'M15.5 7 20 12l-4.5 5', 'm14 4-4 16'],
search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm16 16 4 4'],
pencil: ['m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z', 'm14.8 6.4 2.8 2.8'],
bug: ['M9.5 10h5A3.5 3.5 0 0 1 18 13.5v2A6 6 0 0 1 6 15.5v-2A3.5 3.5 0 0 1 9.5 10Z', 'M9.5 10V8a2.5 2.5 0 0 1 5 0v2', 'M8.5 10c-.8 0-1.6.3-2.2.8L5 12', 'M15.5 10c.8 0 1.6.3 2.2.8L19 12', 'M3.5 14h2.6', 'M17.9 14h2.6', 'M4.6 18.4l2.5-1.3', 'M19.4 18.4l-2.5-1.3'],
book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H11a2 2 0 0 1 2 2v16a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 21.5v-16Z', 'M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18a2 2 0 0 1 2-2h2.5a2.5 2.5 0 0 1 2.5 2.5v-16Z']
};

export function PromptIcon({ name = 'sparkles', size = 20, class: className = '' }) {
const paths = ICON_PATHS[name] || ICON_PATHS.sparkles;
return h('svg', {
class: className || undefined,
viewBox: '0 0 24 24',
width: size,
height: size,
fill: 'none',
stroke: 'currentColor',
'stroke-width': '1.8',
'stroke-linecap': 'round',
'stroke-linejoin': 'round',
'aria-hidden': 'true',
focusable: 'false'
}, paths.map((d, index) => h('path', { d, key: index })));
}
