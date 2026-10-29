// What the run dock says about a run (frontend/src/components/chat/runDock.js).
import assert from 'node:assert/strict';
import { runListItems, runWhen, runsLabel, formatLeft, formatNext, runLine, isActive, ATTENTION, STATUS_TEXT } from '../frontend/src/components/chat/runDock.js';

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

// A recurring task shows its cadence and next run instead of a turn budget.
const at = Date.parse('2027-03-01T10:00:00Z');
assert.equal(formatNext('2027-03-01T10:00:20Z', at), 'next now');
assert.equal(formatNext('2027-03-01T10:45:00Z', at), 'next in 45m');
assert.equal(formatNext('2027-03-01T15:30:00Z', at), 'next in 5h 30m');
assert.equal(formatNext('2027-03-01T16:00:00Z', at), 'next in 6h');
assert.equal(formatNext('2027-03-04T10:00:00Z', at), 'next in 3d');
const recurring = { kind: 'recurring', status: 'running', turnsUsed: 4, maxTurns: 100000, costUsed: 0.4, maxCost: null, endReason: null,
  schedule: { text: 'Weekdays at 09:00 (Europe/Brussels)', nextAt: '2027-03-01T15:30:00Z' } };
assert.equal(runLine(recurring, at), 'Weekdays at 09:00 (Europe/Brussels) · next in 5h 30m · 4 runs · $0.40');
assert.equal(runLine({ ...recurring, maxTurns: 10, maxCost: 2 }, at), 'Weekdays at 09:00 (Europe/Brussels) · next in 5h 30m · 4/10 runs · $0.40 of $2');
assert.equal(runLine({ ...recurring, status: 'paused' }, at), 'Weekdays at 09:00 (Europe/Brussels) · 4 runs · $0.40', 'a paused task has no next run');

assert.equal(isActive(run), true);
assert.equal(isActive({ status: 'paused' }), true);
for (const status of ['stopped', 'ended', 'stalled', 'exhausted']) assert.equal(isActive({ status }), false, status);
assert.equal(isActive(null), false);
assert.deepEqual(ATTENTION, ['stalled', 'exhausted'], 'only runs that need the user stay on screen after they end');
for (const status of ['running', 'paused', ...ATTENTION]) assert.ok(STATUS_TEXT[status], status + ' has a label');

// The run list: newest first, with a divider where a replaced task started over.
const list = runListItems([
  { seq: 4, run: 1, scheduleId: 'a', ts: '2027-03-01T09:00:00Z' }, { seq: 12, run: 2, scheduleId: 'a', ts: '2027-03-02T09:00:00Z' },
  { seq: 30, run: 1, scheduleId: 'b', ts: '2027-03-03T09:00:00Z' }, { seq: 41, run: 2, scheduleId: 'b', ts: '2027-03-04T09:00:00Z' }]);
assert.deepEqual(list.map((x) => [x.seq, x.run, x.newTask]), [[41, 2, false], [30, 1, true], [12, 2, false], [4, 1, true]]);
assert.deepEqual(runListItems(null), []);
assert.equal(runsLabel(1), '1 scheduled run');
assert.equal(runsLabel(12), '12 scheduled runs');
assert.equal(runWhen('not a date'), '');
assert.match(runWhen('2027-03-02T09:00:00Z', 'en-GB'), /Tue/);

console.log('run dock: time, cost and status text passed');
