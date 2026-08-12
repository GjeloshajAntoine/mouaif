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
import { h } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';

export function PreviewPanel(props) {
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  const [imgSrc, setImgSrc] = useState('');
  const [note, setNote] = useState('capturing…');
  // Cache the last successfully decoded image dimensions. Clicks that
  // land while a new screenshot is still decoding (naturalWidth === 0)
  // fall back to these so the tap-to-page mapping is still accurate —
  // the page's intrinsic size is essentially constant between captures,
  // so the previous frame's natural size is a safe approximation.
  const lastDims = useRef({ w: 0, h: 0 });

  useEffect(() => {
    if (!props.capture) return;
    let stop = false;
    let inFlight = false;
    let pendingTimer = null;
    let lastCaptureAt = 0;
    let pendingRevoke = null;

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

    async function runCapture(reason) {
      if (stop || inFlight) return;
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
        if (r && r.data) {
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/jpeg' });
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
            setNote((prev) => (prev === 'capturing…' ? 'live' : prev));
          } else {
            // No img node yet (first render before commit) — fall
            // back to setting state so React mounts the element on
            // the next pass, then we'll swap src on the tick after.
            if (pendingRevoke) URL.revokeObjectURL(pendingRevoke);
            pendingRevoke = next;
            setImgSrc(next);
            setNote((prev) => (prev === 'capturing…' ? 'live' : prev));
          }
        }
      } catch (e) {
        setNote('screenshot failed: ' + (e && e.message || e));
      } finally {
        inFlight = false;
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

    return () => {
      stop = true;
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
  function onPreviewClick(ev) {
    const img = imgRef.current;
    if (!img || !props.clickAt) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const frame = frameRef.current;
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

  return h('div', { class: 'inspector__preview' },
    h('div', {
      ref: frameRef,
      class: 'inspector__preview-frame',
      role: 'group',
      'aria-label': 'Live page preview, scrollable',
      onClick: onPreviewClick
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
    h('div', { class: 'status inspector__status', 'aria-live': 'polite' }, note)
  );
}
