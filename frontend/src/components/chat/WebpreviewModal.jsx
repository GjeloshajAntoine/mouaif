// mouaif web — Webpreview modal (redesigned full-screen viewer)
//
// Renders the latest screenshot the `webpreview` tool captured. The
// same full-screen overlay pattern as the Git modal: dark backdrop,
// a single sheet that fills the viewport on a phone and grows to a
// centered card on tablet/desktop. Tapping the backdrop, the close
// button, or pressing Escape all dismiss the viewer.
//
// Header: page title with a short host sub-line, a "Refresh" button that
// re-captures the current URL at the chosen size, the Size dropdown, and a
// close button. Body: the screenshot, centered, object-fit:contain so a
// tall page keeps its full strip visible without horizontal scroll. Footer:
// small metadata (dimensions, size, capture time), a Screenshot / Live
// toggle, and an "Open in new tab" link.
//
// Live mode swaps the screenshot for an unrestricted <iframe> of the same
// URL (any scheme, no sandbox, every permission delegated), sized to the
// selected viewport and scaled down to fit the sheet. It is loaded by the
// user's own browser, not the server's debug Chrome. In Live mode Refresh
// reloads the frame and the Size control resizes it — no capture runs.
// A payload the agent published with mode: "live" has no screenshot and
// always opens in Live mode.
//
// Props:
//   preview     { url, title, thumbnail, width, height, sizeBytes, capturedAt, viewport }
//   onClose     () => void
//   onRecapture (viewport?) => void  — wired by ChatView to re-run the
//                               capture at the chosen resolution. `viewport`
//                               is a preset id or a 'WIDTHxHEIGHT' string.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';
import { FRAME_ALLOW, frameScale as fitScale, isLivePayload, viewportDims } from './webpreviewFrame.js';
// Keep this small list aligned with VIEWPORTS in src/tools/webpreview.js.
const VIEWPORT_PRESETS = [
  { id: 'phone', label: 'Phone', width: 375, height: 667 },
  { id: 'phone+', label: 'Phone+', width: 414, height: 896 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 }
];
const CUSTOM_VIEWPORT_ID = 'custom';
// Screenshot vs Live (iframe) view, remembered across opens.
const VIEW_MODE_KEY = 'mouaif.webpreview.viewMode';
const VIEW_MODES = [
  { id: 'image', label: 'Screenshot' },
  { id: 'live', label: 'Live' }
];
function readViewMode() {
  try { return localStorage.getItem(VIEW_MODE_KEY) === 'live' ? 'live' : 'image'; } catch { return 'image'; }
}
function writeViewMode(mode) {
  try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
}
// Custom sizes have no range limit (the server passes them to Chrome as-is);
// only a positive whole number is required.
const MIN_VIEWPORT_DIM = 1;
// Native selects open the platform's touch-friendly picker on phones. Custom
// captures share one stable option; their exact dimensions live in the fields
// shown below the header.
function SizeSelect({ value, onChange, busy }) {
  const isPreset = VIEWPORT_PRESETS.some((preset) => preset.id === value);
  return h('select', {
    class: 'wp__size-select',
    value: isPreset ? value : CUSTOM_VIEWPORT_ID,
    disabled: busy,
    'aria-label': 'Capture size',
    onChange: (event) => onChange && onChange(event.currentTarget.value)
  },
    VIEWPORT_PRESETS.map((preset) => h('option', { key: preset.id, value: preset.id },
      preset.label + ' · ' + preset.width + '×' + preset.height
    )),
    h('option', { value: CUSTOM_VIEWPORT_ID }, 'Custom')
  );
}

