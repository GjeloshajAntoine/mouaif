import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizedZone, zonePixels, differenceBounds, captureCanvas, exportCapture, captureAttachment, MAX_CAPTURE_FRAMES } from '../frontend/src/components/chat/screenCapture.js';

function frame(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; }
function pixel(image, x, y, rgb = 255) { const at = (y * image.width + x) * 4; image.data.set([rgb, rgb, rgb, 255], at); }
const before = frame(6, 5), after = frame(6, 5);
assert.equal(differenceBounds(before, after), null, 'identical frames are skipped');
pixel(after, 2, 2); pixel(after, 4, 3);
assert.deepEqual(differenceBounds(before, after), { x: 2, y: 2, width: 3, height: 2, changed: 2 });
assert.equal(differenceBounds(null, after), null, 'first frame is a baseline');
assert.equal(differenceBounds(frame(2, 2), after), null, 'resized source needs a new full image');
const statusOnly = frame(6, 5); pixel(statusOnly, 3, 0);
const top = { x: 0, y: 0, width: 1, height: 0.2 };
assert.equal(differenceBounds(before, statusOnly, [top]), null, 'ignored status-bar changes do not trigger capture');
pixel(statusOnly, 1, 4);
assert.deepEqual(differenceBounds(before, statusOnly, [top]), { x: 1, y: 4, width: 1, height: 1, changed: 1 });
const noise = frame(6, 5); pixel(noise, 2, 2, 24);
assert.equal(differenceBounds(before, noise), null, 'small colour noise is ignored');
pixel(noise, 2, 2, 25);
assert.equal(differenceBounds(before, noise).changed, 1);
assert.deepEqual(normalizedZone(0.9, 0.8, 0.1, 0.2), { x: 0.1, y: 0.2, width: 0.8, height: 0.6000000000000001 });
assert.deepEqual(normalizedZone(-1, -1, 2, 2), { x: 0, y: 0, width: 1, height: 1 });
assert.deepEqual(zonePixels(top, 6, 5), { x: 0, y: 0, right: 6, bottom: 1 });

const canvases = [];
function makeCanvas() {
  const calls = [];
  const canvas = { width: 0, height: 0, calls,
    getContext: () => ({ drawImage: (...args) => calls.push(['draw', ...args]), fillRect: (...args) => calls.push(['mask', ...args]) }),
    toDataURL: () => { calls.push(['encode']); return 'data:image/png;base64,AAAA'; }
  };
  canvases.push(canvas); return canvas;
}
const scaled = captureCanvas({ videoWidth: 2560, videoHeight: 1440 }, makeCanvas);
assert.equal(scaled.width, 1280); assert.equal(scaled.height, 720);
assert.throws(() => captureCanvas({ videoWidth: 0, videoHeight: 0 }, makeCanvas), /not ready/);
const source = { width: 6, height: 5 };
exportCapture(source, [top], null, makeCanvas);
assert.deepEqual(canvases.at(-1).calls.map((c) => c[0]), ['draw', 'mask', 'encode'], 'mask happens before encoding full image');
exportCapture(source, [top], { x: 2, y: 2, width: 3, height: 2 }, makeCanvas);
const masked = canvases.at(-2), cropped = canvases.at(-1);
assert.deepEqual(masked.calls.map((c) => c[0]), ['draw', 'mask']);
assert.equal(cropped.calls[0][1], masked, 'crop reads masked canvas, never raw pixels');
assert.equal(cropped.width, 3); assert.equal(cropped.height, 2);
assert.deepEqual(cropped.calls[0].slice(2), [2, 2, 3, 2, 0, 0, 3, 2]);
const attachment = captureAttachment('data:image/png;base64,AAAA', 1, { x: 2, y: 2, width: 3, height: 2 });
assert.equal(attachment.name, 'screen-2-changes-x2-y2-3x2.png');
assert.deepEqual(Object.keys(attachment), ['type', 'mimeType', 'dataUrl', 'name']);
assert.equal(MAX_CAPTURE_FRAMES, 8);

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const chat = read('frontend/src/components/chat/Chat.jsx');
assert.match(chat, /onOpenScreenCapture: \(\) => setScreenCaptureOpen\(true\)/);
assert.match(chat, /screenCaptureOpen && ScreenCapturePanel/);
assert.doesNotMatch(chat, /chat-view__capture|composerTools\.capture/, 'no standalone or gated capture button');
const toolbar = read('frontend/src/components/chat/FileToolbar.jsx');
assert.match(toolbar, /onClick: handleScreenCapture, 'aria-haspopup': 'dialog'/);
assert.match(toolbar, /function handleScreenCapture\(\) \{\s*setMenuOpen\(false\);\s*if \(onOpenScreenCapture\) onOpenScreenCapture\(\);/);
assert.match(chat, /await updateChat\([\s\S]*?!== true\) throw new Error/, 'failed save does not claim success');
const panel = read('frontend/src/components/chat/ScreenCapturePanel.jsx');
assert.match(panel, /getDisplayMedia\(\{ video: \{ frameRate: 1 \}, audio: false \}\)/);
assert.match(panel, /track\.stop\(\)/);
assert.match(panel, /clearInterval\(timer\)/);
assert.match(panel, /await onAttach\(chosen\.map/);
assert.doesNotMatch(panel, /new MediaRecorder|fetch\(/, 'no video recording or upload before confirmation');
assert.match(read('docs/README.md'), /features\/screen-capture\.md/);
console.log('screen capture: difference bounds, noise, masks, resize, cropping, image shape, and integration contracts passed');
