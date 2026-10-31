// frontend/src/theme/builtin.js — the themes that ship with mouaif.
//
// A theme is data: a base (`dark` or `light`, which sets `color-scheme`), a
// map of design tokens that overrides the `:root` values in base.css, and an
// optional CSS string for anything tokens cannot reach. Built-in themes carry
// no JavaScript; custom themes can (see runtime.js and docs/features/themes.md).
//
// Animated backdrops paint on a fixed pseudo-element and animate `transform`
// only, so the compositor moves them without repainting the app above.

export const DEFAULT_THEME_ID = 'midnight';

// Tokens the theme editor shows as colour rows, in display order. The value
// is the base.css default, used as the starting point and as the swatch when
// a theme leaves the token unset.
export const COLOR_TOKENS = [
  { name: '--bg', label: 'Page', value: '#0a0d12' },
  { name: '--surface', label: 'Cards', value: '#131824' },
  { name: '--surface-2', label: 'Raised rows', value: '#1c2333' },
  { name: '--surface-3', label: 'Menus & code', value: '#273046' },
  { name: '--border-strong', label: 'Edges', value: '#333d52' },
  { name: '--fg', label: 'Text', value: '#eceaf1' },
  { name: '--fg-soft', label: 'Secondary text', value: '#b6bac9' },
  { name: '--muted', label: 'Muted text', value: '#8b8a98' },
  { name: '--accent', label: 'Accent', value: '#6ea8fe' },
  { name: '--on-accent', label: 'Text on accent', value: '#0a1428' },
  { name: '--success', label: 'Success', value: '#6fd49a' },
  { name: '--warning', label: 'Warning', value: '#f0c46a' },
  { name: '--danger', label: 'Danger', value: '#ff8a8a' }
];

const FLAT_BACKGROUND = 'html, body { background: var(--bg); }';

// Paper grain + long horizontal fibres as a tileable SVG noise texture.
// `data:` images are allowed by the page CSP (`img-src 'self' data:`).
const PAPER_GRAIN = 'url("data:image/svg+xml,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'>"
  + "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/>"
  + "<feColorMatrix values='0 0 0 0 0.33 0 0 0 0 0.22 0 0 0 0 0.07 0 0 0 1.3 -0.58'/></filter>"
  + "<filter id='f'><feTurbulence type='fractalNoise' baseFrequency='0.018 0.55' numOctaves='2' seed='7' stitchTiles='stitch'/>"
  + "<feColorMatrix values='0 0 0 0 0.45 0 0 0 0 0.32 0 0 0 0 0.1 0 0 0 0.7 -0.33'/></filter>"
  + "<rect width='100%' height='100%' filter='url(#g)'/>"
  + "<rect width='100%' height='100%' filter='url(#f)'/></svg>"
) + '")';

const REDUCED_MOTION_OFF = (selector) =>
  `@media (prefers-reduced-motion: reduce) { ${selector} { animation: none !important; } }`;

