'use strict';
// Regression tests for composer image annotation text, reset metadata,
// bounded exports, immediate draft saves, and server-side draft cleaning.
const fs = require('fs');
const os = require('os');
const path = require('path');
let passed = 0, failed = 0;
function check(name, condition, detail) {
if (condition) { passed++; console.log('PASS  ' + name); }
else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
async function run() {
const annotation = await import('../frontend/src/components/chat/annotation.js');
const composer = await import('../frontend/src/components/chat/composer.js');
const original = { type: 'image', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,one', name: 'one.jpg' };
const markedImage = { type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,two', name: 'marked.png' };

check('annotation appends without replacing the prompt', annotation.appendAnnotationText('Explain this', 'Attached image') === 'Explain this\n\nAttached image');
const insertion = annotation.annotationTextInsertion('before', 'Attached image');
check('owned annotation text is removed only at its recorded position', annotation.removeAnnotationText(insertion.value + '\n\nafter', 'Attached image', insertion.start) === 'before\n\nafter');
check('edited annotation text is preserved on reset', annotation.removeAnnotationText('before\n\nAttached image edited', 'Attached image', insertion.start) === 'before\n\nAttached image edited');
check('matching user text is not removed without ownership', annotation.removeAnnotationText('Attached image\n\nAttached image', 'Attached image', -1) === 'Attached image\n\nAttached image');
const owned = annotation.annotatedAttachment(original, markedImage, 'Attached image', 8);
const rebased = annotation.rebaseAnnotationStarts([owned], 'before\n\nAttached image', 'new before\n\nAttached image');
check('typing before annotation rebases its ownership position', rebased[0].__annotationStart === 12, String(rebased[0].__annotationStart));
const editedOwned = annotation.rebaseAnnotationStarts([owned], 'before\n\nAttached image', 'before\n\nAttached edited image');
check('editing inside annotation invalidates text ownership', editedOwned[0].__annotationStart === -1, String(editedOwned[0].__annotationStart));

const first = annotation.annotatedAttachment(original, markedImage, 'Attached image', 0);
const second = annotation.annotatedAttachment(first, Object.assign({}, markedImage, { dataUrl: 'data:image/png;base64,three' }), 'New note', 20);
const reset = annotation.annotationReset(second);
check('repeat annotation keeps the untouched original', reset && reset.attachment.dataUrl === original.dataUrl, reset && reset.attachment.dataUrl);
const publicList = annotation.toPublicImageAttachments([Object.assign({}, second, { debug: true })]);
check('public attachment allowlist drops all client metadata', JSON.stringify(publicList) === JSON.stringify([markedImage]).replace('two', 'three'), JSON.stringify(publicList));
check('public attachment validation rejects oversized input', annotation.toPublicImageAttachments([{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + 'x'.repeat(annotation.MAX_IMAGE_DATA_URL_CHARS) }]).length === 0);

const refs = { draftSaveTimer: { current: null } };
const patches = [];
composer.queueComposerDraftSave('old', 'project', 'chat', refs, async (patch) => { patches.push(patch); });
await composer.saveComposerDraftNow('new', refs, async (patch) => { patches.push(patch); }, { draftAttachments: publicList });
await new Promise((resolve) => setTimeout(resolve, 300));
check('immediate annotation save cancels stale debounce', patches.length === 1 && patches[0].draft === 'new' && patches[0].draftAttachments === publicList, JSON.stringify(patches));

function fakeCanvas(width, height, fixedLength) {
return {
width,
height,
getContext() { return { drawImage() {} }; },
toDataURL() { return 'data:image/png;base64,' + 'x'.repeat(fixedLength || this.width * this.height); }
};
}
const bounded = annotation.canvasToBoundedPngDataUrl(fakeCanvas(100, 100), {
limit: 1000,
makeCanvas: () => fakeCanvas(1, 1)
});
check('oversized PNG export is downscaled below the server limit', bounded.length <= 1000, String(bounded.length));
let rejected = false;
try {
annotation.canvasToBoundedPngDataUrl(fakeCanvas(2, 2, 2000), {
limit: 1000,
makeCanvas: () => fakeCanvas(1, 1, 2000)
});
} catch { rejected = true; }
check('unshrinkable PNG export reports an error', rejected);
check('failed canvas encoding is rejected', (() => {
try { annotation.canvasToBoundedPngDataUrl({ width: 1, height: 1, toDataURL: () => 'data:,' }); return false; } catch { return true; }
})());
check('client and server limits remain aligned', annotation.MAX_IMAGE_DATA_URL_CHARS === 12 * 1024 * 1024);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-annotation-home-'));
const project = fs.mkdtempSync(path.join(home, 'project-'));
process.env.MOUAIF_HOME = home;
const chats = require('../src/chats.js');
const chat = chats.createChat(project, {});
const oversized = 'data:image/png;base64,' + 'x'.repeat(12 * 1024 * 1024);
chats.updateChat(project, chat.id, { draftAttachments: [Object.assign({}, markedImage, { private: 'no' }), { type: 'image', mimeType: 'image/png', dataUrl: oversized }] });
const stored = chats.getChat(project, chat.id).draftAttachments || [];
check('server draft normalization strips private fields', stored.length === 1 && !Object.prototype.hasOwnProperty.call(stored[0], 'private'), JSON.stringify(stored.map((item) => Object.keys(item))));
check('server draft normalization rejects oversized images', stored.length === 1, String(stored.length));
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }

const css = fs.readFileSync(path.join(__dirname, '../frontend/src/chat-composer.css'), 'utf8');
const removeRule = (css.match(/\.chat-view__image-chipremove \{[\s\S]*?\n\}/) || [''])[0];
check('remove-image button uses the compact 32px dismiss target', /width:\s*var\(--tap-sm\)/.test(removeRule) && /height:\s*var\(--tap-sm\)/.test(removeRule), removeRule);

// The web-preview viewer's header is one row at every phone width. It used to
// wrap onto two, which cost 107px of a 740px viewport and left the first row
// two-thirds empty once the title ellipsized. These guards pin the contract
// that makes one row work, so a future edit cannot quietly reintroduce the
// wrap (or a control too small to tap). Measured in Chrome at
// 320/340/360/390/414/430 px: one row, head 55px, four 44px-tall controls,
// 8px gaps, no overflow.
const narrowStart = css.indexOf('@media (max-width: 430px)');
// Slice the block and drop the `@media ... {` wrapper plus its closing brace,
// leaving only flat rules to parse.
const narrowRaw = css.slice(narrowStart, css.indexOf('\n.wp__body {', narrowStart));
const narrow = narrowRaw.slice(narrowRaw.indexOf('{') + 1, narrowRaw.lastIndexOf('}'));
// Strip comments before matching: the blocks are heavily commented, and a
// comment that quotes the old declaration (e.g. "do NOT offset this with
// `top: calc(var(--safe-top) + 8px)`") would otherwise satisfy a pattern
// meant to catch the real declaration.
const uncomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
// Parse `selector-list { decls }` pairs so a rule reached through a comma
// list (`.wp__close,\n.mcp-err__close { ... }`) is found too — matching
// `.sel {` textually misses those, and the tap-target rules are written that
// way.
function rules(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(uncomment(src)))) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ selectors, decls: m[2] });
  }
  return out;
}
const declsFor = (src, sel) => {
  const hit = rules(src).filter((r) => r.selectors.includes(sel));
  return hit.map((r) => r.decls).join('\n');
};
const narrowRule = (sel) => declsFor(narrow, sel);
const baseRule = (sel) => declsFor(css, sel);
const REVIEWER = '.wp__sheet:not(.wp__prompt-sheet)';
const HEAD = REVIEWER + ' .wp__head';
// Every selector the phone block declares, so the scoping can be asserted.
const narrowSelectors = rules(narrow).flatMap((r) => r.selectors);
check('the viewer header does not wrap on a phone',
  /flex-wrap:\s*nowrap/.test(narrowRule(HEAD)), narrowRule(HEAD) || 'no rule');
