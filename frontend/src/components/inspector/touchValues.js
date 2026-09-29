// Touch editing beyond the short catalogue of Style controls. Pure, no DOM.
// Choosing a unit changes the declaration; converting a unit preserves its
// meaning only when the required basis is known. Never conflate those actions.
import { propertyFamily, keywordsFor, unitOptions, formatNumber } from './valueKinds.js';

const LENGTH_UNITS = ['px', 'rem', 'em', '%', 'vw', 'vh', 'dvw', 'dvh', 'svw', 'svh', 'lvw', 'lvh', 'ch', 'ex', 'vmin', 'vmax', 'pt', 'cm', 'mm', 'in', 'pc', 'q'];
const DIMENSIONS = { ms: 'time', s: 'time', deg: 'angle', rad: 'angle', turn: 'angle', grad: 'angle', '%': 'percent', fr: 'track' };
const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;
export function scalarValue(value) {
  const raw = String(value == null ? '' : value).trim();
  const match = NUMBER.exec(raw);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  if (unit && !LENGTH_UNITS.includes(unit) && !DIMENSIONS[unit]) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return { raw, number, unit, kind: DIMENSIONS[unit] || (unit ? 'length' : 'number') };
}

function unitsFor(prop, value) {
  const parsed = scalarValue(value);
  const raw = String(value || '').trim();
  // A whole expression or shorthand is not a scalar unit change. Its numbers
  // get their own pickers; never replace the entire expression with zero.
  if (!parsed && raw && !/^[a-z-]+$/i.test(raw)) return [];
  const family = propertyFamily(prop);
  const kind = parsed ? parsed.kind : family;
  if (kind === 'time') return ['ms', 's'];
  if (kind === 'angle') return ['deg', 'turn', 'rad', 'grad'];
  if (kind === 'track') return ['fr', ...LENGTH_UNITS];
  if (prop === 'line-height') return ['', ...LENGTH_UNITS];
  if (kind === 'length' || family === 'length') return LENGTH_UNITS;
  if (!parsed && family === 'angle-or-transform') return ['deg', 'turn', 'rad', 'grad'];
  if (kind === 'percent') return family === 'number' ? ['', '%'] : LENGTH_UNITS;
  if (kind === 'number') return ['opacity', 'fill-opacity', 'stroke-opacity'].includes(prop) ? ['', '%'] : [''];
  return [];
}

