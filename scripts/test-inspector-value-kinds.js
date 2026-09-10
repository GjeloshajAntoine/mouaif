'use strict';

// Inspector value kinds — the type switch behind the edit sheet.
//
// The sheet lets the user switch how a value is written (Length <-> Number <->
// Percent <-> Keyword), and the switch has to be honest about cost: some forms
// are the same value, some discard information, and some cannot be derived at
// all without a base size. All of that is computed by
// frontend/src/components/inspector/valueKinds.js, so every rule is asserted
// here rather than through the UI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const source = strip(read('frontend/src/components/inspector/valueKinds.js'));
const stylesSource = read('frontend/src/components/inspector/StylesPanel.jsx');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const ctx = vm.createContext({});
vm.runInContext(source + '\n;globalThis.VK = { UNITS, KIND_LABEL, keywordsFor, classify, kindsFor, convert, alternatives, unitOptions, propertyFamily, formatNumber, percentBase };\n', ctx);
const VK = ctx.VK;

// A normal context: 16 px root, 18 px parent font (so em/rem conversions have a
// real base rather than a guess).
const CTX = { rootFontSize: 16, parentFontSize: 18, fontSize: 18 };

// ---- classification ----------------------------------------------------

check('the module loads', !!VK && typeof VK.classify === 'function');

const CASES = [
  ['padding', '14px', 'length', 14, 'px'],
  ['padding', '0.875rem', 'length', 0.875, 'rem'],
  ['padding', '50%', 'percent', 50, '%'],
  ['opacity', '0.5', 'number', 0.5, ''],
  ['opacity', '50%', 'percent', 50, '%'],
  ['z-index', '3', 'number', 3, ''],
  ['padding', '0', 'length', 0, 'px'],
  ['line-height', '0', 'number', 0, ''],
  ['width', '100vw', 'length', 100, 'vw'],
  ['transition-duration', '180ms', 'time', 180, 'ms'],
  ['transition-duration', '0.18s', 'time', 0.18, 's'],
  ['rotate', '12deg', 'angle', 12, 'deg'],
  ['transform', '0.5turn', 'angle', 0.5, 'turn'],
  ['color', '#1c2333', 'color', null, null],
  ['color', 'rgb(28, 35, 51)', 'color', null, null],
  ['background-color', 'transparent', 'color', null, null],
  ['color', 'currentcolor', 'color', null, null],
  ['display', 'flex', 'keyword', null, null],
  ['padding', 'inherit', 'keyword', null, null],
  ['--space-card', '14px', 'length', 14, 'px'],   // a token is typed by what it holds
  ['width', 'var(--w)', 'custom', null, null],
  ['width', 'calc(100% - 2px)', 'expression', null, null],
  ['background-image', 'url(hero.png)', 'unknown', null, null]
];
for (const [prop, value, kind, number, unit] of CASES) {
  const got = VK.classify(prop, value);
  check('classify ' + prop + ': ' + value + ' is ' + kind,
    got.kind === kind, got.kind);
  if (number !== null) {
    check('  … with its number', got.number === number, String(got.number));
  }
  if (unit !== null) {
    check('  … with its unit', got.unit === unit, String(got.unit));
  }
}

// The family classification, including the suffix heuristics CSS itself uses.
check('border-top-width is a length', VK.propertyFamily('border-top-width') === 'length');
check('background-color is a colour', VK.propertyFamily('background-color') === 'color');
check('transition-delay is a time', VK.propertyFamily('transition-delay') === 'time');
check('z-index is a number', VK.propertyFamily('z-index') === 'number');
check('a custom property is custom', VK.propertyFamily('--brand') === 'custom');
check('display has no numeric family', VK.propertyFamily('display') === 'keyword-only');
check('an unknown property is unknown', VK.propertyFamily('will-change') === 'unknown');

// ---- the kinds offered per property ------------------------------------

check('a padding offers length, percent, number, keyword',
  VK.kindsFor('padding').join(',') === 'length,percent,number,keyword', VK.kindsFor('padding').join(','));
