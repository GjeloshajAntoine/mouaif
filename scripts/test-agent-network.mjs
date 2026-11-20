// Agent network model (frontend/src/components/chat/agentNetwork.js).
//
// The chat shows one graph of its delegations instead of a schema inside
// every subagent card. Locked in here:
//   1. Persisted rows build the tree (main agent -> child -> grandchild from
//      a settled run's nested chat) without animating anything.
//   2. Live frames, nested to any depth, add the same nodes and return the
//      pulses the dock animates: delegation down, messages to a child,
//      answers back up. A child that only streams text sends no pulse.
//   3. Cooperative groups show declared members before they launch, their
//      dependency edges, and swap the placeholder for the real run.
//   4. Status only moves forward, except the soft "ended" a finished turn
//      gives a foreground delegation that never reported back (background
//      runs outlive their turn).
//   5. Re-ingesting the same rows is a no-op (it runs on every reconcile).
//   6. Feed entries keep a growing seq past the cap, nested exchanges come
//      before the answer, repeated polls add nothing, background answers
//      reach the feed, and the head's failure state follows the latest turn.

import assert from 'node:assert/strict';

const {
  ROOT,
  createAgentNetwork,
  ingestMessages,
  ingestStreamEvent,
  layoutNetwork,
  agentCount,
  activeCount,
  settleRunning,
  latestTurnFailed
} = await import('../frontend/src/components/chat/agentNetwork.js');

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (err) { failed++; console.error('FAIL', name, '\n', err); }
}

const history = [
  { role: 'user', content: 'Audit the parser' },
  { role: 'tool', phase: 'call', toolCallId: 'c1', name: 'subagent', args: { task: 'Review parser', agent: 'reviewer' } },
  {
    role: 'tool', phase: 'result', toolCallId: 'c1', name: 'subagent', ok: true,
    content: JSON.stringify({
      text: 'Parser looks fine',
      agent: 'reviewer',
      chat: [
        { role: 'user', content: 'Review parser' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'g1', function: { name: 'subagent', arguments: JSON.stringify({ task: 'Check tests', agent: 'tester' }) } }] },
        { role: 'tool', tool_call_id: 'g1', name: 'subagent', content: JSON.stringify({ text: 'Tests pass' }) },
        { role: 'assistant', content: '', tool_calls: [{ id: 'g2', function: { name: 'subagent_send', arguments: JSON.stringify({ callId: 'g1', message: 'also lint' }) } }] }
      ]
    })
  }
];

check('persisted rows build the delegation tree, nested runs included', () => {
  const net = createAgentNetwork();
  ingestMessages(net, history);
  assert.equal(agentCount(net), 2);
  assert.equal(net.nodes.get('c1').parentId, ROOT);
  assert.equal(net.nodes.get('c1').status, 'done');
  assert.equal(net.nodes.get('g1').parentId, 'c1');
  assert.equal(net.nodes.get('g1').label, 'tester');
  const kinds = net.feed.map((f) => f.kind + ':' + f.from + '>' + f.to);
  assert.ok(kinds.includes('delegate:root>c1'), kinds);
  assert.ok(kinds.includes('delegate:c1>g1'), kinds);
  assert.ok(kinds.includes('result:g1>c1'), kinds);
  assert.ok(kinds.includes('message:c1>g1'), kinds);
  assert.ok(kinds.includes('result:c1>root'), kinds);
});

check('re-ingesting the same rows changes nothing', () => {
  const net = createAgentNetwork();
  ingestMessages(net, history);
  const v = net.version;
  const feed = net.feed.length;
  ingestMessages(net, history);
  assert.equal(net.version, v);
  assert.equal(net.feed.length, feed);
});

check('live frames return pulses, nested envelopes unwrap to any depth', () => {
  const net = createAgentNetwork();
  let pulses = ingestStreamEvent(net, null, 'tool_call', { id: 'c1', name: 'subagent', args: { task: 'Lead', agent: 'lead' } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['delegate', ROOT, 'c1']]);
  assert.equal(activeCount(net), 1);
  // child c1 delegates to grandchild g1
  pulses = ingestStreamEvent(net, 'c1', 'tool_call', { id: 'g1', name: 'subagent', args: { task: 'Dig', agent: 'digger' } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['delegate', 'c1', 'g1']]);
  // grandchild g1 calls a tool: arrives wrapped once per level
  pulses = ingestStreamEvent(net, 'c1', 'subagent_event', { parentCallId: 'g1', kind: 'tool_call', data: { id: 'x1', name: 'subagent', args: { task: 'Deeper' } } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['delegate', 'g1', 'x1']]);
  assert.equal(net.nodes.get('x1').parentId, 'g1');
  // c1 messages g1
  pulses = ingestStreamEvent(net, 'c1', 'tool_call', { id: 's1', name: 'subagent_send', args: { callId: 'g1', message: 'hurry' } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to, p.text]), [['message', 'c1', 'g1', 'hurry']]);
  // g1 streams text: it is working, not sending anything
  pulses = ingestStreamEvent(net, 'c1', 'subagent_event', { parentCallId: 'g1', kind: 'message', data: { delta: 'hi' } });
  assert.equal(pulses.length, 0);
  // g1 answers c1
  pulses = ingestStreamEvent(net, 'c1', 'tool_result', { id: 'g1', name: 'subagent', ok: true, result: { text: 'found it' } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['result', 'g1', 'c1']]);
  assert.equal(net.nodes.get('g1').status, 'done');
});

