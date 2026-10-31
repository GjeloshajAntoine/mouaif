// mouaif web — agent network model
//
// One graph per chat of who delegated to whom and what they said to each
// other. Replaces the per-card Mermaid schemas that redrew a tiny slice of
// the picture inside every subagent_* card: the user reviews the relation
// between agents in one place (AgentNetworkDock.jsx) instead.
//
// Pure data, no DOM. Two inputs feed the same idempotent upserts:
//   - ingestMessages(net, messages)  persisted top-level tool rows, the
//     nested `result.chat` of every settled subagent (recursively). Never
//     animates: history is reviewed, not replayed.
//   - ingestStreamEvent(net, ...)    live SSE frames (top-level tool_call /
//     tool_result and nested `subagent_event`, unwrapped to any depth).
//     Returns the pulses the dock animates along the edges.
//
// Node ids are tool call ids; ROOT is the chat's own (main) agent.

export const ROOT = 'root';
const FEED_LIMIT = 80;
const TEXT_LIMIT = 140;
// One "speaking" pulse per node per window while it streams text.
const STREAM_PULSE_MS = 1400;

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// 'ended' is the soft terminal state of a delegation whose turn finished
// without telling us how it went (a background child nobody polled). Any
// later report still overrides it.

export function createAgentNetwork() {
  return {
    nodes: new Map([[ROOT, { id: ROOT, parentId: null, label: 'Main agent', status: 'idle', order: 0 }]]),
    groups: new Map(),
    // Arguments of calls whose result has not been seen yet (group create
    // needs its declared members when the groupId comes back).
    callArgs: new Map(),
    feed: [],
    feedKeys: new Set(),
    lastStreamPulse: new Map(),
    // Persisted rows already folded in (ingestMessages runs on every
    // transcript reconcile; a settled subagent result can be large).
    seenRows: new Set(),
    order: 1,
    version: 0
  };
}

function clip(text, max = TEXT_LIMIT) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return {};
  try {
    const v = JSON.parse(value);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function toolName(name) {
  return String(name || '').replace(/^functions\./, '');
}

function mapState(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'succeeded') return 'done';
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'failed';
  if (s === 'cancelled' || s === 'canceled' || s === 'stopped' || s === 'undelivered_cancelled') return 'cancelled';
  if (s === 'pending' || s === 'waiting' || s === 'ready' || s === 'queued') return 'waiting';
  if (s === 'running') return 'running';
  return null;
}

// Status only moves forward: a settled node never goes back to running
// because an older row (or a replayed frame) still says so.
function setStatus(net, node, status) {
  if (!node || !status || node.status === status) return;
  if (TERMINAL.has(node.status) && !TERMINAL.has(status)) return;
  node.status = status;
  net.version++;
}

function upsertNode(net, id, parentId, patch) {
  const key = String(id);
  let node = net.nodes.get(key);
  if (!node) {
    node = { id: key, parentId: parentId || ROOT, label: '', status: 'running', order: net.order++ };
    net.nodes.set(key, node);
    net.version++;
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === '' || node[k] === v) continue;
    node[k] = v;
    net.version++;
  }
  // A declared group member now has a real run: drop its placeholder.
  if (node.groupId && node.memberId) {
    const ghostId = ghostKey(node.groupId, node.memberId);
    if (ghostId !== key && net.nodes.delete(ghostId)) net.version++;
  }
  return node;
}

function ghostKey(groupId, memberId) {
  return 'member:' + groupId + ':' + memberId;
}

function nodeByMember(net, groupId, memberId) {
  for (const node of net.nodes.values()) {
    if (node.groupId === groupId && node.memberId === memberId) return node;
  }
  return null;
}

function addFeed(net, key, entry) {
  if (key && net.feedKeys.has(key)) return false;
  if (key) net.feedKeys.add(key);
  net.feed.push(Object.assign({ at: Date.now() }, entry));
  if (net.feed.length > FEED_LIMIT) net.feed.splice(0, net.feed.length - FEED_LIMIT);
  net.version++;
  return true;
}

function labelFor(args, result) {
  const a = args || {};
  const r = result || {};
  return clip(a.agent || r.agent || a.memberId || r.memberId || 'Subagent', 32);
}