check('an opacity offers number, percent, keyword',
  VK.kindsFor('opacity').join(',') === 'number,percent,keyword', VK.kindsFor('opacity').join(','));
check('a z-index has no percent form (a percentage is not a stacking order)',
  !VK.kindsFor('z-index').includes('percent'));
check('a colour offers colour and keyword', VK.kindsFor('color').join(',') === 'color,keyword');
check('a duration offers time and keyword', VK.kindsFor('transition-duration').join(',') === 'time,keyword');
check('a display offers only keyword', VK.kindsFor('display').join(',') === 'keyword');
check('the current kind is always among the offered kinds',
  VK.kindsFor('padding').includes(VK.classify('padding', '14px').kind));
// A custom property is typed by the value it holds: `--space-card: 14px` gets
// the length switch, which is what makes the control useful for design tokens.
check('a token holding a length gets the length switch',
  VK.kindsFor('--space-card', '14px').join(',') === 'length,keyword',
  VK.kindsFor('--space-card', '14px').join(','));
check('a token is classified by its literal, with the flag alongside',
  VK.classify('--space-card', '14px').kind === 'length'
  && VK.classify('--space-card', '14px').customProperty === true);
check('a token with no value offers only the raw form',
  VK.kindsFor('--space-card', '').join(',') === 'custom');
check('var() as a value is the custom kind', VK.classify('width', 'var(--w)').kind === 'custom');
check('a token switch offers its own kind and the keyword form',
  VK.alternatives('--space-card', '14px', CTX).map((a) => a.kind).join(',') === 'length,keyword');

// ---- conversions: the lossless ones ------------------------------------

// Unit cycling is a separate control from the kind switch: the kind switch
// changes what the value *is*, the unit control rewrites the same value in
// another unit of the same kind.
{
  const units = VK.unitOptions('padding', '16px', CTX);
  check('a length offers its units', units.map((u) => u.unit).join(',') === 'px,rem,em', units.map((u) => u.unit).join(','));
  const px = units.find((u) => u.unit === 'px');
  check('the current unit is flagged', px.current === true);
  const rem = units.find((u) => u.unit === 'rem');
  check('16px rewrites as 1rem with a 16px root', rem.ok && rem.value === '1rem', JSON.stringify(rem));
  check('the unit rewrite is lossless', rem.lossless === true);
  check('it names the base it used', /of 16px/.test(rem.note || ''), rem.note);
  const em = units.find((u) => u.unit === 'em');
  check('and as em with the parent font size', em.ok && em.value === '0.8889em', JSON.stringify(em));
  const noCtx = VK.unitOptions('padding', '16px', {}).find((u) => u.unit === 'rem');
  check('a unit that needs a base it does not have is refused with a reason',
    noCtx.ok === false && /base font size/.test(noCtx.reason), JSON.stringify(noCtx));
  const fromRem = VK.unitOptions('padding', '1rem', CTX).find((u) => u.unit === 'px');
  check('rem resolves back to px', fromRem.ok && fromRem.value === '16px', JSON.stringify(fromRem));
  check('a keyword has no unit cycle', VK.unitOptions('padding', 'inherit', CTX).length === 0);
  check('a colour has no unit cycle', VK.unitOptions('color', '#fff', CTX).length === 0);
  const times = VK.unitOptions('transition-duration', '180ms', CTX);
  check('a time offers ms and s', times.map((u) => u.unit).join(',') === 'ms,s');
  check('ms rewrites as s', times.find((u) => u.unit === 's').value === '0.18s');
  const angles = VK.unitOptions('rotate', '180deg', CTX);
  check('an angle offers deg, turn and rad',
    angles.map((u) => u.unit).join(',') === 'deg,turn,rad', angles.map((u) => u.unit).join(','));
  check('degrees rewrite as turns', angles.find((u) => u.unit === 'turn').value === '0.5turn');
}
{
  const r = VK.convert('opacity', '1', 'percent', CTX);
  check('opacity 1 -> 100% is offered', r.ok && r.value === '100%', JSON.stringify(r));
  check('opacity number -> percent is lossless', r.lossless === true);
  check('it says the value is the same', /same value/.test(r.note || ''), r.note);
  const back = VK.convert('opacity', '100%', 'number', CTX);
  check('and back again', back.ok && back.value === '1', JSON.stringify(back));
}
{
  const r = VK.convert('font-size', '50%', 'length', CTX);
  check('font-size 50% -> px uses the parent font size', r.ok && r.value === '9px', JSON.stringify(r));
  check('a percent -> length conversion is lossless', r.lossless === true);
  check('it names the base', /of 18px/.test(r.note || ''), r.note);
  const back = VK.convert('font-size', '9px', 'percent', CTX);
  check('font-size px -> percent round-trips', back.ok && back.value === '50%', JSON.stringify(back));
}
{
  // A same-kind request is a no-op: the kind did not change, so there is
  // nothing to convert (unit rewriting is unitOptions' job).
  const same = VK.convert('transition-duration', '180ms', 'time', CTX);
  check('a same-kind conversion is a no-op', same.ok === true && same.same === true && same.value === '180ms', JSON.stringify(same));
}

