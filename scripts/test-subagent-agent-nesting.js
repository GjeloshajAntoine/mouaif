'use strict';
// Per-agent nesting limit (agent.maxNesting): the depth cap a launched agent
// sets for its own subtree, and how agents.js stores and validates it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-nesting-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const { Scope } = require('../src/tools/subagent-orchestration.js');
const agents = require('../src/agents.js');

const hang = () => new Promise(() => {});
const child = (scope, row) => scope.child(row);

(async () => {
  // maxNesting 0: the child cannot launch even though the root allows 3.
  let root = new Scope('/p', 'c', null, { maxDepth: 3 });
  let a = root.start('a', 'x', hang, () => {}, { agentLimits: { maxNesting: 0 } });
  assert.equal(a.depthCap, 1);
  assert.throws(() => child(root, a).start('a1', null, hang, () => {}), { code: 'EDEPTH' });

  // maxNesting never exceeds the total.
  root = new Scope('/p', 'c', null, { maxDepth: 2 });
  assert.equal(root.start('t', 'x', hang, () => {}, { agentLimits: { maxNesting: 5 } }).depthCap, 2);

  // maxNesting sets the cap for that subtree.
  root = new Scope('/p', 'c', null, { maxDepth: 8 });
  a = root.start('a', 'x', hang, () => {}, { agentLimits: { maxNesting: 2 } });
  assert.equal(a.depthCap, 3);
  const b = child(root, a).start('b', null, hang, () => {});
  assert.equal(b.depthCap, 3, 'unset inherits the parent cap');
  const c = child(root, b).start('c', null, hang, () => {}, { agentLimits: { maxNesting: 5 } });
  assert.equal(c.depthCap, 3, 'a descendant cannot exceed an ancestor agent cap');
  assert.throws(() => child(root, c).start('d', null, hang, () => {}), { code: 'EDEPTH' });

  // maxRuns: an agent's subtree may start that many runs in total.
  root = new Scope('/p', 'c', null, { maxDepth: 3 });
  a = root.start('a', 'x', hang, () => {}, { agentLimits: { maxRuns: 2 } });
  const as = child(root, a);
  const a1 = as.start('a1', null, hang, () => {});
  child(as, a1).start('a2', null, hang, () => {});
  assert.throws(() => as.start('a3', null, hang, () => {}), { code: 'ETOOL_CAP' });
  root.start('b', null, hang, () => {}); // siblings are not counted

  // Storage and validation.
  const dir = path.join(tmp, 'proj'); fs.mkdirSync(dir);
  agents.create(dir, { name: 'scout', maxNesting: 2 });
  assert.equal(agents.get(dir, 'scout').maxNesting, 2);
  assert.throws(() => agents.update(dir, 'scout', { maxNesting: -1 }), { code: 'EBADINPUT' });
  assert.equal(agents.update(dir, 'scout', { maxNesting: 20, maxRuns: 5000 }).maxNesting, 20, 'no upper bound');
  assert.equal(agents.update(dir, 'scout', { maxNesting: null }).maxNesting, undefined);
  assert.equal(agents.updateDefault(dir, { maxNesting: 0 }).maxNesting, 0);
  assert.equal(agents.getDefault(dir).maxNesting, 0);
  console.log('agent nesting: per-agent caps, inheritance, ancestor ceiling, run budgets, storage and validation passed');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
