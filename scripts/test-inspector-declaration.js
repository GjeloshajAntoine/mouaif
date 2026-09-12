'use strict';
// Inspector style-declaration validation.
//
// `element.style.setProperty()` does not throw on a declaration the CSSOM does
// not understand — it silently discards it. Before declaration.js the panel
// reported that write as a success, merged the value into its own list,
// recorded a receipt entry, and then the post-write re-read came back without
// the property: the row appeared and vanished, and the user was offered an Undo
// for a change that never happened. This test pins the two levels of the fix —
// the pure pre-write check, and the post-write read-back that owns the browser's
// real verdict.
//
// No Chrome and no DOM required: the capability predicate is injected, so the
// rules are exercised directly, and the in-page write function is extracted from
// events.js and run against a stubbed CSSOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8');

// The real thing said about values the browser actually accepts and rejects,
// captured from Chrome: `CSS.supports(prop, value)`.
const SUPPORTS = new Set([
  'color|red', 'color|#fff', 'color|rgb(1, 2, 3)', 'color|var(--brand)', 'color|inherit',
  'padding|30px', 'padding|30px 12px', 'padding|var(--gap)',
  'display|flex', 'display|none', 'display|grid',
  'width|calc(100% - 1rem)', 'width|10ch', 'width|auto', 'width|100%',
  'opacity|0.5', 'opacity|1',
  'margin|0 auto', 'margin|10px',
  'background|linear-gradient(red, blue)', 'background-color|#0af', 'background-color|#fff',
  'font|italic bold 12px/1.4 system-ui', 'font-size|12px', 'font-size|1.2rem',
  'grid-area|1 / 2 / 3 / 4', 'transition|opacity 200ms ease',
  'border|1px solid red', 'z-index|10', 'transform|translateX(2px)'
]);
const supports = (p, v) => SUPPORTS.has(p + '|' + v);

