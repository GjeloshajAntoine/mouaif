// Inspector PreviewPanel — live page screenshot capture
//
// The capture loop grabs the full-page screenshot (captureBeyondViewport,
// so the shot is as tall as the page's scrollable content, not just the
// viewport) and displays it inside a scrollable frame. The image is
// rendered at its natural pixel size, so panning through the frame
// scrolls the actual page content.
//
// Capture triggers:
//   - Page.screencastFrame — Chrome's event-driven visual-change stream;
//     frames are acknowledged after each full-page capture, naturally
//     limiting the stream to ~10 fps without busy polling.
//   - Page.frameNavigated / Page.frameStoppedLoading — document lifecycle.
//   - a slow 3 s safety fallback when Chrome emits no screencast frame.
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
// Live page identity shown in the full-screen header. Both are kept
// in refs as well as state so capture-loop callbacks can write them
// without re-rendering on every CDP event, while the header itself
// reads the state values. `liveUrl` comes straight from the
// Page.frameNavigated / Page.navigatedWithinDocument events the
// panel already subscribes to; `liveTitle` is fetched on demand via
// Runtime.evaluate because CDP doesn't ship document.title as part
// of the navigation payload.
const [liveUrl, setLiveUrl] = useState('');
const [liveTitle, setLiveTitle] = useState('');
const liveUrlRef = useRef('');
// evaluateRef — wraps the parent's Runtime.evaluate arrow so the
// capture-loop effect (which subscribes to Page.frameNavigated)
// can read it without taking the prop as a dependency. The prop
// arrow is recreated on every Inspector render, so adding it to
// the deps list would tear down and rebuild the capture loop on
// every render. Reading through a ref keeps the subscription
// stable for the panel's lifetime.
const evaluateRef = useRef(null);
evaluateRef.current = props.evaluate || null;
// `refreshBusy` short-circuits the full-screen Refresh button so a
// second tap while the screenshot is in flight can't double-call
// capture. Mirrors the recapturing flag in WebpreviewModal but
// times out on its own since PreviewPanel doesn't await the
// capture promise (the in-panel loop is owned by the panel itself).
const [refreshBusy, setRefreshBusy] = useState(false);
async function refreshPageTitle(url) {
// Skip the round-trip if the URL hasn't actually changed — a
// same-document hash navigation re-fires the event but keeps the
// same title. Also skip when no `evaluate` is wired in (e.g. tests
// or first-paint before CDP is ready).
const evaluate = evaluateRef.current;
if (!evaluate || url === undefined) return;
try {
const r = await evaluate('document.title || ""');
if (!r) return;
const value = (r && r.result && typeof r.result.value === 'string') ? r.result.value : '';
if (value) setLiveTitle(value);
} catch { /* CDP not ready yet — keep prior title */ }
}
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
let streamTimer = null;
let lastCaptureAt = 0;
let captureSerial = 0;
let pendingFrameAck = null;
let pendingAckAfter = 0;
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
lastCaptureAt = Date.now();
const serial = ++captureSerial;
try {
const r = await props.capture();
if (stop) return;
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
        const blob = new Blob([bytes], { type: 'image/png' });
        latestImage.current = { dataUrl: 'data:image/png;base64,' + r.data, width: 0, height: 0 };
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
if (pendingFrameAck != null && props.ackFrame && serial >= pendingAckAfter) {
const sessionId = pendingFrameAck;
pendingFrameAck = null;
pendingAckAfter = 0;
if (streamTimer) {
clearTimeout(streamTimer);
streamTimer = null;
}
props.ackFrame(sessionId).catch(() => { /* stream stopped */ });
}
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

    // Subscribe to lifecycle events and Chrome's visual-change stream.
    // Frames are acknowledged after a full-page screenshot, and captures are
// coalesced to at most ~10 fps. This keeps animation, typing, hover, and
    // DOM mutations live while retaining the scrollable full-page image.
    const subs = [];
    if (props.subscribe) {
subs.push(props.subscribe('Page.frameNavigated', (params) => {
if (stop) return;
const frame = params && params.frame;
const url = (frame && !frame.parentId && typeof frame.url === 'string') ? frame.url : '';
if (url && url !== liveUrlRef.current) {
liveUrlRef.current = url;
setLiveUrl(url);
// Update the header title for cross-document navigations. Hash-only
// changes keep the same document.title, so this is a no-op there.
refreshPageTitle(url);
}
runCapture('navigate');
scheduleFallback();
}));
subs.push(props.subscribe('Page.frameStoppedLoading', () => {
if (stop) return;
runCapture('load');
scheduleFallback();
}));
subs.push(props.subscribe('Page.navigatedWithinDocument', (params) => {
if (stop) return;
const url = (params && typeof params.url === 'string') ? params.url : '';
if (url && url !== liveUrlRef.current) {
liveUrlRef.current = url;
setLiveUrl(url);
}
runCapture('load');
scheduleFallback();
}));
      subs.push(props.subscribe('Page.screencastFrame', (frame) => {
if (stop || !frame || frame.sessionId == null || !props.ackFrame) return;
// Hold the acknowledgement until the corresponding full-page capture
// finishes. Chrome then sends the next changed frame, providing natural
// backpressure instead of encoding a high-FPS stream we would discard.
pendingFrameAck = frame.sessionId;
pendingAckAfter = captureSerial + 1;
if (streamTimer) return;
const wait = Math.max(0, 100 - (Date.now() - lastCaptureAt));
streamTimer = setTimeout(() => {
streamTimer = null;
if (!stop) runCapture('stream');
}, wait);
}));
}
// Capture immediately for an already-loaded page, then retain a slow
// safety retry for targets that do not support screencasting.
runCapture('init');
scheduleFallback();
// Read the current document.title right away so the full-screen
// header isn't empty until the first user-driven navigation. We
// deliberately don't reset `liveTitle` to '' here so a fast
// screencast capture that races the title fetch still has a
// meaningful label to show.
refreshPageTitle(liveUrlRef.current);
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
// Keep Draft Craft in the existing panel toolbar instead of placing a
// control over the screenshot. The parent invokes this handle when the
// toolbar icon is tapped, while the latest capture stays owned here.
if (props.draftCraftRef) {
props.draftCraftRef.current = () => {
if (!stop && latestImage.current && props.onDraftCraft) props.onDraftCraft(latestImage.current);
};
}
return () => {
stop = true;
if (props.refreshRef) props.refreshRef.current = null;
if (props.fullscreenRef) props.fullscreenRef.current = null;
if (props.draftCraftRef) props.draftCraftRef.current = null;
if (pendingTimer) clearTimeout(pendingTimer);
if (streamTimer) clearTimeout(streamTimer);
for (const off of subs) { try { off(); } catch { /* listener map gone */ } }
if (pendingRevoke) URL.revokeObjectURL(pendingRevoke);
};
}, [props.capture, props.subscribe, props.ackFrame]);

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
h('div', { class: 'inspector__preview-fs', role: 'dialog', 'aria-modal': 'true', 'aria-label': liveTitle || liveUrl || 'Live page preview, full screen' },
h('div', { class: 'inspector__preview-fs-head' },
// Live page identity on the left: title (one line, ellipsis)
// with a small host subtitle underneath, mirroring the web
// preview modal's `.wp__head` pattern so the two surfaces read
// the same way at a glance.
h('div', { class: 'inspector__preview-fs-text' },
h('div', { class: 'inspector__preview-fs-title', title: liveTitle || liveUrl || 'Preview' },
liveTitle || liveUrl || 'Preview'
),
h('div', { class: 'inspector__preview-fs-host' }, hostFromUrl(liveUrl))
),
h('div', { class: 'inspector__preview-fs-actions' },
// Refresh — re-captures the screenshot at the current size.
// Reuses the same icon as the in-panel Refresh button so the
// user recognizes the gesture. The label stays visible on
// phones (>430 px) and collapses to icon-only below that.
h('button', {
class: 'btn inspector__preview-fs-refresh',
type: 'button',
disabled: refreshBusy,
onClick: () => {
if (refreshBusy) return;
setRefreshBusy(true);
if (props.refreshRef && props.refreshRef.current) props.refreshRef.current();
setTimeout(() => setRefreshBusy(false), 350);
},
'aria-label': 'Refresh preview',
title: 'Refresh preview'
},
h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
h('path', { d: 'M4 12a8 8 0 0 1 13.66-5.66L20 4 M20 4v5h-5 M20 12a8 8 0 0 1-13.66 5.66L4 20 M4 20v-5h5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
),
h('span', null, 'Refresh')
),
// Size — native select keeps the controls compact and uses the
// phone's touch picker. The same preset list the in-panel
// dropdown uses is supplied through `sizePresets` / `sizeId` /
// `onSizeChange` so changing the size here is identical to
// changing it in the panel header.
(Array.isArray(props.sizePresets) && props.sizePresets.length > 0)
? h('select', {
class: 'inspector__preview-fs-size',
value: props.sizeId || 'auto',
disabled: !!props.sizeDisabled,
'aria-label': 'Capture size',
title: 'Capture size',
onChange: (event) => props.onSizeChange && props.onSizeChange(event.currentTarget.value)
},
props.sizePresets.map((preset) => h('option', { key: preset.id, value: preset.id },
preset.width
? (preset.label + ' · ' + preset.width + '×' + preset.height)
: preset.label
))
)
: null,
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
// hostFromUrl — extract `host[:port]` so the full-screen header can
// echo the inspected page's hostname underneath its title. Returns
// an empty string for non-http(s) targets (chrome:// pages, the
// empty about:blank frame, etc.) so the subtitle row stays blank
// instead of printing "host: chrome://".
function hostFromUrl(url) {
if (!url || !/^https?:\/\//i.test(url)) return '';
try { return new URL(url).host; } catch { return ''; }
}
