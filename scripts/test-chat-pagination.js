// Unit test for the chat backward-pagination cursor logic
// (frontend/src/components/chat/pagination.js). Pure module, no
// preact/DOM — runnable directly.
//
// Proves the cursor walking rules that drive the scroll-up loader:
//   - the newest page seeds offset/beforeSeq/hasMore from the first
//     window fetch;
//   - shouldLoadOlder only fires near the top, when an older page
//     exists, and never while a page is in flight;
//   - reset clears the cursor for a chat/project change so the next
//     page starts from the top again.
'use strict';
let pass = 0, fail = 0;
function t(name, cond, msg) {
if (cond) { pass++; console.log('  ok  - ' + name); }
else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + JSON.stringify(msg)) : '')); }
}
async function run() {
const { createPager, recordInitialPage, resetPager, shouldLoadOlder, NEAR_TOP_PX } = await import(
'../frontend/src/components/chat/pagination.js'
);
t('NEAR_TOP_PX is 48', NEAR_TOP_PX === 48, NEAR_TOP_PX);

// 1. A fresh pager is empty and unloadable.
const p = createPager();
t('fresh pager offset 0', p.offset === 0, p);
t('fresh pager hasMore true', p.hasMore === true, p.hasMore);
t('fresh pager loading false', p.loading === false, p.loading);
t('fresh pager beforeSeq null', p.beforeSeq === null, p.beforeSeq);
t('fresh pager not loadable (no beforeSeq)', shouldLoadOlder(p, 0) === false, shouldLoadOlder(p, 0));

// 2. Seed from the first page: 5 of 12 messages (seqs 7..11).
recordInitialPage(p, { messages: [{ seq: 7 }, { seq: 8 }, { seq: 9 }, { seq: 10 }, { seq: 11 }], total: 12, hasMore: true, beforeSeq: 7 });
t('seeded offset 5', p.offset === 5, p.offset);
t('seeded beforeSeq 7', p.beforeSeq === 7, p.beforeSeq);
t('seeded hasMore true', p.hasMore === true, p.hasMore);
t('seeded total 12', p.total === 12, p.total);
t('seeded firstSeq 7', p.firstSeq === 7, p.firstSeq);

// 3. shouldLoadOlder: only near the top.
t('loadable at top', shouldLoadOlder(p, 0) === true, couldLoad(p));
t('loadable just inside threshold', shouldLoadOlder(p, NEAR_TOP_PX - 1) === true, '');
t('not loadable below threshold', shouldLoadOlder(p, NEAR_TOP_PX + 10) === false, '');
// In-flight latch blocks a second load.
p.loading = true;
t('blocked while loading', shouldLoadOlder(p, 0) === false, couldLoad(p));
p.loading = false;

// 4. No more older pages -> never load.
p.hasMore = false;
t('blocked when no more', shouldLoadOlder(p, 0) === false, couldLoad(p));
p.hasMore = true;

// 5. Reset clears the cursor.
resetPager(p);
t('reset offset 0', p.offset === 0, p.offset);
t('reset beforeSeq null', p.beforeSeq === null, p.beforeSeq);
t('reset hasMore true', p.hasMore === true, p.hasMore);
t('reset not loadable', shouldLoadOlder(p, 0) === false, couldLoad(p));

// 6. A last page (hasMore=false) advances the cursor and stops loads.
recordInitialPage(p, { messages: [{ seq: 0 }, { seq: 1 }], total: 12, hasMore: false, beforeSeq: 0 });
t('last page offset 2', p.offset === 2, p.offset);
t('last page beforeSeq 0', p.beforeSeq === 0, p.beforeSeq);
t('last page hasMore false', p.hasMore === false, p.hasMore);
// beforeSeq 0 means "nothing older"; even at the top we must not load.
t('last page not loadable', shouldLoadOlder(p, 0) === false, couldLoad(p));

// 7. A response that omits `hasMore` must not latch pagination off.
// The legacy message endpoints do not send the flag; reading the absent
// value as false left a cursor that could never fetch history even
// though a valid beforeSeq bound came back with the same response.
resetPager(p);
recordInitialPage(p, { messages: [{ seq: 20 }, { seq: 21 }], total: 30, beforeSeq: 20 });
t('absent hasMore stays loadable', p.hasMore === true, p.hasMore);
t('absent hasMore keeps the cursor', p.beforeSeq === 20, p.beforeSeq);
t('absent hasMore loads at the top', shouldLoadOlder(p, 0) === true, couldLoad(p));

// 8. ...but an explicit false still stops it, and a missing cursor is
// still unloadable (there is nothing to page back from).
resetPager(p);
recordInitialPage(p, { messages: [{ seq: 20 }], total: 21, hasMore: false, beforeSeq: 20 });
t('explicit hasMore false stops loads', p.hasMore === false, p.hasMore);
resetPager(p);
recordInitialPage(p, { messages: [{ seq: 20 }], total: 21 });
t('a cursor is derived from the oldest row', p.beforeSeq === 20, p.beforeSeq);
resetPager(p);
recordInitialPage(p, { messages: [{ role: 'user' }], total: 21 });
t('no cursor at all, no loads', p.hasMore === false && shouldLoadOlder(p, 0) === false, couldLoad(p));
t('no cursor means hasMore false', p.hasMore === false, p.hasMore);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}
function couldLoad(p) { return p && p.beforeSeq !== null && p.hasMore && !p.loading; }
run().catch((e) => { console.error(e); process.exit(1); });
