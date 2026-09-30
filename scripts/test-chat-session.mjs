// Unit test for the per-chat session bag
// (frontend/src/components/chat/session.js) and the derived seq index that
// replaced the separate `seenSeqs` store (msgMerge.js heldSeqs).
//
// ChatView is reused across chat navigation, so every per-chat value must be
// replaced together when the chat changes. These cases pin that contract:
// one fresh shape per chat, reuse for the same chat, a new session when only
// the project changes (same chat id in two projects), and a merge that no
// longer mutates shared state.

import assert from 'node:assert/strict';
import { newChatSession, ensureChatSession, chatSessionKey, emptyLiveRun } from '../frontend/src/components/chat/session.js';
import { heldSeqs, mergeServerRows, nextServerMessageIndex } from '../frontend/src/components/chat/msgMerge.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

check('a new session starts from one known shape', () => {
  const s = newChatSession('/p', 'aaaa0001');
  assert.equal(s.key, '/p::aaaa0001');
  assert.deepEqual(s.messages, []);
  assert.equal(s.transcriptNextSeq, 0);
  assert.equal(s.nextLiveSeq, 0);
  assert.equal(s.runSettled, false);
  assert.equal(s.watchingStableTicks, 0);
  assert.deepEqual(s.liveRun, emptyLiveRun());
  assert.ok(s.usedTools instanceof Set && s.usedTools.size === 0);
  assert.equal(s.pager.hasMore, true);
  assert.equal(s.pager.beforeSeq, null);
});

check('the same chat keeps its session (no reset on re-render)', () => {
  const s = newChatSession('/p', 'aaaa0001');
  s.messages = [{ role: 'user', content: 'x', seq: 0 }];
  assert.equal(ensureChatSession(s, '/p', 'aaaa0001'), s);
});

check('another chat gets a fresh session with nothing carried over', () => {
  const s = newChatSession('/p', 'aaaa0001');
  s.messages = [{ role: 'user', content: 'x', seq: 0 }];
  s.transcriptNextSeq = 7;
  s.nextLiveSeq = 3;
  s.runSettled = true;
  s.usedTools.add('shell');
  s.pager.beforeSeq = 12;
  const next = ensureChatSession(s, '/p', 'bbbb0002');
  assert.notEqual(next, s);
  assert.deepEqual(next.messages, []);
  assert.equal(next.transcriptNextSeq, 0);
  assert.equal(next.nextLiveSeq, 0);
  assert.equal(next.runSettled, false);
  assert.equal(next.usedTools.size, 0);
  assert.equal(next.pager.beforeSeq, null);
  // The old session is left intact: a late write lands there, not here.
  assert.equal(s.messages.length, 1);
});

check('the same chat id in another project is a different session', () => {
  const s = newChatSession('/p1', 'aaaa0001');
  s.runSettled = true;
  const next = ensureChatSession(s, '/p2', 'aaaa0001');
  assert.notEqual(next, s);
  assert.equal(next.runSettled, false);
  assert.notEqual(chatSessionKey('/p1', 'aaaa0001'), chatSessionKey('/p2', 'aaaa0001'));
});

check('heldSeqs is derived from the rows, ignoring unsaved ones', () => {
  const set = heldSeqs([
    { role: 'user', seq: 0 }, { role: 'assistant' }, { role: 'tool', seq: 2 }, null, { seq: NaN }
  ]);
  assert.deepEqual([...set].sort(), [0, 2]);
  assert.equal(heldSeqs(null).size, 0);
});

check('mergeServerRows is pure and drops re-delivered seqs', () => {
  const state = { messages: [{ role: 'user', content: 'q', seq: 0 }] };
  const before = state.messages;
  const out = mergeServerRows(state, [
    { role: 'user', content: 'q', seq: 0 },
    { role: 'assistant', content: 'a', seq: 1 },
    { role: 'assistant', content: 'a', seq: 1 }
  ]);
  assert.equal(state.messages, before, 'state.messages is not reassigned');
  assert.equal(before.length, 1, 'the held list is not mutated');
  assert.deepEqual(out.map((m) => m.seq), [0, 1]);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'seenSeqs'), false, 'no seen-set is written');
});

check('nextServerMessageIndex follows the rows alone', () => {
  assert.equal(nextServerMessageIndex({ messages: [] }), 0);
  assert.equal(nextServerMessageIndex({ messages: [{ seq: 4 }, { role: 'user' }] }), 5);
});

console.log('--- ' + passed + ' passed ---');