// ---- conversions that cannot be done honestly --------------------------

{
  // A percentage of padding is relative to the containing block's width, which
  // the inspector does not read: guessing 16px here would be inventing a number.
  const r = VK.convert('padding', '14px', 'percent', CTX);
  check('padding px -> % is refused rather than guessed', r.ok === false, JSON.stringify(r));
  check('and the refusal explains what is missing',
    /base size/.test(r.reason || ''), r.reason);
}
check('a z-index has no percent conversion to offer',
  VK.convert('z-index', '3', 'percent', CTX).ok === false);
check('a same-kind length conversion needs no context (it is a no-op)',
  VK.convert('padding', '1rem', 'length', {}).same === true);

// ---- conversions that discard, and say so ------------------------------

{
  const r = VK.convert('padding', '14', 'length', CTX);
  check('a bare number can be written as px', r.ok && r.value === '14px', JSON.stringify(r));
  check('but it is flagged as lossy (the unit changes the meaning)', r.lossless === false);
  check('and the discarded value is named', r.discarded === '14', r.discarded);
  check('the note explains what changed', /different meaning/.test(r.note || ''), r.note);
}
{
  const zero = VK.convert('padding', '0', 'number', CTX);
  check('zero needs no unit, so 0px -> 0 is lossless', zero.ok && zero.lossless === true, JSON.stringify(zero));
  check('and it says so', /needs no unit/.test(zero.note || ''), zero.note);
}
{
  const r = VK.convert('padding', '14px', 'keyword', CTX);
  check('switching to a keyword is offered', r.ok === true, JSON.stringify(r));
  check('a keyword switch is lossy', r.lossless === false);
  check('the discarded value is named', r.discarded === '14px', r.discarded);
  check('and it says the old value stays undoable', /undoable/.test(r.note || ''), r.note);
}
{
  const same = VK.convert('padding', '14px', 'length', CTX);
  const noop = VK.convert('padding', '14px', 'length', {});
  check('a same-kind conversion with no context still succeeds as a rewrite', same.ok === true);
  check('a conversion to the same kind is flagged', noop.same === true || noop.ok === true);
}

// ---- alternatives: what the switch renders -----------------------------

