'use strict';
// Inspector value shapes — the views beyond one rail (Part R2).
//
// Every value kind gets a view that fits it: colour rails and a palette for a
// colour, one sub-rail per side for a shorthand, segments for an enum, one rail
// per argument for a function list, and the typed field with a stated reason for
// a string or an image. The classification, the splitting and the joining are
// pure, and they are what this suite asserts: a view that mis-splits
// `padding: 10px 14px 18px 14px` or drops a function argument writes the wrong
// CSS, which no amount of rendering will reveal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
if (condition) { passed++; console.log('  ok   - ' + name); }
else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
const ctx = vm.createContext({
location: { search: '' },
document: { createElement: () => ({ style: {} }) }
});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js')), ctx);
// valueShapes imports hslToRgb/rgbToHsl from valueKinds and contrast from
// contrast.js in the real module; both are already in this context.
vm.runInContext(strip(read('frontend/src/components/inspector/valueShapes.js')).replace(/^export \{ hslToRgb, rgbToHsl \};$/m, '')
+ '\n;globalThis.VS = { valueShape, sidesFor, splitSides, joinSides, functionList, joinFunctions, splitArgs, enumValues, parseColourParts, joinColourParts, colourRailValues, applyRailPart, timeOptions, angleOptions, imageCandidates, contrastForValue, listItems, joinListItems, splitLooseArgs, ownKeywords, COMMA_LISTS, ANGLE_SNAPS, FANOUT, SIDE_LABEL, FUNCTION_PROPERTIES, IMAGE_PROPERTIES, FUNCTION_CATALOG, MAX_ADD_CHIPS, addableFunctions, addFunction, moveFunction, FUNCTIONS_NONE };\n', ctx);
const VS = ctx.VS;
check('the module loads', !!VS && typeof VS.valueShape === 'function');
// ---- which view each property gets -------------------------------------
{
const CASES = [
['color', '#1c2333', 'colour'],
['background-color', 'rgb(28, 35, 51)', 'colour'],
['border-color', 'hsl(220, 38%, 15%)', 'colour'],
['padding', '10px 14px 18px 14px', 'fanout'],
['margin', '8px 16px', 'fanout'],
['border-radius', '8px 8px 12px 12px', 'fanout'],
['inset', '0px 0px', 'fanout'],
['gap', '12px 24px', 'fanout'],
['transition-duration', '180ms', 'time'],
['animation-delay', '0.2s', 'time'],
['rotate', '12deg', 'angle'],
['hue-rotate', '90deg', 'angle'],
['display', 'flex', 'enum'],
['position', 'relative', 'enum'],
['transform', 'translateY(-4px) scale(1.02)', 'functions'],
['filter', 'blur(2px)', 'functions'],
['box-shadow', '0px 1px 2px rgba(0, 0, 0, 0.4)', 'functions'],
['transition', 'opacity 180ms ease, transform 200ms ease', 'functions'],
['background-image', 'url(hero.webp)', 'image'],
['mask-image', 'linear-gradient(red, blue)', 'image'],
['padding', '14px', 'rail'],
['margin', '8px', 'rail'],
['gap', '12px', 'rail'],
['opacity', '0.5', 'rail'],
['font-family', 'system-ui, sans-serif', 'text'],
['content', '"…"', 'image']
];
for (const [prop, val, want] of CASES) {
const got = VS.valueShape(prop, val);
check('valueShape(' + prop + ') is ' + want, got === want, got + ' for ' + JSON.stringify(val));
}
check('a custom property holding a length still gets a rail',
VS.valueShape('--space-card', '14px') === 'rail');
check('a custom property holding a colour gets the colour view',
VS.valueShape('--brand', '#6ea8fe') === 'colour');
check('an unparsable value falls to text', VS.valueShape('padding', 'calc(100% - 2px)') === 'text');
check('a transform of none is not a function list',
VS.valueShape('transform', 'none') === 'text');
check('a single-value shorthand stays a rail',
VS.valueShape('padding', '14px') === 'rail' && VS.valueShape('border-radius', '8px') === 'rail');
check('a keyword property with no own set falls to the typed field',
VS.valueShape('pointer-events', 'none') === 'enum'
&& VS.valueShape('user-select', 'none') === 'text',
VS.valueShape('user-select', 'none'));
// A comma-list property gets one row per item, and each item's arguments are
// split so the view can give each one its own rail.
{
const items = VS.listItems('transition', 'opacity 180ms ease, transform 200ms ease');
check('a transition list has two items', items && items.length === 2, JSON.stringify(items));
check('each item is split into arguments',
items[0].args.length === 3 && items[0].args[0].value === 'opacity', JSON.stringify(items[0].args));
check('the items are ordered', items[0].index === 0 && items[1].index === 1);
check('a transition round-trips',
VS.joinListItems(items) === 'opacity 180ms ease, transform 200ms ease', VS.joinListItems(items));
const shadow = VS.listItems('box-shadow', '0px 1px 2px rgba(0, 0, 0, 0.4)');
check('a shadow is one item with four arguments', shadow.length === 1 && shadow[0].args.length === 4, JSON.stringify(shadow));
check('a nested comma stays inside its argument',
shadow[0].args[3].value === 'rgba(0, 0, 0, 0.4)', shadow[0].args[3].value);
check('the shadow round-trips',
VS.joinListItems(shadow) === '0px 1px 2px rgba(0, 0, 0, 0.4)', VS.joinListItems(shadow));
check('a two-item shadow list keeps both', VS.joinListItems(VS.listItems('box-shadow', '0 1px 2px #000, 0 2px 4px #111')).includes('#111'));
check('a non-list property has no items', VS.listItems('color', 'red') === null);
check('an empty value has no items', VS.listItems('transition', '') === null);
}
}
// ---- the fan-out sides -------------------------------------------------
{
const sides = VS.sidesFor('padding');
check('padding has four sides', sides.length === 4, JSON.stringify(sides));
check('the sides are in CSS order',
sides.map((s) => s.key).join(',') === 'top,right,bottom,left', sides.map((s) => s.key).join(','));
check('each side names its longhand', sides[0].longhand === 'padding-top' && sides[3].longhand === 'padding-left');
check('the radius corners use arrows',
VS.sidesFor('border-radius').map((s) => s.label).join('') === '↖↗↘↙',
VS.sidesFor('border-radius').map((s) => s.label).join(''));
check('the radius corners name the right longhand',
VS.sidesFor('border-radius')[0].longhand === 'border-top-left-radius',
VS.sidesFor('border-radius')[0].longhand);
check('gap fans out to two, not four', VS.sidesFor('gap').length === 2);
check('a non-shorthand has no sides', VS.sidesFor('color') === null);
check('an unknown property has no sides', VS.sidesFor('grid-template-columns') === null);
}
// ---- splitting a shorthand ---------------------------------------------
{
const four = VS.splitSides('padding', '10px 14px 18px 14px');
check('a four-value shorthand splits into four', four.ok === true, JSON.stringify(four));
check('the four values land in the right sides',
four.sides.top === '10px' && four.sides.right === '14px'
&& four.sides.bottom === '18px' && four.sides.left === '14px', JSON.stringify(four.sides));
check('the unit is reported once', four.unit === 'px');
check('the numbers come along for the rail', four.numbers.top === 10 && four.numbers.bottom === 18);
check('a four-value shorthand is not uniform', four.uniform === false);
const one = VS.splitSides('padding', '12px');
check('a one-value shorthand repeats into four',
one.sides.top === '12px' && one.sides.left === '12px' && one.uniform === true);
const two = VS.splitSides('margin', '8px 16px');
check('a two-value shorthand repeats the pair',
two.sides.top === '8px' && two.sides.right === '16px'
&& two.sides.bottom === '8px' && two.sides.left === '16px', JSON.stringify(two.sides));
const three = VS.splitSides('padding', '4px 8px 12px');
check('a three-value shorthand repeats the second for the left',
three.sides.bottom === '12px' && three.sides.left === '8px', JSON.stringify(three.sides));
const mixed = VS.splitSides('padding', '0 auto');
check('a mixed shorthand keeps both parts', mixed.ok === true && mixed.sides.right === 'auto');
check('a keyword shorthand has no sides', VS.splitSides('padding', 'inherit').ok === false);
check('an empty value has no sides', VS.splitSides('padding', '').ok === false);
check('a non-shorthand is refused', VS.splitSides('color', 'red').ok === false);
const twoSides = VS.splitSides('gap', '12px 24px');
check('gap splits into row and column',
twoSides.sides.row === '12px' && twoSides.sides.column === '24px', JSON.stringify(twoSides.sides));
const oneGap = VS.splitSides('gap', '12px');
check('a one-value gap repeats', oneGap.sides.row === '12px' && oneGap.sides.column === '12px');
}
// ---- joining back to the shortest form ---------------------------------
{
const four = { top: '10px', right: '14px', bottom: '10px', left: '14px' };
check('a symmetric shorthand collapses to two',
VS.joinSides('padding', four) === '10px 14px', VS.joinSides('padding', four));
check('four equal values collapse to one',
VS.joinSides('padding', { top: '8px', right: '8px', bottom: '8px', left: '8px' }) === '8px');
check('three distinct values stay three',
VS.joinSides('padding', { top: '4px', right: '8px', bottom: '12px', left: '8px' }) === '4px 8px 12px',
VS.joinSides('padding', { top: '4px', right: '8px', bottom: '12px', left: '8px' }));
check('four distinct values stay four',
VS.joinSides('padding', { top: '1px', right: '2px', bottom: '3px', left: '4px' }) === '1px 2px 3px 4px');
check('a two-side property joins as a pair',
VS.joinSides('gap', { row: '12px', column: '24px' }) === '12px 24px');
check('an equal two-side property collapses',
VS.joinSides('gap', { row: '12px', column: '12px' }) === '12px');
check('a missing side writes nothing', VS.joinSides('padding', { top: '4px' }) === '');
check('a non-shorthand writes nothing', VS.joinSides('color', { top: '4px' }) === '');
// The round trip: split then join is the shortest equivalent form, and joining
// then splitting gives back the same four values.
const roundTrip = VS.splitSides('padding', VS.joinSides('padding', four));
check('the fan-out round-trips through the shortest form',
roundTrip.sides.top === '10px' && roundTrip.sides.right === '14px'
&& roundTrip.sides.bottom === '10px' && roundTrip.sides.left === '14px', JSON.stringify(roundTrip.sides));
}
// ---- function lists ----------------------------------------------------
{
const t = VS.functionList('translateY(-4px) scale(1.02)');
check('a two-function transform parses', Array.isArray(t) && t.length === 2, JSON.stringify(t));
check('the names are read', t[0].name === 'translateY' && t[1].name === 'scale');
check('each argument is its own value', t[0].args[0].value === '-4px' && t[1].args[0].value === '1.02');
check('the indexes are ordered', t[0].index === 0 && t[1].index === 1);
check('a function list joins back', VS.joinFunctions(t) === 'translateY(-4px) scale(1.02)', VS.joinFunctions(t));
const shadow = VS.functionList('0px 1px 2px rgba(0, 0, 0, 0.4)');
check('a box-shadow with no function name does not parse', shadow === null, JSON.stringify(shadow));
const rgb = VS.functionList('rgb(28, 35, 51)');
check('a nested-comma function parses', rgb && rgb.length === 1 && rgb[0].args.length === 3, JSON.stringify(rgb));
const blur = VS.functionList('blur(2px) brightness(1.2)');
check('two filters parse', blur && blur.length === 2 && blur[1].name === 'brightness');
check('none is not a function list', VS.functionList('none') === null);
check('an empty value is not a function list', VS.functionList('') === null);
check('bare text is not a function list', VS.functionList('auto') === null);
check('an unbalanced paren is not a function list', VS.functionList('scale(1') === null);
check('joining an empty list gives none', VS.joinFunctions([]) === 'none');
check('joining reads edited arguments',
VS.joinFunctions([{ name: 'scale', args: [{ value: '1.5' }] }]) === 'scale(1.5)');
check('arguments split on top-level commas only',
VS.splitArgs('1, calc(2, 3), 4').length === 3, JSON.stringify(VS.splitArgs('1, calc(2, 3), 4')));
check('a single argument has no commas to split',
VS.splitArgs('1.02').length === 1);
}
// ---- enum ranking ------------------------------------------------------
{
const used = [{ value: 'flex', count: 3 }, { value: 'grid', count: 1 }];
const values = VS.enumValues('display', used);
check('the page values come first',
values[0].value === 'flex' && values[1].value === 'grid', JSON.stringify(values.slice(0, 3)));
check('the page values are marked as such',
values[0].source === 'page' && values[2].source === 'spec');
check('the spec set follows', values.some((v) => v.value === 'inline-block'));
check('the CSS-wide keywords come last',
values[values.length - 1].wide === true, JSON.stringify(values.slice(-4)));
check('a value in both lists appears once',
values.filter((v) => v.value === 'flex').length === 1);
check('no keywords for an unknown property still yields the wide set',
VS.enumValues('accent-color', []).every((v) => v.wide));
check('a bare string in the used list is accepted',
VS.enumValues('display', ['flex'])[0].value === 'flex');
check('duplicates in the page list collapse',
VS.enumValues('display', ['flex', 'flex']).filter((v) => v.value === 'flex').length === 1);
check('keywords are lower-cased', VS.enumValues('display', ['FLEX'])[0].key === 'flex');
}
// ---- colour parts ------------------------------------------------------
{
const hex = VS.parseColourParts('#1c2333');
check('a hex colour parses', !!hex && near(hex.rgb.r, 28) && near(hex.rgb.b, 51), JSON.stringify(hex));
check('the format is remembered', hex.format === 'hex');
check('the hue comes from the channels', near(hex.h, 222, 1), String(hex.h));
const rgb = VS.parseColourParts('rgb(110, 168, 254)');
check('an rgb colour parses', rgb && rgb.rgb.r === 110 && rgb.rgb.g === 168);
check('the hsl conversion matches the mock brand colour', near(rgb.h, 216, 2), String(rgb.h));
const hsl = VS.parseColourParts('hsl(220, 38%, 15%)');
check('an hsl colour parses without conversion loss', near(hsl.h, 220, 1) && near(hsl.s, 0.38, 0.01));
check('an hsl colour keeps its format', hsl.format === 'hsl');
const alpha = VS.parseColourParts('rgba(0, 0, 0, 0.5)');
check('an alpha is read', near(alpha.a, 0.5));
check('a percentage alpha is read', near(VS.parseColourParts('rgb(0 0 0 / 40%)').a, 0.4));
check('a 4-digit hex alpha is read', near(VS.parseColourParts('#0008').a, 0x88 / 255, 0.01));
check('a named colour parses', VS.parseColourParts('white').rgb.r === 255);
check('transparent parses with zero alpha', VS.parseColourParts('transparent').a === 0);
const cc = VS.parseColourParts('currentcolor');
check('currentcolor is a keyword, not a colour', cc.keyword === 'currentcolor' && cc.format === 'keyword');
check('an unknown name is unknown', VS.parseColourParts('not-a-colour').format === 'unknown');
check('an empty value is null', VS.parseColourParts('') === null);
check('a gradient is unknown', VS.parseColourParts('linear-gradient(red, blue)').format === 'unknown');
}
// ---- writing a colour back ---------------------------------------------
{
const parts = VS.parseColourParts('#1c2333');
check('hex writes back as a hex', VS.joinColourParts(parts, 'hex') === '#1c2333', VS.joinColourParts(parts, 'hex'));
check('rgb writes the channels', VS.joinColourParts(parts, 'rgb') === 'rgb(28, 35, 51)', VS.joinColourParts(parts, 'rgb'));
const hslOut = VS.joinColourParts(parts, 'hsl');
check('hsl writes the numbers the rails show', /^hsl\(2\d\d, \d+%, \d+%\)$/.test(hslOut), hslOut);
check('an alpha hex writes eight digits',
VS.joinColourParts(Object.assign({}, parts, { a: 0.5 }), 'hex').length === 9,
VS.joinColourParts(Object.assign({}, parts, { a: 0.5 }), 'hex'));
check('an alpha rgb writes rgba',
VS.joinColourParts(Object.assign({}, parts, { a: 0.5 }), 'rgb').startsWith('rgba('));
check('an alpha hsl writes hsla',
VS.joinColourParts(Object.assign({}, parts, { a: 0.5 }), 'hsl').startsWith('hsla('));
check('currentcolor writes back as itself',
VS.joinColourParts({ keyword: 'currentcolor' }, 'hex') === 'currentcolor');
// The rail round trip: moving the hue and writing it back keeps the hue.
const moved = VS.applyRailPart(parts, 'h', 120);
check('the hue rail updates the hue', Math.round(moved.h) === 120);
check('the rgb snapshot is refreshed',
JSON.stringify(moved.rgb) !== JSON.stringify(parts.rgb), JSON.stringify(moved.rgb));
check('the rgb snapshot matches the hsl', (() => {
const back = VS.parseColourParts(VS.joinColourParts(moved, 'hex'));
return Math.abs(back.rgb.r - moved.rgb.r) <= 1 && Math.abs(back.h - 120) <= 1;
})());
check('the saturation rail takes a percentage', near(VS.applyRailPart(parts, 's', 50).s, 0.5));
check('the lightness rail takes a percentage', near(VS.applyRailPart(parts, 'l', 75).l, 0.75));
check('the saturation rail clamps', near(VS.applyRailPart(parts, 's', 500).s, 1));
check('an unknown rail key is ignored', VS.applyRailPart(parts, 'x', 5).h === parts.h);
}
// ---- the three rails ---------------------------------------------------
{
const parts = VS.parseColourParts('#1c2333');
const rails = VS.colourRailValues(parts);
check('there are three colour rails', rails.length === 3);
check('the rails are hue, saturation and lightness',
rails.map((r) => r.key).join(',') === 'h,s,l');
check('the hue rail runs 0…360', rails[0].min === 0 && rails[0].max === 360);
check('the saturation rail runs 0…100', rails[1].min === 0 && rails[1].max === 100);
check('each rail has a live gradient', rails.every((r) => /^linear-gradient/.test(r.track)));
check('the hue track is a rainbow', /,/.test(rails[0].track) && rails[0].track.split(',').length >= 7);
check('the saturation track starts grey', /#|rgb\(/.test(rails[1].track));
check('the lightness track runs black to white',
/#000000/.test(rails[2].track) && /#ffffff/.test(rails[2].track), rails[2].track);
check('each rail reports its current value', rails.every((r) => Number.isFinite(r.value)));
check('the rails explain their ends',
rails[0].end === 'rainbow = full gamut' && rails[1].end === '0 = grey');
}
// ---- time and angle ----------------------------------------------------
{
const t = VS.timeOptions('180ms');
check('a time offers ms and s', t.length === 2);
check('the current unit is marked', t[0].current === true && t[1].current === false);
check('the other unit is converted', t[1].value === '0.18s', t[1].value);
const s = VS.timeOptions('0.18s');
check('a second value converts back to ms', s[0].value === '180ms', s[0].value);
check('a time is not offered for a non-number', VS.timeOptions('auto').length === 0);
const a = VS.angleOptions('12deg');
check('an angle offers three units', a.length === 3, JSON.stringify(a));
check('the current angle unit is marked', a[0].current === true);
check('degrees convert to turns', near(Number(a[1].value.replace('turn', '')), 12 / 360, 1e-4));
check('degrees convert to radians', near(Number(a[2].value.replace('rad', '')), 12 * Math.PI / 180, 1e-3));
check('the angle snaps are right angles', VS.ANGLE_SNAPS.join(',') === '-180,-90,-45,0,45,90,180');
check('a turn value converts to degrees',
near(Number(VS.angleOptions('0.5turn')[0].value.replace('deg', '')), 180, 1e-4));
}
// ---- images ------------------------------------------------------------
{
const images = VS.imageCandidates([
{ value: 'url(hero-2.webp)' },
{ value: 'linear-gradient(red, blue)' },
{ value: 'none' },
{ value: '14px' },
{ value: 'url(hero-2.webp)' }
]);
check('only url() and gradient() values are offered', images.length === 2, JSON.stringify(images));
check('a duplicate image is offered once', images.filter((i) => i.value === 'url(hero-2.webp)').length === 1);
check('an image candidate is marked for a thumbnail', images[0].thumb === true);
check('a gradient is not marked for a thumbnail', images[1].thumb === false);
check('no candidates for nothing', VS.imageCandidates(null).length === 0);
}
// ---- the contrast hand-off ---------------------------------------------
{
const r = VS.contrastForValue('#9cc2ff', '#1c2333');
check('a colour candidate gets its ratio', r.ok === true && r.ratio > 7, JSON.stringify(r));
check('an unreadable candidate reports the reason', VS.contrastForValue('var(--x)', '#fff').ok === false);
}
// ---- adding, reordering and emptying a function list ---------------------
//
// The mock's functions row ends `add / remove / reorder; none as a chip`. An add
// that produces `translateX()` would be a broken declaration, so every catalogue
// entry carries a valid default argument, and the catalogue is short on purpose.
{
const list = VS.functionList('translateY(-4px) scale(1.02)');
{
const addable = VS.addableFunctions('transform', list);
check('a transform offers the functions it does not have yet',
addable.map((s) => s.name).join(',') === 'translateX,rotate,skewX,skewY', addable.map((s) => s.name).join(','));
check('the functions already in the list are not offered again',
!addable.some((s) => ['translateY', 'scale'].includes(s.name)));
check('every catalogue entry has a default argument',
Object.values(VS.FUNCTION_CATALOG).every((spec) => spec.every((s) => s.args.length > 0 && s.args.every((a) => String(a).length > 0))));
const added = VS.addFunction(list, addable.find((s) => s.name === 'rotate'));
check('an added function is joined as a valid call',
VS.joinFunctions(added) === 'translateY(-4px) scale(1.02) rotate(45deg)', VS.joinFunctions(added));
check('the added entry carries raw and value like a parsed one',
added[2].args[0].raw === '45deg' && added[2].args[0].value === '45deg');
check('an added entry is re-parsed by the same parser',
(VS.functionList(VS.joinFunctions(added)) || []).length === 3);
check('the indices are renumbered after an add',
VS.addFunction(list, addable[0]).map((f) => f.index).join(',') === '0,1,2');
check('adding nothing is a no-op', VS.addFunction(list, null).length === 2);
check('adding to a missing list still works', VS.addFunction(null, { name: 'scale', args: ['1'] }).length === 1);
check('the add row is capped', VS.addableFunctions('filter', []).length <= VS.MAX_ADD_CHIPS);
}
// Reorder: a transform list is not commutative, so this is part of the value.
{
const moved = VS.moveFunction(list, 0, 1);
check('a swap moves the entry one place later',
moved.map((f) => f.name).join(',') === 'scale,translateY', moved.map((f) => f.name).join(','));
check('the moved list joins in the new order',
VS.joinFunctions(moved) === 'scale(1.02) translateY(-4px)', VS.joinFunctions(moved));
check('moving up from the top changes nothing', VS.moveFunction(list, 0, -1) === list);
check('moving down from the bottom changes nothing', VS.moveFunction(list, 1, 1) === list);
check('an out-of-range index changes nothing', VS.moveFunction(list, 9, -1) === list);
check('a move does not mutate the input',
list.map((f) => f.name).join(',') === 'translateY,scale');
check('a move renumbers the indices',
VS.moveFunction(list, 0, 1).map((f) => f.index).join(',') === '0,1');
check('a three-item middle move works both ways',
VS.moveFunction(VS.functionList('a(1) b(2) c(3)'), 1, 1).map((f) => f.name).join(',') === 'a,c,b'
&& VS.moveFunction(VS.functionList('a(1) b(2) c(3)'), 1, -1).map((f) => f.name).join(',') === 'b,a,c');
check('a non-array is handled', VS.moveFunction(null, 0, 1) === null || Array.isArray(VS.moveFunction(null, 0, 1)));
}
// The filter side of the catalogue.
{
const f = VS.addableFunctions('filter', []);
check('a filter offers its own functions',
f.map((s) => s.name).includes('blur') && f.map((s) => s.name).includes('hue-rotate'), f.map((s) => s.name).join(','));
check('blur arrives with a length, not a bare call', f.find((s) => s.name === 'blur').args[0] === '4px');
check('a property with no catalogue offers nothing', VS.addableFunctions('box-shadow', []).length === 0);
check('an empty property offers nothing', VS.addableFunctions('', []).length === 0);
}
// `none` is a real declaration for these properties, not an empty string.
{
check('emptying the list writes none', VS.joinFunctions([]) === 'none');
check('the none constant is the mock\'s word', VS.FUNCTIONS_NONE === 'none');
check('none does not re-parse as a list', VS.functionList('none') === null);
}
// The view renders the three controls and writes through onChange.
{
const src = read('frontend/src/components/inspector/ValueKindsView.jsx');
check('the view offers an add row', /inspector__fn-addrow/.test(src) && /addableFunctions\(props\.prop, list\)/.test(src));
check('an add chip writes the extended list',
/joinFunctions\(addFunction\(list, s\)\)/.test(src));
check('the view offers a reorder pair', /inspector__fn-move/.test(src) && /moveFunction\(list, fi, dir\)/.test(src));
check('a move at the end is disabled, not hidden', /disabled: f\.index === 0/.test(src)
&& /disabled: f\.index === list\.length - 1/.test(src));
check('the view offers the none chip', /FUNCTIONS_NONE\b/.test(src) && /onClick: \(\) => props\.onChange\(FUNCTIONS_NONE\)/.test(src));
check('the comma list reorders too', /moveItem\(ii, -1\)/.test(src) && /moveItem\(ii, 1\)/.test(src));
check('a comma-list move joins through joinListItems', /joinListItems\(copy\.map/.test(src));
check('remove is still there and still writes none when emptied',
/copy\.length \? joinFunctions\(copy\) : FUNCTIONS_NONE/.test(src));
const css = read('frontend/src/inspector.css');
check('the reorder buttons are 44 px targets', /\.inspector__fn-move \{/.test(css)
&& /min-width: 44px/.test(css.slice(css.indexOf('.inspector__fn-move {'))));
check('the add row wraps rather than scrolling', /\.inspector__fn-addrow \{[^}]*flex-wrap: wrap/.test(css));
}
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' value-shape assertion(s) failed');
