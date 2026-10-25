// Agent network model (frontend/src/components/chat/agentNetwork.js).
//
// The chat shows one graph of its delegations instead of a schema inside
// every subagent card. Locked in here:
//   1. Persisted rows build the tree (main agent -> child -> grandchild from
//      a settled run's nested chat) without animating anything.
//   2. Live frames, nested to any depth, add the same nodes and return the
//      pulses the dock animates: delegation down, messages to a child,
//      answers back up, throttled "writing" pulses while a child streams.
//   3. Cooperative groups show declared members before they launch, their
//      dependency edges, and swap the placeholder for the real run.
//   4. Status only moves forward, except the soft "ended" a finished turn
//      gives a delegation that never reported back.
//   5. Re-ingesting the same rows is a no-op (it runs on every reconcile).

import assert from 'node:assert/strict';

const {
  ROOT,
  createAgentNetwork,
  ingestMessages,
  ingestStreamEvent,
  layoutNetwork,
  agentCount,
  activeCount,
  settleRunning
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
  // g1 streams text: one pulse, then throttled
  pulses = ingestStreamEvent(net, 'c1', 'subagent_event', { parentCallId: 'g1', kind: 'message', data: { delta: 'hi' } });
  assert.deepEqual(pulses.map((p) => [p.kind, p.from, p.to]), [['stream', 'g1', 'c1']]);
  pulses = ingestStreamEvent(net, 'c1', 'subagent_event', { parentCallId: 'g1', kind: 'message', data: { delta: ' there' } });
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
  settleRunning(net);
  assert.equal(net.nodes.get('b1').status, 'ended');
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

console.log(passed + ' checks, ' + failed + ' failed');
if (failed) process.exit(1);