export const BUILTIN_THEMES = [
  {
    id: 'midnight',
    name: 'Midnight',
    note: 'the default · cool blue',
    base: 'dark',
    vars: {},
    css: ''
  },
  {
    id: 'oled',
    name: 'OLED',
    note: 'true black · battery friendly',
    base: 'dark',
    vars: {
      '--bg': '#000000',
      '--surface': '#0c0c0f',
      '--surface-2': '#16161b',
      '--surface-3': '#212128',
      '--border-strong': '#2c2c34'
    },
    css: FLAT_BACKGROUND
  },
  {
    id: 'aurora',
    name: 'Aurora',
    note: 'glass + neon · drifting glow',
    base: 'dark',
    vars: {
      '--bg': '#070a14',
      '--surface': '#10162a',
      '--surface-2': '#18203a',
      '--surface-3': '#222c4c',
      '--border': 'rgba(160, 200, 255, 0.08)',
      '--border-strong': '#2e3a60',
      '--fg': '#eef1ff',
      '--fg-soft': '#b8bfdc',
      '--muted': '#8790b0',
      '--muted-2': '#5d6688',
      '--accent': '#79f2d0',
      '--accent-soft': 'rgba(121, 242, 208, 0.14)',
      '--accent-press': '#5fd9b8',
      '--accent-hi': '#a8ffe6',
      '--accent-hi-2': '#cafff0',
      '--on-accent': '#04221a'
    },
    css: `
html { background: var(--bg); }
body, .app__shell, .app__main--flush { background: transparent; }
body::before {
  content: '';
  position: fixed;
  inset: -25%;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(40% 35% at 25% 30%, rgba(121, 242, 208, 0.10), transparent 70%),
    radial-gradient(45% 40% at 75% 20%, rgba(150, 110, 255, 0.12), transparent 70%),
    radial-gradient(50% 40% at 60% 85%, rgba(80, 160, 255, 0.08), transparent 70%);
  will-change: transform;
  animation: mouaif-aurora-drift 38s ease-in-out infinite alternate;
}
@keyframes mouaif-aurora-drift {
  from { transform: translate3d(-4%, -2%, 0) rotate(0deg) scale(1); }
  to   { transform: translate3d(4%, 3%, 0) rotate(12deg) scale(1.08); }
}
${REDUCED_MOTION_OFF('body::before')}
`
  },
  {
    id: 'paper',
    name: 'Paper',
    note: 'warm light · editorial',
    base: 'light',
    vars: {
      '--bg': '#f4efe6',
      '--surface': '#fffbf4',
      '--surface-2': '#efe7da',
      '--surface-3': '#e7ddcc',
      '--border': 'rgba(70, 45, 20, 0.12)',
      '--border-strong': '#d3c5ae',
      '--fg': '#2a241e',
      '--fg-soft': '#4f453b',
      '--muted': '#76685a',
      '--muted-2': '#9d8f7e',
      '--accent': '#b9532d',
      '--accent-soft': 'rgba(185, 83, 45, 0.12)',
      '--accent-press': '#9f4422',
      '--accent-hi': '#c8663f',
      '--accent-hi-2': '#d9805e',
      '--on-accent': '#fff8f2',
      '--success': '#2d7f50',
      '--success-soft': 'rgba(45, 127, 80, 0.12)',
      '--warning': '#9a6200',
      '--warning-soft': 'rgba(154, 98, 0, 0.12)',
      '--danger': '#b8352a',
      '--danger-soft': '#f6dcd6',
      '--shadow-sm': '0 1px 2px rgba(60, 40, 20, 0.10)',
      '--shadow-md': '0 4px 16px rgba(60, 40, 20, 0.10)',
      '--shadow-lg': '0 12px 32px rgba(60, 40, 20, 0.14)'
    },
    css: FLAT_BACKGROUND
  },
  {
    id: 'parchment',
    name: 'Parchment',
    note: 'yellowed paper · fountain-pen ink',
    base: 'light',
    vars: {
      '--bg': '#ecdcab',
      '--surface': '#f7ecc8',
      '--surface-2': '#efe0b3',
      '--surface-3': '#e5d29d',
      '--border': 'rgba(110, 78, 18, 0.18)',
      '--border-strong': '#c9ae6e',
      '--fg': '#2f2414',
      '--fg-soft': '#4f3f24',
      '--muted': '#7a6640',
      '--muted-2': '#9e8a5f',
      '--accent': '#284a80',
      '--accent-soft': 'rgba(40, 74, 128, 0.12)',
      '--accent-press': '#1e3a66',
      '--accent-hi': '#3a5f9c',
      '--accent-hi-2': '#587bb6',
      '--on-accent': '#fbf3d8',
      '--success': '#3b6a28',
      '--success-soft': 'rgba(59, 106, 40, 0.13)',
      '--warning': '#8a5800',
      '--warning-soft': 'rgba(138, 88, 0, 0.13)',
      '--danger': '#9e2f1f',
      '--danger-soft': '#efcfb6',
      '--font-sans': 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
      '--r-sm': '2px',
      '--r-md': '3px',
      '--r-lg': '5px',
      '--shadow-sm': '0 1px 1px rgba(90, 60, 10, 0.14), 0 3px 8px -3px rgba(90, 60, 10, 0.22)',
      '--shadow-md': '0 2px 3px rgba(90, 60, 10, 0.12), 0 8px 18px -6px rgba(90, 60, 10, 0.28)',
      '--shadow-lg': '0 4px 6px rgba(90, 60, 10, 0.12), 0 16px 32px -10px rgba(90, 60, 10, 0.32)'
    },
    css: `
${FLAT_BACKGROUND}
/* Grain, fibres and aged edges over the whole page: one static fixed layer. */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background:
    radial-gradient(130% 95% at 50% 42%, transparent 58%, rgba(130, 85, 15, 0.22) 100%),
    ${PAPER_GRAIN} 0 0 / 260px 260px;
}
/* Cards read as separate sheets lying on the page. */
.group__list, .project-card, .theme-card, .chat-msg__body, .dictation__card, .settings-themes__notice {
  background-image: linear-gradient(172deg, rgba(255, 252, 238, 0.55), rgba(255, 252, 238, 0) 42%, rgba(140, 100, 30, 0.06));
  border: 1px solid rgba(120, 88, 25, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), var(--shadow-sm);
}
.chat-msg--user .chat-msg__body {
  background-image: linear-gradient(172deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0) 50%);
}
::selection { background: rgba(40, 74, 128, 0.2); }
`
  },
  {
    id: 'mono',
    name: 'Mono',
    note: 'terminal green · scanlines',
    base: 'dark',
    vars: {
      '--bg': '#050805',
      '--surface': '#0b110b',
      '--surface-2': '#121b12',
      '--surface-3': '#1a261a',
      '--border': 'rgba(140, 255, 120, 0.10)',
      '--border-strong': '#264326',
      '--fg': '#d6ffd0',
      '--fg-soft': '#a6d9a0',
      '--muted': '#76a170',
      '--muted-2': '#4f6e4b',
      '--accent': '#8cff6e',
      '--accent-soft': 'rgba(140, 255, 110, 0.14)',
      '--accent-press': '#74e058',
      '--accent-hi': '#b4ff9e',
      '--accent-hi-2': '#d0ffc2',
      '--on-accent': '#062006',
      '--success': '#8cff6e',
      '--warning': '#ffd166',
      '--danger': '#ff6b6b',
      '--font-sans': 'var(--font-mono)',
      '--r-sm': '2px',
      '--r-md': '3px',
      '--r-lg': '4px'
    },
    css: `
${FLAT_BACKGROUND}
body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.18) 0 1px, transparent 1px 3px);
  opacity: 0.35;
}
`
  },
  {
    id: 'crt',
    name: 'CRT',
    note: 'phosphor glow · heavy scanlines',
    base: 'dark',
    vars: {
      '--bg': '#020602',
      '--surface': '#061006',
      '--surface-2': '#0b180b',
      '--surface-3': '#112311',
      '--border': 'rgba(92, 255, 122, 0.16)',
      '--border-strong': '#1f4d26',
      '--fg': '#b8ffb4',
      '--fg-soft': '#8fe38c',
      '--muted': '#72c46f',
      '--muted-2': '#4a824a',
      '--accent': '#5cff7a',
      '--accent-soft': 'rgba(92, 255, 122, 0.16)',
      '--accent-press': '#45e061',
      '--accent-hi': '#9dffad',
      '--accent-hi-2': '#c6ffd0',
      '--on-accent': '#021a06',
      '--success': '#5cff7a',
      '--warning': '#ffcf4d',
      '--danger': '#ff5c5c',
      '--font-sans': 'var(--font-mono)',
      '--r-sm': '0px',
      '--r-md': '1px',
      '--r-lg': '2px'
    },
    css: `
html, body { background: radial-gradient(120% 90% at 50% 45%, #072207 0%, var(--bg) 70%); }
.app__shell, .app__main--flush { background: transparent; }
/* Phosphor bloom on every glyph. */
body { text-shadow: 0 0 2px rgba(92, 255, 122, 0.6), 0 0 10px rgba(92, 255, 122, 0.28); }
.btn--primary, .app__tab.is-active .app__tab-icon, .seg__item--on .seg__pill, .theme-card.is-selected {
  box-shadow: 0 0 6px rgba(92, 255, 122, 0.55), 0 0 18px rgba(92, 255, 122, 0.25);
}
/* Heavy scanlines, RGB sub-pixel mask and tube vignette, with a faint flicker. */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background:
    radial-gradient(125% 100% at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.7) 100%),
    repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.62) 0 2px, rgba(0, 0, 0, 0) 2px 4px),
    repeating-linear-gradient(to right, rgba(255, 0, 0, 0.05) 0 1px, rgba(0, 255, 0, 0.03) 1px 2px, rgba(0, 0, 255, 0.05) 2px 3px);
  animation: mouaif-crt-flicker 0.16s steps(2) infinite;
}
/* A bright band rolling down the tube. */
body::before {
  content: '';
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  height: 28vh;
  z-index: 2147483001;
  pointer-events: none;
  background: linear-gradient(to bottom, rgba(92, 255, 122, 0), rgba(92, 255, 122, 0.09) 55%, rgba(180, 255, 190, 0.16) 60%, rgba(92, 255, 122, 0));
  will-change: transform;
  animation: mouaif-crt-roll 6.5s linear infinite;
}
@keyframes mouaif-crt-roll {
  from { transform: translate3d(0, -30vh, 0); }
  to   { transform: translate3d(0, 105vh, 0); }
}
@keyframes mouaif-crt-flicker {
  from { opacity: 1; }
  to   { opacity: 0.88; }
}
@media (prefers-reduced-motion: reduce) {
  body::after { animation: none !important; }
  body::before { display: none; }
}
`
  }
];

export function findBuiltin(id) {
  return BUILTIN_THEMES.find((theme) => theme.id === id) || null;
}
