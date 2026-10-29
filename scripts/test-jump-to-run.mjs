// The run list's jump (frontend/src/components/chat/jumpToRun.js): load older
// pages until the run's row exists, then scroll to it.
import assert from 'node:assert/strict';
import { findRowBySeq, jumpToSeq } from '../frontend/src/components/chat/jumpToRun.js';

// A transcript with rows by seq; loadOlder reveals the next ten older seqs.
function transcript(visibleFrom, oldest = 0) {
  const rows = new Map();
  const add = (seq) => rows.set(seq, { seq });
  for (let s = visibleFrom; s <= 99; s++) add(s);
  return {
    rows,
    root: { querySelector: (sel) => { const m = sel.match(/data-seq="(\d+)"/); return m && rows.get(Number(m[1])) || null; } },
    hasMore: () => visibleFrom > oldest,
    async loadOlder() {
      const from = Math.max(oldest, visibleFrom - 10);
      for (let s = from; s < visibleFrom; s++) add(s);
      const inserted = visibleFrom > from;
      visibleFrom = from;
      return inserted;
    }
  };
}

const noWait = async () => {};
const landed = [];
const options = (t, seq) => ({ root: t.root, seq, hasMore: t.hasMore, loadOlder: () => t.loadOlder(), scrollTo: (row) => landed.push(row.seq), wait: noWait });

assert.equal(findRowBySeq(null, 3), null);
assert.equal(findRowBySeq({ querySelector() { return null; } }, NaN), null);

// Already on screen: no page is fetched.
let t = transcript(50);
let fetched = 0;
let ok = await jumpToSeq({ ...options(t, 70), loadOlder: async () => { fetched++; return false; } });
assert.deepEqual([ok, fetched, landed.at(-1)], [true, 0, 70]);

// Far above the loaded window: pages are pulled until it appears, and no further.
t = transcript(90);
ok = await jumpToSeq(options(t, 12));
assert.equal(ok, true);
assert.equal(landed.at(-1), 12);
assert.equal(t.hasMore(), true, 'it stopped as soon as the row existed');
assert.ok(t.rows.has(12) && !t.rows.has(1), 'older pages beyond it were not loaded');

// A message that does not exist ends when history runs out.
t = transcript(90);
ok = await jumpToSeq(options(t, 100000));
assert.equal(ok, false);
assert.equal(t.hasMore(), false, 'all of the history was searched first');

// The page latch is held by the background drain: wait and retry until it arrives.
t = transcript(90);
let calls = 0;
const busy = async () => { if (++calls < 4) return false; return t.loadOlder(); };
ok = await jumpToSeq({ ...options(t, 85), loadOlder: busy });
assert.deepEqual([ok, landed.at(-1)], [true, 85]);

// A load that never succeeds gives up at the deadline instead of spinning.
let time = 0;
ok = await jumpToSeq({ root: { querySelector: () => null }, seq: 5, hasMore: () => true, loadOlder: async () => false,
  scrollTo() {}, wait: async () => { time += 5000; }, now: () => time, timeoutMs: 20000 });
assert.equal(ok, false);

console.log('jump to run: found on screen, loads older pages, stops at the row, gives up cleanly passed');