check('a settled node never goes back to running; ended is soft', () => {
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'c1', name: 'subagent', args: { task: 't' } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'c1', name: 'subagent', ok: false, result: { error: { code: 'EFAIL', message: 'boom' } } });
  assert.equal(net.nodes.get('c1').status, 'failed');
  ingestMessages(net, [{ role: 'tool', phase: 'call', toolCallId: 'c1', name: 'subagent', args: { task: 't' } }]);
  assert.equal(net.nodes.get('c1').status, 'failed');

  ingestStreamEvent(net, null, 'tool_call', { id: 'b1', name: 'subagent', args: { task: 'bg', background: true } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'b1', name: 'subagent', ok: true, result: { callId: 'b1', backgroundPending: true, state: 'running' } });
  assert.equal(net.nodes.get('b1').status, 'running');
  // A background run outlives its turn (the chat's persistent scope), and so
  // do the subagents it starts; a foreground one ends with the turn.
  ingestStreamEvent(net, 'b1', 'tool_call', { id: 'b1k', name: 'subagent', args: { task: 'kid' } });
  ingestStreamEvent(net, null, 'tool_call', { id: 'f1', name: 'subagent', args: { task: 'fg' } });
  settleRunning(net);
  assert.equal(net.nodes.get('b1').status, 'running');
  assert.equal(net.nodes.get('b1k').status, 'running');
  assert.equal(net.nodes.get('f1').status, 'ended');
  // A later user turn on reload does not end it either.
  ingestMessages(net, [{ role: 'tool', phase: 'call', toolCallId: 'b1', name: 'subagent', args: { task: 'bg', background: true } }, { role: 'user', content: 'next' }]);
  assert.equal(net.nodes.get('b1').status, 'running');
  ingestStreamEvent(net, null, 'tool_result', { id: 'st', name: 'subagent_status', ok: true, result: { runs: [{ callId: 'b1', state: 'completed' }] } });
  assert.equal(net.nodes.get('b1').status, 'done');
});

check('a later user turn ends what an earlier turn left running, paging older rows in does not', () => {
  const net = createAgentNetwork();
  const current = [
    { role: 'user', seq: 5, content: 'go' },
    { role: 'tool', phase: 'call', toolCallId: 'now', name: 'subagent', args: { task: 'current' } }
  ];
  ingestMessages(net, current);
  assert.equal(net.nodes.get('now').status, 'running');
  // older history arrives in front
  ingestMessages(net, [
    { role: 'user', seq: 1, content: 'before' },
    { role: 'tool', phase: 'call', toolCallId: 'old', name: 'subagent', args: { task: 'old bg', background: true } },
    { role: 'tool', phase: 'result', toolCallId: 'old', name: 'subagent', ok: true, content: JSON.stringify({ callId: 'old', backgroundPending: true, state: 'running' }) },
    ...current
  ]);
  assert.equal(net.nodes.get('now').status, 'running');
  assert.equal(net.nodes.get('old').status, 'ended');
});

check('groups show planned members, dependency edges, and swap placeholders for runs', () => {
  const net = createAgentNetwork();
  const members = [
    { memberId: 'contract', role: 'Design API' },
    { memberId: 'review', role: 'Review', dependsOn: ['contract'] }
  ];
  ingestStreamEvent(net, null, 'tool_call', { id: 'gc', name: 'subagent_group_create', args: { name: 'parser', objective: 'ship', members } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'gc', name: 'subagent_group_create', ok: true, result: { groupId: 'group-1', name: 'parser', state: 'pending', members } });
  assert.ok(net.nodes.has('member:group-1:contract'));
  assert.equal(net.nodes.get('member:group-1:review').status, 'planned');
  assert.equal(agentCount(net), 0, 'placeholders are not counted as agents');

  ingestStreamEvent(net, null, 'tool_call', { id: 'r1', name: 'subagent', args: { task: 'Review', groupId: 'group-1', memberId: 'review', background: true } });
  assert.ok(!net.nodes.has('member:group-1:review'));
  assert.equal(net.nodes.get('r1').status, 'waiting', 'waits for its dependency');
  ingestStreamEvent(net, null, 'tool_call', { id: 'k1', name: 'subagent', args: { task: 'Contract', groupId: 'group-1', memberId: 'contract', background: true } });
  const layout = layoutNetwork(net);
  const dep = layout.edges.find((e) => e.kind === 'dep');
  assert.deepEqual(dep && [dep.from, dep.to], ['k1', 'r1']);
  assert.equal(layout.nodes.length, 3);
  for (const n of layout.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id);
  assert.ok(layout.width > 0 && layout.height > 0);
});