// noteToolCall(net, parentId, call, live) -> pulse[]
//
// `parentId` is the agent that MADE the call (ROOT for top-level rows).
export function noteToolCall(net, parentId, call, live) {
  const from = String(parentId || ROOT);
  const name = toolName(call && call.name);
  if (name !== 'subagent' && !name.startsWith('subagent_')) return [];
  const id = call && call.id ? String(call.id) : '';
  const args = parseJson(call && call.args);
  if (id) net.callArgs.set(id, { name, args, from });
  const pulses = [];
  const pulse = (p) => { if (live) pulses.push(p); };

  if (name === 'subagent') {
    if (!id) return [];
    upsertNode(net, id, from, {
      label: labelFor(args),
      agent: args.agent,
      memberId: args.memberId,
      groupId: args.groupId,
      task: clip(args.task, 400),
      background: args.background ? true : undefined
    });
    if (args.groupId && args.memberId) {
      const node = net.nodes.get(id);
      if (node && node.status === 'running' && hasPendingDeps(net, args.groupId, args.memberId)) node.status = 'waiting';
    }
    addFeed(net, 'delegate:' + id, { kind: 'delegate', from, to: id, text: clip(args.task) });
    pulse({ kind: 'delegate', from, to: id, text: clip(args.task, 60) });
  } else if (name === 'subagent_send') {
    const to = args.callId ? String(args.callId) : '';
    if (to && !net.nodes.has(to)) upsertNode(net, to, from, { label: 'Subagent' });
    addFeed(net, id ? 'send:' + id : null, { kind: 'message', from, to: to || null, text: clip(args.message) });
    if (to) pulse({ kind: 'message', from, to, text: clip(args.message, 60) });
  } else if (name === 'subagent_stop') {
    const to = args.callId ? String(args.callId) : '';
    addFeed(net, id ? 'stop:' + id : null, { kind: 'stop', from, to: to || null, text: 'stop' });
    if (to) pulse({ kind: 'stop', from, to, text: 'stop' });
  } else if (name === 'subagent_publish') {
    const node = net.nodes.get(from);
    const to = node && node.parentId ? node.parentId : null;
    addFeed(net, id ? 'publish:' + id : null, { kind: 'handoff', from, to, text: clip([args.name, args.summary].filter(Boolean).join(': ')) });
    if (to) pulse({ kind: 'handoff', from, to, text: clip(args.name, 40) });
  } else if (name === 'subagent_decision' || name === 'subagent_conflict') {
    const node = net.nodes.get(from);
    const to = node && node.parentId ? node.parentId : null;
    const kind = name === 'subagent_decision' ? 'decision' : 'conflict';
    addFeed(net, id ? kind + ':' + id : null, { kind, from, to, text: clip([args.name, args.proposal || args.summary].filter(Boolean).join(': ')) });
    if (to) pulse({ kind, from, to, text: clip(args.name, 40) });
  } else if (name === 'subagent_group_update' && args.action) {
    addFeed(net, id ? 'group-update:' + id : null, { kind: 'decision', from, to: null, text: clip([args.action, args.name, args.contract].filter(Boolean).join(' · ')) });
  }
  return pulses;
}

