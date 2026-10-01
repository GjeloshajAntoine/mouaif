import assert from 'node:assert/strict';
import { formatVideoTime, videoSampleTimes, waitForVideo, seekVideoFrame, releaseVideo } from '../frontend/src/components/chat/videoCapture.js';

assert.equal(formatVideoTime(65.4), '1:05.4');
assert.deepEqual(videoSampleTimes(0, 7, 3, 8), [0, 3, 6]);
assert.deepEqual(videoSampleTimes(4, 7, 3, 8), [4]);
assert.equal(videoSampleTimes(0, 1000, 2, 1000).length, 8);
assert.deepEqual(videoSampleTimes(0, Infinity, 2, 8), []);
assert.deepEqual(videoSampleTimes(0, 7, 3, 0), []);

class FakeVideo extends EventTarget {
  listeners = new Set();
  duration = 7;
  currentTime = 0;
  readyState = 2;
  paused = false;
  addEventListener(name, fn, options) { this.listeners.add(fn); super.addEventListener(name, fn, options); }
  removeEventListener(name, fn) { this.listeners.delete(fn); super.removeEventListener(name, fn); }
  pause() { this.paused = true; }
  removeAttribute(name) { this.removed = name; }
  load() { this.loaded = true; }
}
const video = new FakeVideo();
await waitForVideo(video, 'loadeddata', () => video.dispatchEvent(new Event('loadeddata')));
assert.equal(video.listeners.size, 0, 'ready removes listeners');
await assert.rejects(waitForVideo(video, 'loadeddata', () => video.dispatchEvent(new Event('error'))), /cannot decode/);
assert.equal(video.listeners.size, 0, 'error removes listeners');
await assert.rejects(waitForVideo(video, 'seeked', () => {}, undefined, 1), /too long/);
assert.equal(video.listeners.size, 0, 'timeout removes listeners');
const controller = new AbortController();
await assert.rejects(waitForVideo(video, 'seeked', () => controller.abort(), controller.signal), { name: 'AbortError' });
assert.equal(video.listeners.size, 0, 'abort removes listeners');
await assert.rejects(waitForVideo(video, 'seeked', () => {}, controller.signal), { name: 'AbortError' });
await seekVideoFrame(video, 0);
assert.equal(video.paused, true, 'capture pauses playback');
const pending = seekVideoFrame(video, 3);
video.dispatchEvent(new Event('seeked')); await pending;
assert.equal(video.currentTime, 3);
releaseVideo(video, null);
assert.equal(video.removed, 'src'); assert.equal(video.loaded, true);
console.log('video capture: sample bounds, timestamp labels, seek, cancellation, errors and lifecycle passed');
