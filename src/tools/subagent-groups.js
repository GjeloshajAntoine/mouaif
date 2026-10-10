'use strict';

const { randomUUID } = require('node:crypto');
const error = (code, message) => Object.assign(new Error(message), { code });
const clone = (value) => JSON.parse(JSON.stringify(value));
const key = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
const text = (value, max = 4096) => typeof value === 'string' && value.trim() && value.length <= max;
const files = (value) => Array.isArray(value) && value.length <= 20 && value.every((p) => text(p, 512) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'));
const terminal = (state) => ['completed', 'failed', 'cancelled', 'blocked'].includes(state);

// Metadata only: workspace claims never select folders or grant file access.
class Groups {
  constructor() { this.rows = new Map(); }
  get(id) {
    const row = this.rows.get(id);
    if (!row) throw error('EUNKNOWN_GROUP', 'unknown group in this parent turn');
    return row;
  }
  create(args) {
    if (!key(args.name) || !text(args.objective) || !Array.isArray(args.members) || !args.members.length || args.members.length > 32) throw error('EBADINPUT', 'group needs name, objective and 1–32 members');
    if (this.rows.size >= 8) throw error('ETOOL_CAP', 'maximum eight groups per turn');
    if ([...this.rows.values()].some((g) => g.name === args.name)) throw error('EEXISTS', 'group name already exists');
    const members = new Map();
    for (const m of args.members) {
      if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => !['memberId', 'role', 'owns', 'workspace', 'dependsOn'].includes(k)) || !key(m.memberId) || !text(m.role, 512) || !files(m.owns || []) || !text(m.workspace, 1024) || !Array.isArray(m.dependsOn || []) || (m.dependsOn || []).length > 32 || (m.dependsOn || []).some((id) => !key(id)) || members.has(m.memberId)) throw error('EBADINPUT', 'invalid or duplicate member metadata');
      members.set(m.memberId, { memberId: m.memberId, role: m.role, owns: [...(m.owns || [])], workspace: m.workspace, dependsOn: [...new Set(m.dependsOn || [])], state: 'pending', callId: null, actualWorkspace: null });
    }
    const visiting = new Set(), visited = new Set();
    const visit = (id) => {
      if (!members.has(id)) throw error('EBADINPUT', 'dependency is not a member');
      if (visiting.has(id)) throw error('ECYCLE', 'dependency cycle rejected');
      if (visited.has(id)) return;
      visiting.add(id); for (const dep of members.get(id).dependsOn) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const id of members.keys()) visit(id);
    const groupId = 'group-' + randomUUID();
    const row = { groupId, name: args.name, objective: args.objective, members, decisions: new Map(), conflicts: new Map(), artifacts: [] };
    // Build latches only after all input is validated; no partial group effects.
    for (const m of members.values()) m.done = new Promise((resolve) => { m.resolve = resolve; });
    this.rows.set(groupId, row);
    return this.status(row);
  }
  member(groupId, memberId) {
    const group = this.get(groupId), member = group.members.get(memberId);
    if (!member) throw error('EUNKNOWN_MEMBER', 'unknown group member');
    return { group, member };
  }
  validateLaunch(meta) {
    if (meta.groupId === undefined && meta.memberId === undefined) return null;
    if (!meta.groupId || !meta.memberId) throw error('EBADINPUT', 'groupId and memberId are required together');
    const pair = this.member(meta.groupId, meta.memberId);
    if (pair.member.callId || terminal(pair.member.state)) throw error('EALREADY_FINISHED', 'member is already launched or blocked');
    return pair;
  }
  bind(pair, run) {
    if (!pair) return;
    const { member } = pair;
    member.callId = run.callId;
    member.state = member.dependsOn.every((id) => pair.group.members.get(id).state === 'completed') ? 'ready' : 'waiting';
    run.groupId = pair.group.groupId; run.memberId = member.memberId;
  }
  async ready(run) {
    if (!run.groupId) return true;
    const { group, member } = this.member(run.groupId, run.memberId);
    await Promise.race([Promise.all(member.dependsOn.map((id) => group.members.get(id).done)), member.done]);
    if (terminal(member.state) || run.controller.signal.aborted) return false;
    member.state = 'running'; return true;
  }
  settle(run, state) {
    if (!run.groupId) return;
    const { group, member } = this.member(run.groupId, run.memberId);
    if (terminal(member.state)) return;
    member.state = state; member.resolve(state);
    if (state !== 'completed') this.propagate(group);
  }
  propagate(group) {
    let changed;
    do {
      changed = false;
      for (const m of group.members.values()) {
        if (terminal(m.state)) continue;
        const bad = m.dependsOn.find((id) => ['failed', 'cancelled', 'blocked'].includes(group.members.get(id).state));
        if (bad) { m.state = 'blocked'; m.reason = 'dependency ' + bad + ' did not complete'; m.resolve('blocked'); changed = true; }
      }
    } while (changed);
  }
  status(group) {
    const members = [...group.members.values()].map(({ done, resolve, ...m }) => ({ ...m, ready: !terminal(m.state) && m.dependsOn.every((id) => group.members.get(id).state === 'completed') }));
    const conflicts = [...group.conflicts.values()];
    const state = members.some((m) => m.state === 'failed') ? 'failed'
      : members.some((m) => m.state === 'cancelled') ? 'cancelled'
      : members.some((m) => m.state === 'blocked') || conflicts.some((c) => c.state === 'open') ? 'blocked'
      : members.every((m) => m.state === 'completed') ? 'completed'
      : members.some((m) => m.state === 'running') ? 'running' : 'pending';
    return clone({ groupId: group.groupId, name: group.name, objective: group.objective, state, complete: state === 'completed', settled: members.every((m) => terminal(m.state)), members, decisions: [...group.decisions.values()], conflicts, artifacts: group.artifacts });
  }
  propose(args, run) {
    const group = this.get(args.groupId);
    if (!key(args.name) || !text(args.proposal)) throw error('EBADINPUT', 'decision needs name and proposal');
    if (group.decisions.has(args.name)) throw error('EEXISTS', 'decision names are immutable');
    if (group.decisions.size >= 64) throw error('ETOOL_CAP', 'decision store is full');
    const row = { name: args.name, proposal: args.proposal, author: run?.memberId || 'parent', state: 'proposed', contract: null };
    group.decisions.set(args.name, row); return clone(row);
  }
  conflict(args, run) {
    const group = this.get(args.groupId);
    if (!key(args.name) || !text(args.summary) || !Array.isArray(args.members) || !args.members.length || args.members.length > 32 || args.members.some((id) => !group.members.has(id))) throw error('EBADINPUT', 'conflict needs name, summary and known members');
    if (group.conflicts.has(args.name)) throw error('EEXISTS', 'conflict already exists');
    if (group.conflicts.size >= 64) throw error('ETOOL_CAP', 'conflict store is full');
    const row = { name: args.name, summary: args.summary, members: [...new Set(args.members)], author: run?.memberId || 'parent', state: 'open', resolution: null };
    group.conflicts.set(args.name, row); return clone(row);
  }
  update(args) {
    const group = this.get(args.groupId);
    if (args.action === 'approve' || args.action === 'reject') {
      const row = group.decisions.get(args.name);
      if (!row) throw error('EUNKNOWN_DECISION', 'unknown proposal');
      if (row.state !== 'proposed') throw error('EALREADY_FINISHED', 'decision already resolved');
      if (!text(args.contract)) throw error('EBADINPUT', 'parent contract or rejection reason required');
      row.state = args.action === 'approve' ? 'approved' : 'rejected'; row.contract = args.contract;
    } else if (args.action === 'arbitrate') {
      const row = group.conflicts.get(args.name);
      if (!row) throw error('EUNKNOWN_CONFLICT', 'unknown conflict');
      if (row.state !== 'open') throw error('EALREADY_FINISHED', 'conflict already resolved');
      if (!text(args.contract)) throw error('EBADINPUT', 'parent resolution required');
      row.state = 'resolved'; row.resolution = args.contract;
    } else throw error('EBADINPUT', 'unknown parent action');
    return this.status(group);
  }
  close() {
    for (const group of this.rows.values()) for (const m of group.members.values()) if (!terminal(m.state)) { m.state = 'cancelled'; m.resolve('cancelled'); }
  }
}
module.exports = { Groups };
