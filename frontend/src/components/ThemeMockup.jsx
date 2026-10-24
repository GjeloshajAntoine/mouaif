import { h } from 'preact';
import { useState } from 'preact/hooks';
import '../theme-mockup.css';

const THEMES = [
  { id: 'aurora', label: 'Aurora', note: 'glass + neon' },
  { id: 'paper', label: 'Paper', note: 'warm + editorial' },
  { id: 'mono', label: 'Mono', note: 'terminal + focus' }
];

export function ThemeMockupView() {
  const [theme, setTheme] = useState('aurora');
  return h('main', { class: 'theme-mockup', 'data-theme': theme },
    h('header', { class: 'theme-mockup__top' },
      h('div', { class: 'theme-mockup__brand' }, h('span', { class: 'theme-mockup__mark' }, 'm'), h('span', null, 'mouaif / playground')),
      h('span', { class: 'theme-mockup__live' }, '● live prototype')
    ),
    h('section', { class: 'theme-mockup__hero' },
      h('p', { class: 'eyebrow' }, 'Chat interface study'),
      h('h1', null, 'Choose a mood for the work.'),
      h('p', { class: 'theme-mockup__intro' }, 'Three deliberately different directions for a focused, tactile mobile chat.'),
      h('div', { class: 'theme-mockup__themes', role: 'tablist', 'aria-label': 'Visual themes' }, THEMES.map((item) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': theme === item.id, class: theme === item.id ? 'is-selected' : '', onClick: () => setTheme(item.id) },
          h('strong', null, item.label), h('small', null, item.note)
        )
      ))
    ),
    h('section', { class: 'theme-mockup__chat', 'aria-label': 'Chat mockup' },
      h('div', { class: 'theme-mockup__chat-head' }, h('div', null, h('strong', null, 'Design sprint'), h('span', null, 'sonnet · ready')), h('button', { type: 'button', 'aria-label': 'More options' }, '•••')),
      h('div', { class: 'theme-mockup__messages' },
        h('div', { class: 'mock-msg mock-msg--assistant' }, h('span', { class: 'mock-avatar' }, '✦'), h('div', null, h('p', null, 'I mapped the three visual directions. Want the interface to feel more like a studio, a notebook, or a command deck?'), h('small', null, '09:41 · 142 tokens'))),
        h('div', { class: 'mock-msg mock-msg--user' }, h('p', null, 'A studio with a little sci-fi energy. Keep it calm, not flashy.')),
        h('div', { class: 'mock-msg mock-msg--assistant' }, h('span', { class: 'mock-avatar' }, '✦'), h('div', null, h('p', null, 'Then Aurora is the strongest fit: translucent layers, a soft pulse on active work, and color used only for intent.'), h('div', { class: 'mock-card' }, h('span', null, '✦ direction'), h('strong', null, 'Aurora / focused glow'), h('small', null, 'Low contrast motion · 3 accents'))))
      ),
      h('div', { class: 'theme-mockup__composer' }, h('button', { type: 'button', 'aria-label': 'Attach' }, '+'), h('span', null, 'Ask anything…'), h('button', { type: 'button', class: 'theme-mockup__send', 'aria-label': 'Send' }, '↑'))
    ),
    h('p', { class: 'theme-mockup__hint' }, 'Prototype only · tap a theme to compare the same conversation')
  );
}