check('the title block is the only flexible child, so it ellipsizes',
  /flex:\s*1 1 auto/.test(narrowRule(HEAD + '-text')) && /min-width:\s*0/.test(narrowRule(HEAD + '-text')));
check('the actions group does not stretch to a full row',
  /flex:\s*0 0 auto/.test(narrowRule(HEAD + '-actions')));
check('Refresh collapses to its icon',
  /display:\s*none/.test(narrowRule(REVIEWER + ' .wp__action--refresh span')), narrowRule(REVIEWER + ' .wp__action--refresh span') || 'no rule');
check('the Refresh icon keeps a 44px tap target',
  /min-width:\s*44px/.test(narrowRule(REVIEWER + ' .wp__action--refresh')) ||
  /min-width:\s*44px/.test(baseRule('.wp__action')));
check('the size select is capped but wide enough for its longest option',
  /max-width:\s*7\.5rem/.test(narrowRule(REVIEWER + ' .wp__size-select')));
check('the title block and Refresh are 44px tall in the row',
  /min-height:\s*44px/.test(narrowRule(HEAD + '-text')) &&
  /min-height:\s*44px/.test(baseRule('.wp__action')));
// The Refresh action is the only control in this header whose contents are a
// bare glyph on a phone (its label is hidden at <= 430px). `.wp__action` did
// not centre its contents, so the 14px glyph sat at `padding-left: 4px`: 5px
// from the left edge of the 44px square and 25px from the right, which is
// visibly off-centre. Measured in Chrome at 360px the inset went 5/25 before
// and 15/15 after. `.inspector__preview-fs-refresh` (the Inspector's mirrored
// button) gets the same centring from its own rule in
// frontend/src/inspector-pick-mode.css, and the base rule is asserted here
// because the phone block must not have to re-declare it.
check('the Refresh glyph is centred in its button',
  /justify-content:\s*center/.test(baseRule('.wp__action')), baseRule('.wp__action') || 'no rule');
check('the size select and close button are 44px tall',
  /min-height:\s*44px/.test(baseRule('.wp__size-select')) &&
  /min-height:\s*44px/.test(baseRule('.wp__close')));
// The close button is only absolutely positioned in a *wrapped* header. In the
// single-row layout it is back in the flow, which is what keeps it at the end
// of the row without any safe-area arithmetic. Offsetting it with
// `calc(var(--safe-top) + 8px)` double-applied the inset (the overlay already
// pads it) and dropped its 44px square onto the controls, stealing taps.
const closeRule = narrowRule(REVIEWER + ' .wp__close');
check('the close button sits in the row, not absolutely positioned',
  /position:\s*static/.test(closeRule) && !/top:\s*calc\(var\(--safe-top/.test(closeRule), closeRule || 'no rule');
// Every rule in the phone block must be scoped to the viewer. The URL prompt
// sheet has a single inline close button and never wrapped, so a bare
// `.wp__prompt-sheet .wp__head` selector here would break it.
const headSelectors = narrowSelectors.filter((s) => s.includes('.wp__head'));
check('the URL prompt sheet keeps its own single row',
  headSelectors.length > 0 && headSelectors.every((s) => s.includes(':not(.wp__prompt-sheet)')),
  headSelectors.join(' | '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}
run().catch((error) => { console.error(error); process.exit(1); });
