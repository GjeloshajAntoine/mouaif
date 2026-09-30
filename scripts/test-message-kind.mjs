// Unit test for the derived transcript row kind
// (frontend/src/components/chat/messageKind.js) and the retry helpers that
// now read it (retry.js).
//
// The kind is computed from role/phase/content only: these cases pin every
// branch, check that nothing is written onto the row, and check that a
// subagent-shaped row (tool_call_id, no phase) is not mistaken for a
// top-level tool card.

import assert from 'node:assert/strict';
import { messageKind } from '../frontend/src/components/chat/messageKind.js';
import { isPersistedTurnError, retryPayloadForError } from '../frontend/src/components/chat/retry.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

check('user and assistant rows map to their role', () => {
  assert.equal(messageKind({ role: 'user', content: 'hi', ts: 't' }), 'user');
  assert.equal(messageKind({ role: 'assistant', content: '', ts: 't' }), 'assistant');
});

check('tool rows split on phase', () => {
  assert.equal(messageKind({ role: 'tool', phase: 'call', toolCallId: 'a', content: '' }), 'tool_call');
  assert.equal(messageKind({ role: 'tool', phase: 'result', toolCallId: 'a', content: 'ok' }), 'tool_result');
});

check('a tool row with no phase (subagent shape) is not a tool card', () => {
  assert.equal(messageKind({ role: 'tool', tool_call_id: 'x', content: 'r' }), 'system');
});

check('a warning-marked system row is an error, other system rows are not', () => {
  assert.equal(messageKind({ role: 'system', content: '⚠ EUPSTREAM: boom' }), 'error');
  assert.equal(messageKind({ role: 'system', content: '⚠' }), 'error');
  assert.equal(messageKind({ role: 'system', content: '⚠x' }), 'system');
  assert.equal(messageKind({ role: 'system', content: 'context' }), 'system');
  assert.equal(messageKind({ role: 'system' }), 'system');
});

check('unknown or missing rows fall back to system', () => {
  assert.equal(messageKind(null), 'system');
  assert.equal(messageKind(undefined), 'system');
  assert.equal(messageKind({ role: 'developer', content: 'x' }), 'system');
});

check('the kind is derived, never stored', () => {
  const row = Object.freeze({ role: 'tool', phase: 'call', toolCallId: 'a', content: '' });
  assert.equal(messageKind(row), 'tool_call');
  assert.deepEqual(Object.keys(row).sort(), ['content', 'phase', 'role', 'toolCallId']);
});

check('retry helpers agree with the kind', () => {
  const user = { role: 'user', content: 'again', attachments: [] };
  const err = { role: 'system', content: '⚠ failed' };
  assert.equal(isPersistedTurnError(err), true);
  assert.equal(isPersistedTurnError({ role: 'assistant', content: '⚠ quoted' }), false);
  const call = { role: 'tool', phase: 'call', toolCallId: 'a', content: '' };
  assert.deepEqual(retryPayloadForError([user, call, err], err), { content: 'again', attachments: [] });
});

console.log('\n' + passed + ' passed');
