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
//     pacing the stream to ~10 captures per second without busy polling.
//     The pacing window opens when the previous capture *finished*, so a
//     slow capture cannot be followed by another one immediately.
//   - Page.frameNavigated / Page.frameStoppedLoading — document lifecycle.
//   - a slow 3 s safety fallback when Chrome emits no screencast frame.
//   - a manual "Refresh preview" button in the panel header.
//
// Every trigger lands on the same guard: a capture whose PNG is
// byte-identical to the one already on screen is dropped, so a page that
// is not changing costs no decode, no layout, and no scroll writes.
import { h, Fragment } from 'preact';
import { createPortal } from 'preact/compat';
import { useRef, useEffect, useState } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';
import { pickBannerText } from './pickMode.js';

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
  // fullscreenOpenRef — a small ref the parent reads to know whether the
  // *overlay* full screen below is open. The Preview card's header button is
  // shared with the in-region full screen the other cards use (both cards' buttons
  // live in PanelCard), and only this panel knows which of the two its own button
  // reached — so the answer is published here rather than mirrored as a second
  // flag in the parent, which could drift.
  if (props.fullscreenOpenRef) props.fullscreenOpenRef.current.open = fullscreen;
  // The full-screen overlay is a sheet like the webpreview / Git / CLI modals,
  // so Escape, the Tab cycle and focus restore come from the shared hook
  // (frontend/src/hooks/useModal.js). It is only active while open, so the
  // capture loop and the rest of the Inspector keep normal key handling.
  const fsSheetRef = useModal({ onClose: () => setFullscreen(false), active: fullscreen });
const [imgSrc, setImgSrc] = useState('');
const [note, setNote] = useState('capturing…');
// Zoom mode for the preview. 'fit' scales the screenshot to the frame's
// width (so a tall page scrolls vertically); 'size' renders the full-res
// capture at its natural device->CSS scale (so a wide page shows readable
// text and pans horizontally). Wide viewport presets (e.g. Laptop 1280px)
// are otherwise squashed to ~30% of the frame and become unreadable.
//
// Only an explicit tap on the zoom toggle is persisted. The auto-fit
// heuristic below is deliberately NOT written to storage: it is derived from
// the frame's measured width and the capture's width, so freezing it turns a
// decision that should be re-evaluated per viewport preset into a permanent
// user preference.
//
// The key is versioned. The v1 key was written by the auto-fit path as well
// as by the toggle, and while the Touch stylesheet was collapsing the preview
// frame to a ~38px column (see inspector-touch.css) auto-fit saw a
// permanently "too wide" frame and wrote `size` on every connect. That value
// is indistinguishable from a real preference and would leave the preview
// stuck in panned natural-size mode, so v1 is read once, migrated when it
// still describes the current frame, and never written again.
const ZOOM_STATE_KEY = 'mouaif:inspector:previewZoom';
const ZOOM_STATE_KEY_V2 = 'mouaif:inspector:previewZoom2';
const zoomInitial = (() => {
if (typeof localStorage === 'undefined') return 'fit';
try {
if (localStorage.getItem(ZOOM_STATE_KEY_V2) === 'size') return 'size';
// A legacy `fit` was never written by auto-fit in a way that matters (it is
// also the default), so migrating it is a no-op the reader can keep. A legacy
// `size` is dropped: it is the value the collapse produced.
localStorage.removeItem(ZOOM_STATE_KEY);
} catch { /* storage unavailable — fall back to fit */ }
return 'fit';
})();
const [zoom, setZoom] = useState(zoomInitial);

