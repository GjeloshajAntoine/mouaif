// Mobile-first local capture/review sheet. Only confirmed PNGs reach chat.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';
import { fileToImageAttachment } from './imageInput.js';
import { formatVideoTime, videoSampleTimes, waitForVideo, seekVideoFrame, releaseVideo } from './videoCapture.js';
import { MAX_CAPTURE_FRAMES, captureCanvas, captureAttachment, exportCapture, frameDifference, normalizedZone } from './screenCapture.js';

export function ScreenCapturePanel({ onClose, onAttach, availableSlots = 8 }) {
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [importedVideo, setImportedVideo] = useState(null);
  const [videoPosition, setVideoPosition] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(3);
  const [mode, setMode] = useState('changes');
  const [frames, setFrames] = useState([]);
  const [zones, setZones] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [draftZone, setDraftZone] = useState(null);
  const [message, setMessage] = useState('Choose a screen or import screenshots or a video. Nothing is sent automatically.');
  const [error, setError] = useState('');
  const [attaching, setAttaching] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const importedVideoRef = useRef(null);
  const videoUrlRef = useRef(null);
  const videoSourceRef = useRef(null);
  const videoAbortRef = useRef(null);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);
  const framesRef = useRef([]);
  const settingsRef = useRef(null);
  const drawRef = useRef(null);
  const captureRef = useRef(null);
  const sheetRef = useModal({ onClose: () => { if (!attaching) onClose(); } });
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  settingsRef.current = { zones, mode };

  function stopSharing(update = true) {
    requestRef.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    if (videoRef.current) videoRef.current.srcObject = null;
    if (update && aliveRef.current) { setSharing(false); setAutomatic(false); setBusy(false); }
  }

  useEffect(() => () => {
    aliveRef.current = false;
    stopSharing(false);
    videoAbortRef.current?.abort();
    releaseVideo(videoSourceRef.current, videoUrlRef.current);
    videoUrlRef.current = null;
    videoSourceRef.current = null;
    framesRef.current = [];
  }, []);

  async function onStartSharing() {
    setError(''); setBusy(true);
    const request = ++requestRef.current;
    try {
      // Must stay directly in the tap handler: getDisplayMedia needs activation.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
      if (!aliveRef.current || request !== requestRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => { stopSharing(); setMessage('Screen sharing ended. Your captures are still available to review.'); };
      await video.play();
      if (!aliveRef.current || request !== requestRef.current) return;
      setSharing(true);
      setMessage('Sharing is active. Capture a baseline, then capture changes. No video is recorded.');
    } catch (e) {
      if (!aliveRef.current || request !== requestRef.current) return;
      stopSharing();
      setError(e.name === 'NotAllowedError' ? 'Screen sharing was cancelled or denied. You can try again or import screenshots.' : 'Could not share this screen. Try again or import screenshots.');
    } finally {
      if (aliveRef.current && request === requestRef.current) setBusy(false);
    }
  }

  function onRemoveVideo() {
    videoAbortRef.current?.abort();
    videoAbortRef.current = null;
    releaseVideo(videoSourceRef.current, videoUrlRef.current);
    videoUrlRef.current = null;
    videoSourceRef.current = null;
    setImportedVideo(null); setVideoPosition(0); setBusy(false); setExtracting(false);
  }

  async function onImportVideo(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    onRemoveVideo(); setError(''); setBusy(true);
    const controller = new AbortController();
    videoAbortRef.current = controller;
    const video = importedVideoRef.current;
    videoSourceRef.current = video;
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    try {
      await waitForVideo(video, 'loadeddata', () => { video.src = url; video.load(); }, controller.signal);
      if (!aliveRef.current || controller.signal.aborted) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration. Try a saved MP4 or WebM recording.');
      setImportedVideo({ name: file.name || 'Imported video', duration: video.duration });
      setMessage('Video loaded locally. Scrub to a moment and capture it, or extract images at the chosen interval. The video is never uploaded.');
    } catch (e) {
      if (aliveRef.current && !controller.signal.aborted) { onRemoveVideo(); setError(e.message); }
    } finally {
      if (aliveRef.current && videoAbortRef.current === controller) { videoAbortRef.current = null; setBusy(false); }
    }
  }

  async function onExtractVideo(sample = false) {
    if (!importedVideo || busy || attaching || framesRef.current.length >= MAX_CAPTURE_FRAMES) return;
    const controller = new AbortController();
    videoAbortRef.current = controller;
    setBusy(true); setExtracting(true); setError('');
    const video = importedVideoRef.current;
    const start = video.currentTime;
    const times = sample ? videoSampleTimes(start, importedVideo.duration, intervalSeconds, MAX_CAPTURE_FRAMES - framesRef.current.length) : [start];
    const initialCount = framesRef.current.length;
    try {
      for (const time of times) {
        await seekVideoFrame(video, time, controller.signal);
        if (!aliveRef.current || controller.signal.aborted) return;
        addFrame(captureCanvas(video), `Video ${formatVideoTime(time)}`);
        setVideoPosition(time);
      }
      setMessage(`${framesRef.current.length - initialCount} video images added. Review the selection below; unchanged sampled frames are skipped in changed-area mode.`);
    } catch (e) {
      if (aliveRef.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      if (aliveRef.current && videoAbortRef.current === controller) {
        videoAbortRef.current = null; setBusy(false); setExtracting(false);
      }
    }
  }

  function addFrame(canvas, timeLabel = null) {
    const previous = framesRef.current;
    if (previous.length >= MAX_CAPTURE_FRAMES) {
      setAutomatic(false); setMessage('The review tray is full (8 images). Attach your selection or clear it.'); return;
    }
    const settings = settingsRef.current;
    const before = previous[previous.length - 1]?.canvas;
    const sameSize = before && before.width === canvas.width && before.height === canvas.height;
    const bounds = sameSize ? frameDifference(before, canvas, settings.zones) : null;
    if (sameSize && !bounds && settings.mode === 'changes') {
      setMessage('No changes outside the ignored zones. No new image saved.'); return;
    }
    const frame = { id: previous.length + 1, canvas, selected: true, output: settings.mode, time: timeLabel || new Date().toLocaleTimeString() };
    const next = previous.concat(frame);
    framesRef.current = next; setFrames(next); setError('');
    setMessage(next.length === 1 ? 'Baseline captured. Later images can contain only the changed area.' : `Image ${next.length} captured. Review before attaching.`);
    if (next.length === MAX_CAPTURE_FRAMES) setAutomatic(false);
  }

  function onCapture() {
    try { addFrame(captureCanvas(videoRef.current)); }
    catch (e) { setAutomatic(false); setError(e.message); }
  }
  captureRef.current = onCapture;

  useEffect(() => {
    if (!automatic || !sharing || drawing) return undefined;
    const timer = setInterval(() => captureRef.current(), intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [automatic, sharing, drawing, intervalSeconds]);

  async function onImport(event) {
    const files = Array.from(event.currentTarget.files || []).slice(0, MAX_CAPTURE_FRAMES - framesRef.current.length);
    event.currentTarget.value = '';
    setError(''); setBusy(true);
    const request = ++requestRef.current;
    try {
      for (const file of files) {
        const attachment = await fileToImageAttachment(file);
        if (!attachment) continue;
        const image = new Image();
        image.src = attachment.dataUrl;
        await image.decode();
        if (!aliveRef.current || request !== requestRef.current) return;
        addFrame(captureCanvas(image));
      }
    } catch {
      if (aliveRef.current && request === requestRef.current) setError('Could not read a screenshot. Use a PNG, JPEG, WebP or GIF image.');
    } finally {
      if (aliveRef.current && request === requestRef.current) setBusy(false);
    }
  }

  const prepared = useMemo(() => frames.map((frame, index) => {
    const before = frames[index - 1]?.canvas;
    const sameSize = before && before.width === frame.canvas.width && before.height === frame.canvas.height;
    const bounds = sameSize ? frameDifference(before, frame.canvas, zones) : null;
    const unchanged = !!sameSize && !bounds;
    const crop = frame.output === 'changes' && bounds ? bounds : null;
    try {
      return { ...frame, bounds: crop, unchanged, dataUrl: exportCapture(frame.canvas, zones, crop), eligible: frame.output === 'full' || !unchanged };
    } catch (e) { return { ...frame, eligible: false, exportError: e.message }; }
  }), [frames, zones]);
  const chosen = prepared.filter((frame) => frame.selected && frame.eligible);
  const latest = prepared[prepared.length - 1];
  // The zone editor always shows the full frame, not its cropped output.
  const zonePreview = useMemo(() => {
    if (!frames.length) return null;
    try { return exportCapture(frames[frames.length - 1].canvas, zones); } catch { return null; }
  }, [frames, zones]);

  function updateFrame(id, patch) {
    const next = framesRef.current.map((frame) => frame.id === id ? { ...frame, ...patch } : frame);
    framesRef.current = next; setFrames(next);
  }
  function onClear() {
    setAutomatic(false); framesRef.current = []; setFrames([]); setDrawing(false);
    setMessage('Review tray cleared. The next capture is a new baseline.');
  }
  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function onZoneStart(event) {
    if (!drawing) return;
    event.preventDefault();
    drawRef.current = point(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onZoneMove(event) {
    if (!drawRef.current) return;
    const p = point(event), start = drawRef.current;
    setDraftZone(normalizedZone(start.x, start.y, p.x, p.y));
  }
  function onZoneEnd(event) {
    if (!drawRef.current) return;
    const p = point(event), start = drawRef.current;
    const zone = normalizedZone(start.x, start.y, p.x, p.y);
    drawRef.current = null; setDraftZone(null); setDrawing(false);
    if (zone.width > 0.01 && zone.height > 0.01) setZones((previous) => previous.concat(zone).slice(0, 8));
    else setMessage('Drag across the preview to create an ignored rectangle.');
  }
  async function onConfirm() {
    if (!chosen.length || chosen.length > availableSlots || attaching || busy) return;
    stopSharing(); setAttaching(true); setError('');
    try {
      await onAttach(chosen.map((frame) => captureAttachment(frame.dataUrl, frame.id - 1, frame.bounds)));
      if (aliveRef.current) onClose();
    } catch (e) {
      if (aliveRef.current) { setError('Could not save the images: ' + e.message); setAttaching(false); }
    }
  }
  const button = (label, onClick, disabled = false, primary = false) => h('button', { class: 'btn' + (primary ? ' btn--primary' : ''), type: 'button', onClick, disabled }, label);
  const rectStyle = (zone) => ({ left: `${zone.x * 100}%`, top: `${zone.y * 100}%`, width: `${zone.width * 100}%`, height: `${zone.height * 100}%` });

  return h('div', { class: 'capture__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'capture-title', onClick: (e) => { if (e.target === e.currentTarget && !attaching) onClose(); } },
    h('section', { class: 'capture__sheet', ref: sheetRef },
      h('header', { class: 'capture__header' },
        h('div', null, h('h2', { id: 'capture-title' }, 'Screen capture'), h('p', null, 'Images, not video · Review before sending')),
        h('button', { class: 'btn capture__close', type: 'button', onClick: onClose, disabled: attaching, 'aria-label': 'Close screen capture' }, '×')
      ),
      h('div', { class: 'capture__body' },
        h('video', { ref: videoRef, muted: true, playsInline: true, class: 'capture__video', 'aria-hidden': 'true' }),
        h('section', { class: 'capture__card' },
          h('h3', null, '1. Choose a source'),
          h('p', { class: 'capture__hint' }, sharing ? 'Screen sharing is active. Stop it at any time.' : supported ? 'Choose a browser tab, window or screen in the browser’s sharing dialog.' : 'This browser cannot share a screen. Import screenshots or a screen-recording video instead; desktop sharing requires HTTPS or localhost.'),
          h('div', { class: 'capture__actions' },
            sharing ? button('Stop sharing', () => { stopSharing(); setMessage('Sharing stopped. Review your captures below.'); }) : button(busy ? 'Opening…' : 'Share screen', onStartSharing, !supported || busy || attaching || !!importedVideo, true),
            h('label', { class: 'btn capture__import' + (busy || sharing || attaching || frames.length >= 8 ? ' capture__import--disabled' : '') }, 'Import screenshots',
              h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, disabled: busy || sharing || attaching || frames.length >= 8, onChange: onImport, 'aria-label': 'Import screenshots' })),
            h('label', { class: 'btn capture__import' + (busy || sharing || attaching ? ' capture__import--disabled' : '') }, 'Import video',
              h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', disabled: busy || sharing || attaching, onChange: onImportVideo, 'aria-label': 'Import video' }))
          ),
          h('div', { class: 'capture__video-source', hidden: !importedVideo },
            h('p', { class: 'capture__hint' }, importedVideo ? `${importedVideo.name} · ${formatVideoTime(importedVideo.duration)} · Local only` : ''),
            h('video', { ref: importedVideoRef, controls: !busy, muted: true, playsInline: true, preload: 'auto', 'aria-label': 'Imported video preview', onTimeUpdate: (e) => { if (!busy) setVideoPosition(e.currentTarget.currentTime); } }),
            h('p', { class: 'capture__hint' }, `Selected moment: ${formatVideoTime(videoPosition)}. Use the video timeline to choose a frame.`),
            h('div', { class: 'capture__actions' },
              button('Capture this frame', () => onExtractVideo(), busy || attaching || frames.length >= 8, true),
              button(`Extract every ${intervalSeconds}s`, () => onExtractVideo(true), busy || attaching || frames.length >= 8),
              extracting ? button('Stop extracting', () => videoAbortRef.current?.abort()) : button('Remove video', onRemoveVideo, busy || attaching)
            ),
            h('p', { class: 'capture__hint' }, 'Extraction starts at the selected moment and samples up to the remaining tray slots. Only chosen PNG images will be attached; no video or audio is sent.')
          )
        ),
        h('section', { class: 'capture__card' },
          h('h3', null, '2. Capture images'),
          h('div', { class: 'capture__segments', role: 'group', 'aria-label': 'New capture output' },
            ['changes', 'full'].map((value) => h('button', { class: 'btn' + (mode === value ? ' btn--primary' : ''), type: 'button', 'aria-pressed': String(mode === value), onClick: () => setMode(value) }, value === 'changes' ? 'Changed area only' : 'Full image'))),
          h('p', { class: 'capture__hint' }, 'The first image is a full baseline. Changes are compared with the previous captured image. Unchanged captures are skipped in changed-area mode.'),
          h('div', { class: 'capture__actions' }, button('Capture now', onCapture, !sharing || drawing || frames.length >= 8 || attaching, true)),
          h('div', { class: 'capture__auto' },
            h('label', null, h('input', { type: 'checkbox', checked: automatic, disabled: !sharing || frames.length >= 8 || attaching, onChange: (e) => setAutomatic(e.currentTarget.checked) }), 'Capture automatically'),
            h('select', { class: 'input', value: intervalSeconds, onChange: (e) => setIntervalSeconds(Number(e.currentTarget.value)), 'aria-label': 'Capture interval' }, [2, 3, 5, 10].map((value) => h('option', { value }, `Every ${value}s`)))
          )
        ),
        h('section', { class: 'capture__card' },
          h('h3', null, '3. Ignore zones'),
          h('p', { class: 'capture__hint' }, 'Ignored zones do not trigger differences and are blacked out in every attached image. Zones apply to all images in this tray.'),
          h('div', { class: 'capture__actions' },
            button('Ignore top 5% (status bar)', () => setZones((previous) => previous.concat({ x: 0, y: 0, width: 1, height: 0.05 }).slice(0, 8)), zones.length >= 8 || attaching),
            button(drawing ? 'Cancel drawing' : 'Draw ignored zone', () => { setDrawing(!drawing); drawRef.current = null; setDraftZone(null); }, !latest || zones.length >= 8 || attaching)
          ),
          drawing ? h('p', { class: 'capture__hint', role: 'status' }, 'Drag a rectangle on the preview. Automatic capture pauses while drawing.') : null,
          zonePreview ? h('div', { class: 'capture__zone-preview' + (drawing ? ' capture__zone-preview--drawing' : ''), onPointerDown: onZoneStart, onPointerMove: onZoneMove, onPointerUp: onZoneEnd, onPointerCancel: () => { drawRef.current = null; setDraftZone(null); } },
            h('img', { src: zonePreview, alt: 'Full capture preview for ignored zones', draggable: false }),
            zones.map((zone, index) => h('span', { key: index, class: 'capture__zone', style: rectStyle(zone) }, String(index + 1))),
            draftZone ? h('span', { class: 'capture__zone capture__zone--draft', style: rectStyle(draftZone) }) : null
          ) : null,
          zones.length ? h('ul', { class: 'capture__zones' }, zones.map((zone, index) => h('li', { key: index },
            h('span', null, `Zone ${index + 1} · ${Math.round(zone.width * 100)}% × ${Math.round(zone.height * 100)}%`),
            button('Remove', () => setZones((previous) => previous.filter((_, i) => i !== index)), attaching)))) : null
        ),
        h('section', { class: 'capture__card' },
          h('div', { class: 'capture__review-head' }, h('h3', null, `4. Review · ${frames.length}/8`), button('Clear tray', onClear, !frames.length || attaching || busy)),
          !frames.length ? h('div', { class: 'capture__empty' }, 'Your captures will appear here. Choose the images you want to attach.') : null,
          h('div', { class: 'capture__gallery' }, prepared.map((frame, index) => h('article', { key: frame.id, class: 'capture__frame' + (frame.selected && frame.eligible ? ' capture__frame--selected' : '') },
            h('label', { class: 'capture__selection' }, h('input', { type: 'checkbox', checked: frame.selected, disabled: !frame.eligible || attaching, onChange: (e) => updateFrame(frame.id, { selected: e.currentTarget.checked }) }), `Image ${index + 1}`, h('span', null, frame.time)),
            frame.dataUrl ? h('img', { src: frame.dataUrl, alt: `Capture ${index + 1}${frame.bounds ? ', changed area' : ', full image'}` }) : null,
            h('select', { class: 'input', value: frame.output, disabled: attaching, 'aria-label': `Output for image ${index + 1}`, onChange: (e) => updateFrame(frame.id, { output: e.currentTarget.value }) }, h('option', { value: 'full' }, 'Full image'), h('option', { value: 'changes' }, index === 0 ? 'Baseline (full image)' : 'Changed area only')),
            h('p', { class: 'capture__hint' }, frame.exportError || (frame.bounds ? `Crop at ${frame.bounds.x}, ${frame.bounds.y} · ${frame.bounds.width} × ${frame.bounds.height}` : frame.unchanged && frame.output === 'changes' ? 'No difference. Choose Full image to include it.' : 'Full image · ignored zones masked'))
          )))
        ),
        h('p', { class: 'capture__message', role: 'status', 'aria-live': 'polite' }, message),
        error ? h('p', { class: 'capture__error', role: 'alert' }, error) : null
      ),
      h('footer', { class: 'capture__footer' },
        h('p', null, chosen.length > availableSlots ? `Choose at most ${availableSlots} images. The chat allows 8 attachments.` : `${chosen.length} selected · ${availableSlots} attachment slots available`),
        button(attaching ? 'Saving…' : `Attach ${chosen.length || ''} image${chosen.length === 1 ? '' : 's'}`, onConfirm, !chosen.length || chosen.length > availableSlots || attaching || busy, true),
        h('small', null, 'Adds images to your draft. Use Send in chat when ready.')
      )
    )
  );
}