check('layout centers parents over their children and keeps rows by depth', () => {
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'a', name: 'subagent', args: { task: 'a' } });
  ingestStreamEvent(net, null, 'tool_call', { id: 'b', name: 'subagent', args: { task: 'b' } });
  ingestStreamEvent(net, 'a', 'tool_call', { id: 'a1', name: 'subagent', args: { task: 'a1' } });
  const { nodes } = layoutNetwork(net);
  const at = (id) => nodes.find((n) => n.id === id);
  assert.ok(at(ROOT).y < at('a').y && at('a').y < at('a1').y);
  assert.equal(at('a').y, at('b').y);
  const root = at(ROOT);
  assert.equal(root.x, (at('a').x + at('b').x) / 2);
});

check('vertical layout is one row per agent, children indented under their parent', () => {
  const net = createAgentNetwork();
  for (const id of ['a', 'b', 'c', 'd', 'e']) ingestStreamEvent(net, null, 'tool_call', { id, name: 'subagent', args: { task: id } });
  ingestStreamEvent(net, 'a', 'tool_call', { id: 'a1', name: 'subagent', args: { task: 'a1' } });
  const wide = layoutNetwork(net);
  const tall = layoutNetwork(net, { vertical: true, width: 340 });
  assert.equal(tall.vertical, true);
  assert.ok(tall.width <= 340, 'fits the width it was given');
  assert.ok(tall.width < wide.width && tall.height > wide.height);
  const at = (id) => tall.nodes.find((n) => n.id === id);
  // Delegation order, depth-first: root, a, a1, b, c, d, e.
  const order = [...tall.nodes].sort((x, y) => x.y - y.y).map((n) => n.id);
  assert.deepEqual(order, [ROOT, 'a', 'a1', 'b', 'c', 'd', 'e']);
  assert.ok(at(ROOT).x < at('a').x && at('a').x < at('a1').x, 'indent grows with depth');
  assert.equal(at('a').x, at('e').x, 'siblings share a column');
  assert.ok(tall.nodeW > 132, 'boxes widen into the spare room');
  assert.equal(new Set(tall.nodes.map((n) => n.y)).size, tall.nodes.length, 'one agent per row');
});

check('a subagent\'s shell commands never add agents', () => {
  // src/ai-stream.js forwards a nested command's output keyed by the
  // command's own call id; each approved command used to add a node.
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'c1', name: 'subagent', args: { task: 'Build', agent: 'builder' } });
  ingestStreamEvent(net, 'c1', 'start', { agent: 'builder' });
  for (const sh of ['sh1', 'sh2', 'sh3']) {
    ingestStreamEvent(net, null, 'subagent_event', { parentCallId: 'c1', kind: 'tool_call', data: { id: sh, name: 'shell', args: { cmd: 'ls' } } });
    ingestStreamEvent(net, null, 'subagent_event', { parentCallId: 'c1', kind: 'subagent_event', data: { parentCallId: sh, kind: 'shell_output', data: { id: sh, stream: 'stdout', delta: 'a\n' } } });
    ingestStreamEvent(net, null, 'subagent_event', { parentCallId: 'c1', kind: 'tool_result', data: { id: sh, name: 'shell', ok: true } });
  }
  ingestStreamEvent(net, null, 'subagent_event', { parentCallId: 'c1', kind: 'usage_update', data: { totalCost: 0.01 } });
  assert.equal(agentCount(net), 1);
  assert.deepEqual([...net.nodes.keys()], [ROOT, 'c1']);
});

check('feed seq keeps growing past the cap, so the dock can key rows by it', () => {
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'c1', name: 'subagent', args: { task: 't', background: true } });
  for (let i = 0; i < 90; i++) ingestStreamEvent(net, null, 'tool_call', { id: 's' + i, name: 'subagent_send', args: { callId: 'c1', message: 'm' + i } });
  assert.equal(net.feed.length, 80);
  assert.equal(net.feedSeq, 91);
  assert.equal(net.feed[net.feed.length - 1].seq, 91);
  assert.equal(new Set(net.feed.map((f) => f.seq)).size, 80);
  assert.ok(net.feed.every((f) => f.live));
});