// noteToolResult(net, parentId, res, live) -> pulse[]
export function noteToolResult(net, parentId, res, live) {
  const id = res && res.id ? String(res.id) : '';
  const known = id ? net.callArgs.get(id) : null;
  const name = toolName((res && res.name) || (known && known.name));
  if (name !== 'subagent' && !name.startsWith('subagent_')) return [];
  const from = String((known && known.from) || parentId || ROOT);
  const args = Object.keys(parseJson(res && res.args)).length ? parseJson(res.args) : ((known && known.args) || {});
  const r = parseJson(res && res.result);
  const failed = (res && res.ok === false) || !!r.error;
  const pulses = [];
  const pulse = (p) => { if (live) pulses.push(p); };

  if (name === 'subagent') {
    if (!id) return [];
    const node = upsertNode(net, id, from, {
      label: labelFor(args, r),
      agent: r.agent || args.agent,
      memberId: r.memberId || args.memberId,
      groupId: r.groupId || args.groupId,
      model: r.model && r.model.id ? r.model.id : undefined
    });
    if (r.backgroundPending || (r.background === true && r.state === 'running')) {
      node.background = true;
      setStatus(net, node, mapState(r.state) || 'running');
    } else {
      setStatus(net, node, failed ? (r.error && /ABORT|CANCEL/i.test(String(r.error.code || '')) ? 'cancelled' : 'failed') : 'done');
      const answer = typeof r.text === 'string' && r.text ? r.text : (r.error && (r.error.message || r.error.code)) || '';
      addFeed(net, 'result:' + id, { kind: failed ? 'error' : 'result', from: id, to: from, text: clip(answer) });
      pulse({ kind: failed ? 'error' : 'result', from: id, to: from, text: failed ? 'failed' : 'done' });
      if (Array.isArray(r.chat)) ingestNestedChat(net, id, r.chat);
    }
  } else if (name === 'subagent_group_create' || name === 'subagent_group_status' || name === 'subagent_group_update') {
    noteGroups(net, from, r, args);
  } else if (name === 'subagent_status') {
    const runs = Array.isArray(r.runs) ? r.runs : (r.callId ? [r] : []);
    for (const run of runs) {
      if (!run || !run.callId) continue;
      const node = net.nodes.get(String(run.callId));
      if (node) setStatus(net, node, mapState(run.state));
    }
  } else if (name === 'subagent_messages') {
    const target = args.callId ? String(args.callId) : (r.callId ? String(r.callId) : '');
    const lines = Array.isArray(r.lines) ? r.lines : [];
    lines.forEach((line, idx) => {
      const text = typeof line === 'string' ? line : (line && (line.text || line.message || line.line)) || '';
      if (!text) return;
      const lineFrom = (line && line.callId) ? String(line.callId) : target;
      addFeed(net, 'lines:' + (id || target) + ':' + idx, { kind: 'report', from: lineFrom || null, to: from, text: clip(text) });
    });
    if (target && lines.length) pulse({ kind: 'report', from: target, to: from, text: lines.length + ' line' + (lines.length === 1 ? '' : 's') });
    if (target && r.state) setStatus(net, net.nodes.get(target), mapState(r.state));
  } else if (name === 'subagent_send') {
    const target = args.callId ? String(args.callId) : '';
    const state = String(r.state || r.status || '');
    if (state === 'undelivered') {
      addFeed(net, 'undelivered:' + (id || target), { kind: 'error', from, to: target || null, text: 'message undelivered' });
    }
  } else if (name === 'subagent_read') {
    const arts = Array.isArray(r.artifacts) ? r.artifacts : (r.name ? [r] : []);
    for (const art of arts.slice(0, 8)) {
      if (!art || !art.name || !art.author) continue;
      const author = findNodeByCallOrMember(net, art.author, art.groupId, art.memberId);
      if (!author || author.id === from) continue;
      addFeed(net, 'read:' + (id || '') + ':' + art.name, { kind: 'handoff', from: author.id, to: from, text: clip('read ' + art.name) });
      pulse({ kind: 'handoff', from: author.id, to: from, text: clip(art.name, 40) });
    }
  }
  if (id) net.callArgs.delete(id);
  return pulses;
}

function findNodeByCallOrMember(net, author, groupId, memberId) {
  if (author && net.nodes.has(String(author))) return net.nodes.get(String(author));
  if (groupId && memberId) return nodeByMember(net, groupId, memberId);
  return null;
}

function hasPendingDeps(net, groupId, memberId) {
  const group = net.groups.get(groupId);
  const member = group && group.members.get(memberId);
  if (!member || !member.dependsOn.length) return false;
  return member.dependsOn.some((dep) => {
    const node = nodeByMember(net, groupId, dep);
    return !node || node.status !== 'done';
  });
}

