// Inspector PreviewPanel — live page screenshot capture
//
// The capture loop grabs the full-page screenshot (captureBeyondViewport,
// so the shot is as tall as the page's scrollable content, not just the
// viewport) and displays it inside a scrollable frame. The image is
// rendered at its natural pixel size, so panning through the frame
// scrolls the actual page content.
//
// Capture triggers (no fixed timer, no busy polling):
//   - Page.frameNavigated   — the frame navigated to a new document.
//   - Page.frameStoppedLoading — a frame's load settled.
//   - a slow fallback poll (every 3 s) so in-page state changes
//     (scroll position, hover, click-driven DOM mutations, SPA route
//     changes that don't fire frameNavigated) still show up.
//   - a manual "Refresh preview" button in the panel header.
import { h, Fragment } from 'preact';
import { createPortal } from 'preact/compat';
import { useRef, useEffect, useState } from 'preact/hooks';

export function PreviewPanel(props) {
const frameRef = useRef(null);
const imgRef = useRef(null);
// Type bar — full text input into the inspected page. The user taps a
// text field in the live preview (clickAt focuses it), then types in
// this bar and we forward the string with Input.insertText. A separate
// Enter button sends a real keypress so forms submit / textareas get a
// newline. The bar sits between the preview and the status line so it
// never covers the screenshot. Props flow in from InspectorView's
// renderPanelBody: onInsert / onEnter, plus a pending flag we toggle
// while a send is in flight.
const typeInputRef = useRef(null);
const [typeValue, setTypeValue] = useState('');
const [typePending, setTypePending] = useState(false);
const typePanelRef = useRef(null);
if (props.typeBarRef) props.typeBarRef.current = {
open: () => {
if (typePanelRef.current) typePanelRef.current.scrollIntoView({ block: 'nearest' });
if (typeInputRef.current) typeInputRef.current.focus();
}
};
async function submitType(value, enter) {
if (typePending) return;
const text = (value == null ? typeValue : value);
if (!text && !enter) return;
setTypePending(true);
try {
if (enter) {
if (props.onEnter) await props.onEnter();
} else {
if (props.onInsert) await props.onInsert(text);
setTypeValue('');
}
// The page's DOM changed; nudge a fresh screenshot so the user sees
// the typed text / submitted form immediately instead of waiting for
// the 3 s fallback poll. Guarded so a missing refresh handler (or a
// manual refresh already in flight) is a silent no-op.
if (props.refreshRef && props.refreshRef.current) props.refreshRef.current();
} finally {
setTypePending(false);
}
}
function onTypeSubmit(event) {
event.preventDefault();
submitType(typeValue, false);
}
  // Full-screen mode swaps the in-panel frame for a viewport-spanning
  // overlay (portal to document.body so the app dock can't paint over
  // it). The same capture loop keeps running because the panel stays
  // mounted; the overlay just shows a larger copy of the same live
  // screenshot and keeps tap-to-click working.
  const fsFrameRef = useRef(null);
  const fsImgRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
// Close the full-screen overlay on Escape (mirrors the webpreview /
// Git / CLI overlay behaviour). Only listens while it is open so the
// capture loop and the rest of the Inspector keep normal key handling.
useEffect(() => {
if (!fullscreen) return;
function onKey(e) {
if (e.key === 'Escape') {
e.stopPropagation();
setFullscreen(false);
}
}
document.addEventListener('keydown', onKey, true);
return () => document.removeEventListener('keydown', onKey, true);
}, [fullscreen]);
const [imgSrc, setImgSrc] = useState('');
  const [note, setNote] = useState('capturing…');
  // Cache the last successfully decoded image dimensions. Clicks that
  // land while a new screenshot is still decoding (naturalWidth === 0)
  // fall back to these so the tap-to-page mapping is still accurate —
  // the page's intrinsic size is essentially constant between captures,
  // so the previous frame's natural size is a safe approximation.
  const lastDims = useRef({ w: 0, h: 0 });
  const latestImage = useRef(null);

  useEffect(() => {
    if (!props.capture) return;
    let stop = false;
    let inFlight = false;
    let pendingTimer = null;
    let lastCaptureAt = 0;
    let pendingRevoke = null;
    // Keep one event-driven capture queued while Chrome is already taking
    // a screenshot. Reload emits frameNavigated before the new document is
    // ready, then frameStoppedLoading while that first capture can still be
    // in flight. Dropping the latter leaves the transient blank document in
    // the preview until the fallback poll; queueing it makes loaded content
    // replace that frame immediately. Manual refresh takes precedence.
    let queuedCapture = null;

    function scheduleFallback() {
      if (pendingTimer) clearTimeout(pendingTimer);
      // Slow fallback poll: 3 s. The fallback is skipped entirely if
      // a capture landed recently (event-driven captures reset the
      // counter) so we never busy-poll during a navigation burst.
      const sinceLast = Date.now() - lastCaptureAt;
      const wait = sinceLast >= 3000 ? 500 : (3000 - sinceLast);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (stop) return;
        // If an event-driven capture is already in flight, skip this
        // tick — the in-flight one will cover it.
        if (inFlight) { scheduleFallback(); return; }
        runCapture('poll');
        scheduleFallback();
      }, wait);
    }

    async function runCapture(reason, force) {
      // Lifecycle captures and manual refreshes must survive an in-flight
      // screenshot. In particular, keep the load-complete capture emitted
      // during reload so the preview cannot remain on the transient blank
      // frame. Polls are disposable; the next fallback tick covers them.
      if (stop) return;
      if (inFlight) {
        if (force || reason !== 'poll') {
          if (force || !queuedCapture || !queuedCapture.force) {
            queuedCapture = { reason, force: !!force };
          }
        }
        return;
      }
      inFlight = true;
      try {
        const r = await props.capture();
        if (stop) return;
        lastCaptureAt = Date.now();
        // Make sure the fallback is scheduled even if the trigger that
        // woke us up didn't schedule it itself (e.g. the very first
        // 'init' capture, or a capture started while another was
        // already in flight and the new event was coalesced).
        scheduleFallback();
                if (!r || !r.data) {
          // Page.captureScreenshot can briefly return no image after
          // Page.enable or while navigation is replacing the document.
          // Preserve an existing preview as live; otherwise keep the
          // initial capturing state while the fallback retries.
          setNote(imgRef.current && imgRef.current.src ? 'live' : 'capturing…');
          return;
        }
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        latestImage.current = { dataUrl: 'data:image/jpeg;base64,' + r.data, width: 0, height: 0 };
        const next = URL.createObjectURL(blob);
        const img = imgRef.current;
        const frame = frameRef.current;
        if (img && frame) {
          // Keep the user's scroll position when a new screenshot
          // replaces the old one — otherwise the frame would snap
          // back to the top on every refresh.
          const prevTop = frame.scrollTop || 0;
          const prevLeft = frame.scrollLeft || 0;
          // Swap src in place. Reusing the same <img> node avoids
          // the re-mount + decode window that a brand-new <img>
          // would force (and which was the reason clicks on a
          // just-refreshed preview used to silently no-op:
          // naturalWidth was 0 for a frame or two).
          const prevOnload = img.onload;
          img.onload = () => {
            if (frameRef.current) {
              frameRef.current.scrollTop = prevTop;
              frameRef.current.scrollLeft = prevLeft;
            }
            const cur = imgRef.current;
            if (cur) {
              lastDims.current.w = cur.naturalWidth || lastDims.current.w;
              lastDims.current.h = cur.naturalHeight || lastDims.current.h;
              if (latestImage.current) {
                latestImage.current.width = cur.naturalWidth || 0;
                latestImage.current.height = cur.naturalHeight || 0;
              }
              cur.onload = prevOnload || null;
            }
          };
          // Defer revoking the previous URL until the new one has
          // actually decoded — revoking too early used to abort
          // the in-flight decode and show a blank frame.
          if (pendingRevoke) URL.revokeObjectURL(pendingRevoke);
          pendingRevoke = next;
          img.src = next;
          setImgSrc(next);
          setNote('live');
        } else {
          // No img node yet (first render before commit) — fall
          // back to setting state so React mounts the element on
          // the next pass, then we'll swap src on the tick after.
          if (pendingRevoke) URL.revokeObjectURL(pendingRevoke);
          pendingRevoke = next;
          setImgSrc(next);
          setNote('live');
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        // If the socket isn't open yet, stay in 'capturing…' and let the fallback retry
        if (msg === 'not connected' || msg === 'disconnected') {
          setNote('capturing…');
        } else {
          setNote('screenshot failed: ' + msg);
        }
      } finally {
        inFlight = false;
        // Run the newest meaningful trigger after the current screenshot.
        // This covers reload completion as well as a pressed manual refresh.
        if (queuedCapture && !stop) {
          const queued = queuedCapture;
          queuedCapture = null;
          runCapture(queued.reason, queued.force);
          return;
        }
      }
    }

    // Subscribe to CDP navigation events. Each event triggers an
    // immediate capture, superseding the slow fallback for this tick.
    // The 'subscribe' prop is cdpOn() from the CDP connection — same
    // shape as the existing console/network subscriptions in
    // Inspector.jsx. We only subscribe while the Preview sub-tab is
    // active (the parent unmounts us when the user switches away).
    const subs = [];
    if (props.subscribe) {
      subs.push(props.subscribe('Page.frameNavigated', () => {
        if (stop) return;
        // frameNavigated fires for the very first load too. We
        // already kicked off the first capture in runCapture('init')
        // below, so coalesce if a capture is already in flight.
        runCapture('navigate');
        scheduleFallback();
      }));
      subs.push(props.subscribe('Page.frameStoppedLoading', () => {
        if (stop) return;
        runCapture('load');
        scheduleFallback();
      }));
    }

    // Kick off the first capture. This covers the common case where
    // the user opens the Preview tab on an already-loaded page (no
    // frameNavigated will fire for it because the page was loaded
    // before Page.enable was sent). Without this initial call the
    // panel would wait up to 3 s for the first poll.
    runCapture('init');
    scheduleFallback();
    // Expose a manual refresh to the parent so the Preview panel
    // header can offer a "Refresh preview" action. The parent passes
    // a ref (refreshRef) that it reads when the button is tapped; we
    // assign the handler here so it always closes over the live
    // capture loop for this mount.
    if (props.refreshRef) {
props.refreshRef.current = () => {
if (stop) return;
setNote('capturing…');
runCapture('manual', true);
};
}
// Expose the full-screen toggle to the parent's header button. The
// button lives in the panel header (PanelCard), which can't reach
// PreviewPanel's internal state directly, so the parent reads this
// ref to open the viewport-spanning overlay on tap.
if (props.fullscreenRef) {
props.fullscreenRef.current = () => {
if (stop) return;
setFullscreen((value) => !value);
};
}
return () => {
stop = true;
if (props.refreshRef) props.refreshRef.current = null;
if (props.fullscreenRef) props.fullscreenRef.current = null;
      if (pendingTimer) clearTimeout(pendingTimer);
      for (const off of subs) { try { off(); } catch { /* listener map gone */ } }
      if (pendingRevoke) URL.revokeObjectURL(pendingRevoke);
    };
  }, [props.capture, props.subscribe]);

  // Clicking/tapping the preview pokes the page at that point. The
  // frame is a scroll container (the image is a full-page capture,
  // wider and/or taller than the frame), so the tap coordinates
  // inside the image must first be shifted by the frame's scroll
  // offsets to become image coordinates, then scaled from CSS pixels
  // to the image's natural (device-pixel) size. clickAt() then
  // converts those full-page device pixels into viewport CSS pixels
  // and scrolls the target into view if needed — see events.js.
  function onPreviewClick(ev, targetImg, targetFrame) {
const img = targetImg || imgRef.current;
if (!img || !props.clickAt) return;
const rect = img.getBoundingClientRect();
if (rect.width <= 0 || rect.height <= 0) return;
const frame = targetFrame || frameRef.current;
const sx = frame ? (frame.scrollLeft || 0) : 0;
const sy = frame ? (frame.scrollTop || 0) : 0;
    // Prefer the live image's natural size; if the most recent
    // screenshot is still mid-decode, fall back to the previous
    // frame's dimensions (cached in lastDims) so the tap still
    // maps to a sensible point on the page.
    let natW = img.naturalWidth;
    let natH = img.naturalHeight;
    if (!natW || !natH) {
      natW = lastDims.current.w || natW;
      natH = lastDims.current.h || natH;
    }
    if (!natW || !natH) {
      // Nothing decoded yet (very first click before any capture) —
      // best-effort fall back to the rendered rect so the page still
      // receives a click near the tapped area.
      natW = rect.width;
      natH = rect.height;
    }
    const x = Math.round((ev.clientX - rect.left + sx) * (natW / rect.width));
    const y = Math.round((ev.clientY - rect.top + sy) * (natH / rect.height));
    props.clickAt(x, y);
  }

  return h(Fragment, null,
h('div', { class: 'inspector__preview' },
h('button', {
class: 'btn btn--primary inspector__draft-craft',
type: 'button',
disabled: !imgSrc,
onClick: () => props.onDraftCraft && props.onDraftCraft(latestImage.current),
}, 'Draft Craft'),
h('div', {
ref: frameRef,
class: 'inspector__preview-frame',
role: 'group',
'aria-label': 'Live page preview, scrollable',
onClick: (ev) => onPreviewClick(ev)
},
// A single <img> node is mounted once and its src is swapped on
// every tick (see tick() above). The src is initialised to ''
// so the element is in the tree and has a measurable bounding
// rect even before the first capture lands.
h('img', {
ref: imgRef,
src: imgSrc,
class: 'inspector__preview-img',
alt: 'Live page preview',
draggable: 'false'
})
),
// "Type into page" bar — forward typed text to the focused element via
// Input.insertText. Only rendered (and given a stable ref) when the
// model can actually insert, so a page with no connection doesn't show
// a dead control. Tapping the preview focuses a field; typing here then
// fills it. Enter submits forms / adds a newline.
(props.onInsert || props.onEnter)
? h('form', { ref: typePanelRef, class: 'inspector__typebar', onSubmit: onTypeSubmit },
h('input', {
ref: typeInputRef,
class: 'input inspector__typebar-input',
type: 'text',
placeholder: 'Type into page…',
value: typeValue,
disabled: typePending,
onInput: (event) => setTypeValue(event.currentTarget.value),
'aria-label': 'Type text into the inspected page'
}),
h('button', {
class: 'btn inspector__typebar-send',
type: 'submit',
disabled: typePending || !typeValue,
'aria-label': 'Send typed text',
title: 'Send typed text'
}, 'Send'),
props.onEnter
? h('button', {
class: 'btn inspector__typebar-enter',
type: 'button',
disabled: typePending,
'aria-label': 'Press Enter in the inspected page',
title: 'Press Enter in the inspected page',
onClick: () => submitType('', true)
}, '↵')
: null
)
: h('div', { ref: typePanelRef }),
h('div', { class: 'status inspector__status', 'aria-live': 'polite' }, note)
),
fullscreen
? createPortal(
h('div', { class: 'inspector__preview-fs', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Live page preview, full screen' },
h('div', { class: 'inspector__preview-fs-head' },
h('span', { class: 'inspector__preview-fs-title' }, 'Preview'),
h('button', {
class: 'icon-btn inspector__preview-fs-close',
type: 'button',
'aria-label': 'Close full-screen preview',
title: 'Close full-screen preview',
onClick: () => setFullscreen(false)
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
)
)
),
// Same "type into page" bar in full-screen mode, so the user can keep
// filling forms while the overlay is open. Reuses the same state and
// submit handler as the in-panel bar.
(props.onInsert || props.onEnter)
? h('form', { class: 'inspector__typebar inspector__typebar--fs', onSubmit: onTypeSubmit },
h('input', {
class: 'input inspector__typebar-input',
type: 'text',
placeholder: 'Type into page…',
value: typeValue,
disabled: typePending,
onInput: (event) => setTypeValue(event.currentTarget.value),
'aria-label': 'Type text into the inspected page'
}),
h('button', {
class: 'btn inspector__typebar-send',
type: 'submit',
disabled: typePending || !typeValue,
'aria-label': 'Send typed text',
title: 'Send typed text'
}, 'Send'),
props.onEnter
? h('button', {
class: 'btn inspector__typebar-enter',
type: 'button',
disabled: typePending,
'aria-label': 'Press Enter in the inspected page',
title: 'Press Enter in the inspected page',
onClick: () => submitType('', true)
}, '↵')
: null
)
: null,
h('div', {
ref: fsFrameRef,
class: 'inspector__preview-fs-frame',
role: 'group',
'aria-label': 'Live page preview, scrollable',
onClick: (ev) => onPreviewClick(ev, fsImgRef.current, fsFrameRef.current)
},
h('img', {
ref: fsImgRef,
src: imgSrc,
class: 'inspector__preview-fs-img',
alt: 'Live page preview',
draggable: 'false'
})
)
),
document.body
)
: null
);
}