{
  const alts = VK.alternatives('opacity', '0.5', CTX);
  check('one entry per applicable kind', alts.length === VK.kindsFor('opacity').length, String(alts.length));
  check('the current kind is flagged',
    alts.filter((a) => a.isCurrent).length === 1 && alts.find((a) => a.isCurrent).kind === 'number');
  check('every entry is labelled', alts.every((a) => a.label && a.label.length > 1));
  const percent = alts.find((a) => a.kind === 'percent');
  check('the percent alternative carries the converted value', percent.value === '50%', percent.value);
  check('a lossless alternative is flagged lossless', percent.lossless === true);
  const keyword = alts.find((a) => a.kind === 'keyword');
  check('a lossy alternative is not flagged lossless', keyword.lossless === false);
  check('a lossy alternative names what it discards', keyword.discarded === '0.5', keyword.discarded);
}
{
  const alts = VK.alternatives('padding', '14px', CTX);
  const percent = alts.find((a) => a.kind === 'percent');
  check('an impossible alternative is marked, not hidden', percent.ok === false);
  check('and carries the reason', /base size/.test(percent.reason || ''), percent.reason);
  check('an impossible alternative has no value to apply', percent.value === '');
  const number = alts.find((a) => a.kind === 'number');
  check('a same-kind alternative is not duplicated as a conversion',
    alts.find((a) => a.kind === 'length').isCurrent === true);
  check('the number alternative is offered with its cost', number.ok === true && number.lossless === false);
}
{
  // An unknown value must not produce a switch that lies about it.
  const alts = VK.alternatives('background-image', 'url(a.png)', CTX);
  check('an unknown value yields the keyword form only (no invented conversions)',
    alts.every((a) => a.kind === 'keyword'), JSON.stringify(alts));
}

// ---- keywords ----------------------------------------------------------

check('a keyword list starts with the property own values',
  VK.keywordsFor('display')[0] === 'block' && VK.keywordsFor('display').includes('flex'));
check('the CSS-wide keywords are always appended',
  ['inherit', 'initial', 'unset', 'revert'].every((k) => VK.keywordsFor('display').includes(k)));
check('a property with no list still gets the CSS-wide keywords',
  VK.keywordsFor('will-change').join(',') === 'inherit,initial,unset,revert',
  VK.keywordsFor('will-change').join(','));
check('own keywords are not duplicated by the appended ones',
  VK.keywordsFor('padding').filter((k) => k === 'inherit').length === 1);

// ---- number formatting -------------------------------------------------

check('whole numbers print without a decimal', VK.formatNumber(16) === '16');
check('single decimals are kept', VK.formatNumber(0.875) === '0.875');
check('floating point noise is rounded away', VK.formatNumber(57.29577951308232) === '57.2958',
  VK.formatNumber(57.29577951308232));
check('a non-number prints as empty', VK.formatNumber(NaN) === '');

// ---- the sheet wiring --------------------------------------------------

check('the edit sheet offers a value-type switch',
  /alternatives\(/.test(stylesSource) && /valueKinds\.js/.test(stylesSource));
check('the sheet renders the switch as a segmented control',
  /inspector__kindseg/.test(stylesSource));
check('a lossy switch warns before it is tapped',
  /lossless|discarded/.test(stylesSource));
check('an impossible switch is disabled with its reason',
  /a\.reason/.test(stylesSource));
check('switching type does not write to the page (Apply still commits)',
  !/props\.onApply\([^)]*valueTypes|onApply\([^)]*kind/.test(stylesSource));
check('the switch keeps the property being edited',
  /props\.prop/.test(stylesSource));

// The base sizes must travel with a *pick*, not only with a post-edit read:
// without them the Percent and rem forms are blocked on a freshly selected
// element, which is exactly when the user wants to switch types.
{
  const eventsSource = read('frontend/src/components/inspector/events.js');
  const picks = eventsSource.match(/bases:\s*\{\s*root:\s*root,?\s*parent:\s*parent/g) || [];
  check('both style readers report the base font sizes', picks.length >= 2, String(picks.length));
  check('the pick model carries them', /model\.bases = v\.bases/.test(eventsSource));
  check('the parent font size falls back to the element font size',
    /if \(parent ?== null\) parent = parseFloat\(cs\.fontSize\) \|\| null;/.test(eventsSource)
    || /parent == null\) parent = parseFloat\(cs\.fontSize\)/.test(eventsSource));
  check('the panel hands the bases to the sheet as the unit context',
    /unitCtx: model\.bases \? \{ rootFontSize: model\.bases\.root, parentFontSize: model\.bases\.parent/.test(stylesSource));
  check('the sheet passes the context through to the model',
    /ctx: props\.unitCtx/.test(stylesSource));
  check('a post-edit read keeps the bases on the model',
    /bases: bases \|\| prev\.bases \|\| null/.test(stylesSource));
}

// ---- summary -----------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' value-kind assertion(s) failed');
