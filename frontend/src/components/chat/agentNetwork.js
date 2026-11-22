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
//     Returns the pulses the dock animates along the edges: only real
//     messages, never a child that is merely writing (its ring says that).
//
// Node ids are tool call ids; ROOT is the chat's own (main) agent.
//
// Feed entries carry `seq`, a number that only grows (the feed itself is
// capped), `text` (one line, for the head) and `full` (the whole message, up
// to FULL_LIMIT, for an expanded row). `live` marks entries from SSE frames.

export const ROOT = 'root';
const FEED_LIMIT = 80;
const TEXT_LIMIT = 140;
const FULL_LIMIT = 8000;

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// Live frames that only an agent's own turn emits (src/ai-stream.js forwards
// them as subagent_event). shell_output, usage_update and the like are not.
const AGENT_FRAMES = new Set(['start', 'tool_call', 'tool_result', 'message', 'reasoning', 'image', 'assistant_turn_end']);
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
    // Every entry ever added, also past FEED_LIMIT: the feed's `seq` source
    // and the "Messages" count.
    feedSeq: 0,
    // Top-level delegations of the latest turn that delegated; the head's
    // status dot only reflects these (see latestTurnFailed).
    turnRoots: new Set(),
    // True between a live top-level delegation and the end of its turn.
    liveTurn: false,
    // Timestamp of the persisted row being folded in.
    ingestAt: 0,
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

// The whole message, line breaks kept, for a row expanded to its full text.
function whole(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > FULL_LIMIT ? s.slice(0, FULL_LIMIT - 1) + '…' : s;
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
  endDescendants(net, node);
}

// Whether `ancestorId` is `startId` or one of its parents.
function isAncestor(net, ancestorId, startId) {
  let cur = startId;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (cur === ancestorId) return true;
    if (cur === ROOT) return false;
    const node = net.nodes.get(cur);
    cur = node ? node.parentId : null;
  }
  return false;
}

// A run's children live in its own scope, which closes when the run settles
// (childScope.finish() in src/tools/subagent-orchestration.js): whatever it
// left running, background children included, ended with it. Soft, like any
// 'ended': a later report still overrides it.
function endDescendants(net, node) {
  if (!node || node.id === ROOT || !TERMINAL.has(node.status)) return;
  for (const n of net.nodes.values()) {
    if (n.ghost || (n.status !== 'running' && n.status !== 'waiting')) continue;
    if (isAncestor(net, node.id, n.parentId)) setStatus(net, n, 'ended');
  }
}

// A node can be created from a frame that only names it (its own output, a
// message sent to it) before the frame that launched it, or without that
// frame at all (a page that joined mid-run). Such a stand-in is marked
// `stub`: its parent is a guess and its time is when it was first seen. The
// real delegation, once it arrives, says who made it and when.
function upsertNode(net, id, parentId, patch) {
  const key = String(id);
  let node = net.nodes.get(key);
  const guess = !!(patch && patch.stub);
  if (node && node.stub && !guess) {
    const pid = String(parentId || ROOT);
    // Never under itself or its own descendant.
    if (pid !== node.parentId && !isAncestor(net, key, pid)) node.parentId = pid;
    if (net.ingestAt) node.at = net.ingestAt;
    delete node.stub;
    net.version++;
  }
  if (!node) {
    // A declared member taking over its placeholder keeps the placeholder's
    // slot, so starting a run never moves it to the end of its siblings.
    const ghost = patch && patch.groupId && patch.memberId && net.nodes.get(ghostKey(patch.groupId, patch.memberId));
    node = {
      id: key, parentId: parentId || ROOT, label: '', status: 'running',
      order: ghost ? ghost.order : net.order++,
      // When the delegation was made: older history paged in later still
      // sorts before newer runs.
      at: (ghost && ghost.at) || net.ingestAt || Date.now()
    };
    if (guess) node.stub = true;
    net.nodes.set(key, node);
    net.version++;
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'stub' || v == null || v === '' || node[k] === v) continue;
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

// addFeed(net, key, entry, live) — `entry.text` is the raw message; the
// stored entry gets the one-line `text` and the whole `full`.
function addFeed(net, key, entry, live) {
  if (key && net.feedKeys.has(key)) return false;
  if (key) net.feedKeys.add(key);
  const raw = entry.text;
  const at = live ? Date.now() : (net.ingestAt || 0);
  net.feed.push(Object.assign({}, entry, { seq: ++net.feedSeq, at, live: !!live, text: clip(raw), full: whole(raw) }));
  if (net.feed.length > FEED_LIMIT) net.feed.splice(0, net.feed.length - FEED_LIMIT);
  net.version++;
  return true;
}

// The agent's own answer (or error), kept on the node for the detail view.
function setAnswer(net, node, text, failed) {
  const full = whole(text);
  if (!node || !full || (node.answer === full && node.answerFailed === !!failed)) return;
  node.answer = full;
  node.answerFailed = !!failed;
  net.version++;
}

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.code || '';
}