// Natural size of the capture currently on screen, in device pixels (the
// image's intrinsic size). Kept in state so the render below can pin the
// natural-size width; `dimsRef` mirrors it so the capture loop can compare
// before re-rendering (a capture that did not change size must not trigger a
// re-render of the whole Inspector).
const [dims, setDims] = useState({ w: 0, h: 0 });
const dimsRef = useRef({ w: 0, h: 0 });
// Gate for one-time auto-fit on the first decode: only switch to natural size
// for a page that would otherwise be unreadable (very wide relative to the
// frame) and only before the user explicitly toggles. A manual toggle clears
// the gate so the user's choice is never overridden.
const autoZoomRef = useRef(false);
function toggleZoom() {
autoZoomRef.current = true;
setZoom((v) => {
const next = v === 'fit' ? 'size' : 'fit';
try { localStorage.setItem(ZOOM_STATE_KEY_V2, next); } catch { /* ignore */ }
return next;
});
}
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
// isTapRef — whether the pointer gesture that is about to produce a `click`
// was a tap rather than a pan of the scroll container. Set on pointer-down,
// cleared once the finger moves past TAP_SLOP_PX or the frame scrolls. See
// onPreviewClick for why the distinction matters on a phone.
const isTapRef = useRef(false);
const tapOriginRef = useRef({ x: 0, y: 0 });
// A thumb is sloppy and a scroll container starts moving a frame or two after
// the finger does, so anything past this many CSS pixels counts as a pan.
const TAP_SLOP_PX = 10;
function onPreviewPointerDown(ev) {
// Only a primary press can become a tap; a second finger is a pinch/pan.
if (ev.button != null && ev.button !== 0) { isTapRef.current = false; return; }
isTapRef.current = true;
tapOriginRef.current = { x: ev.clientX, y: ev.clientY };
}
function onPreviewPointerMove(ev) {
if (!isTapRef.current) return;
const dx = ev.clientX - tapOriginRef.current.x;
const dy = ev.clientY - tapOriginRef.current.y;
if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) isTapRef.current = false;
}
// A scroll can begin without a pointermove landing on the frame (momentum, a
// trackpad, a scrollbar drag), so the scroll itself also cancels the tap.
function onPreviewScroll() { isTapRef.current = false; }
// pointercancel fires when the browser takes the gesture over for a scroll —
// exactly the case that must not become a click.
function onPreviewPointerCancel() { isTapRef.current = false; }
const latestImage = useRef(null);
// Base64 payload of the capture that is currently on screen. A page that
// did not change between two captures yields a byte-identical PNG, and
// re-assigning that image makes the browser re-decode it, re-lay out the
// frame, and rewrite the scroll offsets — a hitch the user sees on every
// tick. Identical payloads are dropped before any of that work happens.
const lastPngRef = useRef('');
// The capture effect below is keyed on props.capture/subscribe/ackFrame
// only, so its `img.onload` closure would otherwise keep whatever
// sizeId/sizePresets were current when the effect last restarted — a
// device-preset change would not reach the DPR decision. Read them
// through a ref that every render refreshes.
const sizeRef = useRef({ presets: props.sizePresets, id: props.sizeId });
sizeRef.current = { presets: props.sizePresets, id: props.sizeId };


  useEffect(() => {
if (!props.capture) return;
let stop = false;
let inFlight = false;
let pendingTimer = null;
let streamTimer = null;
let lastCaptureAt = 0;
// When the last capture *finished*, as opposed to when it started. The
// screencast pacing below measures from here so a slow capture cannot
// chain another one the moment it lands.
let lastCaptureEndAt = 0;
let captureSerial = 0;
let pendingFrameAck = null;
let pendingAckAfter = 0;
// Minimum gap between two full-page captures. A screencast frame is emitted
// for *every* visual change (each animation frame of a transition, each
// hover state, each keystroke), and each capture re-encodes a full-page PNG
// — the expensive step — then re-decodes it in the <img>. Pacing at 100 ms
// let a busy page drive that loop at the same rate the encoder could keep
// up, which is the hitch a user reads as "the preview stutters while I
// scroll". 250 ms is still live to the eye (4 fps of *content* change) while
// leaving the main thread three quarters of the time to handle the user's
// own gestures.
const MIN_CAPTURE_GAP_MS = 250;

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
        // An unchanged page yields a byte-identical PNG. Nothing on screen
        // would change, so skip the swap (and the decode, layout, and scroll
        // writes it triggers) instead of re-rendering the same image.
        if (r.data === lastPngRef.current) {
          setNote('live');
          return;
        }
        lastPngRef.current = r.data;
        // The capture already *is* base64 PNG, so it goes straight into the
        // <img> as a data URL and the browser decodes it natively. Turning it
        // into a Blob first copies every byte through JS (atob + a per-char
        // loop), which blocks the main thread for tens of ms per capture on a
        // full-page shot of a real page.
        const next = 'data:image/png;base64,' + r.data;
        latestImage.current = { dataUrl: next, width: 0, height: 0 };
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
// Only write the offsets when they actually moved. A redundant write
// cancels an in-flight momentum scroll, which reads as the preview
// fighting the finger.
if (frameRef.current.scrollTop !== prevTop) frameRef.current.scrollTop = prevTop;
if (frameRef.current.scrollLeft !== prevLeft) frameRef.current.scrollLeft = prevLeft;
}
const cur = imgRef.current;
if (cur) {
lastDims.current.w = cur.naturalWidth || lastDims.current.w;
lastDims.current.h = cur.naturalHeight || lastDims.current.h;
if (latestImage.current) {
latestImage.current.width = cur.naturalWidth || 0;
latestImage.current.height = cur.naturalHeight || 0;
}
// Publish the decoded size for natural-size ("100%") rendering. Only
// when it actually changed: an unchanged capture must not re-render the
// parent Inspector view.
const decW = cur.naturalWidth || 0;
const decH = cur.naturalHeight || 0;
if (decW && decH && (decW !== dimsRef.current.w || decH !== dimsRef.current.h)) {
dimsRef.current = { w: decW, h: decH };
setDims(dimsRef.current);
}
// Smart default: on the first decode, if a wide page would be shrunk
// below ~60% of the frame width in fit mode (text unreadable), switch to
// natural size automatically. Only applies before the user toggles; the
// manual toggle clears the gate so the user's choice always wins.
//
// This is a rendered-mode decision, not a preference: it is derived from
// the frame's live width, so it is intentionally NOT persisted. Persisting
// it is what let a collapsed frame (see the versioned ZOOM_STATE_KEY above)
// pin the preview to `size` across sessions.
if (!autoZoomRef.current && cur.naturalWidth && frameRef.current) {
const frameW = frameRef.current.clientWidth || frameRef.current.offsetWidth;
const dpr = currentDeviceScaleFactor(sizeRef.current.presets, sizeRef.current.id);
if (frameW && previewZoomForWidth(cur.naturalWidth, frameW, dpr) === 'size') {
setZoom('size');
}
autoZoomRef.current = true;
}
cur.onload = prevOnload || null;
}
};
          img.src = next;
          setImgSrc(next);
          setNote('live');
        } else {
          // No img node yet (first render before commit) — fall
          // back to setting state so React mounts the element on
          // the next pass, then we'll swap src on the tick after.
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
// The next capture's pacing window opens when this one finished, not when it
// started: a capture that took ~100 ms would otherwise be followed by another
// one immediately, and every extra capture re-encodes a full-page PNG.
lastCaptureEndAt = Date.now();
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
    // Frames are acknowledged after a full-page screenshot, which paces
    // captures to one per ~100 ms of capture time; identical captures are
    // dropped by the guard in runCapture. This keeps animation, typing,
    // hover, and DOM mutations live while retaining the scrollable
    // full-page image.
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
// Re-read document.title now the document has finished loading. The
// Page.frameNavigated handler below fires *before* the new document is
// ready, so its title read can race the load and come back empty — which
// left the full-screen header on its raw-URL fallback for the rest of the
// document's life (no further navigation event re-tries it). This is that
// second read.
refreshPageTitle(liveUrlRef.current);
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
const wait = Math.max(0, MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureEndAt));
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
};
}, [props.capture, props.subscribe, props.ackFrame]);

