// Chat transcript scroll-nav rail: previous / next message, bottom.
import assert from 'node:assert/strict';
import { findAdjacentMessage, scrollToAdjacentMessage, updateJumpButton, noteTranscriptScrollTop } from '../frontend/src/components/chat/scroll.js';

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// ---- pure index lookup
const tops = [0, 300, 700, 1200];
assert.equal(findAdjacentMessage(tops, 700, -1), 1, 'prev from the start of row 2 goes to row 1');
assert.equal(findAdjacentMessage(tops, 900, -1), 2, 'prev from inside row 2 goes to its start');
assert.equal(findAdjacentMessage(tops, 2, -1), -1, 'nothing above the first row');
assert.equal(findAdjacentMessage(tops, 700, 1), 3, 'next skips the row being read');
assert.equal(findAdjacentMessage(tops, 1200, 1), -1, 'nothing after the last row');
console.log('PASS findAdjacentMessage picks the right row in both directions');

// ---- DOM-shaped fake transcript
function makeTranscript(rowTops, clientHeight = 500, scrollHeight = 2000) {
  const el = { scrollTop: 0, clientHeight, scrollHeight, children: [] };
  el.getBoundingClientRect = () => ({ top: 100 });
  for (const t of rowTops) {
    const isMsg = t.msg !== false;
    el.children.push({
      isConnected: true,
      classList: { contains: (c) => c === 'chat-msg' && isMsg },
      getBoundingClientRect: () => ({ top: 100 + t.top - el.scrollTop })
    });
  }
  return el;
}
function makeNav() {
  const count = { textContent: '' };
  const jump = { hidden: true, querySelector: () => count };
  const nav = { hidden: true, dataset: { mode: 'pinned' } };
  return { jump, nav, count };
}
function makeRefs(el) {
  const { jump, nav, count } = makeNav();
  return {
    refs: { transcript: { current: el }, pinnedToBottom: { current: true }, pendingCount: { current: 0 }, jumpBtn: { current: jump }, scrollNav: { current: nav } },
    jump, nav, count
  };
}

{
  const el = makeTranscript([{ top: 0 }, { top: 300, msg: false }, { top: 600 }, { top: 1100 }]);
  el.scrollTop = 1500;
  const { refs, jump, nav } = makeRefs(el);
  scrollToAdjacentMessage(refs, -1);
  assert.equal(el.scrollTop, 1100 - 6, 'prev aligns the last message row with the top');
  assert.equal(refs.pinnedToBottom.current, false, 'a nav jump unpins');
  assert.equal(nav.dataset.mode, 'free');
  assert.equal(jump.hidden, false, 'bottom arrow shows once unpinned');
  scrollToAdjacentMessage(refs, -1);
  assert.equal(el.scrollTop, 600 - 6, 'prev skips the tool card');
  scrollToAdjacentMessage(refs, 1);
  assert.equal(el.scrollTop, 1100 - 6, 'next returns to the following message');
  scrollToAdjacentMessage(refs, -1);
  scrollToAdjacentMessage(refs, -1);
  scrollToAdjacentMessage(refs, -1);
  assert.equal(el.scrollTop, 0, 'prev past the first row lands at the very top');
  console.log('PASS prev/next step between message rows and skip tool cards');
}

{
  const el = makeTranscript([{ top: 0 }, { top: 600 }]);
  el.scrollTop = 700;
  const { refs, jump } = makeRefs(el);
  refs.pinnedToBottom.current = false;
  scrollToAdjacentMessage(refs, 1);
  assert.equal(refs.pinnedToBottom.current, true, 'next past the last row re-pins to the bottom');
  assert.equal(jump.hidden, true);
  console.log('PASS next after the last message re-pins');
}

{
  const el = makeTranscript([]);
  const { refs, nav, jump, count } = makeRefs(el);
  updateJumpButton(refs);
  assert.equal(nav.hidden, true, 'rail hidden while pinned and not overflowing');
  noteTranscriptScrollTop(refs, 250);
  assert.equal(nav.hidden, false, 'prev arrow shows once the transcript overflows');
  assert.equal(nav.dataset.mode, 'pinned');
  assert.equal(jump.hidden, true);
  refs.pinnedToBottom.current = false;
  refs.pendingCount.current = 120;
  updateJumpButton(refs);
  assert.equal(jump.hidden, false);
  assert.equal(count.textContent, '99+');
  refs.pendingCount.current = 0;
  updateJumpButton(refs);
  assert.equal(count.textContent, '', 'no badge without pending rows');
  console.log('PASS rail visibility follows pinned state, overflow and pending count');
}