export function WebpreviewModal({ preview, onClose, onRecapture }) {
  // One value is enough: a preset id or a custom WIDTHxHEIGHT string.
  const initialViewport = viewportValue(preview && preview.viewport);
  const initialCustomSize = customSizeFromViewport(initialViewport, preview);
  const [selectedViewport, setSelectedViewport] = useState(initialViewport);
  const [customWidth, setCustomWidth] = useState(String(initialCustomSize.width));
  const [customHeight, setCustomHeight] = useState(String(initialCustomSize.height));
  const [customError, setCustomError] = useState('');
  // An agent-requested live preview opens live; otherwise the stored choice.
  const [viewMode, setViewModeState] = useState(() => (isLivePayload(preview) ? 'live' : readViewMode()));
  const [frameKey, setFrameKey] = useState(0);
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 });
  const bodyRef = useRef(null);
  // Escape, the Tab cycle and focus restore come from the shared sheet hook
  // (frontend/src/hooks/useModal.js); the backdrop and the close button are
  // this component's own.
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  // Defensive: render the modal shell even when the preview payload
  // is missing — the close button still has to work and the body
  // shows the model-facing error so the user knows nothing useful
  // was returned.
  const url = (preview && preview.url) || '';
  const title = (preview && preview.title) || url || 'Web preview';
  const thumbnail = preview && preview.thumbnail;
  const width = preview && preview.width;
  const height = preview && preview.height;
  const sizeBytes = preview && preview.sizeBytes;
  const capturedAt = preview && preview.capturedAt;
  const host = hostFromUrl(url);
  // Live works for any URL. Screenshot needs a capture: a live-only payload
  // switching to Screenshot runs one through onRecapture.
  const live = viewMode === 'live' && !!url;
  function setViewMode(mode) {
    setViewModeState(mode);
    writeViewMode(mode);
    if (mode === 'image' && !thumbnail && url && onRecapture) {
      captureAt(selectedViewport);
    }
  }
  // The agent can switch an open viewer to Live by publishing a live payload
  // (webpreview mode: "live"); follow it and its viewport.
  const liveStamp = isLivePayload(preview) ? (preview.capturedAt || preview.url) : '';
  useEffect(() => {
    if (!liveStamp) return;
    setViewModeState('live');
    setSelectedViewport(viewportValue(preview && preview.viewport));
    setFrameKey((k) => k + 1);
  }, [liveStamp]);
  // Track the body box so the live frame can be scaled to fit it.
  useEffect(() => {
    if (!live) return undefined;
    const el = bodyRef.current;
    if (!el) return undefined;
    const measure = () => setBodySize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live]);
    function onBackdropClick(e) {
    // Only close when the tap lands on the backdrop itself, not on
    // the sheet. Same pattern as the Git modal.
    if (e.target === e.currentTarget && onClose) onClose();
  }
  // Re-capture at the current (or a newly chosen) resolution. `idOrString`
