// What the run dock says about a run (frontend/src/components/chat/runDock.js).
import assert from 'node:assert/strict';
import { formatLeft, runLine, isActive, ATTENTION, STATUS_TEXT } from '../frontend/src/components/chat/runDock.js';

assert.equal(formatLeft(null), '');
assert.equal(formatLeft(0), '0m left');
assert.equal(formatLeft(45), '45m left');
assert.equal(formatLeft(60), '1h 0m left');
assert.equal(formatLeft(95), '1h 35m left');
assert.equal(formatLeft(120), '2h left');
assert.equal(formatLeft(1440), '24h left');

const run = { status: 'running', turnsUsed: 3, maxTurns: 50, costUsed: 0.4567, maxCost: null, minutesLeft: 95, endReason: null };
assert.equal(runLine(run), '3/50 turns · $0.46 · 1h 35m left');
assert.equal(runLine({ ...run, costUsed: 0 }), '3/50 turns · 1h 35m left', 'no spend, no cost part');
assert.equal(runLine({ ...run, maxCost: 2 }), '3/50 turns · $0.46 of $2 · 1h 35m left');
assert.equal(runLine({ ...run, status: 'paused' }), '3/50 turns · $0.46 · 1h 35m left');
const stalled = { ...run, status: 'stalled', endReason: 'no progress after 3 reminders' };
assert.equal(runLine(stalled), '3/50 turns · $0.46 · no progress after 3 reminders', 'a finished run shows why, not time left');

assert.equal(isActive(run), true);
assert.equal(isActive({ status: 'paused' }), true);
for (const status of ['stopped', 'ended', 'stalled', 'exhausted']) assert.equal(isActive({ status }), false, status);
assert.equal(isActive(null), false);
assert.deepEqual(ATTENTION, ['stalled', 'exhausted'], 'only runs that need the user stay on screen after they end');
for (const status of ['running', 'paused', ...ATTENTION]) assert.ok(STATUS_TEXT[status], status + ' has a label');

console.log('run dock: time, cost and status text passed');
