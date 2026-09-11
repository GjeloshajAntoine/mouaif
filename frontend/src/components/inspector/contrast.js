// Inspector colour contrast — is this text colour readable on that background?
//
// The edit sheet can suggest the colours a page already uses (valueIndex.js),
// and the value-type switch can rewrite one colour format as another
// (valueKinds.js). Neither says whether a suggested colour is *legible* on the
// element it is about to be applied to, which is the one property of a text
// colour a user cannot see from the chip alone: `#2b3a56` looks perfectly
// reasonable until it is applied to a dark card.
//
// This module computes WCAG 2.1 relative luminance and the contrast ratio
// between two colours, so a candidate chip can carry `AA 7.4:1` before Apply.
//
//   parseColor(value)              -> { r, g, b, a } | null
//   relativeLuminance({r,g,b})     -> number
//   contrast(background, fg, ctx)  -> { ratio, fg, bg, source }
//   contrastLevel(ratio)           -> { level, min, normal, style }
//   contrastBadge(ratio)           -> { ratio, level, text, ok }
//   readableOn(bg, candidates)     -> candidates with their ratio attached
//   suggestTextColor(bg, opts)     -> the light/dark pair that maximises contrast
//
// Everything is pure and DOM-free. `ctx` carries the two resolved values the
// panel already reads from `getComputedStyle` (`computed`), because
// `currentcolor` and `transparent` cannot be resolved from the string alone.
import { formatNumber } from './valueKinds.js';
// NAMED — the CSS named colours that show up in real stylesheets, plus the
// three keywords that have a fixed meaning. Kept to a practical subset: an
// unknown name returns null (and the caller says so) rather than a guess.
const NAMED = {
black: '#000000', white: '#ffffff', silver: '#c0c0c0', gray: '#808080', grey: '#808080',
maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080',
blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', violet: '#ee82ee', indigo: '#4b0082',
crimson: '#dc143c', salmon: '#fa8072', tomato: '#ff6347', khaki: '#f0e68c',
slategray: '#708090', slategrey: '#708090', dimgray: '#696969', dimgrey: '#696969',
lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', lavender: '#e6e6fa', beige: '#f5f5dc',
ivory: '#fffff0', snow: '#fffafa', mintcream: '#f5fffa', azure: '#f0ffff',
midnightblue: '#191970', steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff',
skyblue: '#87ceeb', lightblue: '#add8e6', deepskyblue: '#00bfff', cornflowerblue: '#6495ed',
darkblue: '#00008b', darkgreen: '#006400', forestgreen: '#228b22', seagreen: '#2e8b57',
mediumseagreen: '#3cb371', springgreen: '#00ff7f', yellowgreen: '#9acd32',
darkred: '#8b0000', firebrick: '#b22222', indianred: '#cd5c5c', rosybrown: '#bc8f8f',
darkorange: '#ff8c00', coral: '#ff7f50', sandybrown: '#f4a460', peru: '#cd853f',
chocolate: '#d2691e', saddlebrown: '#8b4513', sienna: '#a0522d',
darkmagenta: '#8b008b', darkviolet: '#9400d3', blueviolet: '#8a2be2', mediumpurple: '#9370db',
plum: '#dda0dd', orchid: '#da70d6', hotpink: '#ff69b4', deeppink: '#ff1493',
lightpink: '#ffb6c1', lightyellow: '#ffffe0', lemonchiffon: '#fffacd', wheat: '#f5deb3',
lightsteelblue: '#b0c4de', powderblue: '#b0e0e6', paleturquoise: '#afeeee',
darkcyan: '#008b8b', lightseagreen: '#20b2aa', cadetblue: '#5f9ea0',
darkolivegreen: '#556b2f', olivedrab: '#6b8e23', darkslateblue: '#483d8b',
slateblue: '#6a5acd', mediumslateblue: '#7b68ee', darkslategray: '#2f4f4f',
darkslategrey: '#2f4f4f', lightslategray: '#778899', lightslategrey: '#778899'
};
// clamp255 — a channel back into 0…255 as an integer.
function clamp255(n) {
if (!Number.isFinite(n)) return 0;
return Math.max(0, Math.min(255, Math.round(n)));
}
// parseChannel — a `rgb()` component: `255`, `100%` (of 255) or `none`.
function parseChannel(part) {
const s = String(part == null ? '' : part).trim();
if (!s) return null;
if (/%$/.test(s)) {
const pct = parseFloat(s);
return Number.isFinite(pct) ? (pct / 100) * 255 : null;
}
const n = parseFloat(s);
return Number.isFinite(n) ? n : null;
}
// parseAlpha — the alpha of a functional notation: `0.5` or `50%`.
function parseAlpha(part) {
if (part == null || part === '') return 1;
const s = String(part).trim();
if (/%$/.test(s)) {
const pct = parseFloat(s);
return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
}
const n = parseFloat(s);
return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
// hslToRgb — the one colour space the panel has to convert itself, because the
// colour rails work in H/S/L while the contrast maths needs RGB.
export function hslToRgb(h, s, l) {
const hue = ((h % 360) + 360) % 360;
const sat = Math.max(0, Math.min(1, s));
const light = Math.max(0, Math.min(1, l));
const c = (1 - Math.abs(2 * light - 1)) * sat;
const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
const m = light - c / 2;
const sector = Math.floor(hue / 60) % 6;
const rgb = [
[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]
][sector] || [0, 0, 0];
return {
r: clamp255((rgb[0] + m) * 255),
g: clamp255((rgb[1] + m) * 255),
b: clamp255((rgb[2] + m) * 255),
a: 1
};
}
// rgbToHsl — the inverse, for the colour rails' read position.
export function rgbToHsl(color) {
const c = color || { r: 0, g: 0, b: 0 };
const r = clamp255(c.r) / 255;
const g = clamp255(c.g) / 255;
const b = clamp255(c.b) / 255;
const max = Math.max(r, g, b);
const min = Math.min(r, g, b);
const l = (max + min) / 2;
const d = max - min;
if (!d) return { h: 0, s: 0, l, a: c.a == null ? 1 : c.a };
const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
let h;
if (max === r) h = ((g - b) / d) % 6;
else if (max === g) h = (b - r) / d + 2;
else h = (r - g) / d + 4;
h *= 60;
if (h < 0) h += 360;
return { h, s, l, a: c.a == null ? 1 : c.a };
}
// parseColor — any colour string the panel can meet, as `{ r, g, b, a }`.
//
// Handles hex (3/4/6/8), `rgb()`/`rgba()`, `hsl()`/`hsla()`, the named subset
// above, and the two context keywords: `currentcolor` resolves through
// `ctx.color`, `transparent` is the fully transparent black. Anything else
// (a `color-mix()`, a `var()`, a gradient) returns null, which is the honest
// answer — the caller shows the chip without a ratio rather than a wrong one.
export function parseColor(value, ctx) {
const c = ctx || {};
const raw = String(value == null ? '' : value).trim().toLowerCase();
if (!raw) return null;
if (raw === 'currentcolor') {
if (!c.color) return null;
return parseColor(c.color, c);
}
if (raw === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
const hex = /^#([0-9a-f]{3,8})$/.exec(raw);
if (hex) {
const h = hex[1];
const expand = (s) => parseInt(s.length === 1 ? s + s : s, 16);
if (h.length === 3 || h.length === 4) {
return {
r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
a: h.length === 4 ? expand(h[3]) / 255 : 1
};
}
if (h.length === 6 || h.length === 8) {
return {
r: expand(h.slice(0, 2)), g: expand(h.slice(2, 4)), b: expand(h.slice(4, 6)),
a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1
};
}
return null;
}
const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(raw);
if (fn) {
// Both the legacy comma syntax and the modern space syntax (with an optional
// `/ alpha`) reach a real page, so both are split the same way.
const body = fn[2].replace(/\//g, ' ').replace(/,/g, ' ').trim();
const parts = body.split(/\s+/).filter((s) => s !== '');
if (parts.length < 3) return null;
if (fn[1].startsWith('rgb')) {
const r = parseChannel(parts[0]);
const g = parseChannel(parts[1]);
const b = parseChannel(parts[2]);
if (r == null || g == null || b == null) return null;
return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: parseAlpha(parts[3]) };
}
const h = parseFloat(parts[0]);
const s = parseFloat(parts[1]);
const l = parseFloat(parts[2]);
if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
const rgb = hslToRgb(h, (/%$/.test(parts[1]) ? s / 100 : s), (/%$/.test(parts[2]) ? l / 100 : l));
rgb.a = parseAlpha(parts[3]);
return rgb;
}
if (!(raw in NAMED)) return null;
return parseColor(NAMED[raw], c);
}
// channelLuminance — one sRGB channel linearised the way WCAG specifies.
function channelLuminance(v) {
const s = v / 255;
return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
// relativeLuminance — WCAG 2.1 relative luminance: 0 for black, 1 for white.
export function relativeLuminance(color) {
const c = color || { r: 0, g: 0, b: 0 };
return 0.2126 * channelLuminance(clamp255(c.r))
+ 0.7152 * channelLuminance(clamp255(c.g))
+ 0.0722 * channelLuminance(clamp255(c.b));
}
// composite — a translucent foreground over an opaque backdrop, which is what
// the page actually renders (a `rgba(255,255,255,.08)` card on `#131824` is not
// the same colour as its own channels).
export function composite(fg, bg) {
const a = fg && fg.a != null ? fg.a : 1;
const b = bg || { r: 0, g: 0, b: 0, a: 1 };
if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
const mix = (f, k) => clamp255(f * a + (k || 0) * (1 - a));
return { r: mix(fg.r, b.r), g: mix(fg.g, b.g), b: mix(fg.b, b.b), a: 1 };
}
// contrastRatio — the WCAG ratio between two luminances, 1…21.
export function contrastRatio(a, b) {
const l1 = relativeLuminance(a);
const l2 = relativeLuminance(b);
const light = Math.max(l1, l2);
const dark = Math.min(l1, l2);
return (light + 0.05) / (dark + 0.05);
}
// LEVELS — the WCAG 2.1 contrast minimums, normal text. `AA` is 4.5:1 and
// `AAA` is 7:1; anything under 4.5 is a fail for body text.
export const AA_MIN = 4.5;
export const AAA_MIN = 7;
// contrastLevel — which threshold the ratio clears, and the style the badge
// should use. A ratio under AA is `fail`, not "AA for large text": the sheet
// shows contrast on text whose size it does not know, and the strict reading is
// the one that cannot mislead.
export function contrastLevel(ratio) {
const r = Number(ratio);
if (!Number.isFinite(r) || r <= 0) return { level: 'fail', min: AA_MIN };
if (r >= AAA_MIN) return { level: 'AAA', min: AAA_MIN };
if (r >= AA_MIN) return { level: 'AA', min: AA_MIN };
return { level: 'fail', min: AA_MIN };
}
// contrastBadge — the chip's label: `AA 7.4:1`, `AAA 12.6:1`, `fail 4.48:1`.
//
// The level is decided by the *true* ratio, never the displayed one: `#777` on
// white is 4.475:1, which rounds to 4.5 and would otherwise be shown as a pass
// while failing the 4.5 threshold. Only when one decimal would misstate the
// level is a second decimal shown, so the common case stays as short as the
// mock's `AA 7.4:1` and the near-miss stays honest.
export function contrastBadge(ratio) {
const r = Number(ratio);
if (!Number.isFinite(r) || r <= 0) return { ratio: 0, level: 'fail', text: 'no ratio', ok: false };
const level = contrastLevel(r).level;
const coarse = Math.round(r * 10) / 10;
const displayed = contrastLevel(coarse).level === level ? coarse : Math.round(r * 100) / 100;
return {
ratio: displayed,
level,
text: level + ' ' + formatNumber(displayed) + ':1',
ok: level !== 'fail'
};
}
// contrast — the ratio between a background and a foreground, with both
// resolved. `ctx.bg` is the element's resolved `background-color` and `ctx.color`
// its resolved `color`, so the caller does not have to pass them twice.
//
// A translucent foreground is composited over the background first, because
// half-transparent text on a card is decided by the composition, not by the
// colour channels alone. A transparent background has no ratio at all: there is
// nothing to measure against, and the caller should inherit upward instead.
export function contrast(background, foreground, ctx) {
const c = ctx || {};
const bg = parseColor(background != null ? background : c.bg, c);
const fg = parseColor(foreground != null ? foreground : c.color, c);
if (!bg || !fg) return { ok: false, ratio: null, reason: 'a colour could not be read' };
if (bg.a === 0) return { ok: false, ratio: null, reason: 'the background is transparent' };
const solidBg = composite(bg, { r: 255, g: 255, b: 255, a: 1 });
const solidFg = composite(fg, solidBg);
const ratio = contrastRatio(solidBg, solidFg);
const badge = contrastBadge(ratio);
return {
ok: true,
ratio: badge.ratio,
level: badge.level,
text: badge.text,
okLevel: badge.ok,
fg: solidFg,
bg: solidBg,
source: { background: String(background || '').trim(), foreground: String(foreground || '').trim() }
};
}
// readableOn — attach a contrast reading to each colour candidate, so a chip
// row can be rendered from one call. Candidates that cannot be parsed keep
// `ratio: null` and carry the reason, which is what lets the chip stay visible
// without a badge instead of disappearing.
export function readableOn(background, candidates, ctx) {
return (candidates || []).map((c) => {
const item = (c && typeof c === 'object') ? c : { value: c };
const result = contrast(background, item.value, ctx);
return Object.assign({}, item, {
ratio: result.ratio,
text: result.text || '',
level: result.level || '',
readable: !!result.okLevel,
reason: result.reason || ''
});
});
}
// suggestTextColor — the two colours that always work on `background`: the
// higher-contrast of white and black. Used when the page offers no text colour
// for the element (a freshly picked node), so the sheet has an honest default
// rather than an empty group.
export function suggestTextColor(background, ctx) {
const bg = parseColor(background, ctx);
if (!bg) return [];
const white = contrast(background, '#ffffff', ctx);
const black = contrast(background, '#000000', ctx);
const pick = (white.ratio || 0) >= (black.ratio || 0)
? { value: '#ffffff', label: 'white text', result: white }
: { value: '#000000', label: 'black text', result: black };
return [{
value: pick.value,
label: pick.label,
ratio: pick.result.ratio,
text: pick.result.text,
level: pick.result.level,
readable: !!pick.result.okLevel,
reason: ''
}];
}