// is a preset id or a 'WIDTHxHEIGHT' string. The local flag keeps the
// controls disabled while the capture runs.
const [recapturing, setRecapturing] = useState(false);
  async function onRecaptureClick(nextViewport) {
    if (live) {
      // Live frame: resize or reload in place, no screenshot capture.
      if (nextViewport && nextViewport !== selectedViewport) setSelectedViewport(nextViewport);
      else setFrameKey((k) => k + 1);
      return;
    }
    return captureAt(nextViewport);
  }
  async function captureAt(nextViewport) {
    if (recapturing || !onRecapture) return;
    const previousViewport = selectedViewport;
    const viewport = nextViewport || selectedViewport || 'phone';
    setSelectedViewport(viewport);
    setRecapturing(true);
    try {
      const out = await onRecapture(viewport);
      if (!out || !out.ok) setSelectedViewport(previousViewport);
    } catch {
      setSelectedViewport(previousViewport);
    } finally {
      setRecapturing(false);
    }
  }
  function onSizeChange(nextViewport) {
    setCustomError('');
    if (nextViewport === CUSTOM_VIEWPORT_ID) {
      setSelectedViewport(customWidth + 'x' + customHeight);
      return;
    }
    onRecaptureClick(nextViewport);
  }
  function onCustomSubmit(event) {
    event.preventDefault();
    const widthValue = parseCustomDimension(customWidth);
    const heightValue = parseCustomDimension(customHeight);
    if (!widthValue || !heightValue) {
      setCustomError('Enter a positive whole number for width and height.');
      return;
    }
    setCustomError('');
    onRecaptureClick(widthValue + 'x' + heightValue);
  }
  const isCustomViewport = !VIEWPORT_PRESETS.some((preset) => preset.id === selectedViewport);
  const meta = [];
  const frameDims = viewportDims(selectedViewport, preview, VIEWPORT_PRESETS);
  const safeScale = fitScale(frameDims, bodySize, 16);
  if (live) {
    meta.push('live · ' + frameDims.width + ' × ' + frameDims.height);
    if (safeScale < 1) meta.push(Math.round(safeScale * 100) + '%');
  }
  else if (width && height) meta.push(width + ' × ' + height);
  if (!live && preview && preview.viewport && preview.viewport.label) meta.push('viewport ' + preview.viewport.label);
  if (!live && sizeBytes) meta.push(formatBytes(sizeBytes));
  if (!live && capturedAt) meta.push('captured ' + formatTime(capturedAt));
  return h('div', {
    class: 'wp__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    onClick: onBackdropClick
  },
    h('div', { class: 'wp__sheet', ref: sheetRef },
h('div', { class: 'wp__head' },
h('div', { class: 'wp__head-text' },
h('div', { class: 'wp__title', title: title }, title || 'Web preview'),
h('div', { class: 'wp__title-sub' }, host)
),
h('div', { class: 'wp__head-actions' },
h('button', {
class: 'wp__action wp__action--refresh',
type: 'button',
disabled: recapturing,
onClick: () => onRecaptureClick(selectedViewport),
'aria-label': live ? 'Reload live page' : 'Refresh preview',
title: live ? 'Reload live page' : 'Refresh preview'
},
h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
h('path', { d: 'M4 12a8 8 0 0 1 13.66-5.66L20 4 M20 4v5h-5 M20 12a8 8 0 0 1-13.66 5.66L4 20 M4 20v-5h5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
),
h('span', null, 'Refresh')
),
          h(SizeSelect, {
            value: selectedViewport,
            busy: recapturing,
            onChange: onSizeChange
          }),
          h('button', {
class: 'wp__close',
type: 'button',
'aria-label': 'Close preview',
title: 'Close preview',
onClick: () => onClose && onClose()
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
)
)
)
      ),
      isCustomViewport
        ? h('form', { class: 'wp__custom-size', onSubmit: onCustomSubmit },
            h('label', { class: 'wp__custom-field' },
              h('span', null, 'Width'),
              h('input', {
                class: 'wp__custom-input',
                type: 'number',
                inputMode: 'numeric',
                min: MIN_VIEWPORT_DIM,
                step: 1,
                value: customWidth,
                disabled: recapturing,
                onInput: (event) => setCustomWidth(event.currentTarget.value),
                'aria-label': 'Custom preview width'
              })
            ),
            h('span', { class: 'wp__custom-times', 'aria-hidden': 'true' }, '×'),
            h('label', { class: 'wp__custom-field' },
              h('span', null, 'Height'),
              h('input', {
                class: 'wp__custom-input',
                type: 'number',
                inputMode: 'numeric',
                min: MIN_VIEWPORT_DIM,
                step: 1,
                value: customHeight,
                disabled: recapturing,
                onInput: (event) => setCustomHeight(event.currentTarget.value),
                'aria-label': 'Custom preview height'
              })
            ),
            h('button', { class: 'wp__custom-apply', type: 'submit', disabled: recapturing }, 'Apply'),
            customError ? h('div', { class: 'wp__custom-error', role: 'alert' }, customError) : null
          )
        : null,
      h('div', { class: 'wp__body' + (live ? ' wp__body--live' : ''), ref: bodyRef },
        live
          ? h('div', {
              class: 'wp__frame-box',
              style: { width: Math.floor(frameDims.width * safeScale) + 'px', height: Math.floor(frameDims.height * safeScale) + 'px' }
            },
              h('iframe', {
                key: frameKey,
                class: 'wp__frame',
                src: url,
                title: 'Live preview of ' + url,
                allow: FRAME_ALLOW,
                allowFullScreen: true,
                loading: 'eager',
                style: {
                  width: frameDims.width + 'px',
                  height: frameDims.height + 'px',
                  transform: safeScale < 1 ? 'scale(' + safeScale + ')' : 'none'
                }
              })
            )
          : thumbnail
          ? h('img', {
              class: 'wp__img',
              src: thumbnail,
              alt: title || ('Preview of ' + url),
              draggable: 'false',
              decoding: 'async'
            })
          : h('div', { class: 'wp__empty' },
              h('p', null, 'No preview available.'),
              h('p', { class: 'wp__empty-hint' }, 'The webpreview call finished without a captured image.')
            )
      ),
      h('div', { class: 'wp__foot' },
        url
          ? h('div', { class: 'wp__mode', role: 'group', 'aria-label': 'Preview mode' },
              VIEW_MODES.map((m) => h('button', {
                key: m.id,
                type: 'button',
                class: 'wp__mode-btn' + ((live ? 'live' : 'image') === m.id ? ' wp__mode-btn--on' : ''),
                'aria-pressed': String((live ? 'live' : 'image') === m.id),
                onClick: () => setViewMode(m.id)
              }, m.label))
            )
          : null,
        h('span', { class: 'wp__foot-meta' }, meta.filter(Boolean).join(' · ')),
        url
          ? h('a', {
              class: 'wp__open-link',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': 'Open ' + url + ' in a new tab'
            }, 'Open in new tab')
          : null
      )
    )
  );
}
function viewportValue(vp) {
  if (!vp) return 'phone';
  if (VIEWPORT_PRESETS.some((preset) => preset.id === vp.id)) return vp.id;
  if (vp.width && vp.height) return vp.width + 'x' + vp.height;
  return 'phone';
}
function customSizeFromViewport(value, preview) {
  const match = typeof value === 'string' && value.match(/^(\d+)x(\d+)$/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return {
    width: (preview && preview.width) || 375,
    height: (preview && preview.height) || 667
  };
}
function parseCustomDimension(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_VIEWPORT_DIM) return 0;
  return parsed;
}
function hostFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname || '';
  } catch { return ''; }
}
function formatBytes(b) {
  if (!b || !isFinite(b) || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}