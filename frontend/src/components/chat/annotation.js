// Pure helpers for composer image annotations.
//
// Annotation reset data stays on the in-memory attachment so the original
// image can be restored during this composer session. Public/network copies
// are built from an allowlist so reset data can never reach SQLite/providers.
export const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024;

export function toPublicImageAttachment(value) {
if (!value || typeof value !== 'object' || value.type !== 'image') return null;
const mimeType = typeof value.mimeType === 'string' ? value.mimeType : '';
const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : '';
if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mimeType)) return null;
if (!dataUrl.startsWith('data:' + mimeType + ';base64,')) return null;
if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) return null;
const out = { type: 'image', mimeType, dataUrl };
if (typeof value.name === 'string' && value.name) out.name = value.name;
return out;
}

export function toPublicImageAttachments(values) {
if (!Array.isArray(values)) return [];
return values.map(toPublicImageAttachment).filter(Boolean);
}

export function annotationTextInsertion(current, addition) {
const before = typeof current === 'string' ? current.trimEnd() : '';
const text = typeof addition === 'string' ? addition.trim() : '';
if (!text) return { value: before, start: -1 };
const separator = before ? '\n\n' : '';
return { value: before + separator + text, start: before.length + separator.length };
}

export function appendAnnotationText(current, addition) {
return annotationTextInsertion(current, addition).value;
}

export function removeAnnotationText(current, annotationText, start = -1) {
const value = typeof current === 'string' ? current : '';
const text = typeof annotationText === 'string' ? annotationText.trim() : '';
if (!text || !Number.isInteger(start) || start < 0 || value.slice(start, start + text.length) !== text) return value;
const end = start + text.length;
if (end < value.length && value.slice(end, end + 2) !== '\n\n') return value;
let before = value.slice(0, start);
let after = value.slice(end);
if (before.endsWith('\n\n')) before = before.slice(0, -2);
else if (after.startsWith('\n\n')) after = after.slice(2);
return before + after;
}

export function annotatedAttachment(current, image, annotationText, annotationStart = -1) {
const previous = current && typeof current === 'object' ? current : {};
const firstOriginal = previous.__originalAttachment || toPublicImageAttachment(previous);
const next = Object.assign({}, previous, toPublicImageAttachment(image) || {});
next.__originalAttachment = firstOriginal;
next.__annotationText = typeof annotationText === 'string' ? annotationText.trim() : '';
next.__annotationStart = Number.isInteger(annotationStart) ? annotationStart : -1;
return next;
}

export function annotationReset(attachment) {
if (!attachment || !attachment.__originalAttachment) return null;
return {
attachment: toPublicImageAttachment(attachment.__originalAttachment),
annotationText: typeof attachment.__annotationText === 'string' ? attachment.__annotationText : '',
annotationStart: Number.isInteger(attachment.__annotationStart) ? attachment.__annotationStart : -1
};
}

export function originalImageDataUrl(attachment) {
const reset = annotationReset(attachment);
return reset && reset.attachment ? reset.attachment.dataUrl : null;
}

export function shiftAnnotationStarts(attachments, afterStart, delta, exceptIndex = -1) {
if (!Array.isArray(attachments) || !delta) return Array.isArray(attachments) ? attachments.slice() : [];
return attachments.map((attachment, index) => {
if (index === exceptIndex || !attachment || !Number.isInteger(attachment.__annotationStart) || attachment.__annotationStart <= afterStart) return attachment;
return Object.assign({}, attachment, { __annotationStart: attachment.__annotationStart + delta });
});
}

export function rebaseAnnotationStarts(attachments, before, after) {
if (!Array.isArray(attachments) || before === after) return Array.isArray(attachments) ? attachments.slice() : [];
const oldValue = typeof before === 'string' ? before : '';
const newValue = typeof after === 'string' ? after : '';
let prefix = 0;
while (prefix < oldValue.length && prefix < newValue.length && oldValue[prefix] === newValue[prefix]) prefix += 1;
let suffix = 0;
while (
suffix < oldValue.length - prefix &&
suffix < newValue.length - prefix &&
oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]
) suffix += 1;
const oldEnd = oldValue.length - suffix;
const delta = newValue.length - oldValue.length;
return attachments.map((attachment) => {
if (!attachment || !Number.isInteger(attachment.__annotationStart) || attachment.__annotationStart < 0) return attachment;
const start = attachment.__annotationStart;
const text = typeof attachment.__annotationText === 'string' ? attachment.__annotationText : '';
const end = start + text.length;
if (oldEnd <= start) return Object.assign({}, attachment, { __annotationStart: start + delta });
if (prefix >= end) return attachment;
return Object.assign({}, attachment, { __annotationStart: -1 });
});
}

export function canvasToBoundedPngDataUrl(canvas, options = {}) {
if (!canvas || typeof canvas.toDataURL !== 'function') throw new Error('Annotation canvas is unavailable.');
const limit = Number.isFinite(options.limit) ? options.limit : MAX_IMAGE_DATA_URL_CHARS;
const makeCanvas = options.makeCanvas || (() => document.createElement('canvas'));
let source = canvas;
let dataUrl = source.toDataURL('image/png');
if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Could not export the annotated image.');
for (let attempt = 0; dataUrl.length > limit && attempt < 10; attempt += 1) {
const ratio = Math.min(0.9, Math.max(0.1, Math.sqrt(limit / dataUrl.length) * 0.9));
const width = Math.max(1, Math.floor(source.width * ratio));
const height = Math.max(1, Math.floor(source.height * ratio));
if (width === source.width && height === source.height) break;
const reduced = makeCanvas();
reduced.width = width;
reduced.height = height;
const ctx = reduced.getContext('2d');
if (!ctx) throw new Error('Could not resize the annotated image.');
ctx.drawImage(source, 0, 0, width, height);
source = reduced;
dataUrl = source.toDataURL('image/png');
if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Could not export the annotated image.');
}
if (dataUrl.length > limit) throw new Error('Annotated image is too large. Try a smaller image.');
return dataUrl;
}
