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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}
run().catch((error) => { console.error(error); process.exit(1); });