// Seed the header identity from the attached target. A page that is already
// loaded when the Inspector attaches emits no Page.frameNavigated, and the
// mount-time title read in the effect above can lose its race with the CDP
// socket opening — so both `liveUrl` (the host subtitle) and `liveTitle`
// (the overlay's one-line heading) could stay empty until the user happened
// to navigate. The target the user connected to already carries the page's
// URL and title (the same pair the "connected to …" status line prints), so
// take them directly instead of asking Chrome again.
//
// Seeded once: navigation events are the authority after this, and re-running
// on every prop change (the Inspector re-renders often) would both stomp a
// fresher event-reported URL and re-render the panel pointlessly.
const seededIdentityRef = useRef(false);
useEffect(() => {
if (seededIdentityRef.current) return;
if (!props.pageUrl && !props.pageTitle) return;
seededIdentityRef.current = true;
const url = typeof props.pageUrl === 'string' ? props.pageUrl : '';
const title = typeof props.pageTitle === 'string' ? props.pageTitle : '';
if (url && url !== liveUrlRef.current) {
liveUrlRef.current = url;
setLiveUrl(url);
}
if (title) setLiveTitle(title);
}, [props.pageUrl, props.pageTitle]);

// Clicking/tapping the preview pokes the page at that point. The
// frame is a scroll container (the image is a full-page capture,
// wider and/or taller than the frame) and the image renders at the
// frame's width, so the tapped point's position within the image is
// derived from the image's own bounding rect, then scaled from CSS
// pixels to the image's natural (device-pixel) size. clickAt() then
// converts those full-page device pixels into viewport CSS pixels
// and scrolls the target into view if needed — see events.js.
//
// The frame's scroll offset must NOT be added here. getBoundingClientRect()
// returns viewport-relative coordinates that already account for the
// scroll container (a scrolled-down image has a negative rect.top), so
// adding frame.scrollTop back in double-counts it and shifts every
// pan-then-tap click two scroll-positions down — worse the farther the
// user scrolls. Omitting it maps the visible pixel to the right spot
// whether or not the frame has been panned.
  function onPreviewClick(ev, targetImg) {
  const img = targetImg || imgRef.current;
  if (!img || !props.clickAt) return;
  // A tap is not a swipe. The frame is a scroll container, so on a phone every
  // pan of the page ends with a `click` on the element the finger lifted over —
  // which forwarded a real click into the inspected page at the end of every
  // scroll. Dragging the preview therefore activated whatever link or button
  // happened to be under the finger. `tap` is set on pointer-down and cleared
  // as soon as the pointer moves past a thumb's slop or the frame scrolls, and
  // only a surviving tap reaches the page.
  if (!isTapRef.current) return;
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
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
    const x = Math.round((ev.clientX - rect.left) * (natW / rect.width));
    const y = Math.round((ev.clientY - rect.top) * (natH / rect.height));
    props.clickAt(x, y);
  }

  // Natural-size ("100%") rendering. A retina preset captures two device
  // pixels per page CSS pixel, so painting the capture at its intrinsic width
  // shows the page at twice its real size: wrong proportions, a soft 2x
  // upscale of the screenshot, and a panning surface four times larger than
  // it needs to be. Divide by the preset's device scale factor so 100% means
  // one page CSS pixel per CSS pixel on screen (and 1:1 with the physical
  // pixels of a screen whose ratio matches the capture). The height stays
  // `auto`, so the image keeps its own aspect ratio.
  const previewSizeStyle = (zoom === 'size' && dims.w)
    ? { width: previewNaturalWidth(dims.w, currentDeviceScaleFactor(props.sizePresets, props.sizeId)) + 'px' }
    : null;

  return h(Fragment, null,
h('div', { class: 'inspector__preview' + (props.pickMode ? ' is-picking' : '') },
// Pick-mode banner. Tap-to-select is armed from the Styles panel, whose
// button is two panels away, so without feedback here the user taps the
// preview and either selects an element or pokes the page with no way to
// tell which mode they are in. The banner sits *over* the screenshot (it
// costs no height and is exactly where the tap goes), names the gesture,
// and carries the Cancel that disarms without a trip back to Styles.
props.pickMode
? h('div', { class: 'inspector__pickban', role: 'status', 'aria-live': 'polite' },
h('span', { class: 'inspector__pickban-dot', 'aria-hidden': 'true' }),
h('span', { class: 'inspector__pickban-text' }, props.pickHint || pickBannerText()),
props.onPickCancel
? h('button', {
class: 'btn inspector__pickban-cancel',
type: 'button',
'aria-label': 'Cancel picking an element',
title: 'Cancel picking',
onClick: (event) => { event.stopPropagation(); props.onPickCancel(); }
}, 'Cancel')
: null
)
: null,
h('div', {
ref: frameRef,
class: 'inspector__preview-frame',
role: 'group',
'aria-label': 'Live page preview, scrollable',
// A tap pokes the page; a pan scrolls this frame. These handlers are what
// tell the two apart — see onPreviewClick.
onPointerDown: onPreviewPointerDown,
onPointerMove: onPreviewPointerMove,
onPointerUp: onPreviewPointerMove,
onPointerCancel: onPreviewPointerCancel,
onScroll: onPreviewScroll,
onClick: (ev) => onPreviewClick(ev)
},
// A single <img> node is mounted once and its src is swapped on
// every tick (see tick() above). The src is initialised to ''
// so the element is in the tree and has a measurable bounding
// rect even before the first capture lands.
h('img', {
ref: imgRef,
src: imgSrc,
class: 'inspector__preview-img' + (zoom === 'size' ? ' inspector__preview-img--size' : ''),
style: previewSizeStyle,
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
h('div', { class: 'inspector__preview-foot' },
h('div', { class: 'status inspector__status', 'aria-live': 'polite' }, note),
h('button', {
class: 'inspector__zoom' + (zoom === 'size' ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(zoom === 'size'),
'aria-label': zoom === 'size' ? 'Show preview fit to width' : 'Show preview at natural size and pan',
title: zoom === 'size' ? 'Fit width' : 'Natural size (pan)',
onClick: toggleZoom
},
h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
h('path', { d: 'M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z', fill: 'currentColor' })
),
h('span', null, zoom === 'size' ? 'Fit' : '100%')
)
)
),
fullscreen
? createPortal(
h('div', { class: 'inspector__preview-fs', role: 'dialog', 'aria-modal': 'true', 'aria-label': liveTitle || liveUrl || 'Live page preview, full screen', ref: fsSheetRef },
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
// Fit / natural-size (zoom) — the same toggle as the in-panel footer,
// so a wide page can be read at 100% and panned instead of squashed.
// Icon-only in the tight header, matching the refresh control.
h('button', {
class: 'inspector__preview-fs-zoom' + (zoom === 'size' ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(zoom === 'size'),
'aria-label': zoom === 'size' ? 'Show preview fit to width' : 'Show preview at natural size and pan',
title: zoom === 'size' ? 'Fit width' : 'Natural size (pan)',
onClick: toggleZoom
},
h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
h('path', { d: 'M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z', fill: 'currentColor' })
)
),
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
class: 'inspector__preview-fs-frame' + (props.pickMode ? ' is-picking' : ''),
role: 'group',
'aria-label': 'Live page preview, scrollable',
// Same tap-vs-pan guard as the in-panel frame: an overlay that is one big
// scroll container would otherwise click the page at the end of every pan.
onPointerDown: onPreviewPointerDown,
onPointerMove: onPreviewPointerMove,
onPointerUp: onPreviewPointerMove,
onPointerCancel: onPreviewPointerCancel,
onScroll: onPreviewScroll,
onClick: (ev) => onPreviewClick(ev, fsImgRef.current)
},
// Pick-mode banner, same contract as the in-panel one: the overlay is a
// full-screen tap surface, so it has to say what a tap will do too.
props.pickMode
? h('div', { class: 'inspector__pickban inspector__pickban--fs', role: 'status' },
h('span', { class: 'inspector__pickban-dot', 'aria-hidden': 'true' }),
h('span', { class: 'inspector__pickban-text' }, props.pickHint || pickBannerText()),
props.onPickCancel
? h('button', {
class: 'btn inspector__pickban-cancel',
type: 'button',
'aria-label': 'Cancel picking an element',
onClick: (event) => { event.stopPropagation(); props.onPickCancel(); }
}, 'Cancel')
: null
)
: null,
h('img', {
ref: fsImgRef,
src: imgSrc,
class: 'inspector__preview-fs-img' + (zoom === 'size' ? ' inspector__preview-img--size' : ''),
style: previewSizeStyle,
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
// currentDeviceScaleFactor — the page's effective device pixel ratio for the
// selected viewport preset. The retina Phone/Phone+ presets capture at
// deviceScaleFactor 2, so their screenshot is 2x the page's CSS width. The
// "Auto"/Tablet/Laptop presets use dpr 1. Falls back to 1 for presets that
// don't declare a factor (so a non-retina capture is unchanged).
function currentDeviceScaleFactor(sizePresets, sizeId) {
const preset = Array.isArray(sizePresets) ? sizePresets.find((p) => p.id === sizeId) : null;
return (preset && preset.deviceScaleFactor) || 1;
}
// previewZoomForWidth — decide the preview zoom mode for a capture of the
// given pixel width shown in a frame of `frameWidth` CSS px. In fit mode the
// frame shows `frameWidth / pageCSSWidth` of the page's width; if that drops
// below ~60%, text becomes too small to read and we switch to natural size so
// the page pans instead of being squashed. Returns 'size' (natural) or 'fit'.
//
// `naturalWidth` is the image's intrinsic width. For a retina capture (the
// Phone presets at deviceScaleFactor 2) that's the page's *device* pixel
// width, not its CSS design width. Fit mode scales the page's CSS width
// against the frame, so we must compare frameWidth to naturalWidth / dpr —
// otherwise a narrow phone page (375 CSS px) is misread as ~47% of the frame
// and auto-zoomed to natural size even though it fits at ~94%.
function previewZoomForWidth(naturalWidth, frameWidth, deviceScaleFactor) {
if (!naturalWidth || !frameWidth) return 'fit';
const pageWidth = naturalWidth / (deviceScaleFactor || 1);
if (!pageWidth) return 'fit';
return (frameWidth / pageWidth) < 0.6 ? 'size' : 'fit';
}
// previewNaturalWidth — the CSS width to paint a capture at in natural-size
// ("100%") mode. `naturalWidth` is the capture's device-pixel width, which for
// the retina Phone/Phone+ presets (deviceScaleFactor 2) is twice the page's CSS
// width. Painting it at that intrinsic width would show a phone page at double
// size — wrong proportions, a blurry 2x upscale, and four times the panning
// area — so the capture is divided by the preset's scale factor. The result is
// the page's own CSS width: 100% means one page CSS pixel per CSS pixel on
// screen, which is also 1:1 with the physical pixels of a screen whose device
// ratio matches the capture. Non-retina captures (dpr 1) are unchanged.
function previewNaturalWidth(naturalWidth, deviceScaleFactor) {
if (!naturalWidth) return 0;
return Math.round(naturalWidth / (deviceScaleFactor || 1));
}
