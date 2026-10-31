// What a mouaif surface tells the MCP App inside it (docs/features/extensions.md):
// the active theme's colours, fonts and radii as the MCP Apps standard style
// variables, the raw mouaif tokens, and the device. Recomputed on every
// theme change (THEME_PAINTED, fired by theme/runtime.js), so a view follows
// Parchment, CRT or a custom theme without knowing about them.
//
// Also the live-surface budget: at most MAX_LIVE extension views (docks and
// tool renderers) are mounted per tab; opening another closes the least
// recently used one. Each frame is a renderer process on a small host.

export const THEME_PAINTED = 'mouaif:theme-painted';

// MCP Apps standard variable -> the mouaif token it reads.
const STANDARD = {
  '--color-background-primary': '--bg',
  '--color-background-secondary': '--surface',
  '--color-background-tertiary': '--surface-2',
  '--color-background-inverse': '--accent',
  '--color-background-info': '--accent-soft',
  '--color-background-danger': '--danger-soft',
  '--color-background-success': '--success-soft',
  '--color-background-warning': '--warning-soft',
  '--color-text-primary': '--fg',
  '--color-text-secondary': '--fg-soft',
  '--color-text-tertiary': '--muted',
  '--color-text-inverse': '--on-accent',
  '--color-text-info': '--accent',
  '--color-text-danger': '--danger',
  '--color-text-success': '--success',
  '--color-text-warning': '--warning',
  '--color-border-primary': '--border',
  '--color-border-secondary': '--border-strong',
  '--color-ring-primary': '--accent',
  '--font-sans': '--font-sans',
  '--font-mono': '--font-mono',
  '--border-radius-sm': '--r-sm',
  '--border-radius-md': '--r-md',
  '--border-radius-lg': '--r-lg',
  '--border-radius-full': '--r-pill',
  '--shadow-sm': '--shadow-sm',
  '--shadow-md': '--shadow-md',
  '--shadow-lg': '--shadow-lg'
};
const TOKENS = ['--bg', '--surface', '--surface-2', '--fg', '--fg-soft', '--muted', '--accent', '--accent-soft', '--on-accent',
  '--border', '--danger', '--success', '--warning', '--r-sm', '--r-md', '--r-lg', '--r-pill', '--font-sans', '--font-mono'];

// 'dark' when the background colour is dark (a mouaif theme may be dark on a
// light OS, or the other way round).
function isDark(color) {
  if (!color || typeof document === 'undefined') return false;
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || [];
  probe.remove();
  const [r, g, b] = rgb.slice(0, 3).map(Number);
  if (![r, g, b].every(Number.isFinite)) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

// themeHostContext() -> { theme, styles: { variables }, tokens }
export function themeHostContext() {
  if (typeof document === 'undefined') return { theme: 'light', styles: { variables: {} }, tokens: {} };
  const cs = getComputedStyle(document.documentElement);
  const variables = {};
  for (const [key, token] of Object.entries(STANDARD)) {
    const value = cs.getPropertyValue(token).trim();
    if (value) variables[key] = value;
  }
  const tokens = {};
  for (const token of TOKENS) {
    const value = cs.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  return { theme: isDark(tokens['--bg']) ? 'dark' : 'light', styles: { variables }, tokens };
}

// surfaceHostContext({ slot, extensionId, surfaceId, chatId, projectName })
// -> the extra hostContext a surface gets on top of the bridge's own.
export function surfaceHostContext(surface) {
  const theme = themeHostContext();
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return {
    theme: theme.theme,
    styles: theme.styles,
    locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
    timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
    platform: coarse ? 'mobile' : 'web',
    deviceCapabilities: { touch: coarse, hover: typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches },
    mouaif: {
      slot: surface.slot,
      extensionId: surface.extensionId,
      surfaceId: surface.surfaceId,
      chatId: surface.chatId || null,
      projectName: surface.projectName || '',
      tokens: theme.tokens
    }
  };
}

// ---- Live-surface budget ------------------------------------------------------

export const MAX_LIVE = 2;
const live = new Map(); // key -> { at, evict }

// claimSurface(key, evict) — a dock or renderer is about to mount its frame.
// The least recently used others are evicted (their `evict` closes them).
export function claimSurface(key, evict) {
  live.set(key, { at: Date.now(), evict });
  while (live.size > MAX_LIVE) {
    let oldest = null;
    for (const [k, v] of live) if (k !== key && (!oldest || v.at < oldest[1].at)) oldest = [k, v];
    if (!oldest) break;
    live.delete(oldest[0]);
    try { oldest[1].evict(); } catch { /* already gone */ }
  }
}

export function touchSurface(key) {
  const entry = live.get(key);
  if (entry) entry.at = Date.now();
}

export function releaseSurface(key) {
  live.delete(key);
}

export function liveSurfaceCount() {
  return live.size;
}
