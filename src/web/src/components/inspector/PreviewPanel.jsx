// Inspector PreviewPanel — live page screenshot capture
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';

export function PreviewPanel(props) {
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
          if (imgRef.current) imgRef.current.src = next;
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
  return h('div', { class: 'inspector__preview' },
    h('div', { class: 'inspector__preview-frame' },
      h('img', { ref: imgRef, class: 'inspector__preview-img', alt: 'Live page preview' })
    ),
    h('div', { ref: noteRef, class: 'status inspector__status', 'aria-live': 'polite' }, 'capturing…')
  );
}