async function main() {
  const source = src('declaration.js');
  const mod = {};
  // The module is plain ESM with no imports, so it evaluates in the current
  // realm with `export` stripped.
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', source.replace(/^export /gm, '') + '\nmodule.exports = { normalizeProp, validateDeclaration, declarationApplied, CUSTOM_PROPERTY_RE, PROPERTY_NAME_RE };')(mod, {});
  const { normalizeProp, validateDeclaration, declarationApplied } = mod.exports;

  // ---- property names ----------------------------------------------------
  assert.equal(normalizeProp('  Background-Color '), 'background-color', 'names are trimmed and lowercased');
  assert.equal(normalizeProp('-Webkit-Box-Shadow'), '-webkit-box-shadow', 'vendor prefixes lowercase too');
  // Custom properties are case-SENSITIVE: `--Brand` and `--brand` are different
  // properties, so lowercasing them would silently edit the wrong one.
  assert.equal(normalizeProp('--Brand'), '--Brand', 'custom properties keep their case');

  // ---- the accepted cases stay accepted ---------------------------------
  // The check must not get in the way of anything that works. A false rejection
  // would be a worse bug than the silent drop it replaces: it would block a
  // legitimate edit.
  for (const [p, v] of [
    ['Background-Color', '  #fff  '], ['color', 'red'], ['color', 'var(--brand)'],
    ['padding', '30px'], ['padding', '30px 12px'], ['display', 'flex'],
    ['width', 'calc(100% - 1rem)'], ['opacity', '0.5'], ['margin', '0 auto'],
    ['background', 'linear-gradient(red, blue)'], ['font', 'italic bold 12px/1.4 system-ui'],
    ['grid-area', '1 / 2 / 3 / 4'], ['transition', 'opacity 200ms ease'],
    ['border', '1px solid red'], ['z-index', '10'], ['transform', 'translateX(2px)']
  ]) {
    const r = validateDeclaration(p, v, supports);
    assert.equal(r.ok, true, p + ': ' + v + ' should be valid (' + r.error + ')');
    if (p !== '--Brand') assert.equal(r.prop, p.toLowerCase(), p + ' is normalised in the verdict');
    assert.equal(r.value, String(v).trim(), 'the value is trimmed for the write');
  }

  // Custom properties take any token stream — `--brand: whatever` is valid CSS,
  // so validating its value here would reject real usage.
  const custom = validateDeclaration('--brand', 'anything at all', supports);
  assert.equal(custom.ok, true, 'a custom property accepts an arbitrary value');

  // ---- the silently-dropped cases are named ------------------------------
  const badValue = validateDeclaration('color', 'notacolor', supports);
  assert.equal(badValue.ok, false, 'a bogus colour is rejected');
  assert.match(badValue.error, /notacolor/, 'the message quotes the offending value');
  assert.match(badValue.error, /color/, 'the message names the property');

  const badName = validateDeclaration('not a prop', '1px', supports);
  assert.equal(badName.ok, false, 'a name with a space is not a property');
  assert.match(badName.error, /background-color/, 'the message shows the shape a name has');

  const badShape = validateDeclaration('bogus-prop', '1px', supports);
  assert.equal(badShape.ok, false, 'an unknown property is rejected before the write');

  // `display: florble` is the classic case: a real property with a value the
  // engine discards.
  assert.equal(validateDeclaration('display', 'florble', supports).ok, false,
    'an unknown keyword for a known property is rejected');

  // ---- required fields ---------------------------------------------------
  // An empty value is not a no-op: setProperty(p, '') REMOVES the declaration,
  // so Apply on a blank field would silently unset the property.
  const emptyValue = validateDeclaration('color', '   ', supports);
  assert.equal(emptyValue.ok, false, 'a blank value is rejected');
  assert.match(emptyValue.error, /Remove/, 'the message points at Remove as the way to drop it');

  assert.equal(validateDeclaration('', 'red', supports).ok, false, 'a blank property is rejected');
  assert.equal(validateDeclaration('--brand', '', supports).ok, false, 'a blank custom property value is rejected');

  // ---- the capability check is optional and must not block --------------
  // Where there is no `CSS` object the shape checks still run, and a value that
  // passes them is allowed: a missing oracle must not refuse a valid write.
  assert.equal(validateDeclaration('color', 'some-future-syntax', null).ok, true,
    'without a capability check the value is accepted');
  // The shape checks still run without an oracle: a malformed NAME is caught
  // here, while a well-formed but unknown one (`bogus-prop`) is only knowable
  // from the browser — which is exactly why the write also verifies itself.
  assert.equal(validateDeclaration('not a prop', '1px', null).ok, false,
    'without a capability check a malformed NAME is still caught');
  assert.equal(validateDeclaration('bogus-prop', '1px', null).ok, true,
    'a well-formed unknown name needs the browser verdict, not a shape check');
  assert.equal(validateDeclaration('color', 'red', () => { throw new Error('boom'); }).ok, false,
    'a throwing capability check counts as unsupported, not as a crash');

  // ---- the post-write verdict -------------------------------------------
  // This is the half that owns the browser's real answer, including the
  // shorthand expansion no client-side check can predict.
  assert.equal(declarationApplied('', 'color: red;', 'red'), true, 'a value read back applied');
  assert.equal(declarationApplied('', 'padding-top: 30px;', ''), true,
    'a shorthand that expanded to longhands applied even though the typed name reads empty');
  assert.equal(declarationApplied('color: red;', 'color: red;', ''), false,
    'nothing written and nothing read back did not apply');
  assert.equal(declarationApplied('', '', ''), false, 'an untouched element rejected the write');
  assert.equal(declarationApplied(null, null, null), false, 'missing answers count as rejected');

  // ---- the wiring --------------------------------------------------------
  const events = src('events.js');
  assert.match(events, /var applied = read !== "" \|\| s\.cssText !== before;/,
    'the in-page write reads the style back and compares cssText');
  assert.match(events, /out\.applied === false/,
    'the handler turns a discarded declaration into an error');
  assert.match(events, /is not a valid value for/,
    'the error says the browser rejected the value');

  const panel = src('StylesPanel.jsx');
  assert.match(panel, /import \{ validateDeclaration \} from '\.\/declaration\.js';/,
    'the sheet uses the shared validator');
  assert.match(panel, /const check = useMemo\(\(\) => validateDeclaration\(/,
    'the sheet validates on every keystroke');
  assert.match(panel, /const verdict = validateDeclaration\(/,
    'Apply runs the same validator, so the button and the hint cannot disagree');
  assert.match(panel, /disabled: busy \|\| !check\.ok/,
    'Apply is disabled while the declaration is invalid');
  assert.match(panel, /check\.error/,
    'the invalid reason is shown to the user');

  // ---- cancel does not silently discard typed work ----------------------
  assert.match(panel, /function dismiss\(\)/,
    'cancel routes through a dismiss guard');
  assert.match(panel, /if \(dirty && !applied && check\.ok\) \{ setConfirmDiscard\(true\); return; \}/,
    'an unapplied edit asks before leaving, an applied one does not');
  assert.match(panel, /onClick: \(e\) => e\.stopPropagation\(\)/,
    'the sheet body does not close the sheet when tapped');
  assert.match(panel, /class: 'btn inspector__sheet-close', type: 'button', onClick: dismiss \}/,
    'the sheet close button uses the guard');
  assert.match(panel, /class: 'inspector__overlay', onClick: busy \? undefined : dismiss/,
    'tapping the backdrop uses the guard too');
  assert.match(panel, /confirmDiscard[\s\S]{0,400}Discard this change\?/,
    'the discard confirmation is rendered from that state');

  console.log('PASS declaration validation (silent-drop detection, accepted values, required fields, cancel guard)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