check('a long message keeps its full text next to the one-line clip', () => {
  const net = createAgentNetwork();
  const long = 'line one\n' + 'x'.repeat(400);
  ingestStreamEvent(net, null, 'tool_call', { id: 'c1', name: 'subagent', args: { task: 't' } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'c1', name: 'subagent', ok: true, result: { text: long } });
  const res = net.feed.find((f) => f.kind === 'result');
  assert.ok(res.text.length <= 140 && res.text.endsWith('…'));
  assert.equal(res.full, long);
  assert.equal(net.nodes.get('c1').answer, long);
});

check('reopened chats list a run\'s nested exchanges before its answer', () => {
  const net = createAgentNetwork();
  ingestMessages(net, history);
  const order = net.feed.map((f) => f.kind + ':' + f.from + '>' + f.to);
  assert.equal(order[order.length - 1], 'result:c1>root', order);
  assert.ok(order.indexOf('delegate:c1>g1') < order.indexOf('result:c1>root'));
  assert.equal(net.nodes.get('c1').answer, 'Parser looks fine');
});

check('polling the same lines again does not repeat them', () => {
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'b1', name: 'subagent', args: { task: 'bg', background: true } });
  const lines = [{ cursor: 1, kind: 'text', text: 'one' }, { cursor: 2, kind: 'text', text: 'two' }];
  let pulses = ingestStreamEvent(net, null, 'tool_result', { id: 'p1', name: 'subagent_messages', args: { callId: 'b1' }, ok: true, result: { callId: 'b1', state: 'running', lines } });
  assert.equal(pulses.length, 1);
  pulses = ingestStreamEvent(net, null, 'tool_result', { id: 'p2', name: 'subagent_messages', args: { callId: 'b1' }, ok: true, result: { callId: 'b1', state: 'running', lines: [...lines, { cursor: 3, kind: 'text', text: 'three' }] } });
  const reports = net.feed.filter((f) => f.kind === 'report').map((f) => f.text);
  assert.deepEqual(reports, ['one', 'two', 'three']);
  assert.deepEqual(pulses.map((p) => p.text), ['1 line']);
});

check('a background answer from subagent_status reaches the feed once', () => {
  const net = createAgentNetwork();
  ingestStreamEvent(net, null, 'tool_call', { id: 'b1', name: 'subagent', args: { task: 'bg', background: true } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'b1', name: 'subagent', ok: true, result: { callId: 'b1', backgroundPending: true, state: 'running' } });
  const status = { runs: [{ callId: 'b1', state: 'completed', ok: true, text: 'all good' }] };
  const pulses = ingestStreamEvent(net, null, 'tool_result', { id: 'st1', name: 'subagent_status', ok: true, result: status });
  ingestStreamEvent(net, null, 'tool_result', { id: 'st2', name: 'subagent_status', ok: true, result: status });
  const results = net.feed.filter((f) => f.kind === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'all good');
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['result', 'b1', ROOT]]);
  assert.equal(net.nodes.get('b1').answer, 'all good');
});

check('the head\'s failure state follows the latest turn that delegated', () => {
  const fail = (id) => ({ role: 'tool', phase: 'result', toolCallId: id, name: 'subagent', ok: false, content: JSON.stringify({ error: { code: 'EFAIL', message: 'boom' } }) });
  const okRow = (id) => ({ role: 'tool', phase: 'result', toolCallId: id, name: 'subagent', ok: true, content: JSON.stringify({ text: 'ok' }) });
  const call = (id) => ({ role: 'tool', phase: 'call', toolCallId: id, name: 'subagent', args: { task: id } });
  const net = createAgentNetwork();
  const turn1 = [{ role: 'user', content: 'a' }, call('f1'), fail('f1')];
  ingestMessages(net, turn1);
  assert.equal(latestTurnFailed(net), true);
  ingestMessages(net, [...turn1, { role: 'user', content: 'b' }, call('k1'), okRow('k1')]);
  assert.equal(latestTurnFailed(net), false, 'an older failure no longer counts');
  // A live turn replaces the persisted one before its rows are saved.
  ingestStreamEvent(net, null, 'tool_call', { id: 'l1', name: 'subagent', args: { task: 'live' } });
  ingestStreamEvent(net, null, 'tool_result', { id: 'l1', name: 'subagent', ok: false, result: { error: { code: 'EFAIL' } } });
  assert.equal(latestTurnFailed(net), true);
  settleRunning(net);
  assert.equal(latestTurnFailed(net), true);
});

check('persisted messages keep their row time and do not count as live', () => {
  const net = createAgentNetwork();
  ingestMessages(net, [{ role: 'tool', phase: 'call', seq: 42, ts: '2026-11-13T10:00:00Z', toolCallId: 'c1', name: 'subagent', args: { task: 't' } }]);
  assert.equal(net.feed[0].at, Date.parse('2026-11-13T10:00:00Z'));
  assert.equal(net.feed[0].live, false);
});

console.log(passed + ' checks, ' + failed + ' failed');
if (failed) process.exit(1);