function noteGroups(net, ownerId, r, args) {
  const list = Array.isArray(r.groups) ? r.groups : [r];
  for (const g of list) {
    if (!g || !g.groupId) continue;
    let group = net.groups.get(g.groupId);
    if (!group) {
      group = { id: g.groupId, owner: ownerId, name: '', objective: '', state: '', members: new Map() };
      net.groups.set(g.groupId, group);
      net.version++;
    }
    const declared = Array.isArray(g.members) ? g.members : (list.length === 1 && Array.isArray(args.members) ? args.members : []);
    const patch = { name: g.name || (list.length === 1 ? args.name : ''), objective: g.objective || (list.length === 1 ? args.objective : ''), state: g.state || '' };
    for (const [k, v] of Object.entries(patch)) {
      if (v && group[k] !== v) { group[k] = clip(v, 200); net.version++; }
    }
    for (const m of declared) {
      if (!m || !m.memberId) continue;
      const dependsOn = Array.isArray(m.dependsOn) ? m.dependsOn.map(String) : [];
      const prev = group.members.get(m.memberId);
      if (!prev || prev.dependsOn.join() !== dependsOn.join() || (m.role && prev.role !== m.role)) {
        group.members.set(m.memberId, { memberId: m.memberId, role: clip(m.role || (prev && prev.role) || '', 60), dependsOn });
        net.version++;
      }
      // A member that runs (or ran) is keyed by its call id; a member that has
      // not been launched yet is a placeholder so the declared structure is
      // visible from the moment the group exists.
      const live = (m.callId && net.nodes.get(String(m.callId))) || nodeByMember(net, g.groupId, m.memberId);
      if (live) {
        if (!live.groupId) { live.groupId = g.groupId; net.version++; }
        if (!live.memberId) { live.memberId = m.memberId; net.version++; }
        setStatus(net, live, mapState(m.state));
      } else if (m.callId) {
        upsertNode(net, String(m.callId), ownerId, { label: clip(m.memberId, 32), memberId: m.memberId, groupId: g.groupId });
        setStatus(net, net.nodes.get(String(m.callId)), mapState(m.state));
      } else if (!net.nodes.has(ghostKey(g.groupId, m.memberId))) {
        net.nodes.set(ghostKey(g.groupId, m.memberId), {
          id: ghostKey(g.groupId, m.memberId), parentId: ownerId, label: clip(m.memberId, 32),
          memberId: m.memberId, groupId: g.groupId, status: 'planned', ghost: true, order: net.order++
        });
        net.version++;
      }
    }
  }
}

// ingestNestedChat(net, ownerId, chat) — the persisted conversation of a
// settled subagent run: its own tool calls (and their results) are made by
// `ownerId`. Recurses through settled grandchildren the same way.
export function ingestNestedChat(net, ownerId, chat) {
  if (!Array.isArray(chat)) return;
  for (const m of chat) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = (tc && tc.function) || tc || {};
        noteToolCall(net, ownerId, { id: tc && (tc.id || fn.id), name: fn.name || (tc && tc.name), args: fn.arguments != null ? fn.arguments : tc && tc.args }, false);
      }
    } else if (m.role === 'tool') {
      noteToolResult(net, ownerId, { id: m.tool_call_id, name: m.name, result: m.content, ok: m.ok }, false);
    }
  }
}

// ingestMessages(net, messages) — persisted top-level transcript rows.
// A user row after a delegation starts a new turn: anything that delegation
// left running ended with its turn (handles never outlive it). Decided from
// row positions on every pass, so older history paged in later never ends
// the turn that is running now.
export function ingestMessages(net, messages) {
  if (!Array.isArray(messages)) return;
  let lastUser = -1;
  const callRow = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') { lastUser = i; continue; }
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const name = toolName(m.name);
    if (name !== 'subagent' && !name.startsWith('subagent_')) continue;
    if (m.phase === 'call') callRow.set(String(m.toolCallId), i);
    const key = m.phase + ':' + m.toolCallId;
    if (net.seenRows.has(key)) continue;
    net.seenRows.add(key);
    if (m.phase === 'call') noteToolCall(net, ROOT, { id: m.toolCallId, name, args: m.args }, false);
    else if (m.phase === 'result') noteToolResult(net, ROOT, { id: m.toolCallId, name, args: m.args, ok: m.ok, result: m.content }, false);
  }
  if (lastUser < 0) return;
  const endedRoots = new Set();
  for (const [id, idx] of callRow) if (idx < lastUser) endedRoots.add(id);
  for (const node of net.nodes.values()) {
    if (node.status !== 'running' && node.status !== 'waiting') continue;
    if (topLevelAncestor(net, node) && endedRoots.has(topLevelAncestor(net, node).id)) setStatus(net, node, 'ended');
  }
}

function topLevelAncestor(net, node) {
  let cur = node;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (!cur.parentId || cur.parentId === ROOT) return cur;
    cur = net.nodes.get(cur.parentId);
  }
  return null;
}

