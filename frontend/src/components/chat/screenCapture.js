// Local-only screen capture processing. No recording or network calls.
import { canvasToBoundedPngDataUrl } from './annotation.js';

export const MAX_CAPTURE_FRAMES = 8;
export const MAX_CAPTURE_EDGE = 1280;
export const MAX_IGNORE_ZONES = 8;

export function normalizedZone(x1, y1, x2, y2) {
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const left = clamp(Math.min(x1, x2));
  const top = clamp(Math.min(y1, y2));
  return { x: left, y: top, width: clamp(Math.max(x1, x2)) - left, height: clamp(Math.max(y1, y2)) - top };
}

export function zonePixels(zone, width, height) {
  return {
    x: Math.floor(zone.x * width), y: Math.floor(zone.y * height),
    right: Math.ceil((zone.x + zone.width) * width),
    bottom: Math.ceil((zone.y + zone.height) * height)
  };
}

// Bounding rectangle of meaningful RGB changes. Alpha is not compared: screen
// frames are opaque. Small colour fluctuations below tolerance are ignored.
export function differenceBounds(previous, current, zones = [], tolerance = 24) {
  if (!previous || previous.width !== current.width || previous.height !== current.height) return null;
  const { width, height, data } = current;
  const masks = zones.map((zone) => zonePixels(zone, width, height));
  let left = width, top = height, right = -1, bottom = -1, changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (masks.some((r) => x >= r.x && x < r.right && y >= r.y && y < r.bottom)) continue;
      const at = (y * width + x) * 4;
      if (Math.max(Math.abs(data[at] - previous.data[at]), Math.abs(data[at + 1] - previous.data[at + 1]), Math.abs(data[at + 2] - previous.data[at + 2])) <= tolerance) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
      changed += 1;
    }
  }
  return changed ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1, changed } : null;
}

export function captureCanvas(source, makeCanvas = () => document.createElement('canvas')) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) throw new Error('The screen is not ready yet. Try Capture again.');
  const ratio = Math.min(1, MAX_CAPTURE_EDGE / Math.max(width, height));
  const canvas = makeCanvas();
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Screen capture is unavailable in this browser.');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function frameDifference(previous, current, zones) {
  if (!previous || previous.width !== current.width || previous.height !== current.height) return null;
  return differenceBounds(
    previous.getContext('2d').getImageData(0, 0, previous.width, previous.height),
    current.getContext('2d').getImageData(0, 0, current.width, current.height), zones
  );
}

// Masks are applied BEFORE cropping/encoding. Raw frames never become draft
// attachments, so ignored pixels cannot leak through a full-image choice.
export function exportCapture(canvas, zones, bounds = null, makeCanvas = () => document.createElement('canvas')) {
  const masked = makeCanvas();
  masked.width = canvas.width; masked.height = canvas.height;
  const ctx = masked.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the captured image.');
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = '#000';
  for (const zone of zones) {
    const r = zonePixels(zone, canvas.width, canvas.height);
    ctx.fillRect(r.x, r.y, r.right - r.x, r.bottom - r.y);
  }
  if (!bounds) return canvasToBoundedPngDataUrl(masked, { makeCanvas });
  const crop = makeCanvas();
  crop.width = bounds.width; crop.height = bounds.height;
  const cropCtx = crop.getContext('2d');
  if (!cropCtx) throw new Error('Could not prepare the changed area.');
  cropCtx.drawImage(masked, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  return canvasToBoundedPngDataUrl(crop, { makeCanvas });
}

// Review edits (selection, output) must not re-read pixels or re-encode PNGs,
// so results are cached per canvas. Entries are keyed by the zones array
// identity: any zone change invalidates them. Discarded canvases are released
// with their entries.
export function createCaptureCache({ difference = frameDifference, encode = exportCapture } = {}) {
  const diffs = new WeakMap(), exports = new WeakMap();
  function entry(map, canvas, zones, make) {
    let found = map.get(canvas);
    if (!found || found.zones !== zones) { found = { zones, results: make() }; map.set(canvas, found); }
    return found.results;
  }
  return {
    difference(before, canvas, zones) {
      const results = entry(diffs, canvas, zones, () => new WeakMap());
      if (!results.has(before)) results.set(before, difference(before, canvas, zones));
      return results.get(before);
    },
    export(canvas, zones, bounds = null) {
      const results = entry(exports, canvas, zones, () => new Map());
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'full';
      if (!results.has(key)) results.set(key, encode(canvas, zones, bounds));
      return results.get(key);
    }
  };
}

// A changed-area image is compared with the latest earlier image that will be
// attached, so a crop never depends on an image the AI won't see. With no
// earlier image selected, it falls back to the previous capture.
export function prepareReview(frames, zones, cache) {
  let attached = -1;
  return frames.map((frame, index) => {
    const reference = attached >= 0 ? attached : index - 1;
    const before = frames[reference]?.canvas;
    const sameSize = !!before && before.width === frame.canvas.width && before.height === frame.canvas.height;
    const bounds = sameSize ? cache.difference(before, frame.canvas, zones) : null;
    const unchanged = sameSize && !bounds;
    const crop = frame.output === 'changes' && bounds ? bounds : null;
    let prepared;
    try {
      prepared = { ...frame, reference: sameSize ? reference : null, bounds: crop, unchanged, dataUrl: cache.export(frame.canvas, zones, crop), eligible: frame.output === 'full' || !unchanged };
    } catch (e) { prepared = { ...frame, eligible: false, exportError: e.message }; }
    if (prepared.selected && prepared.eligible) attached = index;
    return prepared;
  });
}

export function captureAttachment(dataUrl, index, bounds = null) {
  const suffix = bounds ? `-changes-x${bounds.x}-y${bounds.y}-${bounds.width}x${bounds.height}` : '-full';
  return { type: 'image', mimeType: 'image/png', dataUrl, name: `screen-${index + 1}${suffix}.png` };
}
