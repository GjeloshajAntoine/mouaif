// liveShot — the pacing for the Styles panel's live element preview.
//
// ## Why this exists
//
// The pinned element preview (`.inspector__styles-shot`) used to be a
// snapshot: it re-captured when the *panel* acted — a selection, an edit, a
// tap on the image itself — and never otherwise. Anything that changed the
// page without going through the panel (typing into a field on the inspected
// page, the page's own script re-rendering, a stylesheet swap) therefore left a
// stale image behind, and the only way to see the current state was to refresh
// by hand. A preview of the thing you are editing has to be the thing you are
// editing, so that gap is closed here.
//
// ## Why a poll
//
// The event-driven signal the Preview panel uses (`Page.startScreencast`) is a
// single stream per target, and its frames are acknowledged by *that* panel's
// capture loop to pace itself (see PreviewPanel.jsx). Two consequences rule it
// out as the signal for this preview: the pinned preview must stay live in the
// Styles-only layout on a phone, where the Preview panel is hidden and no
// stream is running at all, and a second consumer of the same frames would have
// to ack them too, which is what paces the preview. A clipped
// `Page.captureScreenshot` of one element is cheap — a box read plus a small
// PNG on the inspected side, no decode at all when the bytes are unchanged —
// so the freshness is bought with a slow poll instead of a second stream.
//
// ## What the policy is
//
// - one capture per interval, scheduled after the previous one *finished*, so a
//   slow capture can never be followed immediately by another;
// - never two at once (an in-flight capture is not interrupted);
// - skipped while the app is in the background (`document.visibilityState`),
//   where nothing on screen can change, and while a manual capture is running,
//   which owns the preview;
// - a capture that throws, or that returns nothing, is a no-op: the loop keeps
//   its schedule and the previous image stays on screen.
//
// The interval is deliberately slow. This is a preview that must not *lie*,
// not a video: 800 ms is under a human's "did I just change that?" latency
// while leaving the inspected page idle most of the time.
export const LIVE_SHOT_MS = 800;

// createLiveShot — start/stop the paced capture loop.
//
// `capture` is an async function that takes no arguments; it owns the work and
// the decision of whether a new image is worth publishing. Only the timing
// policy lives here, so it can be exercised without a document or a CDP
// connection (see scripts/test-inspector-live-shot.js).
export function createLiveShot(options) {
  const opts = options || {};
  const interval = Math.max(200, Number(opts.intervalMs) || LIVE_SHOT_MS);
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
  const isHidden = opts.isHidden || (() => false);
  const busy = opts.busy || (() => false);
  let stopped = true;
  let timer = null;
  let inFlight = false;

  async function tick() {
    timer = null;
    if (stopped) return;
    if (!inFlight && !isHidden() && !busy()) {
      inFlight = true;
      try {
        await opts.capture();
      } catch { /* keep the previous preview and keep the schedule */ }
      finally { inFlight = false; }
    }
    // Re-arm only if this loop is still the live one: `stop()` may have run
    // while the capture was in flight, and a timer armed after it would keep a
    // hidden panel capturing forever.
    if (!stopped) timer = setTimer(tick, interval);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimer(tick, interval);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    }
  };
}
