// Browser-local video decode/seek lifecycle. Original videos never leave the
// device; callers turn individual decoded frames into regular PNG attachments.
export function formatVideoTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, '0')}.${String(Math.floor((value % 1) * 10))}`;
}

export function videoSampleTimes(start, duration, interval, count) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const step = Math.max(0.1, Number(interval) || 3);
  const first = Math.max(0, Math.min(Number(start) || 0, Math.max(0, duration - 0.001)));
  const times = [];
  for (let index = 0; index < Math.min(8, Math.max(0, count)); index += 1) {
    const time = first + index * step;
    if (time >= duration) break;
    times.push(time);
  }
  return times;
}

function abortError() { return new DOMException('Video import cancelled.', 'AbortError'); }

// Register before changing src/currentTime so cached events cannot be missed.
// Every wait is bounded and abortable, with listeners released on all paths.
export function waitForVideo(video, eventName, action, signal, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let timer;
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    }
    function onReady() { cleanup(); resolve(); }
    function onError() { cleanup(); reject(new Error('This browser cannot decode that video. Try an MP4 (H.264) or WebM recording.')); }
    function onAbort() { cleanup(); reject(abortError()); }
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('The video took too long to load or seek. Try a shorter recording.')); }, timeoutMs);
    try { action(); } catch (e) { cleanup(); reject(e); }
  });
}

export async function seekVideoFrame(video, seconds, signal) {
  if (signal?.aborted) throw abortError();
  video.pause();
  const target = Math.max(0, Math.min(seconds, Math.max(0, video.duration - 0.001)));
  if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2 && !video.seeking) return;
  await waitForVideo(video, 'seeked', () => { video.currentTime = target; }, signal);
  if (video.readyState < 2) throw new Error('That video frame is not ready. Try another position.');
}

export function releaseVideo(video, url) {
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (url) URL.revokeObjectURL(url);
}
