// Shared, safe icon catalog for custom prompts.
import { h } from 'preact';

export const PROMPT_ICONS = [
{ id: 'sparkles', label: 'Sparkles' },
{ id: 'code', label: 'Code' },
{ id: 'search', label: 'Search' },
{ id: 'pencil', label: 'Writing' },
{ id: 'bug', label: 'Debug' },
{ id: 'book', label: 'Research' }
];

const ICON_PATHS = {
sparkles: ['M12 3l1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3Z', 'M6 13l.9 2.1L9 16l-2.1.9L6 19l-.9-2.1L3 16l2.1-.9L6 13Z', 'M18 12l.8 1.7 1.7.8-1.7.8L18 17l-.8-1.7-1.7-.8 1.7-.8L18 12Z'],
code: ['M8.5 7 4 12l4.5 5', 'M15.5 7 20 12l-4.5 5', 'm14 4-4 16'],
search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm16 16 4 4'],
pencil: ['m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z', 'm14.8 6.4 2.8 2.8'],
bug: ['M9 9h6a3 3 0 0 1 3 3v3a6 6 0 0 1-12 0v-3a3 3 0 0 1 3-3Z', 'M9 9V7a3 3 0 0 1 6 0v2', 'M3 13h3', 'M18 13h3', 'M4 18l3-1', 'm20 18-3-1'],
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
