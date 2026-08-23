// Draft Craft image annotator for the Inspector preview.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DraftCraftSheet } from '../DraftCraftSheet.jsx';

const COLORS = ['#ff5f57', '#ffd60a', '#32d74b', '#0a84ff'];

function pointFor(event, canvas) {
const rect = canvas.getBoundingClientRect();
return {
x: (event.clientX - rect.left) * (canvas.width / rect.width),
y: (event.clientY - rect.top) * (canvas.height / rect.height)
};
}

export function DraftCraftAnnotator({ image, pageTitle, pageUrl, onClose }) {
const canvasRef = useRef(null);
const drawingRef = useRef(false);
const lastRef = useRef(null);
const [color, setColor] = useState(COLORS[0]);
const [note, setNote] = useState('');
const [pickerOpen, setPickerOpen] = useState(false);
const [payload, setPayload] = useState(null);
const [ready, setReady] = useState(false);

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

function start(event) {
if (!ready || !canvasRef.current) return;
drawingRef.current = true;
lastRef.current = pointFor(event, canvasRef.current);
try { canvasRef.current.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
}
function move(event) {
if (!drawingRef.current || !canvasRef.current || !lastRef.current) return;
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
function end() {
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
h('div', { class: 'draft-craft__canvas-wrap' },
h('canvas', {
ref: canvasRef,
class: 'draft-craft__canvas',
onPointerDown: start,
onPointerMove: move,
onPointerUp: end,
onPointerCancel: end,
onPointerLeave: end,
'aria-label': 'Inspector screenshot annotation canvas'
})
),
h('div', { class: 'draft-craft__annotator-tools' },
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
