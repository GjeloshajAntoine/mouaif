// ThemeCard — one theme in Settings → Themes: a miniature of the app in the
// theme's own tokens, its name, and a tap target that makes it active.
import { h } from 'preact';
import { COLOR_TOKENS } from '../../theme/builtin.js';

const DEFAULTS = Object.fromEntries(COLOR_TOKENS.map((t) => [t.name, t.value]));

// The miniature reads the theme's tokens directly (inline custom properties),
// so every card shows its own palette whatever theme the page is in.
function previewStyle(theme) {
  const vars = theme.vars || {};
  const pick = (name) => vars[name] || DEFAULTS[name];
  return {
    '--tc-bg': pick('--bg'),
    '--tc-surface': pick('--surface'),
    '--tc-fg': pick('--fg'),
    '--tc-muted': pick('--muted'),
    '--tc-accent': pick('--accent'),
    '--tc-on-accent': pick('--on-accent'),
    '--tc-radius': vars['--r-md'] || '10px',
    '--tc-font': vars['--font-sans'] === 'var(--font-mono)' ? 'var(--font-mono)' : (vars['--font-sans'] || 'var(--font-sans)')
  };
}

export function ThemeCard({ theme, selected, onSelect, editHref, editLabel }) {
  const detail = theme.builtin
    ? theme.note
    : [theme.base === 'light' ? 'light' : 'dark', theme.hasJs ? 'JS' : '', theme.css ? 'CSS' : ''].filter(Boolean).join(' · ');
  return h('li', { class: 'theme-card' + (selected ? ' is-selected' : '') },
    h('button', {
      type: 'button',
      class: 'theme-card__pick',
      role: 'radio',
      'aria-checked': selected ? 'true' : 'false',
      onClick: () => onSelect(theme.id)
    },
      h('span', { class: 'theme-card__preview', style: previewStyle(theme), 'aria-hidden': 'true' },
        h('span', { class: 'theme-card__bubble theme-card__bubble--them' }),
        h('span', { class: 'theme-card__bubble theme-card__bubble--me' }),
        h('span', { class: 'theme-card__bar' }, h('span', { class: 'theme-card__dot' }))
      ),
      h('span', { class: 'theme-card__text' },
        h('span', { class: 'theme-card__name' }, theme.name),
        h('span', { class: 'theme-card__note' }, detail || ' ')
      ),
      selected ? h('span', { class: 'theme-card__check', 'aria-hidden': 'true' }, '✓') : null
    ),
    h('a', { class: 'theme-card__edit', href: editHref }, editLabel)
  );
}
