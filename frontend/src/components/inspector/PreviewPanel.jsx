// Inspector PreviewPanel — live page screenshot capture
//
// The capture loop grabs the full-page screenshot (captureBeyondViewport,
// so the shot is as tall as the page's scrollable content, not just the
// viewport) and displays it inside a scrollable frame. The image is
// rendered at its natural pixel size, so panning through the frame
// scrolls the actual page content.
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';

export function PreviewPanel(props) {
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  const noteRef = useRef(null);
  useEffect(() => {
    let stop = false;
    let timer = null;
    let inFlight = false;
    let objUrl = null;
    async function tick() {
      if (stop || inFlight) return;
      inFlight = true;
      try {
        const r = await props.capture();
        if (stop) return;
        if (r && r.data) {
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const next = URL.createObjectURL(blob);
          const img = imgRef.current;
          const frame = frameRef.current;
          if (img && frame) {
            // If the user is scrolled inside the preview frame, keep their
            // position when a new screenshot replaces the old one. Without
            // this the frame would snap back to the top on every refresh.
            const prevTop = frame.scrollTop || 0;
            const prevLeft = frame.scrollLeft || 0;
            img.onload = () => {
              frame.scrollTop = prevTop;
              frame.scrollLeft = prevLeft;
              img.onload = null;
            };
            img.src = next;
          }
          if (objUrl) URL.revokeObjectURL(objUrl);
          objUrl = next;
          if (noteRef.current) noteRef.current.textContent = 'live · ' + new Date().toLocaleTimeString();
        }
      } catch (e) {
        if (noteRef.current) noteRef.current.textContent = 'screenshot failed: ' + (e && e.message || e);
      } finally {
        inFlight = false;
        if (!stop) timer = setTimeout(tick, 1200);
      }
    }
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, []);
  // Clicking/tapping the preview pokes the page at that point. The frame
  // is a scroll container (the image is a full-page capture, wider and/or
  // taller than the frame), so the tap coordinates inside the image must
  // first be shifted by the frame's scroll offsets to become image
  // coordinates, then scaled from CSS pixels to the image's natural
  // (device-pixel) size. clickAt() then converts those full-page device
  // pixels into viewport CSS pixels and scrolls the target into view if
  // needed — see events.js.
  function onPreviewClick(ev) {
    const img = imgRef.current;
    if (!img || !props.clickAt || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const frame = frameRef.current;
    const sx = frame ? (frame.scrollLeft || 0) : 0;
    const sy = frame ? (frame.scrollTop || 0) : 0;
    const x = Math.round((ev.clientX - rect.left + sx) * (img.naturalWidth / rect.width));
    const y = Math.round((ev.clientY - rect.top + sy) * (img.naturalHeight / rect.height));
    props.clickAt(x, y);
  }
  return h('div', { class: 'inspector__preview' },
    h('div', { ref: frameRef, class: 'inspector__preview-frame', role: 'group', 'aria-label': 'Live page preview, scrollable', onClick: onPreviewClick },
      h('img', { ref: imgRef, class: 'inspector__preview-img', alt: 'Live page preview' })
    ),
    h('div', { ref: noteRef, class: 'status inspector__status', 'aria-live': 'polite' }, 'capturing…')
  );
}