// ingestStreamEvent(net, parentCallId, kind, data) -> pulse[]
//
// `parentCallId` is null for top-level frames (made by ROOT). Nested frames
// arrive as `subagent_event` envelopes, one envelope per delegation level.
export function ingestStreamEvent(net, parentCallId, kind, data) {
  const owner = parentCallId ? String(parentCallId) : ROOT;
  const d = data && typeof data === 'object' ? data : {};
  if (kind === 'subagent_event') return ingestStreamEvent(net, d.parentCallId || owner, d.kind, d.data);
  if (owner !== ROOT && !net.nodes.has(owner)) upsertNode(net, owner, ROOT, { label: 'Subagent' });
  if (kind === 'tool_call') return noteToolCall(net, owner, d, true);
  if (kind === 'tool_result') return noteToolResult(net, owner, d, true);
  if (kind === 'start' && owner !== ROOT) {
    const node = net.nodes.get(owner);
    upsertNode(net, owner, node.parentId, { agent: d.agent, model: d.model && d.model.id, label: node.label || clip(d.agent || 'Subagent', 32) });
    if (node.status === 'waiting') setStatus(net, node, 'running');
    return [];
  }
  if ((kind === 'message' || kind === 'reasoning') && owner !== ROOT) {
    const node = net.nodes.get(owner);
    if (node.status === 'waiting') setStatus(net, node, 'running');
    const now = Date.now();
    const last = net.lastStreamPulse.get(owner) || 0;
    if (now - last < STREAM_PULSE_MS) return [];
    net.lastStreamPulse.set(owner, now);
    return [{ kind: 'stream', from: owner, to: node.parentId || ROOT, text: kind === 'reasoning' ? 'thinking' : 'writing' }];
  }
  return [];
}

// settleRunning(net) — the parent turn ended: background children that never
// reported back ended with it (handles do not outlive the turn).
export function settleRunning(net) {
  for (const node of net.nodes.values()) {
    if (node.id === ROOT || node.ghost) continue;
    if (node.status === 'running' || node.status === 'waiting') setStatus(net, node, 'ended');
  }
}

export function agentCount(net) {
  let n = 0;
  for (const node of net.nodes.values()) if (node.id !== ROOT && !node.ghost) n++;
  return n;
}

export function activeCount(net) {
  let n = 0;
  for (const node of net.nodes.values()) if (node.status === 'running' || node.status === 'waiting') n++;
  return n;
}

// layoutNetwork(net, opts) -> { nodes, edges, width, height, nodeW, vertical }
//
// Two shapes of the same tree:
//   horizontal  a tidy top-down tree: leaves take consecutive slots, a parent
//               is centered over its children. Grows sideways with siblings.
//   vertical    an indented outline: one agent per row in delegation order,
//               each child indented under its parent. Grows downwards only,
//               so it fits a phone and scrolls with the body. opts.width is
//               the room available; boxes widen to use it (up to a cap).
// Dependency edges inside a cooperative group are drawn between siblings on
// top of the tree edges.
export const NODE_W = 132;
export const NODE_H = 44;
const GAP_X = 18;
const GAP_Y = 46;
const PAD = 14;
const INDENT = 26;
const ROW_GAP = 10;
const DEP_ROOM = 44;
const NODE_W_MAX = 280;

function treeChildren(net) {
  const children = new Map();
  for (const node of net.nodes.values()) {
    if (node.id === ROOT) continue;
    const pid = net.nodes.has(node.parentId) ? node.parentId : ROOT;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(node);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  return children;
}

function layoutEdges(net, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const n of nodes) {
    if (n.id === ROOT) continue;
    const parent = byId.get(net.nodes.has(n.parentId) ? n.parentId : ROOT);
    if (parent) edges.push({ id: 'tree:' + n.id, kind: 'tree', from: parent.id, to: n.id });
  }
  for (const group of net.groups.values()) {
    for (const member of group.members.values()) {
      const target = nodes.find((n) => n.groupId === group.id && n.memberId === member.memberId);
      if (!target) continue;
      for (const dep of member.dependsOn) {
        const source = nodes.find((n) => n.groupId === group.id && n.memberId === dep);
        if (source) edges.push({ id: 'dep:' + source.id + ':' + target.id, kind: 'dep', from: source.id, to: target.id });
      }
    }
  }
  return edges;
}

export function layoutNetwork(net, opts = {}) {
  return opts.vertical ? layoutVertical(net, opts.width) : layoutHorizontal(net);
}

