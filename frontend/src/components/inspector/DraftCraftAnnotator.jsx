// Draft Craft image annotator for the Inspector preview.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DraftCraftSheet } from '../DraftCraftSheet.jsx';

const COLORS = ['#ff5f57', '#ffd60a', '#32d74b', '#0a84ff'];
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
function clampZoom(value) {
return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}
function pointFor(event, canvas) {
const rect = canvas.getBoundingClientRect();
return {
x: (event.clientX - rect.left) * (canvas.width / rect.width),
y: (event.clientY - rect.top) * (canvas.height / rect.height)
};
}
function midpoint(a, b) {
return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function distance(a, b) {
return Math.hypot(b.x - a.x, b.y - a.y);
}

export function DraftCraftAnnotator({ image, pageTitle, pageUrl, onClose }) {
const canvasRef = useRef(null);
const wrapRef = useRef(null);
const drawingRef = useRef(false);
const lastRef = useRef(null);
const pointersRef = useRef(new Map());
const pinchRef = useRef(null);
const panRef = useRef(null);
const zoomRef = useRef(1);
const [color, setColor] = useState(COLORS[0]);
const [note, setNote] = useState('');
const [pickerOpen, setPickerOpen] = useState(false);
const [payload, setPayload] = useState(null);
const [ready, setReady] = useState(false);
const [zoom, setZoom] = useState(1);
const [mode, setMode] = useState('draw');

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
};
source.src = image.dataUrl;
return () => { cancelled = true; };
}, [image]);

function applyZoom(value, focus) {
const wrap = wrapRef.current;
const before = canvasRef.current && canvasRef.current.getBoundingClientRect();
const next = clampZoom(value);
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
function clearMarks() {
setReady(false);
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
function openPicker() {
const canvas = canvasRef.current;
if (!canvas || !ready) return;
const context = ['Inspector image', pageTitle || '', pageUrl || '', note.trim()].filter(Boolean).join('\n');
setPayload({
text: context,
textLabel: 'Inspector context',
image: {
type: 'image',
mimeType: 'image/png',
dataUrl: canvas.toDataURL('image/png'),
name: 'draft-craft-inspector.png'
}
});
setPickerOpen(true);
}

return h('div', { class: 'draft-craft__annotator-overlay', role: 'presentation' },
h('section', { class: 'draft-craft__annotator', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Annotate Inspector image with Draft Craft' },
h('header', { class: 'draft-craft__annotator-head' },
h('div', null,
h('strong', null, 'Draft Craft'),
h('span', null, 'Draw on the Inspector image')
),
h('button', { type: 'button', class: 'draft-craft__close', onClick: onClose, 'aria-label': 'Close image annotator' }, '×')
),
h('div', { ref: wrapRef, class: 'draft-craft__canvas-wrap' + (mode === 'pan' ? ' is-panning' : '') },
h('canvas', {
ref: canvasRef,
class: 'draft-craft__canvas',
style: { width: (zoom * 100) + '%' },
onPointerDown: start,
onPointerMove: move,
onPointerUp: end,
onPointerCancel: end,
onPointerLeave: end,
'aria-label': 'Inspector screenshot annotation canvas. Pinch with two fingers to zoom.'
})
),
h('div', { class: 'draft-craft__annotator-tools' },
h('div', { class: 'draft-craft__zoom', role: 'group', 'aria-label': 'Image zoom' },
h('button', { class: 'btn btn--small', type: 'button', onClick: () => applyZoom(zoomRef.current - 0.25), disabled: zoom <= MIN_ZOOM, 'aria-label': 'Zoom out' }, '−'),
h('span', { 'aria-live': 'polite' }, Math.round(zoom * 100) + '%'),
h('button', { class: 'btn btn--small', type: 'button', onClick: () => applyZoom(zoomRef.current + 0.25), disabled: zoom >= MAX_ZOOM, 'aria-label': 'Zoom in' }, '+'),
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
h('textarea', { class: 'input draft-craft__note', rows: 2, value: note, onInput: (event) => setNote(event.currentTarget.value), placeholder: 'Optional note about this image', 'aria-label': 'Image note' }),
h('button', { class: 'btn btn--primary', type: 'button', onClick: openPicker, disabled: !ready }, 'Add to chat draft')
)
),
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
}
