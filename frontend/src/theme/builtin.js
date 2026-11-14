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

// Parchment's paper textures: small tileable PNGs in frontend/public/themes/,
// made by scripts/make-parchment-textures.py. They are pre-rendered rather
// than SVG `feTurbulence`, which Chrome recomputes on every repaint. The URL
// is relative so it resolves against the app page wherever it is served.
// PNGs are cached as immutable, so bump `v` when the files change.
const PAPER_GRAIN = 'url("themes/parchment-grain.png?v=1")';
const PAPER_MOTTLE = 'url("themes/parchment-mottle.png?v=1")';
// Yellow Paper's much fainter texture, from the same script.
const LEGAL_GRAIN = 'url("themes/legal-pad-grain.png?v=3")';
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
    note: 'aged paper · iron-gall ink',
    base: 'light',
    vars: {
      '--bg': '#e8d9b5',
      '--surface': '#f7efdc',
      '--surface-2': '#f0e5cb',
      '--surface-3': '#e7d8b6',
      '--border': 'rgba(96, 66, 22, 0.16)',
      '--border-strong': '#c9b083',
      '--fg': '#2a1f12',
      '--fg-soft': '#4a3a25',
      '--muted': '#6d5b40',
      '--muted-2': '#927f5f',
      '--accent': '#2d4a78',
      '--accent-soft': 'rgba(45, 74, 120, 0.11)',
      '--accent-press': '#22395f',
      '--accent-hi': '#3f5f94',
      '--accent-hi-2': '#6480b0',
      '--on-accent': '#f9f2e0',
      '--success': '#3d6a2a',
      '--success-soft': 'rgba(61, 106, 42, 0.12)',
      '--warning': '#8a5600',
      '--warning-soft': 'rgba(138, 86, 0, 0.12)',
      '--danger': '#9a2b1b',
      '--danger-soft': '#f1d6c3',
      '--font-sans': '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif", ui-serif, serif',
      '--r-sm': '2px',
      '--r-md': '3px',
      '--r-lg': '4px',
      '--shadow-sm': '0 1px 1px rgba(80, 52, 12, 0.10), 0 2px 6px -2px rgba(80, 52, 12, 0.18)',
      '--shadow-md': '0 1px 2px rgba(80, 52, 12, 0.10), 0 6px 16px -6px rgba(80, 52, 12, 0.26)',
      '--shadow-lg': '0 2px 4px rgba(80, 52, 12, 0.10), 0 14px 30px -10px rgba(80, 52, 12, 0.32)'
    },
    css: `
/* The paper lies behind the app: tone, mottling, foxing, grain and darker,
   handled edges on one static fixed layer under everything, so no texture
   ever sits on top of the text. */
html { background: var(--bg); }
body, .app__shell, .app__main--flush { background: transparent; }
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(140% 110% at 50% 40%, transparent 50%, rgba(120, 76, 20, 0.16) 82%, rgba(92, 54, 10, 0.34) 100%),
    ${PAPER_GRAIN} 0 0 / 128px 128px,
    ${PAPER_MOTTLE} 0 0 / 640px 640px,
    radial-gradient(90% 70% at 45% 35%, rgba(255, 248, 226, 0.55), transparent 75%),
    var(--bg);
}
/* Cards are fresher sheets laid on the page: a lighter tone, the same grain
   at half strength, and edges that darken a touch. */
.group__list, .project-card, .theme-card, .chat-msg__body, .dictation__card, .settings-themes__notice {
  background-image:
    ${PAPER_GRAIN},
    linear-gradient(170deg, rgba(255, 252, 240, 0.6), rgba(255, 252, 240, 0) 45%, rgba(150, 110, 40, 0.05));
  background-size: 128px 128px, auto;
  border: 1px solid rgba(110, 80, 30, 0.2);
  box-shadow: inset 0 0 18px rgba(150, 108, 40, 0.09), var(--shadow-sm);
}
/* Your own messages read as a note written in blue ink on a tinted slip,
   not a solid slab of colour. */
.chat-msg--user .chat-msg__body {
  background-color: #f3ecd9;
  background-image:
    ${PAPER_GRAIN},
    linear-gradient(170deg, rgba(255, 252, 240, 0.55), rgba(150, 110, 40, 0.04));
  color: #1f3355;
  border: 1px solid rgba(45, 74, 120, 0.28);
  border-left: 3px solid rgba(45, 74, 120, 0.7);
}
.chat-msg--user .chat-msg__body a { color: inherit; }
body { text-rendering: optimizeLegibility; font-variant-ligatures: common-ligatures; }
::selection { background: rgba(45, 74, 120, 0.18); }
`
  },
  {
    // The id predates the name; it stays so a saved choice keeps working.
    id: 'legal-pad',
    name: 'Yellow Paper',
    note: 'warm yellow sheets · black ink',
    base: 'light',
    vars: {
      '--bg': '#f9f3e1',
      '--surface': '#fbe9a3',
      '--surface-2': '#f6de8b',
      '--surface-3': '#f0d275',
      '--border': 'rgba(110, 88, 0, 0.16)',
      '--border-strong': '#dcc163',
      '--fg': '#25221b',
      '--fg-soft': '#454034',
      '--muted': '#655f4c',
      '--muted-2': '#8a846f',
      '--accent': '#3b3626',
      '--accent-soft': 'rgba(240, 176, 0, 0.26)',
      '--accent-press': '#25221b',
      '--accent-hi': '#4f4935',
      '--accent-hi-2': '#6b6450',
      '--on-accent': '#fff6d2',
      '--success': '#2f6b2c',
      '--success-soft': 'rgba(47, 107, 44, 0.14)',
      '--warning': '#875400',
      '--warning-soft': 'rgba(138, 82, 0, 0.14)',
      '--danger': '#b3261e',
      '--danger-soft': '#f8d2b0',
      '--r-sm': '3px',
      '--r-md': '4px',
      '--r-lg': '6px',
      '--shadow-sm': '0 1px 1px rgba(76, 60, 0, 0.10), 0 2px 5px -2px rgba(76, 60, 0, 0.20)',
      '--shadow-md': '0 1px 2px rgba(76, 60, 0, 0.10), 0 6px 16px -6px rgba(76, 60, 0, 0.28)',
      '--shadow-lg': '0 2px 4px rgba(76, 60, 0, 0.10), 0 14px 30px -10px rgba(76, 60, 0, 0.34)'
    },
    css: `
/* A warm ivory page under the paper: a barely visible unevenness and a soft highlight
   on one static fixed layer behind the app, like Parchment's paper. */
html { background: var(--bg); }
body, .app__shell, .app__main--flush { background: transparent; }
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    ${LEGAL_GRAIN} 0 0 / 256px 256px,
    radial-gradient(120% 90% at 50% 30%, rgba(255, 253, 246, 0.6), transparent 70%),
    var(--bg);
}
/* Cards are the yellow sheets lying on it. */
.group__list, .project-card, .theme-card, .chat-msg__body, .dictation__card, .settings-themes__notice {
  border: 1px solid rgba(130, 104, 0, 0.2);
  box-shadow: var(--shadow-sm);
}
/* Your own messages sit on a paler slip with an amber edge. */
.chat-msg--user .chat-msg__body {
  background-color: #fff6cf;
  color: var(--fg);
  border: 1px solid rgba(130, 104, 0, 0.24);
  border-left: 3px solid #e6a800;
}
.chat-msg--user .chat-msg__body a { color: inherit; }
::selection { background: rgba(240, 176, 0, 0.4); }
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
    note: 'phosphor glow · scanlines',
    base: 'dark',
    vars: {
      '--bg': '#020602',
      '--surface': '#061006',
      '--surface-2': '#0b180b',
      '--surface-3': '#112311',
      '--border': 'rgba(92, 255, 122, 0.16)',
      '--border-strong': '#1f4d26',
      '--fg': '#c6ffc2',
      '--fg-soft': '#9cec98',
      '--muted': '#76c873',
      '--muted-2': '#4f8a4f',
      '--accent': '#5cff7a',
      '--accent-soft': 'rgba(92, 255, 122, 0.16)',
      '--accent-press': '#45e061',
      '--accent-hi': '#9dffad',
      '--accent-hi-2': '#c6ffd0',
      '--on-accent': '#021a06',
      '--success': '#5cff7a',
      '--warning': '#ffcf4d',
      '--danger': '#ff6b6b',
      '--font-sans': 'var(--font-mono)',
      '--r-sm': '0px',
      '--r-md': '1px',
      '--r-lg': '2px'
    },
    css: `
html, body { background: radial-gradient(120% 90% at 50% 45%, #082608 0%, var(--bg) 72%); }
.app__shell, .app__main--flush { background: transparent; }
/* Phosphor bloom: a tight halo thickens each stroke so the scanlines below
   cross the glyphs without cutting them apart, and a wider one glows. */
body { text-shadow: 0 0 1px rgba(140, 255, 150, 0.6), 0 0 6px rgba(92, 255, 122, 0.3); }
.btn--primary, .app__tab.is-active .app__tab-icon, .seg__item--on .seg__pill, .theme-card.is-selected {
  box-shadow: 0 0 6px rgba(92, 255, 122, 0.55), 0 0 18px rgba(92, 255, 122, 0.25);
}
/* Your messages glow as an outlined phosphor block instead of a solid one:
   dark text on solid green is what the scanlines hurt most. */
.chat-msg--user .chat-msg__body {
  background: rgba(92, 255, 122, 0.09);
  color: var(--fg);
  border: 1px solid rgba(92, 255, 122, 0.55);
  box-shadow: 0 0 10px rgba(92, 255, 122, 0.2), inset 0 0 14px rgba(92, 255, 122, 0.1);
}
/* Scanlines and a tube vignette over the whole screen, with a faint
   flicker. The lines are fine (one dark pixel in three) and half-dark, so
   they read as a screen texture and the text stays legible. */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background:
    radial-gradient(130% 105% at 50% 50%, transparent 62%, rgba(0, 0, 0, 0.55) 100%),
    repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.34) 0 1px, rgba(0, 0, 0, 0) 1px 3px);
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
  background: linear-gradient(to bottom, rgba(92, 255, 122, 0), rgba(92, 255, 122, 0.06) 55%, rgba(180, 255, 190, 0.11) 60%, rgba(92, 255, 122, 0));
  will-change: transform;
  animation: mouaif-crt-roll 7s linear infinite;
}
@keyframes mouaif-crt-roll {
  from { transform: translate3d(0, -30vh, 0); }
  to   { transform: translate3d(0, 105vh, 0); }
}
@keyframes mouaif-crt-flicker {
  from { opacity: 1; }
  to   { opacity: 0.9; }
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
