// Draft Craft image annotator for the Inspector preview.
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DraftCraftSheet } from '../DraftCraftSheet.jsx';
import { canvasToBoundedPngDataUrl } from '../chat/annotation.js';

const COLORS = ['#ff5f57', '#ffd60a', '#32d74b', '#0a84ff'];
const MIN_ZOOM = 0.1; // hard safety floor; the real minimum is the fit-to-view level below
const MAX_ZOOM = 4;
const MAX_MARKERS = 26;
function clampZoom(value, min = MIN_ZOOM) {
return Math.min(MAX_ZOOM, Math.max(min, value));
}
// The largest zoom that still shows the whole image inside the canvas frame.
// At zoom z the image renders at width = frameWidth * z and height = width *
// (naturalHeight / naturalWidth), so the height-limited fit is
// frameHeight / (frameWidth * h/w). We never zoom out past 1 — width already
// fills the frame there — so a short/wide page fits at 1. The fit gives the
// "show whole screenshot" default instead of the top-left corner only.
function fitZoomFor(wrap, canvas) {
if (!wrap || !canvas) return MIN_ZOOM;
const wrapW = wrap.clientWidth || wrap.offsetWidth;
const wrapH = wrap.clientHeight || wrap.offsetHeight;
const natW = canvas.width || canvas.naturalWidth || 1;
const natH = canvas.height || canvas.naturalHeight || 1;
if (wrapW <= 0 || wrapH <= 0 || natW <= 0 || natH <= 0) return MIN_ZOOM;
const displayHeightAtOne = wrapW * (natH / natW);
return Math.max(MIN_ZOOM, Math.min(1, wrapH / displayHeightAtOne));
}
function clamp(value) {
return Math.min(1, Math.max(0, value));
}
function markerLabel(index, style) {
return style === 'letters' ? String.fromCharCode(65 + index) : String(index + 1);
}
function markerTextColor(color) {
// Pick black or white text from the marker's background by relative
// luminance so labels stay legible for the global palette, instead of
// a hardcoded check that only knew about the yellow preset.
const hex = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
if (!hex) return '#ffffff';
const value = parseInt(hex[1], 16);
const r = (value >> 16) & 255;
const g = (value >> 8) & 255;
const b = value & 255;
const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
return luminance > 0.6 ? '#111111' : '#ffffff';
}
function pointFor(event, canvas) {
const rect = canvas.getBoundingClientRect();
return {
x: (event.clientX - rect.left) * (canvas.width / rect.width),
y: (event.clientY - rect.top) * (canvas.height / rect.height)
};
}
function markerPoint(event, stage, constrain = false) {
if (!stage) return null;
const rect = stage.getBoundingClientRect();
if (!constrain && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return null;
return {
x: clamp((event.clientX - rect.left) / rect.width),
y: clamp((event.clientY - rect.top) / rect.height)
};
}
function paintMarker(ctx, marker, label, width) {
const radius = Math.max(14, width / 46);
const x = marker.x * ctx.canvas.width;
const y = marker.y * ctx.canvas.height;
ctx.save();
ctx.beginPath();
ctx.arc(x, y, radius, 0, Math.PI * 2);
ctx.fillStyle = marker.color;
ctx.fill();
ctx.lineWidth = Math.max(3, radius / 7);
ctx.strokeStyle = '#ffffff';
ctx.stroke();
ctx.fillStyle = markerTextColor(marker.color);
ctx.font = '700 ' + Math.round(radius * 1.05) + 'px system-ui, sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText(label, x, y + radius * 0.04);
ctx.restore();
}
function midpoint(a, b) {
return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function distance(a, b) {
return Math.hypot(b.x - a.x, b.y - a.y);
}

export function DraftCraftAnnotator({ image, pageTitle, pageUrl, onClose, onAnnotated, originalDataUrl = null, sourceLabel = 'Inspector image', actionLabel = 'Add to chat draft', onReset }) {
const canvasRef = useRef(null);
const stageRef = useRef(null);
const wrapRef = useRef(null);
const drawingRef = useRef(false);
const lastRef = useRef(null);
const pointersRef = useRef(new Map());
const pinchRef = useRef(null);
const panRef = useRef(null);
const markerDragRef = useRef(null);
const markerListRef = useRef(null);
const activeMarkerRowRef = useRef(null);
const zoomRef = useRef(1);
const lastFitZoomRef = useRef(null);
const [color, setColor] = useState(COLORS[0]);
const [note, setNote] = useState('');
const [markers, setMarkers] = useState([]);
const [markerStyle, setMarkerStyle] = useState('numbers');
const [activeMarker, setActiveMarker] = useState(null);
const [dragMarker, setDragMarker] = useState(null);
const [pickerOpen, setPickerOpen] = useState(false);
const [payload, setPayload] = useState(null);
const [ready, setReady] = useState(false);
const [exportError, setExportError] = useState('');
const [zoom, setZoom] = useState(1);
const [mode, setMode] = useState('draw');
const [toolsOpen, setToolsOpen] = useState(true);

useEffect(() => {
if (!image || !image.dataUrl || !canvasRef.current) return;
let cancelled = false;
const source = new Image();
source.onload = () => {
if (cancelled || !canvasRef.current) return;
const canvas = canvasRef.current;
canvas.width = source.naturalWidth || 1;
canvas.height = source.naturalHeight || 1;
const ctx = canvas.getContext('2d');
ctx.drawImage(source, 0, 0);
setReady(true);
// Start at the fit-to-view zoom so the whole screenshot is visible
// (instead of a tall full-page capture overflowing the frame's top-left
// corner), then let the user zoom in to annotate. Runs on the next paint
// so the wrap has a measurable size.
requestAnimationFrame(fit);
};
source.src = image.dataUrl;
return () => { cancelled = true; };
}, [image]);
// Re-fit when the available canvas size changes (collapsing the tools panel,
// rotating the device, or a window resized). Only re-fit when the user has not
// deliberately zoomed in past the fit level — otherwise collapsing the tools
// panel would yank a magnified image back to full-page. Toggling the tools
// panel changes the wrap's height (it is flex:1), so this keeps the whole
// screenshot visible as the free space grows.
useEffect(() => {
const wrap = wrapRef.current;
const canvas = canvasRef.current;
if (!wrap || !canvas || !ready) return;
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
const tryFit = () => {
if (!wrapRef.current || !canvasRef.current) return;
const fitLevel = fitZoomFor(wrapRef.current, canvasRef.current);
// If the user is still at (or below) the previous fit, re-fit to the
// new size so the whole image stays visible. Otherwise leave it alone.
const current = zoomRef.current;
const prevFit = lastFitZoomRef.current;
const shouldRefit = current <= (prevFit != null ? prevFit : fitLevel) + 0.005;
if (shouldRefit) fit(false);
};
tryFit();
requestAnimationFrame(tryFit);
}) : null;
if (ro) ro.observe(wrap);
return () => { if (ro) ro.disconnect(); };
}, [ready]);

// Keep the selected marker's row visible inside the scrollable marker list
// instead of letting the list scroll past it (newly dragged dots land last).
useEffect(() => {
const list = markerListRef.current;
const row = activeMarkerRowRef.current;
if (!list || !row) return;
const top = row.offsetTop;
const bottom = top + row.offsetHeight;
if (top < list.scrollTop) list.scrollTop = top;
else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}, [activeMarker, markers.length]);

function applyZoom(value, focus) {
const wrap = wrapRef.current;
const canvas = canvasRef.current;
const before = canvas && canvas.getBoundingClientRect();
const next = clampZoom(value, fitZoomFor(wrap, canvas));
zoomRef.current = next;
setZoom(next);
if (!wrap || !before || !focus || before.width <= 0 || before.height <= 0) return;
const wrapRect = wrap.getBoundingClientRect();
const imageX = (focus.x - before.left) / before.width;
const imageY = (focus.y - before.top) / before.height;
const viewportX = focus.x - wrapRect.left;
const viewportY = focus.y - wrapRect.top;
requestAnimationFrame(() => {
const canvas = canvasRef.current;
if (!canvas || !wrap) return;
const after = canvas.getBoundingClientRect();
wrap.scrollLeft = Math.max(0, imageX * after.width - viewportX);
wrap.scrollTop = Math.max(0, imageY * after.height - viewportY);
});
}
function fit(resetScroll = true) {
const wrap = wrapRef.current;
const canvas = canvasRef.current;
if (!wrap || !canvas) return;
const next = clampZoom(fitZoomFor(wrap, canvas), MIN_ZOOM);
zoomRef.current = next;
setZoom(next);
lastFitZoomRef.current = next;
if (resetScroll) {
wrap.scrollLeft = 0;
wrap.scrollTop = 0;
}
}
function start(event) {
if (!ready || !canvasRef.current) return;
pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
try { canvasRef.current.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
if (pointersRef.current.size === 2) {
const points = Array.from(pointersRef.current.values());
pinchRef.current = { distance: distance(points[0], points[1]), zoom: zoomRef.current };
panRef.current = null;
drawingRef.current = false;
lastRef.current = null;
return;
}
if (mode === 'pan') {
const wrap = wrapRef.current;
panRef.current = wrap ? { x: event.clientX, y: event.clientY, left: wrap.scrollLeft, top: wrap.scrollTop } : null;
return;
}
drawingRef.current = true;
lastRef.current = pointFor(event, canvasRef.current);
}
function move(event) {
if (!pointersRef.current.has(event.pointerId) || !canvasRef.current) return;
pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
if (pointersRef.current.size >= 2 && pinchRef.current) {
const points = Array.from(pointersRef.current.values()).slice(0, 2);
const currentDistance = distance(points[0], points[1]);
if (pinchRef.current.distance > 0) {
applyZoom(pinchRef.current.zoom * (currentDistance / pinchRef.current.distance), midpoint(points[0], points[1]));
}
return;
}
if (mode === 'pan' && panRef.current && wrapRef.current) {
wrapRef.current.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
wrapRef.current.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
return;
}
if (!drawingRef.current || !lastRef.current) return;
const canvas = canvasRef.current;
const next = pointFor(event, canvas);
const ctx = canvas.getContext('2d');
ctx.strokeStyle = color;
ctx.lineWidth = Math.max(5, canvas.width / 180);
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.beginPath();
ctx.moveTo(lastRef.current.x, lastRef.current.y);
ctx.lineTo(next.x, next.y);
ctx.stroke();
lastRef.current = next;
}
function end(event) {
if (event && event.pointerId !== undefined) pointersRef.current.delete(event.pointerId);
if (pointersRef.current.size < 2) pinchRef.current = null;
panRef.current = null;
drawingRef.current = false;
lastRef.current = null;
}
function startMarkerDrag(event, markerId = null) {
if (!ready || (markerId === null && markers.length >= MAX_MARKERS)) return;
event.preventDefault();
event.stopPropagation();
const marker = markerId === null ? null : markers.find((item) => item.id === markerId);
markerDragRef.current = { markerId, pointerId: event.pointerId };
setDragMarker({
id: markerId,
label: markerLabel(markerId === null ? markers.length : markers.indexOf(marker), markerStyle),
color: marker ? marker.color : color,
clientX: event.clientX,
clientY: event.clientY
});
try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
}
function moveMarkerDrag(event) {
if (!markerDragRef.current || markerDragRef.current.pointerId !== event.pointerId) return;
event.preventDefault();
setDragMarker((current) => current ? { ...current, clientX: event.clientX, clientY: event.clientY } : current);
}
function endMarkerDrag(event) {
const drag = markerDragRef.current;
if (!drag || drag.pointerId !== event.pointerId) return;
event.preventDefault();
event.stopPropagation();
// Clamp to the image edges so a sloppy drag that spills off the stage
// still lands the dot on the image instead of silently dropping it.
const point = markerPoint(event, stageRef.current, true);
if (point) {
setMarkers((current) => {
if (drag.markerId !== null) return current.map((item) => item.id === drag.markerId ? { ...item, ...point } : item);
if (current.length >= MAX_MARKERS) return current;
const next = [...current, { id: Date.now() + Math.random(), ...point, color, text: '' }];
// Select the just-created dot so its row is highlighted and scrolled into
// view inside the marker list.
setActiveMarker(next[next.length - 1].id);
return next;
});
}
markerDragRef.current = null;
setDragMarker(null);
}
function updateMarkerText(id, text) {
setMarkers((current) => current.map((marker) => marker.id === id ? { ...marker, text } : marker));
}
function removeMarker(id) {
setMarkers((current) => {
const next = current.filter((marker) => marker.id !== id);
setActiveMarker((active) => active === id ? null : active);
return next;
});
}
function clearMarks() {
setReady(false);
setMarkers([]);
setActiveMarker(null);
const canvas = canvasRef.current;
if (!canvas) return;
const source = new Image();
source.onload = () => {
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
setReady(true);
};
source.src = image.dataUrl;
}
function resetImage() {
if (typeof onReset !== 'function' || !originalDataUrl) return;
onReset();
onClose();
}
function openPicker() {
const canvas = canvasRef.current;
if (!canvas || !ready) return;
setExportError('');
let dataUrl;
try {
const output = document.createElement('canvas');
output.width = canvas.width;
output.height = canvas.height;
const ctx = output.getContext('2d');
if (!ctx) throw new Error('Could not export the annotated image.');
ctx.drawImage(canvas, 0, 0);
markers.forEach((marker, index) => paintMarker(ctx, marker, markerLabel(index, markerStyle), canvas.width));
dataUrl = canvasToBoundedPngDataUrl(output);
} catch (error) {
setExportError(error && error.message ? error.message : 'Could not export the annotated image.');
return;
}
const markerNotes = markers.map((marker, index) => {
const label = markerLabel(index, markerStyle);
return marker.text.trim() ? label + '. ' + marker.text.trim() : label + '.';
});
const context = [sourceLabel, pageTitle || '', pageUrl || '', note.trim(), markerNotes.length ? 'Annotations:\n' + markerNotes.join('\n') : ''].filter(Boolean).join('\n');
const nextPayload = {
text: context,
textLabel: markers.length ? markers.length + ' matched annotation' + (markers.length === 1 ? '' : 's') : 'Inspector context',
image: {
type: 'image',
mimeType: 'image/png',
dataUrl,
name: 'draft-craft-inspector.png'
}
};
// When a composer callback is provided, hand the annotated image back
// directly (replace-in-place) instead of opening the chat-picker sheet.
if (onAnnotated) {
setPayload(nextPayload);
onAnnotated(nextPayload);
onClose();
return;
}
setPayload(nextPayload);
setPickerOpen(true);
}

const annotator = h('div', { class: 'draft-craft__annotator-overlay', role: 'presentation' },
h('section', { class: 'draft-craft__annotator', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Annotate Inspector image with Draft Craft' },
h('header', { class: 'draft-craft__annotator-head' },
h('div', null,
h('strong', null, 'Draft Craft'),
h('span', null, onAnnotated ? 'Draw on the attached image' : 'Draw on the Inspector image')
),
h('button', { type: 'button', class: 'draft-craft__close', onClick: onClose, 'aria-label': 'Close image annotator' }, '×')
),
h('div', { ref: wrapRef, class: 'draft-craft__canvas-wrap' + (mode === 'pan' ? ' is-panning' : '') },
h('div', { ref: stageRef, class: 'draft-craft__canvas-stage', style: { width: (zoom * 100) + '%' } },
h('canvas', {
ref: canvasRef,
class: 'draft-craft__canvas',
onPointerDown: start,
onPointerMove: move,
onPointerUp: end,
onPointerCancel: end,
onPointerLeave: end,
'aria-label': 'Inspector screenshot annotation canvas. Pinch with two fingers to zoom.'
}),
markers.map((marker, index) => h('button', {
key: marker.id,
type: 'button',
class: 'draft-craft__image-marker' + (dragMarker && dragMarker.id === marker.id ? ' is-dragging' : ''),
style: { left: (marker.x * 100) + '%', top: (marker.y * 100) + '%', background: marker.color, color: markerTextColor(marker.color) },
onPointerDown: (event) => startMarkerDrag(event, marker.id),
onPointerMove: moveMarkerDrag,
onPointerUp: endMarkerDrag,
onPointerCancel: endMarkerDrag,
'aria-label': 'Move annotation ' + markerLabel(index, markerStyle)
}, markerLabel(index, markerStyle)))
)
),
h('div', { class: 'draft-craft__annotator-tools' },
h('button', {
type: 'button',
class: 'draft-craft__tools-toggle',
'aria-expanded': String(toolsOpen),
'aria-controls': 'draftCraftToolsBody',
onClick: () => setToolsOpen((value) => !value)
},
h('span', { class: 'draft-craft__tools-toggle-label' }, 'Tools'),
h('span', { class: 'draft-craft__tools-toggle-hint' }, 'Annotate & zoom'),
h('span', { class: 'draft-craft__tools-toggle-chevron', 'aria-hidden': 'true' }, toolsOpen ? '⌄' : '⌃')
),
toolsOpen ? h('div', { id: 'draftCraftToolsBody', class: 'draft-craft__tools-body' },
h('div', { class: 'draft-craft__zoom', role: 'group', 'aria-label': 'Image zoom' },
h('button', { class: 'btn btn--small', type: 'button', onClick: () => applyZoom(zoomRef.current - 0.25), disabled: zoom <= fitZoomFor(wrapRef.current, canvasRef.current), 'aria-label': 'Zoom out' }, '−'),
h('span', { 'aria-live': 'polite' }, Math.round(zoom * 100) + '%'),
h('button', { class: 'btn btn--small', type: 'button', onClick: () => applyZoom(zoomRef.current + 0.25), disabled: zoom >= MAX_ZOOM, 'aria-label': 'Zoom in' }, '+'),
h('button', { class: 'btn btn--small', type: 'button', onClick: () => fit(), disabled: Math.abs(zoom - fitZoomFor(wrapRef.current, canvasRef.current)) < 0.005, 'aria-label': 'Show whole image', title: 'Fit image to view' }, 'Fit'),
h('button', { class: 'btn btn--small' + (mode === 'pan' ? ' is-active' : ''), type: 'button', onClick: () => setMode((value) => value === 'pan' ? 'draw' : 'pan'), 'aria-pressed': String(mode === 'pan') }, mode === 'pan' ? 'Draw' : 'Pan')
),
h('div', { class: 'draft-craft__colors', role: 'group', 'aria-label': 'Annotation color' },
COLORS.map((value) => h('button', {
key: value,
type: 'button',
class: 'draft-craft__color' + (value === color ? ' is-active' : ''),
style: { background: value },
'aria-label': 'Use ' + value,
'aria-pressed': String(value === color),
onClick: () => setColor(value)
}))
),
h('button', { class: 'btn btn--small', type: 'button', onClick: clearMarks, disabled: !ready }, 'Clear'),
h('section', { class: 'draft-craft__markers', 'aria-label': 'Matched image annotations' },
h('div', { class: 'draft-craft__marker-bar' },
h('div', null,
h('strong', null, 'Marker dots'),
h('span', null, 'Drag the next dot onto the image')
),
h('select', { class: 'input draft-craft__marker-style', value: markerStyle, onChange: (event) => setMarkerStyle(event.currentTarget.value), 'aria-label': 'Marker label style' },
h('option', { value: 'numbers' }, '1, 2, 3'),
h('option', { value: 'letters' }, 'A, B, C')
),
h('button', {
type: 'button',
class: 'draft-craft__marker-source',
style: { background: color, color: markerTextColor(color) },
disabled: !ready || markers.length >= MAX_MARKERS,
onPointerDown: startMarkerDrag,
onPointerMove: moveMarkerDrag,
onPointerUp: endMarkerDrag,
onPointerCancel: endMarkerDrag,
'aria-label': markers.length >= MAX_MARKERS ? 'Maximum markers reached' : 'Drag marker ' + markerLabel(markers.length, markerStyle) + ' onto image'
}, markers.length >= MAX_MARKERS ? '✓' : markerLabel(markers.length, markerStyle))
),
markers.length
// One row per dot in a vertically scrollable list: the label selects the
// dot, the row's own text field labels it, and the row's remove button
// deletes it. The list scrolls inside the tools panel so the canvas keeps
// its height no matter how many dots are placed.
? h('div', { class: 'draft-craft__marker-list', ref: markerListRef, role: 'list', 'aria-label': 'Marked image annotations' }, markers.map((marker, index) => {
const label = markerLabel(index, markerStyle);
const isActive = marker.id === activeMarker;
return h('div', {
key: marker.id,
ref: isActive ? activeMarkerRowRef : null,
role: 'listitem',
class: 'draft-craft__marker-row' + (isActive ? ' is-active' : '')
},
h('button', {
type: 'button',
class: 'draft-craft__marker-label',
style: { background: marker.color, color: markerTextColor(marker.color) },
onClick: () => setActiveMarker(marker.id),
'aria-pressed': String(isActive),
'aria-label': 'Select annotation ' + label + (marker.text.trim() ? ': ' + marker.text.trim() : ' (no text)')
}, label),
h('input', {
class: 'input draft-craft__marker-input',
value: marker.text,
onInput: (event) => updateMarkerText(marker.id, event.currentTarget.value),
placeholder: 'Text for ' + label,
'aria-label': 'Text for annotation ' + label
}),
h('button', { type: 'button', class: 'draft-craft__marker-remove', onClick: () => removeMarker(marker.id), 'aria-label': 'Remove annotation ' + label }, '×')
);
}))
: h('div', { class: 'draft-craft__marker-empty' }, 'No marker dots on the image yet.'),
),
h('textarea', { class: 'input draft-craft__note', rows: 2, value: note, onInput: (event) => setNote(event.currentTarget.value), placeholder: 'Optional note about this image', 'aria-label': 'Image note' })
) : null),
h('div', { class: 'draft-craft__annotator-foot' },
exportError ? h('span', { class: 'status', role: 'alert' }, exportError) : null,
originalDataUrl
? h('button', { class: 'btn btn--ghost', type: 'button', onClick: resetImage, disabled: !ready }, 'Reset')
: null,
h('button', { class: 'btn btn--primary', type: 'button', onClick: openPicker, disabled: !ready }, actionLabel)
)
),
dragMarker ? h('span', { class: 'draft-craft__drag-marker', style: { left: dragMarker.clientX + 'px', top: dragMarker.clientY + 'px', background: dragMarker.color, color: markerTextColor(dragMarker.color) }, 'aria-hidden': 'true' }, dragMarker.label) : null,
h(DraftCraftSheet, {
open: pickerOpen,
payload,
onClose: () => setPickerOpen(false),
onAdded: () => {
setPickerOpen(false);
onClose();
}
})
);
// Inspector sections animate into view, which creates a stacking context.
// Render the modal at the document root so the app dock cannot paint over it.
return typeof document === 'undefined' ? annotator : createPortal(annotator, document.body);
}
