// Inspector value kinds — what kind of value is this, and how else can it be
// written?
//
// A CSS declaration's *type* is invisible in the panel: `14px`, `14`, `87.5%`,
// `0.875rem` and `auto` all look like "the value of padding". They behave
// differently (some are interchangeable, some discard information), so the
// edit sheet offers an explicit type switch and says what each switch costs.
//
// Everything here is pure: a property name, a value string and a small context
// in; a kind, a set of alternatives and a loss report out. No DOM, no CDP.
//
//   classify(property, value, ctx)        -> { kind, number, unit, keyword, ... }
//   kindsFor(property)                    -> ordered applicable kinds
//   alternatives(property, value, ctx)    -> one entry per kind, converted
//   convert(property, value, toKind, ctx) -> { ok, value, lossless, discarded, note }
//
// Loss is reported honestly:
//   * px <-> rem/em and px <-> % (for font-size) are lossless;
//   * number <-> percent is lossless only where both mean the same thing
//     (opacity: 1 === 100%). Elsewhere it is not a conversion at all;
//   * ms <-> s and deg <-> turn/rad are lossless;
//   * colour formats are lossless;
//   * switching to a keyword always discards the number, and says so.
//
// Nothing writes to the page: the sheet shows a converted string in the field
// and commits on Apply, so a type switch stays one undo entry on one property
// and never touches the element's other declarations.

// KEYWORD_SETS — the CSS-wide keywords every property accepts, plus the
// property-specific keywords worth offering. Kept small on purpose: the user
// can always type the value, and a chip that is wrong for the property is worse
// than no chip.
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert'];