// Only exact, measured conversions. ch/ex depend on actual glyph metrics, not
// half a font size; viewport/percentage bases are not assumed here either.
function conversion(prop, parsed, unit, ctx) {
  if (unit === parsed.unit) return { ok: true, value: parsed.raw };
  if (parsed.kind === 'time') {
    const ms = parsed.number * (parsed.unit === 's' ? 1000 : 1);
    return { ok: true, value: formatNumber(unit === 's' ? ms / 1000 : ms) + unit };
  }
  if (parsed.kind === 'angle') {
    const deg = parsed.number * ({ deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[parsed.unit]);
    return { ok: true, value: formatNumber(deg / ({ deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[unit])) + unit };
  }
  if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(prop) && ['', '%'].includes(parsed.unit)) {
    return { ok: true, value: formatNumber(unit === '%' ? parsed.number * 100 : parsed.number / 100) + unit };
  }
  if (['ch', 'ex'].includes(parsed.unit)) return { ok: false, reason: 'Needs measured glyph metrics; use Choose unit to change the value instead.' };
  const options = unitOptions(prop, parsed.raw, ctx);
  const exact = options.find((o) => o.unit === unit);
  if (exact && exact.ok) return exact;
  return { ok: false, reason: (exact && exact.reason) || 'No measured basis for this conversion; use Choose unit to change the value instead.' };
}

export function touchUnitOptions(prop, value, ctx = {}, mode = 'choose') {
  const parsed = scalarValue(value);
  return unitsFor(prop, value).map((unit) => {
    const current = !!parsed && parsed.unit === unit;
    if (mode === 'convert') {
      const out = parsed ? conversion(prop, parsed, unit, ctx) : { ok: false, reason: 'Choose a numeric value first.' };
      return { unit, label: unit || 'number', current, ...out };
    }
    return { unit, label: unit || 'number', current, ok: true,
      value: formatNumber(parsed ? parsed.number : 0) + unit,
      note: parsed ? 'Keeps the number, changes its meaning — not a conversion.' : 'Starts a new numeric value at zero; nothing is applied yet.' };
  });
}

const PRESETS = {
  display: ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'none', 'contents', 'flow-root', 'list-item', 'table'],
  'align-content': ['normal', 'start', 'end', 'center', 'stretch', 'space-between', 'space-around', 'space-evenly'],
  'justify-self': ['auto', 'normal', 'start', 'end', 'center', 'stretch'],
  'place-items': ['center', 'stretch', 'start', 'end'],
  'grid-template-columns': ['none', '1fr', '1fr 1fr', 'repeat(3, 1fr)', 'repeat(auto-fit, minmax(12rem, 1fr))'],
  'grid-template-rows': ['none', 'auto', '1fr 1fr', 'repeat(3, auto)'],
  'grid-auto-flow': ['row', 'column', 'row dense', 'column dense'],
  'grid-auto-columns': ['auto', '1fr', 'min-content', 'max-content'],
  'grid-auto-rows': ['auto', '1fr', 'min-content', 'max-content'],
  'grid-column': ['auto', 'span 2', '1 / -1'],
  'grid-row': ['auto', 'span 2', '1 / -1'],
  'aspect-ratio': ['auto', '1 / 1', '4 / 3', '16 / 9'],
  'font-family': ['system-ui, sans-serif', 'sans-serif', 'serif', 'monospace'],
  'font-weight': ['400', '500', '600', '700', '900'],
  'font-size': ['12px', '16px', '20px', '24px', '1rem', '1.5rem'],
  'line-height': ['normal', '1', '1.2', '1.5', '2', '100%', '150%'],
  'letter-spacing': ['normal', '0px', '0.05em', '0.1em'],
  'word-break': ['normal', 'break-all', 'keep-all', 'break-word'],
  'overflow-wrap': ['normal', 'break-word', 'anywhere'],
  'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'text-overflow': ['clip', 'ellipsis'],
  'text-decoration-line': ['none', 'underline', 'overline', 'line-through'],
  'text-decoration-style': ['solid', 'double', 'dotted', 'dashed', 'wavy'],
  'border-collapse': ['collapse', 'separate'],
  'border': ['none', '1px solid currentColor', '2px dashed currentColor'],
  'outline': ['none', '2px solid currentColor'],
  'box-shadow': ['none', '0px 2px 8px rgba(0, 0, 0, 0.2)', '0px 8px 24px rgba(0, 0, 0, 0.3)', 'inset 0px 1px 4px rgba(0, 0, 0, 0.2)'],
  'text-shadow': ['none', '0px 1px 2px rgba(0, 0, 0, 0.3)'],
  transform: ['none', 'translateX(0px)', 'translateY(0px)', 'scale(1)', 'rotate(0deg)'],
  filter: ['none', 'blur(0px)', 'brightness(1)', 'contrast(1)', 'grayscale(0)', 'hue-rotate(0deg)'],
  'backdrop-filter': ['none', 'blur(4px)', 'blur(12px)'],
  transition: ['none', 'all 200ms ease', 'opacity 200ms ease', 'transform 200ms ease'],
  'transition-property': ['none', 'all', 'opacity', 'transform', 'color', 'background-color'],
  'background-image': ['none', 'linear-gradient(rgb(255, 255, 255), rgb(0, 0, 0))', 'linear-gradient(90deg, rgb(110, 168, 254), rgb(185, 212, 255))'],
  'background-size': ['auto', 'cover', 'contain', '100% 100%'],
  'background-position': ['center', 'top', 'bottom', 'left', 'right', '50% 50%'],
  'background-attachment': ['scroll', 'fixed', 'local'],
  'object-position': ['center', 'top', 'bottom', 'left', 'right', '50% 50%'],
  'scroll-behavior': ['auto', 'smooth'],
  'scroll-snap-type': ['none', 'x mandatory', 'y mandatory', 'x proximity', 'y proximity'],
  'scroll-snap-align': ['none', 'start', 'center', 'end'],
  'touch-action': ['auto', 'none', 'pan-x', 'pan-y', 'manipulation'],
  'user-select': ['auto', 'none', 'text', 'all'],
  'animation-play-state': ['running', 'paused'],
  'animation-direction': ['normal', 'reverse', 'alternate', 'alternate-reverse'],
  'animation-fill-mode': ['none', 'forwards', 'backwards', 'both'],
  'animation-iteration-count': ['1', '2', 'infinite'],
  'content': ['none', 'normal', '""'],
  'flex': ['none', 'auto', '1', '1 1 0%', '0 1 auto'],
  'vertical-align': ['baseline', 'middle', 'top', 'bottom', 'sub', 'super']
};

export function valuePresets(prop, supports) {
  const family = propertyFamily(prop);
  const defaults = family === 'length' ? ['0px', '4px', '8px', '16px', '24px', '1rem', 'auto', '100%']
    : family === 'number' ? ['0', '1', '2', '0.5']
    : family === 'time' ? ['0ms', '100ms', '200ms', '500ms', '1s']
    : family === 'color' ? ['transparent', 'currentColor', '#000000', '#ffffff'] : [];
  const values = [...new Set([...(PRESETS[prop] || defaults), ...keywordsFor(prop)])];
  return values.filter((value) => {
    if (!supports || prop.startsWith('--')) return true;
    try { return supports(prop, value); } catch { return false; }
  });
}

// Numeric components of an otherwise unparsed value. Keep exact source spans;
// replacing one token cannot rewrite its neighbours, punctuation or functions.
// Strings, URLs, variables (including fallbacks), and colour functions are
// opaque. Never mistake a hex colour, identifier or URL digit for a dimension.
export function numericParts(value) {
  const src = String(value == null ? '' : value);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i++] === quote) break; }
      continue;
    }
    if (src.startsWith('/*', i)) { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    const fn = /^([a-z][a-z0-9-]*)\(/i.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      if (/^(url|var|env|rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)$/i.test(fn[1])) {
        let depth = 1;
        let quote = '';
        while (i < src.length && depth) {
          const c = src[i++];
          if (c === '\\') { i++; continue; }
          if (quote) { if (c === quote) quote = ''; continue; }
          if (c === '"' || c === "'") { quote = c; continue; }
          if (c === '(') depth++; else if (c === ')') depth--;
        }
      }
      continue;
    }
    const before = src[i - 1] || '';
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?/i.exec(src.slice(i));
    if (match && !/[\w#.-]/.test(before)) {
      const raw = match[0];
      const end = i + raw.length;
      const parsed = scalarValue(raw);
      if (parsed && !/[\w.(]/.test(src[end] || '')) out.push({ start: i, end, ...parsed });
      i = end;
    } else i++;
  }
  return out.slice(0, 16);
}

export function replaceNumericPart(value, part, next) {
  const src = String(value == null ? '' : value);
  if (!part || src.slice(part.start, part.end) !== part.raw || !scalarValue(next)) return src;
  return src.slice(0, part.start) + next + src.slice(part.end);
}