function labelFor(args, result) {
  const a = args || {};
  const r = result || {};
  return clip(a.name || r.name || a.agent || r.agent || a.memberId || r.memberId || 'Subagent', 32);
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
  const feed = (key, entry) => addFeed(net, key, entry, live);

  if (name === 'subagent') {
    if (!id) return [];
    // A stand-in made from an earlier nested frame is new as a delegation.
    const known = net.nodes.get(id);
    const isNew = !known || !!known.stub;
    upsertNode(net, id, from, {
      label: labelFor(args),
      agent: args.agent,
      name: args.name,
      memberId: args.memberId,
      groupId: args.groupId,
      task: whole(args.task),
      background: args.background ? true : undefined
    });
    if (from === ROOT && live && isNew) {
      // The first live delegation of a turn starts a new set of turn roots.
      if (!net.liveTurn) { net.turnRoots = new Set(); net.liveTurn = true; }
      net.turnRoots.add(id);
    }
    if (args.groupId && args.memberId) {
      const node = net.nodes.get(id);
      if (node && node.status === 'running' && hasPendingDeps(net, args.groupId, args.memberId)) node.status = 'waiting';
    }
    feed('delegate:' + id, { kind: 'delegate', from, to: id, text: args.task });
    pulse({ kind: 'delegate', from, to: id, text: clip(args.task, 60) });
  } else if (name === 'subagent_send') {
    const to = args.callId ? String(args.callId) : '';
    // Only the local parent sends to a child, so `from` is a good guess, but
    // its launch (paged in later) still sets when it was made.
    if (to && !net.nodes.has(to)) upsertNode(net, to, from, { label: 'Subagent', stub: true });
    feed(id ? 'send:' + id : null, { kind: 'message', from, to: to || null, text: args.message });
    if (to) pulse({ kind: 'message', from, to, text: clip(args.message, 60) });
  } else if (name === 'subagent_stop') {
    const to = args.callId ? String(args.callId) : '';
    feed(id ? 'stop:' + id : null, { kind: 'stop', from, to: to || null, text: 'stop' });
    if (to) pulse({ kind: 'stop', from, to, text: 'stop' });
  } else if (name === 'subagent_publish') {
    const node = net.nodes.get(from);
    const to = node && node.parentId ? node.parentId : null;
    feed(id ? 'publish:' + id : null, { kind: 'handoff', from, to, text: [args.name, args.summary].filter(Boolean).join(': ') });
    if (to) pulse({ kind: 'handoff', from, to, text: clip(args.name, 40) });
  } else if (name === 'subagent_decision' || name === 'subagent_conflict') {
    const node = net.nodes.get(from);
    const to = node && node.parentId ? node.parentId : null;
    const kind = name === 'subagent_decision' ? 'decision' : 'conflict';
    feed(id ? kind + ':' + id : null, { kind, from, to, text: [args.name, args.proposal || args.summary].filter(Boolean).join(': ') });
    if (to) pulse({ kind, from, to, text: clip(args.name, 40) });
  } else if (name === 'subagent_group_update' && args.action) {
    feed(id ? 'group-update:' + id : null, { kind: 'decision', from, to: null, text: [args.action, args.name, args.contract].filter(Boolean).join(' · ') });
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
  const feed = (key, entry) => addFeed(net, key, entry, live);

  if (name === 'subagent') {
    if (!id) return [];
    const node = upsertNode(net, id, from, {
      label: labelFor(args, r),
      agent: r.agent || args.agent,
      name: r.name || args.name,
      memberId: r.memberId || args.memberId,
      groupId: r.groupId || args.groupId,
      model: r.model && r.model.id ? r.model.id : undefined
    });
    if (r.backgroundPending || (r.background === true && r.state === 'running')) {
      if (!node.background) { node.background = true; net.version++; }
      setStatus(net, node, mapState(r.state) || 'running');
    } else {
      setStatus(net, node, failed ? (r.error && /ABORT|CANCEL/i.test(String(r.error.code || '')) ? 'cancelled' : 'failed') : 'done');
      const answer = typeof r.text === 'string' && r.text ? r.text : errorText(r.error);
      setAnswer(net, node, answer, failed);
      // The run's own exchanges happened before its answer: fold them in
      // first so the feed (and the head's latest message) stay in order.
      if (Array.isArray(r.chat)) ingestNestedChat(net, id, r.chat);
      // Children its chat launched in the background and never polled are
      // only known now; they ended with this run.
      endDescendants(net, node);
      feed('result:' + id, { kind: failed ? 'error' : 'result', from: id, to: from, text: answer });
      pulse({ kind: failed ? 'error' : 'result', from: id, to: from, text: failed ? 'failed' : 'done' });
    }
  } else if (name === 'subagent_group_create' || name === 'subagent_group_status' || name === 'subagent_group_update') {
    noteGroups(net, from, r, args);
  } else if (name === 'subagent_status') {
    const runs = Array.isArray(r.runs) ? r.runs : (r.callId ? [r] : []);
    for (const run of runs) {
      if (!run || !run.callId) continue;
      const node = net.nodes.get(String(run.callId));
      if (!node) continue;
      const status = mapState(run.state);
      setStatus(net, node, status);
      // A background run that finished reports its answer here; it shares
      // the key of a direct answer, so it is listed once either way.
      const answer = typeof run.text === 'string' && run.text ? run.text : errorText(run.error);
      if (!TERMINAL.has(status) || !answer) continue;
      const bad = status !== 'done';
      setAnswer(net, node, answer, bad);
      const to = net.nodes.has(node.parentId) ? node.parentId : ROOT;
      if (feed('result:' + node.id, { kind: bad ? 'error' : 'result', from: node.id, to, text: answer })) {
        pulse({ kind: bad ? 'error' : 'result', from: node.id, to, text: bad ? 'failed' : 'done' });
      }
    }
  } else if (name === 'subagent_messages') {
    const target = args.callId ? String(args.callId) : (r.callId ? String(r.callId) : '');
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const since = Number.isInteger(args.since) ? args.since : 0;
    let added = 0;
    lines.forEach((line, idx) => {
      const text = typeof line === 'string' ? line : (line && (line.text || line.message || line.line)) || '';
      if (!text) return;
      const lineFrom = (line && line.callId) ? String(line.callId) : target;
      // Keyed by the line's own cursor, so polling the same lines again
      // (from cursor 0, or an overlapping `since`) never repeats them.
      const cursor = line && Number.isFinite(line.cursor) ? line.cursor : since + idx + 1;
      const key = target ? 'line:' + (lineFrom || target) + ':' + cursor : 'lines:' + id + ':' + idx;
      if (feed(key, { kind: 'report', from: lineFrom || null, to: from, text })) added++;
    });
    if (target && added) pulse({ kind: 'report', from: target, to: from, text: added + ' line' + (added === 1 ? '' : 's') });
    if (target && r.state) setStatus(net, net.nodes.get(target), mapState(r.state));
  } else if (name === 'subagent_send') {
    const target = args.callId ? String(args.callId) : '';
    const state = String(r.state || r.status || '');
    if (state === 'undelivered') {
      feed('undelivered:' + (id || target), { kind: 'error', from, to: target || null, text: 'message undelivered' });
    }
  } else if (name === 'subagent_read') {
    const arts = Array.isArray(r.artifacts) ? r.artifacts : (r.name ? [r] : []);
    for (const art of arts.slice(0, 8)) {
      if (!art || !art.name || !art.author) continue;
      const author = findNodeByCallOrMember(net, art.author, art.groupId, art.memberId);
      if (!author || author.id === from) continue;
      feed('read:' + (id || '') + ':' + art.name, { kind: 'handoff', from: author.id, to: from, text: 'read ' + art.name });
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
          memberId: m.memberId, groupId: g.groupId, status: 'planned', ghost: true, order: net.order++, at: net.ingestAt || Date.now()
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
  // Top-level delegations by the user row that started their turn.
  const turnOf = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') { lastUser = i; continue; }
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const name = toolName(m.name);
    if (name !== 'subagent' && !name.startsWith('subagent_')) continue;
    if (m.phase === 'call') {
      callRow.set(String(m.toolCallId), i);
      if (name === 'subagent') turnOf.set(String(m.toolCallId), lastUser);
    }
    const key = m.phase + ':' + m.toolCallId;
    if (net.seenRows.has(key)) continue;
    net.seenRows.add(key);
    const ts = m.ts ? Date.parse(m.ts) : NaN;
    net.ingestAt = Number.isFinite(ts) ? ts : 0;
    if (m.phase === 'call') noteToolCall(net, ROOT, { id: m.toolCallId, name, args: m.args }, false);
    else if (m.phase === 'result') {
      noteToolResult(net, ROOT, { id: m.toolCallId, name, args: m.args, ok: m.ok, result: m.content }, false);
      // Only turn-local runs (before chat-scoped background runs) saved a
      // "still running" receipt row; those runs ended with their turn.
      const node = name === 'subagent' && net.nodes.get(String(m.toolCallId));
      if (node && node.background && /"backgroundPending":true/.test(String(m.content || ''))) node.turnLocal = true;
    }
  }
  net.ingestAt = 0;
  noteLatestTurn(net, turnOf);
  if (lastUser < 0) return;
  const endedRoots = new Set();
  for (const [id, idx] of callRow) if (idx < lastUser) endedRoots.add(id);
  for (const node of net.nodes.values()) {
    if (node.status !== 'running' && node.status !== 'waiting') continue;
    if (outlivesTurn(net, node)) continue;
    if (topLevelAncestor(net, node) && endedRoots.has(topLevelAncestor(net, node).id)) setStatus(net, node, 'ended');
  }
}

// The latest turn that delegated, from row positions (paging older rows in
// never changes which turn is the latest). A live turn still adding
// delegations that are not persisted yet keeps its own.
function noteLatestTurn(net, turnOf) {
  if (!turnOf.size) return;
  let latest = -Infinity;
  for (const turn of turnOf.values()) latest = Math.max(latest, turn);
  const roots = new Set();
  for (const [id, turn] of turnOf) if (turn === latest) roots.add(id);
  if (net.liveTurn && net.turnRoots.size) {
    // Rows of the running turn may not be persisted yet: the persisted
    // latest turn is then an older one, which the live turn replaces.
    if (![...roots].some((id) => net.turnRoots.has(id))) roots.clear();
    for (const id of net.turnRoots) roots.add(id);
  }
  const same = roots.size === net.turnRoots.size && [...roots].every((id) => net.turnRoots.has(id));
  if (same) return;
  net.turnRoots = roots;
  net.version++;
}

// latestTurnFailed(net) — whether an agent of the latest turn that delegated
// (at any depth) failed. Older turns no longer colour the head.
export function latestTurnFailed(net) {
  for (const node of net.nodes.values()) {
    if (node.status !== 'failed') continue;
    const top = topLevelAncestor(net, node);
    if (top && net.turnRoots.has(top.id)) return true;
  }
  return false;
}

// A parent that is not in the network counts as the main agent, as in the
// layout (treeChildren).
export function topLevelAncestor(net, node) {
  let cur = node;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (!cur.parentId || cur.parentId === ROOT || !net.nodes.has(cur.parentId)) return cur;
    cur = net.nodes.get(cur.parentId);
  }
  return null;
}

// An agent named by a frame before its launch was seen: a stand-in under the
// agent whose envelope carried the frame (see upsertNode).
function noteAgent(net, id, outer) {
  if (id === ROOT || net.nodes.has(id)) return;
  upsertNode(net, id, outer && outer !== id ? outer : ROOT, { label: 'Subagent', stub: true });
}

// ingestStreamEvent(net, parentCallId, kind, data) -> pulse[]
//
// `parentCallId` is null for top-level frames (made by ROOT). Nested frames
// arrive as `subagent_event` envelopes, one envelope per delegation level;
// `outer` (internal) is the agent whose envelope this frame came out of.
export function ingestStreamEvent(net, parentCallId, kind, data, outer) {
  const owner = parentCallId ? String(parentCallId) : ROOT;
  const d = data && typeof data === 'object' ? data : {};
  if (kind === 'subagent_event') {
    // An envelope is only ever wrapped by a run (src/ai-stream.js), so its
    // parentCallId is an agent even when no frame of its own was seen.
    noteAgent(net, owner, outer);
    return ingestStreamEvent(net, d.parentCallId || owner, d.kind, d.data, owner);
  }
  // Only an agent's own turn proves `owner` is an agent. Other nested frames
  // are keyed by a tool call: a subagent's shell / group_cli output carries
  // the command's call id as its parentCallId, so creating a node for it
  // added a phantom agent for every command (each approved one, typically).
  if (!AGENT_FRAMES.has(kind)) return [];
  noteAgent(net, owner, outer);
  if (kind === 'tool_call') return noteToolCall(net, owner, d, true);
  if (kind === 'tool_result') return noteToolResult(net, owner, d, true);
  if (kind === 'start' && owner !== ROOT) {
    const node = net.nodes.get(owner);
    // A stand-in learns its agent's name here; its launch may never come.
    const own = d.name || d.agent;
    const label = node.stub && own ? clip(own, 32) : (node.label || clip(own || 'Subagent', 32));
    upsertNode(net, owner, node.parentId, { agent: d.agent, name: d.name, model: d.model && d.model.id, label, stub: node.stub });
    if (node.status === 'waiting') setStatus(net, node, 'running');
    return [];
  }
  // A child writing or thinking is working, not sending anything: its ring
  // already says so, so no pulse travels.
  if ((kind === 'message' || kind === 'reasoning') && owner !== ROOT) {
    const node = net.nodes.get(owner);
    if (node.status === 'waiting') setStatus(net, node, 'running');
  }
  return [];
}

// outlivesTurn(net, node) — the node's top-level run is a background run.
// A chat's background runs keep going after their turn ends (the chat's
// persistent scope, src/tools/subagent-orchestration.js), so only their own
// result or status report settles them. A nested run lives in its parent
// run's scope, so a background run under a foreground one does not: it
// ends with the turn like its parent.
function outlivesTurn(net, node) {
  const top = topLevelAncestor(net, node);
  return !!(top && top.background && !top.turnLocal);
}

// settleRunning(net) — the parent turn ended: foreground delegations that
// never reported back ended with it. Background runs keep running.
export function settleRunning(net) {
  net.liveTurn = false;
  for (const node of net.nodes.values()) {
    if (node.id === ROOT || node.ghost || outlivesTurn(net, node)) continue;
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
//               the room available; boxes widen to fill it.
// In both shapes opts.width, when given, widens the boxes so the drawing
// follows the width of the card or screen.
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

// Delegation order: by when each run was made, then by arrival.
export function byDelegation(a, b) {
  if (a.at && b.at && a.at !== b.at) return a.at - b.at;
  return a.order - b.order;
}

// A group's status, from its members': working while any is, failed when
// any failed, otherwise done once all are.
function groupStatus(members) {
  const s = members.map((m) => m.status);
  if (s.includes('running')) return 'running';
  if (s.includes('waiting')) return 'waiting';
  if (s.includes('failed')) return 'failed';
  if (s.every((x) => x === 'planned')) return 'planned';
  if (s.includes('planned')) return 'waiting';
  if (s.every((x) => x === 'done')) return 'done';
  return 'ended';
}

// Cooperative groups as a level of the tree: the members an agent launched
// into a group sit under a box for that group, itself under that agent.
// Without it every member of every group was a direct child of the main
// agent, so a chat that organised its work in groups looked flat. The box
// sits where its earliest member was delegated. Layout only: never in
// `net.nodes`, never counted as an agent.
export const GROUP_PREFIX = 'group:';

function groupBoxes(net) {
  const boxes = new Map();
  for (const node of net.nodes.values()) {
    if (node.id === ROOT || !node.groupId) continue;
    const group = net.groups.get(node.groupId);
    if (!group) continue;
    const pid = net.nodes.has(node.parentId) ? node.parentId : ROOT;
    // Only members launched by the agent that owns the group.
    if (pid !== (net.nodes.has(group.owner) ? group.owner : ROOT)) continue;
    let box = boxes.get(group.id);
    if (!box) {
      box = { id: GROUP_PREFIX + group.id, parentId: pid, group: true, groupId: group.id, label: group.name || 'Group', objective: group.objective, members: [], order: node.order, at: node.at };
      boxes.set(group.id, box);
    }
    box.members.push(node);
    if (byDelegation(node, box) < 0) { box.order = node.order; box.at = node.at; }
  }
  for (const box of boxes.values()) box.status = groupStatus(box.members);
  return boxes;
}

// treeChildren(net) -> { children, parentOf, boxes }
function treeChildren(net) {
  const boxes = groupBoxes(net);
  const children = new Map();
  const parentOf = new Map();
  const add = (pid, node) => {
    parentOf.set(node.id, pid);
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(node);
  };
  for (const box of boxes.values()) add(box.parentId, box);
  for (const node of net.nodes.values()) {
    if (node.id === ROOT) continue;
    const box = node.groupId && boxes.get(node.groupId);
    if (box && box.members.includes(node)) add(box.id, node);
    else add(net.nodes.has(node.parentId) ? node.parentId : ROOT, node);
  }
  for (const list of children.values()) list.sort(byDelegation);
  return { children, parentOf, boxes };
}

// The placed nodes, each with `treeParent`: the box (or agent) it hangs from.
function placedNodes(net, tree, pos, at) {
  const nodes = [];
  for (const node of [...net.nodes.values(), ...tree.boxes.values()]) {
    const p = pos.get(node.id);
    if (!p) continue;
    nodes.push(Object.assign({}, node, at(p), { treeParent: tree.parentOf.get(node.id) || null }));
  }
  return nodes;
}

function layoutEdges(net, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const n of nodes) {
    const parent = n.treeParent && byId.get(n.treeParent);
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
  return opts.vertical ? layoutVertical(net, opts.width) : layoutHorizontal(net, opts.width);
}

function layoutHorizontal(net, avail) {
  const tree = treeChildren(net);
  const { children } = tree;
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
    else x = slot++;
    pos.set(node.id, { x, y: depth * (NODE_H + GAP_Y) });
  };
  place(net.nodes.get(ROOT), 0, new Set());
  // x is in slots until here; boxes widen to fill the room given.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
  const span = maxX - minX;
  const fit = Math.floor(((Number(avail) || 0) - PAD * 2 - span * GAP_X) / (span + 1));
  const nodeW = Math.max(NODE_W, fit);
  const nodes = placedNodes(net, tree, pos, (p) => ({ x: (p.x - minX) * (nodeW + GAP_X) + PAD, y: p.y + PAD }));
  return {
    nodes,
    edges: layoutEdges(net, nodes),
    width: span * (nodeW + GAP_X) + nodeW + PAD * 2,
    height: (maxDepth + 1) * NODE_H + maxDepth * GAP_Y + PAD * 2,
    nodeW,
    vertical: false
  };
}

function layoutVertical(net, avail) {
  const tree = treeChildren(net);
  const { children } = tree;
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
  const nodes = placedNodes(net, tree, pos, (p) => ({ x: PAD + p.depth * INDENT, y: PAD + p.row * (NODE_H + ROW_GAP) }));
  const edges = layoutEdges(net, nodes);
  const depRoom = edges.some((e) => e.kind === 'dep') ? DEP_ROOM : 0;
  const fit = Math.floor((Number(avail) || 0) - PAD * 2 - maxDepth * INDENT - depRoom);
  const nodeW = Math.max(NODE_W, fit);
  return {
    nodes,
    edges,
    width: PAD * 2 + maxDepth * INDENT + nodeW + depRoom,
    height: PAD * 2 + row * NODE_H + Math.max(0, row - 1) * ROW_GAP,
    nodeW,
    vertical: true
  };
}

// treeRoute(byId, a, b) -> [upper, (group box,) lower] | null
//
// The tree edges a message between two placed nodes travels: parent to
// child directly, or an agent to a member of its group through the group's
// box. Null when they are not joined that way (group handoffs).
export function treeRoute(byId, a, b) {
  const down = (up, low) => {
    if (low.treeParent === up.id) return [up, low];
    const mid = byId.get(low.treeParent);
    return mid && mid.group && mid.treeParent === up.id ? [up, mid, low] : null;
  };
  return down(a, b) || down(b, a);
}

// edgePath(a, b, kind, layout) -> SVG path for an edge.
//   horizontal  tree edges run from the parent's bottom to the child's top;
//               dependency edges are a dip below two siblings.
//   vertical    tree edges drop from under the parent's status dot and turn
//               into the child's left side; dependency edges arc on the
//               right between two rows.
// Pulses travel the same path in either direction.
export function edgePath(a, b, kind, layout) {
  const w = (layout && layout.nodeW) || NODE_W;
  if (layout && layout.vertical) return verticalEdgePath(a, b, kind, w);
  if (kind === 'dep' || Math.abs(a.y - b.y) < 1) {
    const ax = a.x + w / 2;
    const bx = b.x + w / 2;
    const y = a.y + NODE_H;
    const dip = 22 + Math.min(40, Math.abs(bx - ax) / 6);
    return `M ${ax} ${y} C ${ax} ${y + dip}, ${bx} ${b.y + NODE_H + dip}, ${bx} ${b.y + NODE_H}`;
  }
  const top = a.y < b.y ? a : b;
  const bottom = top === a ? b : a;
  const x1 = top.x + w / 2;
  const y1 = top.y + NODE_H;
  const x2 = bottom.x + w / 2;
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