const KEYWORD_SETS = {
  display: ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'none', 'contents'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'overflow-x': ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'overflow-y': ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'align-items': ['stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  'align-self': ['auto', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  'justify-content': ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  'justify-items': ['start', 'end', 'center', 'stretch'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  'box-sizing': ['content-box', 'border-box'],
  'font-style': ['normal', 'italic', 'oblique'],
  'font-weight': ['normal', 'bold', 'lighter', 'bolder'],
  'text-decoration': ['none', 'underline', 'line-through', 'overline'],
  'border-style': ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'],
  'list-style-type': ['none', 'disc', 'circle', 'square', 'decimal'],
  'pointer-events': ['auto', 'none'],
  'visibility': ['visible', 'hidden', 'collapse'],
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
  'background-repeat': ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'],
  'background-size': ['auto', 'cover', 'contain'],
  'cursor': ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'not-allowed', 'wait', 'help'],
  'mix-blend-mode': ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'],
  // Numeric properties that also take a keyword, so the switch offers it.
  'opacity': ['initial', 'inherit', 'unset'],
  'line-height': ['normal', 'inherit', 'initial', 'unset'],
  'width': ['auto', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'height': ['auto', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'max-width': ['none', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'max-height': ['none', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'min-width': ['auto', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'min-height': ['auto', 'fit-content', 'max-content', 'min-content', 'inherit'],
  'z-index': ['auto', 'inherit', 'initial', 'unset'],
  'flex': ['none', 'auto', 'initial'],
  'transform': ['none'],
  'transition': ['none'],
  /* Easing: the mock's "easing presets for timing-function". These are the
     property's whole choice set, and they are worth segments rather than a
     typed field because `cubic-bezier(...)` is not something anyone types on a
     phone — and because the page's own usage is ranked first by enumValues. */
  'transition-timing-function': ['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'],
  'animation-timing-function': ['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'],
  'transition-duration': ['inherit', 'initial', 'unset'],
  'animation-duration': ['inherit', 'initial', 'unset'],
  'border-radius': ['inherit', 'initial', 'unset'],
  'padding': ['inherit', 'initial', 'unset'],
  'margin': ['auto', 'inherit', 'initial', 'unset']
};

// UNITS — recognised numeric units, grouped by the dimension they measure.
// `length-abs` and `length-rel` are both lengths; the split only decides which
// conversions need a context size.
export const UNITS = {
  px: 'length-abs',
  pt: 'length-abs',
  pc: 'length-abs',
  cm: 'length-abs',
  mm: 'length-abs',
  in: 'length-abs',
  q: 'length-abs',
  rem: 'length-rel',
  em: 'length-rel',
  '%': 'percent',
  vh: 'view',
  vw: 'view',
  vmin: 'view',
  vmax: 'view',
  ch: 'length-rel',
  ex: 'length-rel',
  ms: 'time',
  s: 'time',
  deg: 'angle',
  rad: 'angle',
  turn: 'angle',
  grad: 'angle'
};

// NUMBER_PERCENT_EQUIVALENT — properties where a bare number and a percentage
// mean the same thing, so the conversion is lossless. `opacity: 1` and
// `opacity: 100%` are identical; `flex-grow: 1` and `flex-grow: 100%` are not.
const NUMBER_PERCENT_EQUIVALENT = new Set(['opacity', 'fill-opacity', 'stroke-opacity']);

// LENGTH_PROPERTIES — properties whose value is a length (or a list of them).
// Used when a property is not in KEYWORD_SETS and the suffix heuristics cannot
// classify it.
const LENGTH_PROPERTIES = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'top', 'right', 'bottom', 'left', 'padding', 'margin', 'gap', 'row-gap', 'column-gap',
  'font-size', 'letter-spacing', 'word-spacing', 'text-indent', 'vertical-align',
  'border-radius', 'border-width', 'outline-width', 'outline-offset',
  'inset', 'block-size', 'inline-size', 'flex-basis'
]);

// NUMBER_PROPERTIES — property names that take a unitless number.
const NUMBER_PROPERTIES = new Set([
  'opacity', 'z-index', 'line-height', 'flex-grow', 'flex-shrink', 'order',
  'font-weight', 'widows', 'orphans', 'tab-size', 'scale', 'aspect-ratio'
]);

// PERCENT_PROPERTIES — properties where a percentage is a first-class form.
// font-size is the one whose base (the parent's font size) is knowable, which
// is what makes px <-> % convertible here and nowhere else.
const PERCENT_PROPERTIES = new Set([
  'font-size', 'line-height', 'opacity', 'width', 'height', 'max-width', 'max-height',
  'min-width', 'min-height', 'padding', 'margin', 'top', 'right', 'bottom', 'left',
  'flex-basis', 'letter-spacing', 'text-indent'
]);

// KIND_LABEL — what the switch calls each kind.
export const KIND_LABEL = {
  length: 'Length',
  number: 'Number',
  percent: 'Percent',
  keyword: 'Keyword',
  color: 'Colour',
  time: 'Time',
  angle: 'Angle',
  custom: 'Custom',
  expression: 'Expression',
  unknown: 'Text'
};

const NUMERIC_RE = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color\(|color-mix\(|currentcolor$|transparent$|(?:[a-z]+)$)/i;
const NAMED_COLORS = new Set([
  'black', 'silver', 'gray', 'grey', 'white', 'maroon', 'red', 'purple', 'fuchsia',
  'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua', 'orange',
  'pink', 'brown', 'gold', 'cyan', 'magenta', 'violet', 'indigo', 'transparent',
  'currentcolor'
]);

// isLengthProperty / isNumberProperty — property classification, with the
// suffix heuristics CSS itself suggests (`border-*-width`, `*-color`,
// `*-duration`, `*-delay`). `_all` style logical shorthand lists (`padding`,
// `margin`) are covered by the explicit sets above.
export function propertyFamily(property) {
  const prop = String(property || '').trim().toLowerCase();
  if (!prop) return 'unknown';
  if (prop === 'color' || prop.endsWith('-color') || prop === 'background') return 'color';
  if (prop.endsWith('-duration') || prop.endsWith('-delay')
    || prop === 'transition-duration' || prop === 'animation-duration') return 'time';
  if (prop.startsWith('rotate') || prop.endsWith('-angle') || prop.startsWith('hue-rotate')
    || prop === 'rotate' || prop === 'transform') return 'angle-or-transform';
  if (prop.startsWith('--')) return 'custom';
  if (NUMBER_PROPERTIES.has(prop)) return 'number';
  if (LENGTH_PROPERTIES.has(prop) || prop.endsWith('-width') || prop.endsWith('-size')) return 'length';
  if (KEYWORD_SETS[prop]) return 'keyword-only';
  return 'unknown';
}

// classify — what kind of value is this?
//
// Note the custom-property case: `--space-card: 14px` is classified by its
// *literal* (a length), with `customProperty: true` alongside, because that is
// how a custom property behaves — it is typed by the value it holds, which is
// what lets the sheet offer a length switch for it. Only `var(...)` *as a
// value* is the `custom` kind.
export function classify(property, value) {
  const prop = String(property || '').trim().toLowerCase();
  const customProperty = prop.startsWith('--');
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { kind: 'unknown', raw, customProperty };
  const lower = raw.toLowerCase();

  if (/^var\(/i.test(lower)) return { kind: 'custom', raw, customProperty, keyword: raw };
  if (/^(calc|min|max|clamp)\(/i.test(lower)) return { kind: 'expression', raw, customProperty };
  if (lower.startsWith('url(') || lower.startsWith('linear-gradient(') || lower.startsWith('radial-gradient(')) {
    return { kind: 'unknown', raw, customProperty };
  }

  // Colour: a hex literal, a functional notation, or a named colour / keyword
  // the property family says is a colour (`currentcolor`, `transparent`).
  const family = propertyFamily(prop);
  if (family === 'color' && (COLOR_RE.test(lower) || NAMED_COLORS.has(lower))) {
    return { kind: 'color', raw, customProperty, keyword: NAMED_COLORS.has(lower) ? lower : undefined };
  }
  if (/^#[0-9a-f]{3,8}$/i.test(lower)) return { kind: 'color', raw, customProperty };
  if (/^(rgba?|hsla?)\(/i.test(lower)) return { kind: 'color', raw, customProperty };

  const m = NUMERIC_RE.exec(raw);
  if (m) {
    const number = Number(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (!unit) {
      // A bare number: a number for a number property, but also the `0` every
      // length property accepts, which is a length.
      const isZero = number === 0;
      const kind = (family === 'length' && isZero) ? 'length' : 'number';
      return { kind, raw, number, customProperty, unit: isZero && family === 'length' ? 'px' : '' };
    }
    const dimension = UNITS[unit];
    if (dimension === 'percent') return { kind: 'percent', raw, number, unit: '%', customProperty };
    if (dimension === 'time') return { kind: 'time', raw, number, unit, customProperty };
    if (dimension === 'angle') return { kind: 'angle', raw, number, unit, customProperty };
    if (dimension === 'length-abs' || dimension === 'length-rel' || dimension === 'view') {
      return { kind: 'length', raw, number, unit, customProperty, relative: dimension === 'length-rel' };
    }
    return { kind: 'unknown', raw, number, unit, customProperty };
  }

  // A keyword: comma- or space-separated identifiers. `none`, `auto`, `flex`,
  // `inherit` all land here.
  if (/^[a-z-]+(\s+[a-z-]+)*$/i.test(lower)) return { kind: 'keyword', raw, keyword: lower, customProperty };
  return { kind: 'unknown', raw, customProperty };
}

// kindsFor — the ordered kinds the switch offers for this property. The
// current kind is flagged by `alternatives`, so this is a stable,
// property-driven list.
//
// `value` is optional and only matters for custom properties: `--space-card`
// holds whatever it holds, so its switch follows its literal's kind (a custom
// property holding `14px` gets the length switch), which is what makes the
// type control useful for design tokens.
export function kindsFor(property, value) {
  const prop = String(property || '').trim().toLowerCase();
  if (prop.startsWith('--')) {
    const held = classify(prop, value);
    // No value yet, or a value we cannot type: offer the raw form only.
    if (!value || held.kind === 'custom' || held.kind === 'unknown' || held.kind === 'expression') {
      return ['custom'];
    }
    // A token holding a length behaves as a length, so the switch is the same
    // one that property would get.
    return [held.kind, 'keyword'];
  }
  const family = propertyFamily(prop);
  const kinds = [];
  const add = (k) => { if (!kinds.includes(k)) kinds.push(k); };

  if (family === 'color') { add('color'); add('keyword'); return kinds; }
  if (family === 'time') { add('time'); add('keyword'); return kinds; }
  if (family === 'custom') return ['custom'];
  if (family === 'length') {
    add('length');
    if (PERCENT_PROPERTIES.has(prop)) add('percent');
    add('number');            // `0` is a valid length; other numbers are flagged as lossy
    add('keyword');
    return kinds;
  }
  if (family === 'number') {
    add('number');
    if (NUMBER_PERCENT_EQUIVALENT.has(prop)) add('percent');
    add('keyword');
    return kinds;
  }
  if (family === 'angle-or-transform') { add('angle'); add('length'); add('keyword'); return kinds; }
  // Keyword-only and unknown properties still get the typed field, and unknown
  // values are handled by the caller as text.
  add('keyword');
  return kinds;
}

// unitOf — the unit implied by a kind + context for a conversion target.
function absPx(value, unit, ctx) {
  const c = ctx || {};
  if (unit === 'px') return value;
  if (unit === 'pt') return value * (96 / 72);
  if (unit === 'pc') return value * 16;
  if (unit === 'in') return value * 96;
  if (unit === 'cm') return value * (96 / 2.54);
  if (unit === 'mm') return value * (96 / 25.4);
  if (unit === 'q') return value * (96 / 101.6);
  if (unit === 'rem') return c.rootFontSize ? value * c.rootFontSize : null;
  if (unit === 'em') return c.parentFontSize || c.fontSize ? value * (c.parentFontSize || c.fontSize) : null;
  if (unit === 'ch') return c.fontSize ? value * c.fontSize * 0.5 : null;
  if (unit === 'ex') return c.fontSize ? value * c.fontSize * 0.5 : null;
  return null;
}

// formatNumber — a value a human would type: no trailing zeros, no `14.0`.
export function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 1e4) / 1e4;
  return String(rounded);
}

// percentBase — the pixel size a percentage resolves against, for the one
// property whose base is knowable from what the panel already reads. `null`
// means "no honest conversion", and the switch then offers the percentage as a
// form the user can edit rather than pretending to compute it.
export function percentBase(property, ctx) {
  const prop = String(property || '').trim().toLowerCase();
  const c = ctx || {};
  if (prop === 'font-size' || prop === 'line-height') {
    const base = c.parentFontSize || c.fontSize;
    return base ? base : null;
  }
  return null;
}

// UNIT_ORDER — the units the unit chip cycles within one kind. Absolute first
// for lengths (a px value is the least surprising target), then the relative
// ones the context can resolve.
const UNIT_ORDER = {
  length: ['px', 'rem', 'em'],
  time: ['ms', 's'],
  angle: ['deg', 'turn', 'rad']
};

// unitOptions — the unit cycle for the current value, for the unit control that
// sits beside the type switch.
//
// This is deliberately a *separate* control from the kind switch: the kind
// switch changes what the value *is* (a length, a number, a percentage), while
// this rewrites the same value in another unit of the same kind — 16px and 1rem
// are the same length. Entries that need a base size the inspector does not
// have come back `ok: false` with the reason, so the control can show the unit
// and disable it rather than inventing a number.
export function unitOptions(property, value, ctx) {
  const from = classify(property, value);
  const order = UNIT_ORDER[from.kind];
  if (!order || from.number == null) return [];
  const c = ctx || {};
  return order.map((unit) => {
    if (unit === from.unit) {
      return { unit, value: from.raw, current: true, ok: true, lossless: true };
    }
    if (from.kind === 'length') {
      // Only a length has to be resolved to pixels first; the length-based
      // units (rem/em) then need their own base size.
      const px = absPx(from.number, from.unit, c);
      if (px == null) {
        return { unit, ok: false, value: '', reason: 'needs a base font size the inspector has not read' };
      }
      if (unit === 'px') return { unit, ok: true, value: formatNumber(px) + 'px', lossless: true };
      const base = unit === 'rem' ? c.rootFontSize : (c.parentFontSize || c.fontSize);
      if (!base) return { unit, ok: false, value: '', reason: 'needs the ' + unit + ' base font size' };
      return { unit, ok: true, value: formatNumber(px / base) + unit, lossless: true, note: 'of ' + formatNumber(base) + 'px' };
    }
    if (from.kind === 'time') {
      return unit === 's'
        ? { unit, ok: true, value: formatNumber(from.number / 1000) + 's', lossless: true }
        : { unit, ok: true, value: formatNumber(from.number * 1000) + 'ms', lossless: true };
    }
    if (from.kind === 'angle') {
      const deg = from.unit === 'turn' ? from.number * 360
        : from.unit === 'rad' ? from.number * (180 / Math.PI)
          : from.number;
      if (unit === 'deg') return { unit, ok: true, value: formatNumber(deg) + 'deg', lossless: true };
      if (unit === 'turn') return { unit, ok: true, value: formatNumber(deg / 360) + 'turn', lossless: true };
      return { unit, ok: true, value: formatNumber(deg * (Math.PI / 180)) + 'rad', lossless: true };
    }
    return { unit, ok: false, value: '', reason: 'unsupported unit change' };
  });
}

// convert — rewrite `value` in the `toKind` form.
//
// Returns `{ ok: false, reason }` when the target form is not derivable (no
// known base size, incompatible kinds), so the caller can disable the chip with
// a reason instead of guessing a number. A successful result always carries
// `lossless`; when it is false the `note` says what is being discarded, because
// the user is about to replace a value they may not have meant to lose.
//
// A same-kind request is a no-op here on purpose: rewriting 16px as 1rem is the
// unit control's job (`unitOptions`), not a change of kind.
export function convert(property, value, toKind, ctx) {
  const prop = String(property || '').trim().toLowerCase();
  const from = classify(prop, value);
  const target = String(toKind || '');
  if (!target) return { ok: false, reason: 'no target type' };
  if (from.kind === target) return { ok: true, value: from.raw, lossless: true, same: true, toKind: target };

  // Keywords accept anything as text, so any -> keyword "works" but discards.
  if (target === 'keyword') {
    const keyword = KEYWORD_SETS[prop] ? KEYWORD_SETS[prop][0] : 'inherit';
    return {
      ok: true,
      value: keyword,
      lossless: false,
      toKind: 'keyword',
      discarded: from.raw,
      note: 'discards ' + from.raw + ' — the old value stays undoable'
    };
  }

  if (target === 'length' && (from.kind === 'number' || from.kind === 'percent')) {
    if (from.kind === 'number') {
      // `14` -> `14px` is not a conversion: the two mean different things for
      // every property except the zero length.
      if (from.number === 0) return { ok: true, value: '0px', lossless: true, toKind: 'length', note: '0 needs no unit' };
      return {
        ok: true,
        value: from.raw + 'px',
        lossless: false,
        toKind: 'length',
        discarded: from.raw,
        note: from.raw + ' becomes ' + from.raw + 'px — the same digits, a different meaning; still undoable'
      };
    }
    const base = percentBase(prop, ctx);
    if (base == null) return { ok: false, reason: 'a percentage of ' + prop + ' needs a base size the inspector does not read' };
    const px = (from.number / 100) * base;
    return { ok: true, value: formatNumber(px) + 'px', lossless: true, toKind: 'length', note: 'of ' + formatNumber(base) + 'px' };
  }

  if (target === 'percent' && (from.kind === 'length' || from.kind === 'number')) {
    if (from.kind === 'number') {
      if (!NUMBER_PERCENT_EQUIVALENT.has(prop)) {
        return { ok: false, reason: 'a bare number and a percentage mean different things for ' + prop };
      }
      return { ok: true, value: formatNumber(from.number * 100) + '%', lossless: true, toKind: 'percent', note: 'the same value for ' + prop };
    }
    const base = percentBase(prop, ctx);
    if (base == null) return { ok: false, reason: 'a percentage of ' + prop + ' needs a base size the inspector does not read' };
    const px = absPx(from.number, from.unit, ctx);
    if (px == null) return { ok: false, reason: 'cannot resolve ' + from.raw + ' to pixels (no base font size)' };
    return { ok: true, value: formatNumber((px / base) * 100) + '%', lossless: true, toKind: 'percent', note: 'of ' + formatNumber(base) + 'px' };
  }

  if (target === 'number' && from.kind === 'percent') {
    if (!NUMBER_PERCENT_EQUIVALENT.has(prop)) {
      return { ok: false, reason: 'a percentage and a bare number mean different things for ' + prop };
    }
    return { ok: true, value: formatNumber(from.number / 100), lossless: true, toKind: 'number', note: 'the same value for ' + prop };
  }
  if (target === 'number' && from.kind === 'length') {
    if (from.number === 0) return { ok: true, value: '0', lossless: true, toKind: 'number', note: '0 needs no unit' };
    return {
      ok: true,
      value: formatNumber(from.number),
      lossless: false,
      toKind: 'number',
      discarded: from.raw,
      note: from.raw + ' becomes ' + formatNumber(from.number) + ' — the unit is dropped; still undoable'
    };
  }

  // length -> length: a unit rewrite, lossless whenever the context size the
  // source unit needs is known.
  if (target === 'length' && from.kind === 'length') {
    const px = absPx(from.number, from.unit, ctx);
    if (px == null) return { ok: false, reason: 'cannot resolve ' + from.raw + ' without a base font size' };
    const c = ctx || {};
    if (c.rootFontSize) {
      return { ok: true, value: formatNumber(px / c.rootFontSize) + 'rem', lossless: true, toKind: 'length', note: 'of ' + formatNumber(c.rootFontSize) + 'px root' };
    }
    return { ok: true, value: formatNumber(px) + 'px', lossless: true, toKind: 'length' };
  }

  if (target === 'time') {
    if (from.kind !== 'time' && from.kind !== 'number') return { ok: false, reason: 'not a time value' };
    const ms = from.unit === 's' ? from.number * 1000 : from.number;
    return { ok: true, value: from.unit === 's' ? formatNumber(ms / 1000) + 's' : formatNumber(ms) + 'ms', lossless: true, toKind: 'time' };
  }

  if (target === 'angle') {
    if (from.kind !== 'angle' && from.kind !== 'number') return { ok: false, reason: 'not an angle value' };
    const deg = from.unit === 'turn' ? from.number * 360
      : from.unit === 'rad' ? from.number * (180 / Math.PI)
        : from.unit === 'grad' ? from.number * 0.9
          : from.number;
    return { ok: true, value: formatNumber(deg) + 'deg', lossless: true, toKind: 'angle' };
  }

  if (target === 'color') {
    if (from.kind !== 'color') return { ok: false, reason: 'not a colour value' };
    return { ok: true, value: from.raw, lossless: true, toKind: 'color' };
  }

  if (target === 'custom') {
    if (from.kind === 'custom') return { ok: true, value: from.raw, lossless: true, same: true, toKind: 'custom' };
    return { ok: false, reason: 'a custom property form needs a variable to point at' };
  }

  return { ok: false, reason: 'no conversion from ' + from.kind + ' to ' + target };
}

// alternatives — one entry per applicable kind, ready for the type switch: the
// current kind is flagged, and every other entry carries either the converted
// value or the reason it cannot be produced.
export function alternatives(property, value, ctx) {
  const prop = String(property || '').trim();
  const current = classify(prop, value);
  // A custom property's switch follows the value it holds (see kindsFor).
  const kinds = prop.startsWith('--') ? kindsFor(prop, value)
    : kindsFor(prop);
  return kinds.map((kind) => {
    if (kind === current.kind) {
      return { kind, label: KIND_LABEL[kind] || kind, value: current.raw, isCurrent: true, ok: true, lossless: true };
    }
    const result = convert(prop, value, kind, ctx);
    return {
      kind,
      label: KIND_LABEL[kind] || kind,
      isCurrent: false,
      ok: result.ok,
      value: result.ok ? result.value : '',
      lossless: !!(result.ok && result.lossless),
      discarded: result.discarded || '',
      note: result.note || '',
      reason: result.ok ? '' : result.reason
    };
  });
}

// keywordsFor — the keyword chips for a property, with the CSS-wide keywords
// appended so `inherit` and `initial` are always reachable.
export function keywordsFor(property) {
  const prop = String(property || '').trim().toLowerCase();
  const own = KEYWORD_SETS[prop] || [];
  const out = own.slice();
  for (const k of CSS_WIDE) if (!out.includes(k)) out.push(k);
  return out;
}
