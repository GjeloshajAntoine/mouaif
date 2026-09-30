// Chat pagination scroll stability.
//
// Scrolling up through a long chat jumped on phones for two reasons:
//   1. `content-visibility: auto` rows report a 120px placeholder until they
//      first scroll into view, then snap to their real height. Without CSS
//      scroll anchoring (WebKit: Safari and every iOS browser) that shift
//      moves the rows being read. The rule must be gated on anchoring.
//   2. An older page landing mid-fling wrote a compensating `scrollTop`,
//      which cancels iOS momentum. Prepends must wait for the transcript to
//      go idle.
// Rows inserted above the viewport also skip the entry animation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { whenTranscriptScrollIdle, noteTranscriptScroll, trackUserScrollIntent } from '../frontend/src/components/chat/scroll.js';

// ---- 1. CSS contract: row skipping only where scroll anchoring exists.
{
  const css = fs.readFileSync(new URL('../frontend/src/chat-transcript.css', import.meta.url), 'utf8');
  const at = css.indexOf('content-visibility: auto;');
  assert.ok(at > 0, 'content-visibility rule still present');
  const gate = css.lastIndexOf('@supports (overflow-anchor: auto)', at);
  assert.ok(gate > 0, 'content-visibility is inside @supports (overflow-anchor: auto)');
  const between = css.slice(gate, at);
  assert.equal((between.match(/}/g) || []).length, 0, 'no block closes between the gate and the rule');
  assert.match(css, /\.chat-view__transcript > \.is-backfilled \{ animation: none; \}/, 'backfilled rows skip the entry animation');
  console.log('PASS content-visibility is gated on scroll anchoring; backfilled rows are not animated');
}

// ---- 2. Idle gate: waits while touching or scrolling, bounded.
{
  let clock = 0;
  const now = () => clock;
  const waits = [];
  const wait = async (ms) => { waits.push(ms); clock += ms; };
  const listeners = {};
  const el = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { listeners[t] && listeners[t].delete(fn); },
    ownerDocument: { addEventListener() {}, removeEventListener() {} }
  };
  const fire = (t) => { for (const fn of listeners[t] || []) fn({}); };
  const intent = trackUserScrollIntent(el, now);
  const refs = { _scrollIntent: intent };

  await whenTranscriptScrollIdle(refs, { now, wait });
  assert.equal(waits.length, 0, 'an idle transcript resolves at once');

  noteTranscriptScroll(refs, clock);
  await whenTranscriptScrollIdle(refs, { now, wait, quietMs: 160 });
  assert.ok(clock >= 160, 'waits out the quiet period after a scroll');

  fire('touchstart');
  assert.equal(intent.isTouching(), true);
  const start = clock;
  let done = false;
  const p = whenTranscriptScrollIdle(refs, { now, wait: async (ms) => { clock += ms; if (clock - start >= 400) fire('touchend'); }, quietMs: 160 }).then(() => { done = true; });
  await p;
  assert.equal(done, true);
  assert.ok(clock - start >= 400, 'holds while a finger is on the transcript');
  assert.equal(intent.isTouching(), false);

  fire('touchstart');
  const s2 = clock;
  await whenTranscriptScrollIdle(refs, { now, wait, maxMs: 1000 });
  assert.ok(clock - s2 >= 1000 && clock - s2 < 1100, 'bounded by maxMs so pagination is never starved');
  fire('touchend');
  intent.dispose();
  console.log('PASS prepends wait for touch release and scroll quiet, bounded by maxMs');
}