function layoutHorizontal(net) {
  const children = treeChildren(net);
  const pos = new Map();
  let slot = 0;
  let maxDepth = 0;
  const place = (node, depth, seen) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(node.id) || [];
    for (const kid of kids) place(kid, depth + 1, seen);
    let x;
    const placed = kids.map((k) => pos.get(k.id)).filter(Boolean);
    if (placed.length) x = (placed[0].x + placed[placed.length - 1].x) / 2;
    else x = slot++ * (NODE_W + GAP_X);
    pos.set(node.id, { x, y: depth * (NODE_H + GAP_Y) });
  };
  place(net.nodes.get(ROOT), 0, new Set());
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
  const nodes = [];
  for (const node of net.nodes.values()) {
    const p = pos.get(node.id);
    if (!p) continue;
    nodes.push(Object.assign({}, node, { x: p.x - minX + PAD, y: p.y + PAD }));
  }
  return {
    nodes,
    edges: layoutEdges(net, nodes),
    width: Math.max(NODE_W, maxX - minX + NODE_W) + PAD * 2,
    height: (maxDepth + 1) * NODE_H + maxDepth * GAP_Y + PAD * 2,
    nodeW: NODE_W,
    vertical: false
  };
}

function layoutVertical(net, avail) {
  const children = treeChildren(net);
  const pos = new Map();
  let row = 0;
  let maxDepth = 0;
  const place = (node, depth, seen) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    maxDepth = Math.max(maxDepth, depth);
    pos.set(node.id, { depth, row: row++ });
    for (const kid of children.get(node.id) || []) place(kid, depth + 1, seen);
  };
  place(net.nodes.get(ROOT), 0, new Set());
  const nodes = [];
  for (const node of net.nodes.values()) {
    const p = pos.get(node.id);
    if (!p) continue;
    nodes.push(Object.assign({}, node, { x: PAD + p.depth * INDENT, y: PAD + p.row * (NODE_H + ROW_GAP) }));
  }
  const edges = layoutEdges(net, nodes);
  const depRoom = edges.some((e) => e.kind === 'dep') ? DEP_ROOM : 0;
  const fit = Math.floor((Number(avail) || 0) - PAD * 2 - maxDepth * INDENT - depRoom);
  const nodeW = Math.max(NODE_W, Math.min(NODE_W_MAX, fit));
  return {
    nodes,
    edges,
    width: PAD * 2 + maxDepth * INDENT + nodeW + depRoom,
    height: PAD * 2 + row * NODE_H + Math.max(0, row - 1) * ROW_GAP,
    nodeW,
    vertical: true
  };
}

// edgePath(a, b, kind, layout) -> SVG path for an edge.
//   horizontal  tree edges run from the parent's bottom to the child's top;
//               dependency edges are a dip below two siblings.
//   vertical    tree edges drop from under the parent's status dot and turn
//               into the child's left side; dependency edges arc on the
//               right between two rows.
// Pulses travel the same path in either direction.
export function edgePath(a, b, kind, layout) {
  if (layout && layout.vertical) return verticalEdgePath(a, b, kind, layout.nodeW || NODE_W);
  if (kind === 'dep' || Math.abs(a.y - b.y) < 1) {
    const ax = a.x + NODE_W / 2;
    const bx = b.x + NODE_W / 2;
    const y = a.y + NODE_H;
    const dip = 22 + Math.min(40, Math.abs(bx - ax) / 6);
    return `M ${ax} ${y} C ${ax} ${y + dip}, ${bx} ${b.y + NODE_H + dip}, ${bx} ${b.y + NODE_H}`;
  }
  const top = a.y < b.y ? a : b;
  const bottom = top === a ? b : a;
  const x1 = top.x + NODE_W / 2;
  const y1 = top.y + NODE_H;
  const x2 = bottom.x + NODE_W / 2;
  const y2 = bottom.y;
  const my = (y1 + y2) / 2;
  const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  return d;
}

function verticalEdgePath(a, b, kind, nodeW) {
  if (kind === 'dep') {
    const ax = a.x + nodeW;
    const bx = b.x + nodeW;
    const ay = a.y + NODE_H / 2;
    const by = b.y + NODE_H / 2;
    const bulge = 16 + Math.min(24, Math.abs(by - ay) / 8);
    const x = Math.max(ax, bx) + bulge;
    return `M ${ax} ${ay} C ${x} ${ay}, ${x} ${by}, ${bx} ${by}`;
  }
  const parent = a.y < b.y ? a : b;
  const child = parent === a ? b : a;
  const x1 = parent.x + 13;
  const y1 = parent.y + NODE_H;
  const y2 = child.y + NODE_H / 2;
  const x2 = child.x;
  const r = Math.min(8, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
  return `M ${x1} ${y1} L ${x1} ${y2 - r} Q ${x1} ${y2} ${x1 + r} ${y2} L ${x2} ${y2}`;
}
